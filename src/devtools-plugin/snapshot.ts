import { pluginApi } from "./api";
import { raceDialog } from "./dialog-race";
import {
    ControlTarget,
    controlTarget,
    cutText,
    FrameControlRoute,
    frameControlId,
    FrameRead,
    framePointToPage,
    frameShownAt,
    readFrames,
    withTimeout,
} from "./frames";
import type { BrowserToolSessionContext, PendingDialog, RaceOutcome, TabInfo } from "./host";
import {
    controlRuntime,
    RuntimeControl,
    RuntimeLocateResult,
    RuntimeOperation,
    RuntimeRequest,
    RuntimeSnapshot,
} from "./runtime";
import { OVERLAY_HOST_ID } from "./overlay";
import { snapshotFrames } from "./settings";

import { createHash } from "node:crypto";

import type { ElementHandle, Frame, JSHandle, Page } from "playwright-core";
import type { ZodRawShape, ZodTypeAny } from "zod";


export const DEFAULT_MAX_CONTROLS: number = 250;
export const DEFAULT_MAX_TEXT_CHARS: number = 6000;

/** How long a snapshot keeps retrying through a navigation before giving up. */
const SNAPSHOT_NAVIGATION_BUDGET_MS: number = 5_000;
const SNAPSHOT_RETRY_DELAY_MS: number = 20;

/** After an action: two animation frames, capped at this. */
export const SETTLE_FRAME_BUDGET_MS: number = 50;
/** After typing into an autocomplete field: until options are visible, capped at this. */
export const SETTLE_AUTOCOMPLETE_BUDGET_MS: number = 200;
/** Then: until running animations that end within this (from the action) have ended. */
export const SETTLE_ANIMATION_BUDGET_MS: number = 1_000;
/** A frame's settle is bounded by its own budgets (plus this), not the 1 s of any other frame read. */
const SETTLE_TIMEOUT_SLACK_MS: number = 250;

export enum ControlOperation {
    CLICK = "click",
    FILL = "fill",
    SELECT = "select",
}

export interface ControlOption {
    value: string;
    label: string;
}

export interface Control {
    id: number;
    role: string;
    name: string;
    ops: ControlOperation[];
    value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
    /** A password field: offered for fill, its value never read. */
    password?: boolean;
    /** Password fields only: whether it holds anything — never what. */
    filled?: boolean;
    /** Nearby text, only for controls whose role + name repeat. */
    context?: string;
    options?: ControlOption[];
    /** A control inside an iframe (BROWSER_CONTROL_SNAPSHOT_FRAMES): the frame's host[:port]. */
    frame?: string;
}

export interface ControlSnapshot {
    snapshotId: number;
    url: string;
    title: string;
    text: string;
    controls: Control[];
    omittedControls: number;
    offscreenControls: number;
    canScrollUp: boolean;
    canScrollDown: boolean;
    /** Hash of everything observed; equal fingerprints mean nothing the model saw changed. */
    fingerprint: string;
    /**
     * Set while a native dialog is held open (BROWSER_DIALOG_MODE=hold): the
     * page is blocked behind it, so the snapshot is the dialog — its message
     * as the text, OK / Cancel (and a prompt's field) as the controls.
     */
    dialog?: { type: string; message: string };
    /** The session's open tabs, when there is more than one (BROWSER_FOLLOW_NEW_TABS). */
    tabs?: TabInfo[];
}

/** Of a dialog's message in the snapshot's `dialog` field (the page chooses it). */
const MAX_DIALOG_MESSAGE_CHARS: number = 2_000;

/** The controls of a dialog snapshot. */
export enum DialogControlId {
    OK = 1,
    CANCEL = 2,
    INPUT = 3,
}

export interface ControlSnapshotLimits {
    maxControls: number;
    maxTextChars: number;
}

/** What the session keeps of its latest snapshot to guard the next action. */
export interface StoredControlSnapshot {
    snapshot: ControlSnapshot;
    /** JSON of the page-side document key (a navigation changes it). */
    pageKey: string;
    /** JSON of each control's guard, by control id. */
    guards: Map<number, string>;
    /** The context each control's own document gave it (before a frame's label), by control id: its guard rechecks it. */
    contexts?: Map<number, string>;
    /** A dialog snapshot: the held dialog it shows. */
    dialogId?: number;
    /** Frame control id → its frame and runtime id (only this snapshot's routes are ever used). */
    frameControls?: Map<number, FrameControlRoute>;
    /** JSON of each read frame's document key, by frame slot. */
    framePageKeys?: Map<number, string>;
}

/** The schemas, built once DevTools' zod is at hand (the plugin API). */
let schemas: { snapshot: ZodRawShape; limits: ZodRawShape } | undefined;

function buildSchemas(): { snapshot: ZodRawShape; limits: ZodRawShape } {
    if (schemas) {
        return schemas;
    }
    const z: typeof import("zod").z = pluginApi().z;
    const controlOptionSchema: ZodTypeAny = z.object({
        value: z.string(),
        label: z.string(),
    });

    const controlSchema: ZodTypeAny = z.object({
        id: z.number().describe("Control id; pass as controlId."),
        role: z.string(),
        name: z.string(),
        ops: z.array(z.nativeEnum(ControlOperation)),
        value: z.string().optional(),
        checked: z.string().optional(),
        selected: z.string().optional(),
        expanded: z.string().optional(),
        password: z.boolean().optional(),
        filled: z
            .boolean()
            .optional()
            .describe("Password fields only: whether it holds anything."),
        context: z
            .string()
            .optional()
            .describe("Nearby text; only on controls whose role + name repeat."),
        options: z
            .array(controlOptionSchema)
            .optional()
            .describe("Selectable options of a native dropdown."),
        frame: z
            .string()
            .optional()
            .describe("Inside an iframe: the host of its document."),
    });

    // Shared by the snapshot tool and the act tool's `snapshot` field.
    const snapshotShape: ZodRawShape = {
        snapshotId: z.number().describe("Pass to the next action."),
        url: z.string(),
        title: z.string(),
        text: z.string().describe("Visible text in the viewport."),
        controls: z
            .array(controlSchema)
            .describe("Visible, enabled controls in the viewport."),
        omittedControls: z.number(),
        offscreenControls: z.number(),
        canScrollUp: z.boolean(),
        canScrollDown: z.boolean(),
        fingerprint: z.string(),
        dialog: z
            .object({ type: z.string(), message: z.string() })
            .optional()
            .describe(
                "A native dialog is open: the page is behind it. Answer it with its OK / Cancel controls."
            ),
        tabs: z
            .array(
                z.object({
                    index: z.number(),
                    url: z.string(),
                    title: z.string(),
                    active: z.boolean(),
                })
            )
            .optional()
            .describe(
                "Open tabs, when more than one; the active one is this snapshot."
            ),
    };

    const limitsShape: ZodRawShape = {
        maxControls: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .default(DEFAULT_MAX_CONTROLS)
            .describe("Max controls returned."),
        maxTextChars: z
            .number()
            .int()
            .min(0)
            .max(50_000)
            .optional()
            .default(DEFAULT_MAX_TEXT_CHARS)
            .describe("Max visible-text characters returned."),
    };
    schemas = { snapshot: snapshotShape, limits: limitsShape };
    return schemas;
}

/** Shared by the snapshot tool and the act tool's `snapshot` field. */
export function controlSnapshotShape(): ZodRawShape {
    return buildSchemas().snapshot;
}

export function controlSnapshotLimitsShape(): ZodRawShape {
    return buildSchemas().limits;
}

const SNAPSHOT_KEY: string = "control.snapshot";
const SEQ_KEY: string = "control.snapshotSeq";

/** The latest control snapshot of the page the tools act on (the page's state: gone with the page / tab). */
export function getControlSnapshot(context: BrowserToolSessionContext): StoredControlSnapshot | undefined {
    return context.pageState().get(SNAPSHOT_KEY) as StoredControlSnapshot | undefined;
}

export function setControlSnapshot(context: BrowserToolSessionContext, stored: StoredControlSnapshot): void {
    context.pageState().set(SNAPSHOT_KEY, stored);
}

/** Snapshot ids grow for the whole session. */
export function nextControlSnapshotId(context: BrowserToolSessionContext): number {
    const next: number = ((context.sessionState().get(SEQ_KEY) as number | undefined) ?? 0) + 1;
    context.sessionState().set(SEQ_KEY, next);
    return next;
}


export function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, ms);
    });
}

function isNavigationError(err: unknown): boolean {
    const message: string = err instanceof Error ? err.message : String(err);
    return /Execution context was destroyed|navigat|Cannot find context|Target closed|frame was detached/i.test(
        message
    );
}

/**
 * The runtime as an expression. Sent as a string with a no-op `__name`
 * binding: an esbuild build with keepNames (`scripts/build.js` has it on for
 * `dist/`; the plugin bundle turns it off) wraps inner functions in
 * `__name(...)`, a helper that does not exist in the page.
 */
const RUNTIME_SOURCE: string = `((__name) => (${controlRuntime.toString()}))((f) => f)`;

/** Runs the page-side runtime; the only way this module runs the runtime in the page. */
function runRuntime(target: Page | Frame, req: RuntimeRequest): Promise<unknown> {
    return target.evaluate(`${RUNTIME_SOURCE}(${JSON.stringify(req)})`);
}

function fingerprint(marker: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(marker))
        .digest("hex")
        .slice(0, 16);
}

async function readRuntimeSnapshot(
    page: Page,
    limits: ControlSnapshotLimits
): Promise<RuntimeSnapshot> {
    const deadline: number = Date.now() + SNAPSHOT_NAVIGATION_BUDGET_MS;
    for (;;) {
        try {
            const result: RuntimeSnapshot | null = (await runRuntime(page, {
                op: "snapshot",
                maxControls: limits.maxControls,
                maxTextChars: limits.maxTextChars,
            })) as RuntimeSnapshot | null;
            if (result !== null) {
                return result;
            }
        } catch (err: unknown) {
            if (!isNavigationError(err) || Date.now() >= deadline) {
                throw err;
            }
        }
        if (Date.now() >= deadline) {
            throw new Error(
                "The page did not settle: no document to snapshot. Try again."
            );
        }
        await page
            .waitForLoadState("domcontentloaded", {
                timeout: Math.max(1, deadline - Date.now()),
            })
            .catch((): void => {});
        await sleep(SNAPSHOT_RETRY_DELAY_MS);
    }
}

/**
 * Reads the page in one evaluation, stores the guard state on the session and
 * returns the snapshot. Retries through a navigation that is still committing.
 */
export async function takeControlSnapshot(
    context: BrowserToolSessionContext,
    limits: ControlSnapshotLimits
): Promise<ControlSnapshot> {
    // A tab an action just opened: the snapshot is of it, once it is the
    // page. A switch landing mid-read would mix one tab's snapshot with the
    // other's tab list: read again (bounded).
    let snapshot: ControlSnapshot;
    for (let attempt: number = 0; ; attempt++) {
        await context.tabsSettled();
        const generation: number = context.tabGeneration();
        snapshot = await takeSnapshotOnce(context, limits);
        if (generation === context.tabGeneration() || attempt >= 2) {
            break;
        }
    }
    // This snapshot is of the active tab: decisions on it are current again.
    context.takeTabSwitched();
    if (context.tabCount() > 1) {
        snapshot.tabs = await context.tabs();
    }
    return snapshot;
}

async function takeSnapshotOnce(
    context: BrowserToolSessionContext,
    limits: ControlSnapshotLimits,
    retried: boolean = false
): Promise<ControlSnapshot> {
    const held: PendingDialog | undefined = context.heldDialog();
    if (held !== undefined) {
        return dialogSnapshot(context, held, limits);
    }
    // One page for the whole read: a tab switch mid-read must not mix tabs.
    const page: Page = context.page;
    // A dialog may open while the page is read (a timer, an onload handler):
    // the read then waits for it, so the dialog is shown instead.
    const read: RaceOutcome<RuntimeSnapshot> = await raceDialog(
        context.dialogs(),
        readRuntimeSnapshot(page, limits)
    );
    if (read.dialog) {
        return afterDialogRace(context, limits, retried);
    }
    const main: RuntimeSnapshot = read.value;
    // The page's iframes (opt-in): read after the page, merged into one view.
    let frames: FrameRead[] = [];
    if (snapshotFrames()) {
        const framesRead: RaceOutcome<FrameRead[]> = await raceDialog(
            context.dialogs(),
            readFrames(
                page,
                runRuntime,
                {
                    op: "snapshot",
                    maxControls: limits.maxControls,
                    maxTextChars: limits.maxTextChars,
                },
                main.viewport
            )
        );
        if (framesRead.dialog) {
            return afterDialogRace(context, limits, retried);
        }
        frames = framesRead.value;
    }
    const merged: MergedSnapshot = mergeFrames(main, frames, limits);
    const raw: RuntimeSnapshot = merged.raw;
    const snapshot: ControlSnapshot = {
        snapshotId: nextControlSnapshotId(context),
        url: raw.url,
        title: raw.title,
        text: raw.text,
        controls: raw.controls.map(
            (c: RuntimeControl): Control => ({
                ...c,
                ops: c.ops.map(
                    (op: RuntimeOperation): ControlOperation =>
                        op as ControlOperation
                ),
            })
        ),
        omittedControls: raw.omittedControls,
        offscreenControls: raw.offscreenControls,
        canScrollUp: raw.scroll.y > 0,
        canScrollDown:
            raw.scroll.y + raw.viewport.height < raw.scroll.height - 2,
        fingerprint: fingerprint(raw.marker),
    };
    const guards: Map<number, string> = new Map();
    for (const [id, guard] of Object.entries(raw.guards)) {
        guards.set(Number(id), JSON.stringify(guard));
    }
    setControlSnapshot(context, {
        snapshot,
        pageKey: JSON.stringify(main.pageKey),
        guards,
        contexts: merged.contexts,
        ...(frames.length > 0
            ? {
                frameControls: merged.routes,
                framePageKeys: new Map(
                    frames.map((f: FrameRead): [number, string] => [
                        f.route.slot,
                        JSON.stringify(f.raw.pageKey),
                    ])
                ),
            }
            : {}),
    });
    return snapshot;
}

/** Of each frame's text; all frames' text together takes at most a third of the budget. */
const FRAME_TEXT_CHARS: number = 800;
/** A frame's text is cut to fit only when at least this much of it would show. */
const MIN_FRAME_TEXT_CHARS: number = 120;

interface MergedSnapshot {
    raw: RuntimeSnapshot;
    /** Frame control id → its frame and runtime id. */
    routes: Map<number, FrameControlRoute>;
    /** Control id → the context its own document gave it. */
    contexts: Map<number, string>;
}

/**
 * The page and its frames as one runtime snapshot: frame controls under their
 * frame ids (routed by the returned map) and tagged with the frame's host,
 * `[frame: …]` text sections after the page's (within a third of the same
 * budget; each added whole, or cut only when at least 120 chars of it fit),
 * guards and the fingerprint's marker over all of them. Without
 * frames it is the page's own snapshot, unchanged.
 */
function mergeFrames(
    main: RuntimeSnapshot,
    frames: FrameRead[],
    limits: ControlSnapshotLimits
): MergedSnapshot {
    const routes: Map<number, FrameControlRoute> = new Map();
    const contexts: Map<number, string> = new Map();
    for (const c of main.controls) {
        if (c.context !== undefined) {
            contexts.set(c.id, c.context);
        }
    }
    if (frames.length === 0) {
        return { raw: main, routes, contexts };
    }
    const textBudget: number = Math.floor(limits.maxTextChars / 3);
    let framesText: string = "";
    for (const f of frames) {
        const body: string = cutText(f.raw.text.trim(), FRAME_TEXT_CHARS);
        if (!body) {
            continue;
        }
        const header: string = `\n\n[frame: ${f.route.label}]\n`;
        const room: number = textBudget - framesText.length - header.length;
        // A section is added whole, or cut only when a useful part of it fits.
        if (room < Math.min(body.length, MIN_FRAME_TEXT_CHARS)) {
            break;
        }
        framesText += header + cutText(body, room);
    }
    const controls: RuntimeControl[] = [...main.controls];
    const guards: Record<string, unknown> = { ...main.guards };
    let omitted: number = main.omittedControls;
    let offscreen: number = main.offscreenControls;
    for (const f of frames) {
        for (const c of f.raw.controls) {
            const id: number | undefined = frameControlId(f.route.slot, c.id);
            if (id === undefined || controls.length >= limits.maxControls) {
                omitted++;
                continue;
            }
            routes.set(id, { route: f.route, local: c.id });
            if (c.context !== undefined) {
                contexts.set(id, c.context);
            }
            const guard: unknown = f.raw.guards[String(c.id)];
            if (guard !== undefined) {
                guards[String(id)] = guard;
            }
            controls.push({
                ...c,
                id,
                frame: f.route.host,
                context: `in frame: ${f.route.label}${c.context ? `; ${c.context}` : ""}`,
            });
        }
        omitted += f.raw.omittedControls;
        offscreen += f.raw.offscreenControls;
    }
    return {
        raw: {
            ...main,
            text:
                cutText(
                    main.text,
                    Math.max(0, limits.maxTextChars - framesText.length)
                ) + framesText,
            controls,
            omittedControls: omitted,
            offscreenControls: offscreen,
            guards,
            marker: [
                main.marker,
                ...frames.map((f: FrameRead): unknown => [
                    f.route.host,
                    f.raw.marker,
                ]),
            ],
        },
        routes,
        contexts,
    };
}

/**
 * A read overtaken by a dialog. It may be another tab's (tabs opened from one
 * another share a renderer, so it stops this page too): the session brings
 * that tab to the front, and the snapshot is of the dialog there. A dialog
 * already answered (by a timeout, another call, its page closing) is read
 * past, once.
 */
async function afterDialogRace(
    context: BrowserToolSessionContext,
    limits: ControlSnapshotLimits,
    retried: boolean
): Promise<ControlSnapshot> {
    await context.tabsSettled();
    const opened: PendingDialog | undefined = context.dialogs().pending();
    if (opened !== undefined) {
        return dialogSnapshot(context, opened, limits);
    }
    if (context.dialogs().disposed) {
        throw new Error("The browser session closed.");
    }
    if (retried) {
        throw new Error(
            "Dialogs kept interrupting the page read; take the snapshot again."
        );
    }
    return takeSnapshotOnce(context, limits, true);
}

/**
 * The snapshot of a held dialog: nothing of the page can be read behind it.
 * Its message is the text; OK (and Cancel, but for an alert) are the controls,
 * plus the field of a prompt, holding what was typed into it so far.
 */
function dialogSnapshot(
    context: BrowserToolSessionContext,
    dialog: PendingDialog,
    limits: ControlSnapshotLimits
): ControlSnapshot {
    const promptText: string | undefined =
        context.dialogs().promptText() ?? dialog.defaultValue;
    const controls: Control[] = [
        {
            id: DialogControlId.OK,
            role: "button",
            name: "OK",
            ops: [ControlOperation.CLICK],
        },
    ];
    if (dialog.type !== "alert") {
        controls.push({
            id: DialogControlId.CANCEL,
            role: "button",
            name: "Cancel",
            ops: [ControlOperation.CLICK],
        });
    }
    if (dialog.type === "prompt") {
        controls.push({
            id: DialogControlId.INPUT,
            role: "textbox",
            name: "Dialog input",
            ops: [ControlOperation.FILL],
            ...(promptText !== undefined ? { value: promptText } : {}),
        });
    }
    const previous: ControlSnapshot | undefined =
        getControlSnapshot(context)?.snapshot;
    const url: string = context.page.url();
    const snapshot: ControlSnapshot = {
        snapshotId: nextControlSnapshotId(context),
        url,
        title: previous?.url === url ? previous.title : "",
        // The page chooses the message: bounded like any page text.
        text: `A ${dialog.type} dialog is open: ${dialog.message}`.slice(
            0,
            limits.maxTextChars
        ),
        controls,
        omittedControls: 0,
        offscreenControls: 0,
        canScrollUp: false,
        canScrollDown: false,
        fingerprint: fingerprint(["dialog", dialog.id, promptText]),
        dialog: {
            type: dialog.type,
            message: dialog.message.slice(0, MAX_DIALOG_MESSAGE_CHARS),
        },
    };
    setControlSnapshot(context, {
        snapshot,
        pageKey: `dialog:${dialog.id}`,
        guards: new Map(),
        dialogId: dialog.id,
    });
    return snapshot;
}

/** Where a control of the stored snapshot lives — resolved once per action; undefined when its frame has gone. */
export function resolveControl(
    page: Page,
    stored: StoredControlSnapshot | undefined,
    controlId: number
): ControlTarget | undefined {
    return controlTarget(page, stored?.frameControls, controlId);
}

/**
 * Whether the target is as the snapshot saw it: the
 * document (a navigation makes a new one) and the control itself: the same
 * element, meaning the same thing — role, name, value, state, link target,
 * and for identical controls the context that told them apart. Nothing else
 * on the page counts: a field, a ticker or an ad added or changed elsewhere,
 * the address changing in place, a scroll — none of them change what the
 * decision was about. Where the control is now is read and hit-tested after.
 */
export async function isControlFresh(
    stored: StoredControlSnapshot,
    target: ControlTarget,
    controlId: number
): Promise<boolean> {
    const expected: string | undefined = stored.guards.get(controlId);
    if (expected === undefined) {
        return false;
    }
    const expectedKey: string | undefined =
        target.route === undefined
            ? stored.pageKey
            : stored.framePageKeys?.get(target.route.slot);
    let current: unknown;
    try {
        const read: unknown = runInTarget(target, {
            op: "guard",
            id: target.local,
            context: stored.contexts?.get(controlId),
        });
        current = await read;
        if (current === undefined) {
            return false;
        }
    } catch (err: unknown) {
        if (isNavigationError(err)) {
            return false;
        }
        throw err;
    }
    const [pageKey, guard] = current as [unknown, unknown];
    return (
        JSON.stringify(pageKey) === expectedKey &&
        JSON.stringify(guard) === expected
    );
}

/** Current center of the control on the page, after visibility / enabled / occlusion checks. */
export async function locateControl(
    target: ControlTarget,
    kind: ControlOperation,
    value?: string
): Promise<RuntimeLocateResult> {
    try {
        const located: RuntimeLocateResult | undefined = (await runInTarget(target, {
            op: "locate",
            id: target.local,
            kind: kind as RuntimeOperation,
            value,
            // Only a frame's control is checked again on the page, after this.
            ...(target.route !== undefined ? { keepUnscroll: true } : {}),
        })) as RuntimeLocateResult | undefined;
        if (located === undefined) {
            return { error: "the frame did not answer" };
        }
        if (
            target.route === undefined ||
            located.error !== undefined ||
            located.x === undefined ||
            located.y === undefined
        ) {
            return located;
        }
        const onPage: RuntimeLocateResult = await pointOnPage(target, located);
        if (onPage.error !== undefined) {
            // Refused on the page after the frame scrolled a list to the
            // target: nothing is executed, so the list is put back.
            await runInTarget(target, { op: "unscroll" });
        }
        return onPage;
    } catch (err: unknown) {
        if (isNavigationError(err)) {
            return { error: "the page navigated" };
        }
        throw err;
    }
}

/**
 * A frame control's point, on the page: through the frame's content box and
 * scale, and only when the page shows the frame at that point.
 */
async function pointOnPage(
    target: ControlTarget,
    located: RuntimeLocateResult
): Promise<RuntimeLocateResult> {
    const point: { x: number; y: number } | undefined = await framePointToPage(
        target.route!,
        located.x!,
        located.y!
    );
    if (point === undefined) {
        return { error: "the frame is not rendered" };
    }
    if (!(await frameShownAt(target.route!, point.x, point.y))) {
        return {
            error: "the frame is covered or outside the viewport there",
        };
    }
    return { ...located, x: point.x, y: point.y };
}

/**
 * Selects the focused field's contents (in the control's own document) so the next insert replaces
 * them — false when focus is on another field the page showed than the target (the caller then
 * fills the target itself).
 */
export async function selectAllInFocusedField(
    target: ControlTarget
): Promise<boolean> {
    try {
        return (
            (await runInTarget(target, { op: "select-all", id: target.local })) ===
            true
        );
    } catch {
        return false;
    }
}

/** A handle on the observed element itself — never re-resolved by selector. */
export async function controlHandle(
    target: ControlTarget
): Promise<ElementHandle<Element> | null> {
    const work: Promise<JSHandle> = target.runner.evaluateHandle(
        (id: number): unknown => {
            const cache: any = (window as any)[
                Symbol.for("ironbee.devtools.controls")
            ];
            const e: Element | undefined = cache?.nodes.get(id);
            return e && e.isConnected ? e : null;
        },
        target.local
    );
    const handle: JSHandle | undefined =
        target.route === undefined
            ? await work
            : await withTimeout(work, undefined, (late: JSHandle): void => {
                late.dispose().catch((): void => {});
            });
    if (handle === undefined) {
        return null;
    }
    const element: ElementHandle<Element> | null =
        handle.asElement() as ElementHandle<Element> | null;
    if (element === null) {
        await handle.dispose();
    }
    return element;
}

/**
 * Waits briefly for the page to reflect the action: two animation frames, or
 * until autocomplete options appear after typing — in the control's own
 * document. Read-only, and never fails the action — a navigation
 * interrupting it is expected.
 */
export async function settleAfterAction(
    page: Page,
    kind: string,
    target?: ControlTarget
): Promise<void> {
    try {
        await runInTarget(
            target ?? { runner: page, local: 0 },
            {
                op: "settle",
                id: target?.local,
                kind,
                frameBudgetMs: SETTLE_FRAME_BUDGET_MS,
                autocompleteBudgetMs: SETTLE_AUTOCOMPLETE_BUDGET_MS,
                animationBudgetMs: SETTLE_ANIMATION_BUDGET_MS,
                skipHostId: OVERLAY_HOST_ID,
            },
            SETTLE_FRAME_BUDGET_MS +
                SETTLE_AUTOCOMPLETE_BUDGET_MS +
                SETTLE_ANIMATION_BUDGET_MS +
                SETTLE_TIMEOUT_SLACK_MS
        );
    } catch {
        // A navigation destroyed the context; the next snapshot waits for it.
    }
}

/**
 * The runtime in the control's document: a frame's bounded in time — the
 * frame read's default, or `timeoutMs` for an op with a longer budget of its
 * own (undefined when it did not answer).
 */
function runInTarget(target: ControlTarget, req: RuntimeRequest, timeoutMs?: number): Promise<unknown> {
    return target.route === undefined
        ? runRuntime(target.runner, req)
        : withTimeout(runRuntime(target.runner, req), timeoutMs);
}
