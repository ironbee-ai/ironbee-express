import { pluginApi } from "./api";
import { raceDialog } from "./dialog-race";
import type { ControlTarget } from "./frames";
import {
    BrowserToolSessionContext,
    DialogKeeper,
    PendingDialog,
    RaceOutcome,
    SecretSinkKind,
    Tool,
    ToolInput,
    ToolInputSchema,
    ToolOutput,
    ToolOutputSchema,
} from "./host";
import {
    DEFAULT_ACTION_BOX_DURATION_MS,
    DEFAULT_CLICK_RIPPLE_DURATION_MS,
    DEFAULT_HIGHLIGHT_BORDER_WIDTH,
    DEFAULT_HIGHLIGHT_COLOR,
    DEFAULT_HIGHLIGHT_PADDING,
    drawActionBox,
    drawClickRipple,
    shouldMarkAction,
} from "./overlay";
import type { RuntimeLocateResult } from "./runtime";
import { actionAnimation, followsNewTabs } from "./settings";
import {
    Control,
    controlHandle,
    ControlOperation,
    ControlSnapshot,
    controlSnapshotLimitsShape,
    controlSnapshotShape,
    DEFAULT_MAX_CONTROLS,
    DEFAULT_MAX_TEXT_CHARS,
    DialogControlId,
    getControlSnapshot,
    isControlFresh,
    locateControl,
    resolveControl,
    selectAllInFocusedField,
    settleAfterAction,
    sleep,
    StoredControlSnapshot,
    takeControlSnapshot,
} from "./snapshot";

import type { ElementHandle, Page } from "playwright-core";

/**
 * Whether the element is an <input type="password">, decided by Playwright's
 * selector engine matching the element against itself, in its own isolated
 * world: nothing the page's scripts redefine (not even an identity compare)
 * takes part in it.
 */
async function isPasswordInput(handle: ElementHandle<Element>): Promise<boolean> {
    const self: ElementHandle<Element> | null = await handle
        .$(`css=:scope:is(input[type="password"])`)
        .catch((): null => null);
    if (self === null) {
        return false;
    }
    // The match is the element itself: only its existence was the answer.
    await self.dispose().catch((): void => undefined);
    return true;
}

/**
 * A {{secret:…}} reference where none may go. Carries DevTools' SECRET_DENIED
 * code so the daemon's error envelope marks it a refusal — the page is as it
 * was and the run reads it like any other — rather than a failure.
 */
class SecretRefusal extends Error {
    readonly code: string = "SECRET_DENIED";

    constructor(message: string) {
        super(message);
        this.name = "SecretRefusal";
    }
}

const DEFAULT_WAIT_MS: number = 300;
/** Share of the viewport height one scroll step moves. */
const SCROLL_VIEWPORT_RATIO: number = 0.7;
/** Playwright's own waits (selectOption, the fill fallback) — the control was just checked. */
const HANDLE_ACTION_TIMEOUT_MS: number = 2_000;
/** A click on a link that opens a new tab: how long the tab may take to appear. */
const NEW_TAB_TIMEOUT_MS: number = 1_000;
/** go-back / go-forward: until the other page's document is in (the snapshot waits for the rest). */
const HISTORY_TIMEOUT_MS: number = 10_000;
/** waitForNetworkMs: done once nothing the action started was in flight for this long… */
const NETWORK_IDLE_WINDOW_MS: number = 50;
/** …or, once a request was seen, this long after the last one ended (a request often follows another). */
const NETWORK_TAIL_WINDOW_MS: number = 150;
const NETWORK_POLL_INTERVAL_MS: number = 25;
/**
 * A press-key value: a key name, optionally with modifiers (`Escape`,
 * `ArrowDown`, `Shift+Tab`, `a`) — Playwright's own grammar. Anything else
 * (text, a reference) is refused before it reaches the page.
 */
const KEY_PATTERN: RegExp =
    /^((Shift|Control|Alt|Meta|ControlOrMeta)\+)*([A-Za-z0-9]|[A-Z][A-Za-z0-9]{1,15})$/;

/** How an action is marked in the page (see overlay.ts). */
enum Mark {
    /** Before a click: a navigating click tears the overlay down. */
    RIPPLE = "ripple",
    /** After a write: the box frames the control's new value. */
    BOX = "box",
}

/** Thrown into an action's background work once a dialog overtook it (see ActionRun). */
class AbandonedAction extends Error {}

/**
 * One action, raced against a native dialog opening (see executeAround).
 * Every input the action sends goes through `input()`: once a dialog has
 * overtaken the action the rest of it is abandoned — it must not click, type
 * or press later, when the dialog is answered, into whatever is there then.
 */
class ActionRun {
    abandoned: boolean = false;
    /** Some input reached the page: the action happened (and may have opened the dialog). */
    dispatched: boolean = false;

    input(): void {
        if (this.abandoned) {
            throw new AbandonedAction("abandoned: a dialog opened");
        }
        this.dispatched = true;
    }
}

export enum ControlAction {
    CLICK = "click",
    FILL = "fill",
    SELECT = "select",
    PRESS_ENTER = "press-enter",
    SCROLL_DOWN = "scroll-down",
    SCROLL_UP = "scroll-up",
    WAIT = "wait",
    /** Move the pointer onto a control (menus and tooltips that open on hover). */
    HOVER = "hover",
    /** Press a key (value), in the control given (focused first) or wherever focus is. */
    PRESS_KEY = "press-key",
    /** The tab's history: the previous / next page. */
    GO_BACK = "go-back",
    GO_FORWARD = "go-forward",
    /** Make the tab of index `value` the active one. */
    SWITCH_TAB = "switch-tab",
    /** Close the tab of index `value` (default: the active one); the latest remaining becomes active. */
    CLOSE_TAB = "close-tab",
}

/** The control operation each targeted action requires. */
const REQUIRED_OPERATION: Partial<Record<ControlAction, ControlOperation>> = {
    [ControlAction.CLICK]: ControlOperation.CLICK,
    [ControlAction.FILL]: ControlOperation.FILL,
    [ControlAction.SELECT]: ControlOperation.SELECT,
    [ControlAction.PRESS_ENTER]: ControlOperation.FILL,
    // A hover target is anything a person could point at and click.
    [ControlAction.HOVER]: ControlOperation.CLICK,
};

export interface ActInput extends ToolInput {
    action: ControlAction;
    snapshotId?: number;
    controlId?: number;
    value?: string;
    waitMs?: number;
    waitForNetworkMs?: number;
    observe?: boolean;
    /** Mark the action in the page. Defaults to whether a screen recording is running. */
    animate?: boolean;
    maxControls?: number;
    maxTextChars?: number;
}

export interface ActOutput extends ToolOutput {
    executed: boolean;
    /** Why nothing was executed (stale snapshot, covered/gone target). */
    reason?: string;
    /** With waitForNetworkMs: false when requests were still in flight at the bound; absent while a native dialog is held. */
    networkIdle?: boolean;
    snapshot?: ControlSnapshot;
}

export class Act implements Tool {
    name(): string {
        return "control_act";
    }

    description(): string {
        return "Performs one action on a control from the latest <control_take-snapshot> and, by default, returns the next snapshot in the same call. Refuses without acting (executed: false + reason + a fresh snapshot) when the control changed since the snapshot (or the page navigated) or the target is gone, covered or off-screen — decide again on the returned snapshot.";
    }

    inputSchema(): ToolInputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            action: z.nativeEnum(ControlAction),
            snapshotId: z
                .number()
                .int()
                .optional()
                .describe(
                    "snapshotId the decision was made on. Required with controlId."
                ),
            controlId: z
                .number()
                .int()
                .optional()
                .describe(
                    "Required for click / fill / select / press-enter / hover; optional for press-key (focused first)."
                ),
            value: z
                .string()
                .optional()
                .describe(
                    "fill: text to enter (replaces). select: option value. press-key: key, e.g. Escape, ArrowDown, Shift+Tab. switch-tab / close-tab: tab index."
                ),
            waitMs: z
                .number()
                .int()
                .min(0)
                .max(10_000)
                .optional()
                .default(DEFAULT_WAIT_MS)
                .describe("wait: how long."),
            waitForNetworkMs: z
                .number()
                .int()
                .min(0)
                .max(10_000)
                .optional()
                .default(0)
                .describe(
                    "After an executed action, wait up to this long for the requests it started (wait: any in flight) to finish before observing, e.g. a list loaded from an API; not one started later (debounced). 0: no wait."
                ),
            observe: z
                .boolean()
                .optional()
                .default(true)
                .describe("Return the next snapshot."),
            animate: z
                .boolean()
                .optional()
                .describe(
                    "Mark the action (click ripple / box) so it is visible in recordings. Defaults to whether a screen recording is running."
                ),
            ...controlSnapshotLimitsShape(),
        };
    }

    outputSchema(): ToolOutputSchema {
        const z: typeof import("zod").z = pluginApi().z;
        return {
            executed: z.boolean(),
            reason: z.string().optional(),
            networkIdle: z
                .boolean()
                .optional()
                .describe(
                    "With waitForNetworkMs: false when requests were still in flight at the bound; absent while a native dialog is held."
                ),
            snapshot: z.object(controlSnapshotShape()).optional(),
        };
    }

    async handle(
        context: BrowserToolSessionContext,
        args: ActInput
    ): Promise<ActOutput> {
        const page: Page = context.page;
        const startedMs: number = Date.now();
        const reason: string | undefined = await this.executeAround(
            context,
            page,
            args
        );
        const output: ActOutput = { executed: reason === undefined };
        if (reason !== undefined) {
            output.reason = reason;
        }
        const waitForNetworkMs: number = args.waitForNetworkMs ?? 0;
        if (reason === undefined && waitForNetworkMs > 0) {
            // A wait is for what is already loading; any other action, for what it started.
            const idle: boolean | undefined = await this.waitForNetwork(
                context,
                args.action === ControlAction.WAIT ? undefined : startedMs,
                waitForNetworkMs
            );
            if (idle !== undefined) {
                output.networkIdle = idle;
            }
        }
        if (args.observe ?? true) {
            output.snapshot = await takeControlSnapshot(context, {
                maxControls: args.maxControls ?? DEFAULT_MAX_CONTROLS,
                maxTextChars: args.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
            });
        }
        return output;
    }

    /**
     * Waits, up to `timeoutMs`, until none of the requests started since
     * `sinceMs` (the action's start; every one when undefined) is in flight: true when it got there,
     * at the bound whether nothing is in flight right then. The settle only waits frames, so a list the action
     * made the page fetch would not be on the next snapshot yet. Requests
     * opened before the action (a long poll, an event stream) do not hold it.
     * A held native dialog stops it (undefined): the page is frozen until
     * the dialog is answered, and the snapshot is the dialog anyway.
     */
    private async waitForNetwork(
        context: BrowserToolSessionContext,
        sinceMs: number | undefined,
        timeoutMs: number
    ): Promise<boolean | undefined> {
        const deadlineMs: number = Date.now() + timeoutMs;
        // A tab the action opened becomes the current one on the tab queue.
        await context.tabsSettled();
        let lastBusyMs: number = Date.now();
        let sawRequest: boolean = false;
        while (true) {
            if (context.dialogs().pending() !== undefined) {
                return undefined;
            }
            const nowMs: number = Date.now();
            if (context.numOfInFlightRequests(sinceMs) > 0) {
                lastBusyMs = nowMs;
                sawRequest = true;
            } else if (
                nowMs - lastBusyMs >=
                (sawRequest ? NETWORK_TAIL_WINDOW_MS : NETWORK_IDLE_WINDOW_MS)
            ) {
                return true;
            }
            if (nowMs >= deadlineMs) {
                // A bound shorter than the idle window: still the truth about what is in flight.
                return context.numOfInFlightRequests(sinceMs) === 0;
            }
            await sleep(NETWORK_POLL_INTERVAL_MS);
        }
    }

    /**
     * The action, around native dialogs (BROWSER_DIALOG_MODE=hold). A dialog
     * snapshot's controls answer the dialog. A dialog opened since the last
     * snapshot refuses anything but a wait. And an action whose handler opens
     * one counts as executed the moment it does: its input event, and every
     * later evaluate, would wait for the dialog — so the rest of the action is
     * abandoned (never typing later into whatever has focus then).
     */
    private async executeAround(
        context: BrowserToolSessionContext,
        page: Page,
        args: ActInput
    ): Promise<string | undefined> {
        // Only a fill's value is a destination. Anywhere else a reference would
        // reach the page as its literal text (this tool is exempt at the generic
        // chokepoints — it resolves its own destination), so it is refused,
        // whatever the action.
        if (
            pluginApi().carriesSecretReference({
                ...args,
                value:
                    args.action === ControlAction.FILL ? undefined : args.value,
            })
        ) {
            throw new SecretRefusal(
                "a {{secret:…}} reference may only be the value of a fill"
            );
        }
        if (
            args.action === ControlAction.SWITCH_TAB ||
            args.action === ControlAction.CLOSE_TAB
        ) {
            return this.tab(context, args);
        }
        const stored: StoredControlSnapshot | undefined =
            getControlSnapshot(context);
        if (
            stored === undefined &&
            args.action !== ControlAction.WAIT &&
            context.takeTabSwitched()
        ) {
            return "another tab became active since the snapshot; nothing was executed";
        }
        if (stored?.dialogId !== undefined) {
            return this.executeOnDialog(context, page, args, stored);
        }
        if (args.action === ControlAction.WAIT) {
            // Outside the race: a held dialog must not cut the wait short.
            await sleep(args.waitMs ?? DEFAULT_WAIT_MS);
            return undefined;
        }
        // Any held dialog, this tab's or another's (tabs opened from one
        // another share a renderer: it stops this page too).
        const held: PendingDialog | undefined = context.dialogs().pending();
        if (held !== undefined) {
            return `a ${held.type} dialog opened: answer it first (take a snapshot to see it); nothing was executed`;
        }
        const run: ActionRun = new ActionRun();
        const outcome: RaceOutcome<string | undefined> = await raceDialog(
            context.dialogs(),
            this.execute(context, page, args, run)
        );
        if (!outcome.dialog) {
            return outcome.value;
        }
        run.abandoned = true;
        if (context.dialogs().pending() === undefined) {
            if (context.dialogs().disposed) {
                throw new Error("control_act: the browser session closed");
            }
            // Answered already (a timeout, another call, its page closing).
            return run.dispatched
                ? undefined
                : "a dialog opened and closed before the action reached the page; nothing was executed";
        }
        // The action opened the dialog only if it had sent the page something.
        return run.dispatched
            ? undefined
            : "a dialog opened before the action reached the page; nothing was executed";
    }

    /** An action on a dialog snapshot: its OK / Cancel / field answer the held dialog. */
    private async executeOnDialog(
        context: BrowserToolSessionContext,
        page: Page,
        args: ActInput,
        stored: StoredControlSnapshot
    ): Promise<string | undefined> {
        const keeper: DialogKeeper = context.dialogs();
        const held: PendingDialog | undefined = keeper.pending();
        if (held === undefined || held.id !== stored.dialogId) {
            return "stale: the dialog is no longer open; nothing was executed";
        }
        const answered: (accept: boolean) => Promise<undefined> = async (
            accept: boolean
        ): Promise<undefined> => {
            await keeper.resolve(accept);
            // Let what the answer set off (a navigation, a re-render) begin.
            await raceDialog(
                keeper,
                settleAfterAction(page, ControlAction.CLICK)
            );
            return undefined;
        };
        switch (args.action) {
            case ControlAction.WAIT:
                await sleep(args.waitMs ?? DEFAULT_WAIT_MS);
                return undefined;
            case ControlAction.CLICK: {
                const control: Control = this.controlFor(
                    context,
                    args,
                    ControlOperation.CLICK
                );
                return answered(control.id === DialogControlId.OK);
            }
            case ControlAction.FILL: {
                this.controlFor(context, args, ControlOperation.FILL);
                if (pluginApi().carriesSecretReference(args.value)) {
                    throw new SecretRefusal(
                        "a {{secret:…}} reference cannot be typed into a native dialog"
                    );
                }
                keeper.setPromptText(args.value ?? "");
                return undefined;
            }
            case ControlAction.PRESS_ENTER:
                this.controlFor(context, args, ControlOperation.FILL);
                return answered(true);
            case ControlAction.PRESS_KEY:
                if (args.value === "Enter" || args.value === "Escape") {
                    return answered(args.value === "Enter");
                }
                return `a ${held.type} dialog is open: only Enter (OK) or Escape (Cancel) answer it; nothing was executed`;
            default:
                return `a ${held.type} dialog is open: answer it with OK or Cancel first; nothing was executed`;
        }
    }

    /** Runs the action; returns a refusal reason, or undefined when executed. */
    private async execute(
        context: BrowserToolSessionContext,
        page: Page,
        args: ActInput,
        run: ActionRun
    ): Promise<string | undefined> {
        if (
            args.action === ControlAction.SCROLL_DOWN ||
            args.action === ControlAction.SCROLL_UP
        ) {
            await this.scroll(page, args.action, run);
            return undefined;
        }
        if (
            args.action === ControlAction.GO_BACK ||
            args.action === ControlAction.GO_FORWARD
        ) {
            return this.history(page, args.action, run);
        }
        if (args.action === ControlAction.PRESS_KEY) {
            return this.pressKey(context, page, args, run);
        }

        const operation: ControlOperation = REQUIRED_OPERATION[args.action]!;
        const control: Control = this.controlFor(context, args, operation);
        const controlId: number = control.id;
        const stored: StoredControlSnapshot = getControlSnapshot(context)!;
        // Resolved once, against the snapshot the decision was made on.
        const target: ControlTarget | undefined = resolveControl(
            page,
            stored,
            controlId
        );
        if (target === undefined) {
            return "the frame of the control is gone; nothing was executed";
        }

        if (!(await isControlFresh(stored, target, controlId))) {
            return `stale: the control changed since snapshot ${args.snapshotId}, or the page navigated; nothing was executed`;
        }

        if (args.action === ControlAction.SELECT) {
            if (
                !control.options?.some(
                    (o: { value: string }): boolean => o.value === args.value
                )
            ) {
                throw new Error(
                    `control_act: control ${controlId} offers no option with value ${JSON.stringify(args.value)}`
                );
            }
        }

        const located: RuntimeLocateResult = await locateControl(
            target,
            operation,
            args.value
        );
        if (located.error !== undefined) {
            return `${located.error}; nothing was executed`;
        }
        const x: number = located.x!;
        const y: number = located.y!;

        const mark: boolean = shouldMarkAction(
            context,
            args.animate,
            actionAnimation()
        );
        switch (args.action) {
            case ControlAction.CLICK:
                // Drawn BEFORE the click: a click that navigates tears the
                // overlay down with the page. Not once a dialog pre-empted
                // the click (`run.input()` below refuses it): no ripple for a
                // click that never happens. The ripple sits where the click
                // goes (a label for a hidden input, a list scrolled to its
                // target), not on the element.
                if (mark && !run.abandoned) {
                    await this.decorate(target, Mark.RIPPLE, { x, y });
                }
                {
                    // The tab a link opens arrives some ms after the click:
                    // waited for, so the next snapshot is of it.
                    const newTab: Promise<unknown> | undefined =
                        located.opensTab && followsNewTabs()
                            ? page
                                .waitForEvent("popup", {
                                    timeout: NEW_TAB_TIMEOUT_MS,
                                })
                                .catch((): undefined => undefined)
                            : undefined;
                    run.input();
                    await page.mouse.click(x, y);
                    if (newTab !== undefined) {
                        await newTab;
                    }
                }
                break;
            case ControlAction.FILL:
                if (pluginApi().carriesSecretReference(args.value)) {
                    await this.fillSecret(target, args.value!, run);
                } else {
                    await this.fill(page, target, x, y, args.value ?? "", run);
                }
                break;
            case ControlAction.SELECT:
                await this.withHandle(
                    target,
                    async (handle: ElementHandle<Element>): Promise<void> => {
                        run.input();
                        await handle.selectOption(
                            { value: args.value! },
                            { timeout: HANDLE_ACTION_TIMEOUT_MS }
                        );
                    }
                );
                break;
            case ControlAction.HOVER:
                run.input();
                await page.mouse.move(x, y);
                break;
            case ControlAction.PRESS_ENTER:
                await this.withHandle(
                    target,
                    async (handle: ElementHandle<Element>): Promise<void> => {
                        run.input();
                        await handle.focus();
                    }
                );
                run.input();
                await page.keyboard.press("Enter");
                break;
        }
        if (run.abandoned) {
            return undefined;
        }
        if (mark && args.action !== ControlAction.CLICK) {
            // After the write, so the box frames the control's new value.
            await this.decorate(target, Mark.BOX);
        }
        // The action, not the operation: press-enter is a fill's operation but not a typing.
        await settleAfterAction(page, args.action, target);
        return undefined;
    }

    /**
     * Decoration only: never fails the action. `at`: the page point a ripple
     * is centred on. Only for a page control — a frame's ripple draws in the
     * frame's document, where the page point means nothing, so it stays
     * centred on the element there.
     */
    private async decorate(target: ControlTarget, kind: Mark, at?: { x: number; y: number }): Promise<void> {
        try {
            const handle: ElementHandle<Element> | null =
                await controlHandle(target);
            if (handle === null) {return;}
            try {
                if (kind === Mark.RIPPLE) {
                    await drawClickRipple(handle, {
                        color: DEFAULT_HIGHLIGHT_COLOR,
                        durationMs: DEFAULT_CLICK_RIPPLE_DURATION_MS,
                        ...(at !== undefined && target.route === undefined ? { at } : {}),
                    });
                } else {
                    await drawActionBox(handle, {
                        color: DEFAULT_HIGHLIGHT_COLOR,
                        padding: DEFAULT_HIGHLIGHT_PADDING,
                        borderWidth: DEFAULT_HIGHLIGHT_BORDER_WIDTH,
                        durationMs: DEFAULT_ACTION_BOX_DURATION_MS,
                    });
                }
            } finally {
                await handle.dispose().catch((): void => {});
            }
        } catch {
            // The page may be navigating; a missing mark is fine.
        }
    }

    /** `operation` undefined: any control focus can go to (clickable or fillable). */
    private controlFor(
        context: BrowserToolSessionContext,
        args: ActInput,
        operation: ControlOperation | undefined
    ): Control {
        if (args.controlId === undefined || args.snapshotId === undefined) {
            throw new Error(
                `control_act: ${args.action} needs controlId and snapshotId`
            );
        }
        if (args.action === ControlAction.SELECT && args.value === undefined) {
            throw new Error(
                "control_act: select needs value (an option value)"
            );
        }
        if (args.action === ControlAction.FILL && args.value === undefined) {
            throw new Error("control_act: fill needs value");
        }
        const stored: StoredControlSnapshot | undefined =
            getControlSnapshot(context);
        if (stored === undefined) {
            throw new Error(
                "control_act: no control snapshot on this page; take one first"
            );
        }
        if (stored.snapshot.snapshotId !== args.snapshotId) {
            throw new Error(
                `control_act: snapshot ${args.snapshotId} is not the latest (${stored.snapshot.snapshotId}); decide on the latest snapshot`
            );
        }
        const control: Control | undefined = stored.snapshot.controls.find(
            (c: Control): boolean => c.id === args.controlId
        );
        if (control === undefined) {
            throw new Error(
                `control_act: control ${args.controlId} is not in snapshot ${args.snapshotId}`
            );
        }
        if (operation === undefined) {
            if (
                !control.ops.includes(ControlOperation.CLICK) &&
                !control.ops.includes(ControlOperation.FILL)
            ) {
                throw new Error(
                    `control_act: control ${args.controlId} (${control.role} "${control.name}") cannot take focus; it supports ${control.ops.join(", ")}`
                );
            }
            return control;
        }
        if (!control.ops.includes(operation)) {
            throw new Error(
                `control_act: control ${args.controlId} (${control.role} "${control.name}") does not support ${operation}; it supports ${control.ops.join(", ")}`
            );
        }
        return control;
    }

    /**
     * Clicks the field like a person, then replaces the contents of whatever
     * is focused. Some widgets open an overlay with their own input on click
     * (the observed field is only a trigger); typing where focus landed is what
     * works for those, and is identical for an ordinary field.
     */
    private async fill(
        page: Page,
        target: ControlTarget,
        x: number,
        y: number,
        value: string,
        run: ActionRun
    ): Promise<void> {
        run.input();
        await page.mouse.click(x, y);
        // A dialog the click opened: the click resolves only once it is
        // answered, and nothing more of this action may run in the page then
        // (not even the select-all: it would select in whatever has focus).
        run.input();
        // In the control's own document: a frame control's focus is in its frame.
        const selected: boolean = await selectAllInFocusedField(target);
        run.input();
        if (selected) {
            if (value === "") {
                await page.keyboard.press("Delete");
            } else {
                await page.keyboard.insertText(value);
            }
            return;
        }
        // Focus went somewhere that is not a text field: fill the observed
        // element itself.
        await this.withHandle(
            target,
            async (handle: ElementHandle<Element>): Promise<void> => {
                run.input();
                await handle.fill(value, { timeout: HANDLE_ACTION_TIMEOUT_MS });
            }
        );
    }

    /**
     * The form-fill sink. A fill whose value carries a {{secret:…}} reference
     * is written through the element itself, never typed where focus happened
     * to land (the ordinary fill's click-and-insert could put the value into
     * another element than the one checked): the reference is resolved by
     * DevTools' `resolveSecrets` for THIS element — its own frame's origin, and
     * whether it is a password input (a login password goes only there) — and
     * that is re-checked right before the write, since focusing first can run
     * an `onfocus` handler that flips the input's type.
     */
    private async fillSecret(
        target: ControlTarget,
        value: string,
        run: ActionRun
    ): Promise<void> {
        await this.withHandle(
            target,
            async (handle: ElementHandle<Element>): Promise<void> => {
                const passwordField: boolean = await isPasswordInput(handle);
                const resolved: string = pluginApi().resolveSecrets(value, {
                    kind: SecretSinkKind.FORM_FILL,
                    origin: (await handle.ownerFrame())?.url() ?? "",
                    passwordField,
                });
                run.input();
                await handle.focus().catch((): void => {});
                if (passwordField && !(await isPasswordInput(handle))) {
                    throw new Error(
                        "control_act: the element stopped being a password field between the check and the write; nothing was typed"
                    );
                }
                run.input();
                await handle.fill(resolved, { timeout: HANDLE_ACTION_TIMEOUT_MS });
            }
        );
    }

    /**
     * A key press. With a control: that control, freshness-checked and
     * focused first (any control a person could click or type into). Without
     * one: wherever focus is — Escape to close a dialog, arrows in an open list.
     */
    private async pressKey(
        context: BrowserToolSessionContext,
        page: Page,
        args: ActInput,
        run: ActionRun
    ): Promise<string | undefined> {
        const key: string = args.value ?? "";
        if (!KEY_PATTERN.test(key)) {
            throw new Error(
                `control_act: press-key needs a key name as value (e.g. Escape, ArrowDown, Shift+Tab), got ${JSON.stringify(key)}`
            );
        }
        let focused: ControlTarget | undefined;
        if (args.controlId !== undefined) {
            const control: Control = this.controlFor(
                context,
                args,
                undefined
            );
            const stored: StoredControlSnapshot = getControlSnapshot(context)!;
            focused = resolveControl(page, stored, control.id);
            if (focused === undefined) {
                return "the frame of the control is gone; nothing was executed";
            }
            if (!(await isControlFresh(stored, focused, control.id))) {
                return `stale: the control changed since snapshot ${args.snapshotId}, or the page navigated; nothing was executed`;
            }
            await this.withHandle(
                focused,
                async (handle: ElementHandle<Element>): Promise<void> => {
                    run.input();
                    await handle.focus();
                }
            );
        }
        run.input();
        await page.keyboard.press(key);
        if (run.abandoned) {
            // A dialog the key opened took the action over: no mark, no settle here.
            return undefined;
        }
        if (focused !== undefined && shouldMarkAction(context, args.animate, actionAnimation())) {
            // Like the other non-click actions: the box after the key, around the control it went to.
            await this.decorate(focused, Mark.BOX);
        }
        await settleAfterAction(page, ControlAction.PRESS_KEY, focused);
        return undefined;
    }

    /** switch-tab / close-tab by the index in the snapshot's `tabs`. */
    private async tab(
        context: BrowserToolSessionContext,
        args: ActInput
    ): Promise<string | undefined> {
        const index: number | undefined =
            args.value === undefined || args.value === ""
                ? undefined
                : Number(args.value);
        if (index !== undefined && !Number.isInteger(index)) {
            throw new Error(
                `control_act: ${args.action} takes a tab index as value, got ${JSON.stringify(args.value)}`
            );
        }
        if (args.action === ControlAction.SWITCH_TAB) {
            if (index === undefined) {
                throw new Error(
                    "control_act: switch-tab needs the tab index as value"
                );
            }
            return context.switchTab(index);
        }
        return context.closeTab(index);
    }

    /** The previous / next page in the tab's history; a refusal when there is none. */
    private async history(
        page: Page,
        action: ControlAction,
        run: ActionRun
    ): Promise<string | undefined> {
        const before: string = page.url();
        // Committed is enough: the next snapshot waits for the document. A page the
        // back/forward cache restores (patchright leaves the cache on) fires no
        // DOMContentLoaded, so waiting for it ran into the timeout.
        const options: { waitUntil: "commit"; timeout: number } = {
            waitUntil: "commit",
            timeout: HISTORY_TIMEOUT_MS,
        };
        run.input();
        const response: unknown =
            action === ControlAction.GO_BACK
                ? await page.goBack(options)
                : await page.goForward(options);
        // `null` is also what a same-document (hash / pushState) history step
        // returns: a refusal only when the URL did not move either.
        if (response === null && page.url() === before) {
            const where: string =
                action === ControlAction.GO_BACK ? "back" : "forward";
            return `there is no page to go ${where} to; nothing was executed`;
        }
        await settleAfterAction(page, action);
        return undefined;
    }

    private async scroll(
        page: Page,
        action: ControlAction,
        run: ActionRun
    ): Promise<void> {
        const viewport: { width: number; height: number } =
            page.viewportSize() ??
            ((await page.evaluate((): { width: number; height: number } => ({
                width: innerWidth,
                height: innerHeight,
            }))) as { width: number; height: number });
        const delta: number = Math.round(
            viewport.height * SCROLL_VIEWPORT_RATIO
        );
        run.input();
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
        run.input();
        await page.mouse.wheel(
            0,
            action === ControlAction.SCROLL_DOWN ? delta : -delta
        );
        await settleAfterAction(page, action);
    }

    private async withHandle(
        target: ControlTarget,
        fn: (handle: ElementHandle<Element>) => Promise<void>
    ): Promise<void> {
        const handle: ElementHandle<Element> | null =
            await controlHandle(target);
        if (handle === null) {
            throw new Error(
                "control_act: the control disappeared during the action"
            );
        }
        try {
            await fn(handle);
        } finally {
            await handle.dispose().catch((): void => {});
        }
    }
}
