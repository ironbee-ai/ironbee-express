/**
 * The loop: observe → decide → act, where acting returns the next observation
 * in the same DevTools call. One engine request and one DevTools call per
 * step; a stale refusal costs no extra call because it carries a fresh
 * snapshot to decide on. With a goal judge, DONE is accepted only when the
 * engine sees the goal done on the page and the API responses.
 */

import { DEFAULT_LIMITS, DevtoolsClient, NetworkWait } from "../devtools/client";
import { ActRequest, ActResult, Control, ControlAction, ControlSnapshot, SnapshotLimits } from "../devtools/types";
import { describeTarget, TargetDescriptor } from "../scenario/descriptor";
import { maskSecretsEncoded, textRefOf, visibleText, withoutText } from "../text/mask";
import { TextImage } from "../text/providers";
import { FieldContext, TextChoice, TextRef, TextSource, TextStrategy } from "../text/types";
import { describeApiResponses } from "../verify/describe";
import { describeNow, EVIDENCE_MAX_CHARS, readEvidence, ReadEvidence } from "../verify/evidence";
import { GoalJudge } from "../verify/goal";
import { Journey, JourneyRecorder } from "../verify/journey";
import { GoalJudgement, GoalState } from "../verify/types";
import { DEFAULT_MAX_ACTIONS, DEFAULT_MAX_DECISIONS } from "./budgets";
import { Decider, Decision, DecisionInput, describeControl, FieldTextChoice, HistoryEntry, Operation, UserActionKind } from "./policy";
import { MAX_TAKEOVERS, Takeover, TakeoverEnd, TakeoverLook, TakeoverLooks, TakeoverSession, TakeoverStep } from "./rescue";

export { DEFAULT_MAX_ACTIONS, DEFAULT_MAX_DECISIONS } from "./budgets";

/** This many executed actions in a row that changed nothing observable → blocked. */
const MAX_UNCHANGED_ACTIONS: number = 3;
const MAX_CONSECUTIVE_REFUSALS: number = 5;
const MAX_CONSECUTIVE_WAITS: number = 10;
/** A DONE the goal judge rejects this many times ends the run as FAILED. */
const MAX_DONE_REJECTIONS: number = 3;
/** A run hands the browser to its user at most this often; more is a loop, not a login. */
const MAX_USER_ACTIONS: number = 5;
/** The same action on the same page this often is a loop: the run is blocked. */
const MAX_REPEATED_ACTIONS: number = 3;
/**
 * With a text model, this many executed actions in a row that reach no page state the run has not
 * been in (going round through pages it has seen) hand it the controls. Without one the run goes on:
 * this check only calls the rescuer, it never ends a run.
 */
const MAX_ACTIONS_WITHOUT_NEW_STATE: number = 10;
/**
 * The share of the action and decision budgets the engine uses before a text model takes the
 * controls: the rest is the model's room to get the run past what the engine could not.
 */
const ENGINE_BUDGET_SHARE: number = 0.75;
/**
 * After an action, the requests it started are waited for (up to the bound) before the page is
 * observed, so a list loaded from an API is on the snapshot the next decision reads. DevTools does
 * it inside the act (`waitForNetworkMs`); an older one gets a separate wait and a second look.
 * A site whose bound runs out (it keeps polling) is not waited for again in the run.
 */
export const QUIET_TIMEOUT_MS: number = 1_500;
const QUIET_IDLE_MS: number = 50;

/** A pause for the person running the test. */
export interface UserActionRequest {
    step: number;
    kind: UserActionKind;
    /** What to do, for the person. */
    prompt: string;
    /** ENTER_VALUE: the field to fill. */
    field?: string;
    url: string;
}

/** Resolves true when the user is done (the run continues), false to stop the run. */
export type AskUser = (request: UserActionRequest) => Promise<boolean>;

/** What the person is asked to do. Generic on purpose: the page says the rest. */
export function userPrompt(kind: UserActionKind, field?: string): string {
    switch (kind) {
        case UserActionKind.SIGN_IN:
            return "Sign in on the page (a third-party, social or single sign-on login), then continue.";
        case UserActionKind.VERIFY:
            return "Complete the check on the page (a CAPTCHA, a verification code, a confirmation), then continue.";
        case UserActionKind.ENTER_VALUE:
            return `Type a value into ${field ?? "the field"}, then continue.`;
        case UserActionKind.OTHER:
            return "Do the step on the page that needs a person, then continue.";
    }
}

export enum RunStatus {
    DONE = "done",
    BLOCKED = "blocked",
    BUDGET = "budget",
    /** The policy chose DONE, but the evidence kept not showing the goal done. */
    FAILED = "failed",
    /** Stopped by the caller. */
    CANCELLED = "cancelled",
}

/** Who decided a step: the decision engine, or a scenario recording being replayed. */
export enum StepMode {
    ENGINE = "engine",
    REPLAY = "replay",
    /** The engine was stuck; a text model had the controls and took this step (rescue.ts). */
    RESCUE = "rescue",
}

/**
 * The text model at the controls, as it happens: it took over (the UI says so while it works),
 * looked at something, then handed back or confirmed the goal done — or gave up.
 */
export enum RescueState {
    ASKING = "asking",
    LOOKING = "looking",
    ANSWERED = "answered",
    NONE = "none",
}

export interface RescueEvent {
    state: RescueState;
    /** The step the help is for. */
    step: number;
    /** `provider/model`. */
    model: string;
    /** Why the engine was stuck. */
    stuck: string;
    /** ANSWERED / NONE: how long the model had the controls. */
    ms?: number;
    /** LOOKING: the tool it used (snapshot, screenshot …). */
    action?: string;
    /** The model's reason for what it did. */
    why?: string;
    /** ANSWERED: how it ended — handed back (resolved) or the goal confirmed done. */
    end?: TakeoverEnd;
    /** NONE: why it could not get past it (it gave up, or an error). */
    error?: string;
}

export interface StepEvent {
    step: number;
    mode: StepMode;
    elapsedMs: number;
    operation: Operation;
    confidence: number;
    decisionMs: number;
    operationProbabilities: Record<string, number>;
    /** The chosen operation's target head, label → probability, most probable first (top 5). */
    targetTop?: Array<{ label: string; probability: number }>;
    target?: string;
    /** As history/logs may see it: secrets by name only. */
    text?: string;
    /** Where the text came from (value, secret, goal literal, the text model — as generator or at the controls …). */
    textSource?: TextSource;
    /** GENERATE: how long the text model took to write it. */
    textMs?: number;
    /** GENERATE: the text written for the attempt just before, which the page change refused. */
    textReused?: boolean;
    /** The target as a recording keeps it. */
    targetDescriptor?: TargetDescriptor;
    /**
     * REPLAY: the page changed around the recorded control (as recorded: `from`), and the engine
     * found it again (`decisionMs` is its question's time); `targetDescriptor` is the control's new one.
     */
    reidentified?: { from: string; probability: number };
    /** The typed value as a recording keeps it (secrets by name). */
    textRef?: TextRef;
    /** SELECT: the chosen option's label. */
    optionLabel?: string;
    /** PRESS_KEY: the key. */
    key?: string;
    /** SWITCH_TAB: the tab's index. */
    tab?: number;
    /** SWITCH_TAB: the tab's address (origin + path), for a replay to find it by. */
    tabUrl?: string;
    executed: boolean;
    reason?: string;
    actMs?: number;
    url: string;
    pageChanged?: boolean;
    /** DONE: whether the engine saw the goal done on the evidence. */
    goal?: GoalJudgement;
    /** ASK_USER: what the user was asked, and how long they took (not counted in elapsedMs). */
    userAction?: { kind: UserActionKind; prompt: string; waitMs: number };
    /** RESCUE: the text model that chose the step, why the engine was stuck, and the model's reason. */
    rescue?: { model: string; stuck: string; why: string };
}

export interface RunResult {
    status: RunStatus;
    reason?: string;
    elapsedMs: number;
    actions: number;
    decisions: number;
    steps: StepEvent[];
    finalSnapshot: ControlSnapshot;
    /** The last goal judgement at DONE (with a goal judge). */
    goal?: GoalJudgement;
    /** The steps taken and the pages visited (secrets masked): what the goal is judged on besides the final page. */
    journey?: Journey;
}

export interface AgentOptions {
    client: DevtoolsClient;
    decider: Decider;
    goal: string;
    /** Navigate here first; else start from the session's current page. */
    url?: string;
    text: TextStrategy;
    limits?: SnapshotLimits;
    maxActions?: number;
    maxDecisions?: number;
    /** Judges a DONE on the page and the API responses; a DONE it does not bear out is rejected. */
    goalJudge?: GoalJudge;
    signal?: AbortSignal;
    onStep?: (event: StepEvent) => void;
    /** A person to hand the browser to (ASK_USER); without one the engine is not offered it. */
    askUser?: AskUser;
    /** What already happened (a replayed prefix this run continues from). */
    initialHistory?: HistoryEntry[];
    /** Step numbers continue after this many earlier steps. */
    stepOffset?: number;
    /** The journey so far (a replayed prefix this run continues from). */
    initialJourney?: Journey;
    /** Network evidence counts from here (default: this run's start). */
    evidenceSinceMs?: number;
    /** Step times continue after this much earlier run time. */
    elapsedOffsetMs?: number;
    /** Hand-overs already made in this run (a replayed prefix's): they count toward the run's limit. */
    initialUserActions?: number;
    /**
     * Every secret is a password (drawn as dots in a password input): the text model may be offered
     * screenshots. Each one is still refused while the page shows a secret (a password revealed, or
     * typed into a plain field — after which none is taken for the rest of the run).
     */
    screenshotSafe?: boolean;
    /** The run's clock starts (after the first observation): what `elapsedMs` counts from. Not called when continuing a clock (`elapsedOffsetMs`). */
    onClockStart?: () => void;
    /** A text model that takes the controls when the engine is stuck (at most MAX_TAKEOVERS times a run). */
    takeover?: Takeover;
    /** The rescue as it happens. */
    onRescue?: (event: RescueEvent) => void;
}

const ACTION_OF: Partial<Record<Operation, ControlAction>> = {
    [Operation.CLICK]: ControlAction.CLICK,
    [Operation.TYPE_TEXT]: ControlAction.FILL,
    [Operation.SELECT]: ControlAction.SELECT,
    [Operation.PRESS_ENTER]: ControlAction.PRESS_ENTER,
    [Operation.SCROLL_DOWN]: ControlAction.SCROLL_DOWN,
    [Operation.SCROLL_UP]: ControlAction.SCROLL_UP,
    [Operation.WAIT]: ControlAction.WAIT,
    [Operation.HOVER]: ControlAction.HOVER,
    [Operation.PRESS_KEY]: ControlAction.PRESS_KEY,
    [Operation.GO_BACK]: ControlAction.GO_BACK,
    [Operation.GO_FORWARD]: ControlAction.GO_FORWARD,
    [Operation.SWITCH_TAB]: ControlAction.SWITCH_TAB,
    [Operation.CLOSE_TAB]: ControlAction.CLOSE_TAB,
};

interface TypedText {
    text: string;
    shown: string;
    source: TextSource;
    ref: TextRef;
    /** GENERATE: how long the text model took. */
    generatedMs?: number;
    /** GENERATE: written for an attempt the page change refused, and typed now without a new call. */
    reused?: boolean;
}

/** A field's identity across snapshots, as a recording names it (ids change between snapshots). */
function fieldKey(control: Control, page: ControlSnapshot): string {
    return JSON.stringify(describeTarget(control, page));
}

/**
 * Whether the page carries a secret where a screenshot would show it: a value of the run's in the
 * snapshot (a revealed password, a secret typed into a plain field), or DevTools' own mask marker
 * — in seeded mode DevTools masks the snapshot at the source, so the marker is what is left of it.
 */
function pageShowsSecret(page: ControlSnapshot, secrets: Record<string, string>): boolean {
    const raw: string = JSON.stringify(page);
    return raw.includes("[secret:") || raw !== JSON.stringify(maskSecretsEncoded(page, secrets));
}

/**
 * The real value of the option `masked` names on a masked control: masking maps a control's
 * options one for one, so the option at the same index of the same control on the raw page.
 */
function rawOptionValue(control: Control | undefined, raw: ControlSnapshot, masked: string): string {
    const index: number = control?.options?.findIndex((o: { value: string }): boolean => o.value === masked) ?? -1;
    const rawControl: Control | undefined = raw.controls.find((c: Control): boolean => c.id === control?.id);
    return (index >= 0 ? rawControl?.options?.[index]?.value : undefined) ?? masked;
}

/** A tab's address without query or fragment: stable enough to find it again. */
export function tabAddress(page: ControlSnapshot, index: number): string | undefined {
    const url: string | undefined = page.tabs?.find((t: { index: number }): boolean => t.index === index)?.url;
    if (url === undefined) {
        return undefined;
    }
    try {
        const u: URL = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return url;
    }
}

export function originOf(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return url;
    }
}

/**
 * What the page SAYS: address, title, text and each control's role, name and
 * state — not DevTools' fingerprint, which also changes with the document's
 * identity. Progress is measured on this: a click that reloads the very same
 * page changed nothing the goal can use.
 */
export function pageContentKey(page: ControlSnapshot): string {
    return JSON.stringify([
        page.url,
        page.title,
        page.text,
        page.controls.map((c: Control): unknown[] => [c.role, c.name, c.context, c.value, c.checked, c.selected, c.expanded, c.filled]),
        // A tab opening or closing is a change too.
        (page.tabs ?? []).map((t: { url: string; active: boolean }): string => `${t.active ? "*" : ""}${t.url}`),
    ]);
}

/**
 * Where the run is, coarser than pageContentKey: the address without its fragment and the controls
 * by role and name — not the text or the values, which change on their own (prices, counters, ads)
 * and would make every return to a page look like a new one.
 */
export function pageStateKey(page: ControlSnapshot): string {
    return JSON.stringify([
        page.url.split("#")[0],
        [...new Set(page.controls.map((c: Control): string => `${c.role} ${c.name}`))].sort(),
    ]);
}

function topTargets(decision: Decision): Array<{ label: string; probability: number }> | undefined {
    if (!decision.targetProbabilities) {
        return undefined;
    }
    return Object.entries(decision.targetProbabilities)
        .sort((a: [string, number], b: [string, number]): number => b[1] - a[1])
        .slice(0, 5)
        .map(([key, probability]: [string, number]): { label: string; probability: number } => ({
            label: decision.targetLabels?.[key] ?? key,
            probability,
        }));
}

export class Agent {
    private readonly options: AgentOptions;
    private readonly limits: SnapshotLimits;
    /** What the decider gets: the same choices without their text. */
    private readonly policyChoices: TextChoice[];
    /**
     * The last text the text model wrote, until it is typed. A TYPE_TEXT refused because the page
     * changed under it (an autocomplete opening, a banner) is usually chosen again at once for the
     * same field: the text is not written twice.
     */
    private pendingText?: { key: string; typed: TypedText };
    /**
     * A secret was typed into a field that shows it (not a password input): from then on the
     * screen may carry it, and the text model gets no screenshot for the rest of the run.
     */
    private secretShown: boolean = false;
    /**
     * The last text this run typed into each field, by the field's recording identity (role, name,
     * context, position: ids change between snapshots). Typing replaces a field's contents, so a
     * second value typed into a field that still holds the first is settled first (settleFieldText).
     */
    private readonly typedInto: Map<string, TypedText> = new Map();

    constructor(options: AgentOptions) {
        if (!options.goal.trim()) {
            throw new Error("A goal is required");
        }
        this.options = options;
        this.limits = options.limits ?? DEFAULT_LIMITS;
        this.policyChoices = withoutText(options.text.choices);
    }

    async run(): Promise<RunResult> {
        const { client, decider, goal } = this.options;
        const secrets: Record<string, string> = this.options.text.secrets;
        const maxActions: number = this.options.maxActions ?? DEFAULT_MAX_ACTIONS;
        const maxDecisions: number = this.options.maxDecisions ?? DEFAULT_MAX_DECISIONS;
        // Network evidence is read from here on: the run's own traffic only.
        const runStartedAtMs: number = this.options.evidenceSinceMs ?? Date.now();
        if (this.options.url) {
            await client.navigate(this.options.url);
        }
        let snapshot: ControlSnapshot = await client.snapshot(this.limits);
        // What the goal is judged on besides the final page; page text masked as the decider sees it.
        const journey: JourneyRecorder = new JourneyRecorder(this.options.initialJourney);
        const see: (page: ControlSnapshot) => void = (page: ControlSnapshot): void =>
            journey.see(maskSecretsEncoded({ url: page.url, title: page.title, text: page.text, dialog: page.dialog }, secrets));
        see(snapshot);
        // The page's address as an event carries it: a GET form typed a secret into puts the value in it.
        // A URL carries a typed value encoded (`p%40ss+word`), so the encoded forms are masked too.
        const shownUrl: () => string = (): string => maskSecretsEncoded(snapshot.url, secrets);
        // Timing starts after the initial observation: navigation and page load are not the agent's time.
        const started: number = performance.now();
        const elapsedOffsetMs: number = this.options.elapsedOffsetMs ?? 0;
        // The user's time is theirs: pauses do not count as the run's.
        let pausedMs: number = 0;
        const elapsed: () => number = (): number => Math.round(performance.now() - started - pausedMs) + elapsedOffsetMs;
        if (this.options.elapsedOffsetMs === undefined) {
            this.options.onClockStart?.();
        }
        const history: HistoryEntry[] = [...(this.options.initialHistory ?? [])];
        const stepOffset: number = this.options.stepOffset ?? 0;
        const steps: StepEvent[] = [];
        let actions: number = 0;
        let decisions: number = 0;
        let unchanged: number = 0;
        let refusals: number = 0;
        let waits: number = 0;
        let rejections: number = 0;
        let userActions: number = this.options.initialUserActions ?? 0;
        // History, as GO_BACK / GO_FORWARD are offered: the URLs the run has been on, and
        // whether the last navigation was a GO_BACK (the page left is ahead).
        const seenUrls: Set<string> = new Set([snapshot.url]);
        let wentBack: boolean = false;
        // How often each action was taken on each page (the loop guard).
        const repeats: Map<string, number> = new Map();
        // The text model at the controls while the engine is stuck: its session, why, and how the run
        // would have ended without it (no status: it would have gone on — the model was called early).
        let takeovers: number = 0;
        let atControls: { session: TakeoverSession; stuck: string; status?: RunStatus; since: number } | undefined;
        // Origins that never go quiet: not waited for again.
        const busyOrigins: Set<string> = new Set();
        // Progress: the page states the run has been in, and the actions since it reached a new one.
        const states: Set<string> = new Set([pageStateKey(snapshot)]);
        let sinceNewState: number = 0;
        // The engine's share of the budgets, then the whole: each, once reached, calls the text model.
        // At least one, so the engine acts before the text model is ever called (`--max-actions 1`).
        const engineActions: number = Math.max(1, Math.floor(maxActions * ENGINE_BUDGET_SHARE));
        const engineDecisions: number = Math.max(1, Math.floor(maxDecisions * ENGINE_BUDGET_SHARE));
        let engineBudgetSpent: boolean = false;

        const emit: (event: StepEvent) => void = (event: StepEvent): void => {
            steps.push(event);
            journey.step(event);
            this.options.onStep?.(event);
        };
        let lastGoal: GoalJudgement | undefined;
        /** The goal judged on a fresh read; the fresh snapshot becomes the current one. */
        const judgeGoal: () => Promise<GoalJudgement> = async (): Promise<GoalJudgement> => {
            const read: ReadEvidence = await readEvidence(client, runStartedAtMs, this.limits, secrets);
            snapshot = read.snapshot;
            see(snapshot);
            lastGoal = await this.options.goalJudge!.judge(goal, { ...read.evidence, journey: journey.get() });
            return lastGoal;
        };
        /**
         * Hands the browser to the user and waits. True when they are done
         * (the page is read afresh and the run goes on), false when they stopped it.
         */
        const pauseForUser: (
            base: Omit<StepEvent, "executed">,
            kind: UserActionKind,
            target?: { control: Control; page: ControlSnapshot }
        ) => Promise<boolean> = async (
            base: Omit<StepEvent, "executed">,
            kind: UserActionKind,
            target?: { control: Control; page: ControlSnapshot }
        ): Promise<boolean> => {
            // `target` is the masked control on the masked page it was found on (the decision's):
            // what the person, the engine and a recording read of it carries no secret, and the
            // descriptor's place among its peers is read off the very page the control is from.
            const field: string | undefined = target ? describeControl(target.control) : undefined;
            // A replay waits for this field before pausing again.
            const targetDescriptor: TargetDescriptor | undefined = target ? describeTarget(target.control, target.page) : undefined;
            const prompt: string = userPrompt(kind, field);
            const waitStarted: number = performance.now();
            const resumed: boolean = await this.options.askUser!({ step: base.step, kind, prompt, field, url: shownUrl() });
            const waitMs: number = Math.round(performance.now() - waitStarted);
            pausedMs += waitMs;
            if (!resumed) {
                emit({ ...base, operation: Operation.ASK_USER, target: field, executed: false, reason: "stopped by the user", userAction: { kind, prompt, waitMs } });
                return false;
            }
            const before: string = pageContentKey(snapshot);
            snapshot = await client.snapshot(this.limits);
            see(snapshot);
            const pageChanged: boolean = pageContentKey(snapshot) !== before;
            history.push({ step: history.length + 1, operation: Operation.ASK_USER, target: field, executed: true, pageChanged, note: `the user was asked: ${prompt}` });
            emit({
                ...base,
                operation: Operation.ASK_USER,
                target: field,
                targetDescriptor,
                executed: true,
                pageChanged,
                userAction: { kind, prompt, waitMs },
            });
            unchanged = 0;
            refusals = 0;
            waits = 0;
            return true;
        };
        const finish: (status: RunStatus, reason?: string) => RunResult = (status: RunStatus, reason?: string): RunResult => ({
            status,
            reason,
            elapsedMs: elapsed(),
            actions,
            decisions,
            steps,
            // Its ids stay; its address is masked like every event's.
            finalSnapshot: { ...snapshot, url: shownUrl() },
            ...(lastGoal ? { goal: lastGoal } : {}),
            journey: journey.get(),
        });
        /** A stall's end — unless the caller stopped the run meanwhile: then it is cancelled, not stuck. */
        const stalled: (status: RunStatus, reason: string) => RunResult = (status: RunStatus, reason: string): RunResult =>
            this.options.signal?.aborted ? finish(RunStatus.CANCELLED, "stopped by the caller") : finish(status, reason);

        /**
         * The engine is stuck (`stuck` is why; `status` how the run would end — none when it would go
         * on and the model is merely called early): the text model takes the controls. True while it
         * has them — the loop takes its steps, and the stall checks do not end the run (its tool-call
         * budget does); false when there is no model to take over.
         */
        const unstick: (stuck: string, status?: RunStatus) => Promise<boolean> = async (
            stuck: string,
            status?: RunStatus
        ): Promise<boolean> => {
            if (atControls) {
                return true;
            }
            const takeover: Takeover | undefined = this.options.takeover;
            if (!takeover || takeovers >= MAX_TAKEOVERS || this.options.signal?.aborted) {
                return false;
            }
            takeovers++;
            const looks: TakeoverLooks = this.looks(
                runStartedAtMs,
                (): ControlSnapshot => snapshot,
                (fresh: ControlSnapshot): void => {
                    snapshot = fresh;
                    see(fresh);
                }
            );
            atControls = { session: takeover.start(stuck, looks), stuck, status, since: performance.now() };
            this.options.onRescue?.({ state: RescueState.ASKING, step: stepOffset + steps.length + 1, model: takeover.label, stuck });
            unchanged = 0;
            refusals = 0;
            waits = 0;
            rejections = 0;
            sinceNewState = 0;
            repeats.clear();
            return true;
        };

        for (;;) {
            if (this.options.signal?.aborted) {
                return finish(RunStatus.CANCELLED, "stopped by the caller");
            }
            // Budgets: the engine's share, then the whole — each hands the text model the controls
            // first. While it has them, its own tool-call budget bounds it. Checked before the
            // decision, so no decision is asked for that could not be carried out.
            if (!atControls) {
                if (!engineBudgetSpent && (actions >= engineActions || decisions >= engineDecisions)) {
                    engineBudgetSpent = true;
                    const spent: string = actions >= engineActions ? `${actions} actions` : `${decisions} decisions`;
                    if (await unstick(`${spent} without reaching the goal`)) {
                        continue;
                    }
                }
                if (decisions >= maxDecisions || actions >= maxActions) {
                    const stuck: string = decisions >= maxDecisions ? `${maxDecisions}-decision budget reached` : `${maxActions}-action budget reached`;
                    if (await unstick(stuck, RunStatus.BUDGET)) {
                        continue;
                    }
                    return stalled(RunStatus.BUDGET, stuck);
                }
            }
            const canAskUser: boolean = this.options.askUser !== undefined && userActions < MAX_USER_ACTIONS;
            const input: DecisionInput = {
                goal,
                snapshot: maskSecretsEncoded(snapshot, secrets),
                history,
                // The "ask the user" value goes with the hand-overs: withdrawn once they are used up.
                textChoices: canAskUser ? this.policyChoices : this.policyChoices.filter((c: TextChoice): boolean => c.source !== TextSource.USER),
                canAskUser,
                canGoBack: seenUrls.size > 1,
                earlierPages: journey.get().pages,
                canGoForward: wentBack,
                now: describeNow(new Date()),
            };
            // While the text model has the controls, the step is its; else the engine's.
            let help: { stuck: string; why: string } | undefined;
            let decision: Decision;
            if (atControls) {
                const at: { session: TakeoverSession; stuck: string; status?: RunStatus; since: number } = atControls;
                const model: string = this.options.takeover!.label;
                const step: number = stepOffset + steps.length + 1;
                const asked: number = performance.now();
                /** The engine decides again, with fresh stall counters, after the model's turn ended. */
                const handBack: (note: string) => void = (note: string): void => {
                    history.push({ step: history.length + 1, operation: Operation.WAIT, executed: false, note });
                    // A turn that ended past the engine's share was the share's call: the model is not
                    // called again for it before the engine has decided once.
                    engineBudgetSpent = engineBudgetSpent || actions >= engineActions || decisions >= engineDecisions;
                    unchanged = 0;
                    refusals = 0;
                    waits = 0;
                    rejections = 0;
                    sinceNewState = 0;
                    repeats.clear();
                };
                let taken: TakeoverStep;
                try {
                    taken = await at.session.next(
                        input,
                        this.rescueOperations(seenUrls.size > 1, wentBack, input.canAskUser === true),
                        (look: TakeoverLook): void => {
                            this.options.onRescue?.({ state: RescueState.LOOKING, step, model, stuck: at.stuck, action: look.tool, why: look.why });
                        }
                    );
                } catch (err: unknown) {
                    taken = { end: TakeoverEnd.GAVE_UP, why: err instanceof Error ? err.message : String(err) };
                }
                if ("end" in taken) {
                    atControls = undefined;
                    const ms: number = Math.round(performance.now() - at.since);
                    if (taken.end === TakeoverEnd.GAVE_UP) {
                        this.options.onRescue?.({ state: RescueState.NONE, step, model, stuck: at.stuck, ms, error: taken.why });
                        if (at.status === undefined) {
                            // Called early (the run was not stuck): the engine goes on as it would have.
                            handBack(`the text model ${model} had the controls and saw no way past it (${taken.why}); the run goes on`);
                            continue;
                        }
                        return stalled(at.status, `${at.stuck}; ${model} could not get past it: ${taken.why}`);
                    }
                    this.options.onRescue?.({ state: RescueState.ANSWERED, step, model, stuck: at.stuck, ms, end: taken.end, why: taken.why });
                    if (taken.end === TakeoverEnd.DONE) {
                        // A Stop that landed during the model's turn wins over its word.
                        if (this.options.signal?.aborted) {
                            return finish(RunStatus.CANCELLED, "stopped by the caller");
                        }
                        // On the model's word: it saw the goal done where the engine could not.
                        lastGoal = {
                            state: GoalState.DONE,
                            stateProbability: 1,
                            probability: 1,
                            achieved: true,
                            confirmedBy: { model, why: taken.why },
                        };
                        emit({
                            step,
                            mode: StepMode.RESCUE,
                            rescue: { model, stuck: at.stuck, why: taken.why },
                            elapsedMs: elapsed(),
                            operation: Operation.DONE,
                            confidence: 1,
                            decisionMs: Math.round(performance.now() - asked),
                            operationProbabilities: {},
                            url: shownUrl(),
                            executed: true,
                            goal: lastGoal,
                        });
                        return finish(RunStatus.DONE);
                    }
                    if (at.status === RunStatus.BUDGET) {
                        // The budget was the obstacle, and it is still spent: the engine cannot act again.
                        return stalled(RunStatus.BUDGET, `${at.stuck}; ${model} handed the controls back: ${taken.why}`);
                    }
                    // Handed back: the engine decides from here, with fresh stall counters.
                    handBack(`the text model ${model} had the controls and handed them back: ${taken.why}`);
                    continue;
                }
                decision = taken.act;
                decision.latencyMs = Math.round(performance.now() - asked);
                help = { stuck: at.stuck, why: taken.why };
            } else {
                decision = await decider.decide(input);
            }
            decisions++;
            // A Stop during the decision (seconds for the engine, up to minutes for the text
            // model) must not cost the page one more action.
            if (this.options.signal?.aborted) {
                return finish(RunStatus.CANCELLED, "stopped by the caller");
            }
            const base: Omit<StepEvent, "executed"> = {
                step: stepOffset + steps.length + 1,
                mode: help ? StepMode.RESCUE : StepMode.ENGINE,
                ...(help ? { rescue: { model: this.options.takeover!.label, stuck: help.stuck, why: help.why } } : {}),
                elapsedMs: elapsed(),
                operation: decision.operation,
                confidence: decision.confidence,
                decisionMs: decision.latencyMs,
                operationProbabilities: decision.operationProbabilities,
                targetTop: topTargets(decision),
                url: shownUrl(),
            };

            if (decision.operation === Operation.DONE && this.options.goalJudge) {
                const judged: GoalJudgement = await judgeGoal();
                if (judged.achieved) {
                    emit({ ...base, executed: true, goal: judged });
                    return finish(RunStatus.DONE);
                }
                const shown: string = judged.signals?.length ? `; the evidence shows ${judged.signals.join("; ")}` : "";
                if (judged.state === GoalState.FAILED) {
                    // An error or failed outcome no further step undoes: stop now, with it as the cause.
                    const reason: string = `the goal failed (p=${judged.stateProbability.toFixed(2)})${shown}`;
                    emit({ ...base, executed: false, reason, goal: judged });
                    return finish(RunStatus.FAILED, reason);
                }
                // Not done yet: tell the policy WHY — it sees only the page — and keep going on the fresh snapshot.
                const reason: string = `DONE rejected: the goal is not done yet (p=${judged.probability.toFixed(2)})${shown}`;
                history.push({ step: history.length + 1, operation: Operation.DONE, executed: false, reason });
                emit({ ...base, executed: false, reason, goal: judged });
                if (++rejections >= MAX_DONE_REJECTIONS) {
                    const stuck: string = `the goal was not shown done after ${rejections} DONEs`;
                    if (await unstick(stuck, RunStatus.FAILED)) {
                        continue;
                    }
                    return stalled(RunStatus.FAILED, stuck);
                }
                continue;
            }
            if (decision.operation === Operation.DONE || decision.operation === Operation.BLOCKED) {
                emit({ ...base, executed: true });
                if (decision.operation === Operation.DONE) {
                    return finish(RunStatus.DONE);
                }
                if (await unstick("the policy chose BLOCKED", RunStatus.BLOCKED)) {
                    continue;
                }
                return stalled(RunStatus.BLOCKED, "the policy chose BLOCKED");
            }
            if (decision.operation === Operation.ASK_USER) {
                userActions++;
                if (!(await pauseForUser(base, decision.userAction ?? UserActionKind.OTHER))) {
                    return finish(RunStatus.CANCELLED, "stopped by the user");
                }
                continue;
            }

            // The page the decision was made on, secrets masked (the text model's `snapshot` look
            // may have replaced the agent's since the input was built). The control as it shows it:
            // everything that describes the control (the history, the text model's field, the
            // recording's descriptor) is built from this one; the act itself needs only its id. A
            // page may display a secret (a demo hint beside a button, a typed value), and a model
            // must never read it.
            const page: ControlSnapshot = help ? maskSecretsEncoded(snapshot, secrets) : input.snapshot;
            const control: Control | undefined =
                decision.controlId === undefined ? undefined : page.controls.find((c: Control): boolean => c.id === decision.controlId);
            if (decision.controlId !== undefined && !control) {
                // The id is not on the page the agent acts on (the page moved under the decision):
                // refused like a stale action, with a fresh decision to follow.
                const reason: string = `no control ${decision.controlId} on the page`;
                history.push({ step: history.length + 1, operation: decision.operation, executed: false, reason });
                emit({ ...base, executed: false, reason });
                if (++refusals >= MAX_CONSECUTIVE_REFUSALS) {
                    const stuck: string = `${refusals} refusals in a row: ${reason}`;
                    if (await unstick(stuck, RunStatus.BLOCKED)) {
                        continue;
                    }
                    return stalled(RunStatus.BLOCKED, stuck);
                }
                continue;
            }
            let typed: TypedText | undefined;
            if (decision.operation === Operation.TYPE_TEXT) {
                // The engine's value question is blind to which field won, so its choice is re-asked;
                // the text model at the controls named field and key together, on purpose.
                if (!help) {
                    await this.recheckValue(decision, control!, input, history);
                }
                const resolved: TypedText | { none: string } = await this.resolveText(decision, control!, page, history);
                const handOver: boolean = this.options.askUser !== undefined && userActions < MAX_USER_ACTIONS;
                let none: string | undefined;
                if ("none" in resolved) {
                    none = resolved.none;
                } else if (resolved.source === TextSource.USER) {
                    // The choice is withdrawn once the hand-overs are used up; a decider that names it
                    // anyway is told why it gets nothing (defence in depth).
                    none = handOver ? "the user types it" : `the user was already asked ${MAX_USER_ACTIONS} times; no more hand-overs`;
                }
                // No value from the run: the user types it, when there is one.
                if (none !== undefined && handOver) {
                    userActions++;
                    if (!(await pauseForUser(base, UserActionKind.ENTER_VALUE, { control: control!, page }))) {
                        return finish(RunStatus.CANCELLED, "stopped by the user");
                    }
                    continue;
                }
                if (none !== undefined) {
                    // Nothing is typed, and the engine learns why (no confident value, or the text model failed).
                    const reason: string = `no value for ${describeControl(control!)}: ${none}`;
                    history.push({
                        step: history.length + 1,
                        operation: decision.operation,
                        target: describeControl(control!),
                        executed: false,
                        reason,
                    });
                    emit({ ...base, target: describeControl(control!), executed: false, reason });
                    if (++refusals >= MAX_CONSECUTIVE_REFUSALS) {
                        const stuck: string = `${refusals} refusals in a row: ${reason}`;
                        if (await unstick(stuck, RunStatus.BLOCKED)) {
                            continue;
                        }
                        return stalled(RunStatus.BLOCKED, stuck);
                    }
                    continue;
                }
                typed = resolved as TypedText;
                // The text model at the controls names the field and its text together, on purpose.
                if (!help) {
                    typed = await this.settleFieldText(decision, control!, page, input, typed);
                }
            }

            const waitForNetwork: boolean = !busyOrigins.has(originOf(snapshot.url));
            // The decision names an option off the masked page; the page itself needs the option's
            // real value (an option whose value is a secret's text reads `[secret:name]` there).
            const optionValue: string | undefined =
                decision.optionValue === undefined ? undefined : rawOptionValue(control, snapshot, decision.optionValue);
            const request: ActRequest = {
                action: ACTION_OF[decision.operation]!,
                snapshotId: snapshot.snapshotId,
                controlId: decision.controlId,
                value: typed?.text ?? optionValue ?? decision.key ?? (decision.tabIndex !== undefined ? String(decision.tabIndex) : undefined),
                observe: true,
                ...(waitForNetwork ? { waitForNetworkMs: QUIET_TIMEOUT_MS } : {}),
                ...this.limits,
            };
            // The value question and the text model took their time too: a Stop during them must
            // not cost the page this action either.
            if (this.options.signal?.aborted) {
                return finish(RunStatus.CANCELLED, "stopped by the caller");
            }
            const actStarted: number = performance.now();
            const result: ActResult = await client.act(request);
            let next: ControlSnapshot = result.snapshot!;
            if (result.executed && waitForNetwork) {
                if (result.networkIdle === false) {
                    busyOrigins.add(originOf(next.url));
                } else if (result.networkIdle === undefined && !next.dialog) {
                    // The act's wait was cut short by a dialog that is gone again by the snapshot:
                    // wait here, then look again. (A dialog still held means a frozen page: nothing to wait for.)
                    const wait: NetworkWait = await client.waitForQuiet(QUIET_TIMEOUT_MS, QUIET_IDLE_MS);
                    if (wait === NetworkWait.BUSY) {
                        busyOrigins.add(originOf(next.url));
                    }
                    if (wait !== NetworkWait.QUIET) {
                        next = await client.snapshot(this.limits);
                    }
                }
            }
            const actMs: number = Math.round(performance.now() - actStarted);
            if (result.executed) {
                this.pendingText = undefined;
                if (typed && control && typed.source !== TextSource.USER) {
                    this.typedInto.set(fieldKey(control, page), typed);
                }
                if (typed?.source === TextSource.SECRET && control?.password !== true) {
                    // Typed where it shows: the screen may carry it from now on.
                    this.secretShown = true;
                }
            }
            const pageChanged: boolean = pageContentKey(next) !== pageContentKey(snapshot);
            const target: string | undefined = control ? describeControl(control) : undefined;
            // Read off the (masked) snapshot the decision was made on, before it is replaced.
            const targetDescriptor: TargetDescriptor | undefined = control ? describeTarget(control, page) : undefined;
            const optionLabel: string | undefined =
                decision.optionValue === undefined
                    ? undefined
                    : control?.options?.find((o: { value: string }): boolean => o.value === decision.optionValue)?.label;

            see(next);
            history.push({
                step: history.length + 1,
                operation: decision.operation,
                target,
                // The engine reads which key it pressed where the typed text would be.
                text: typed?.shown ?? decision.key,
                executed: result.executed,
                reason: result.reason,
                pageChanged: result.executed ? pageChanged : undefined,
                // The engine reads who chose the step it did not choose.
                ...(help ? { note: `taken by the text model ${this.options.takeover!.label}, which had the controls after: ${help.stuck}` } : {}),
            });
            emit({
                ...base,
                target,
                text: typed?.shown,
                textSource: typed?.source,
                ...(typed?.generatedMs !== undefined ? { textMs: typed.generatedMs } : {}),
                ...(typed?.reused ? { textReused: true } : {}),
                targetDescriptor,
                textRef: typed?.ref,
                optionLabel,
                ...(decision.key ? { key: decision.key } : {}),
                ...(decision.tabIndex !== undefined
                    ? { tab: decision.tabIndex, tabUrl: maskSecretsEncoded(tabAddress(snapshot, decision.tabIndex), this.options.text.secrets) }
                    : {}),
                executed: result.executed,
                reason: result.reason,
                actMs,
                pageChanged,
            });
            if (result.executed && next.url !== snapshot.url) {
                wentBack = decision.operation === Operation.GO_BACK;
            }
            seenUrls.add(next.url);
            const previous: ControlSnapshot = snapshot;
            snapshot = next;

            if (!result.executed) {
                if (++refusals >= MAX_CONSECUTIVE_REFUSALS) {
                    const stuck: string = `${refusals} refusals in a row: ${result.reason}`;
                    if (await unstick(stuck, RunStatus.BLOCKED)) {
                        continue;
                    }
                    return stalled(RunStatus.BLOCKED, stuck);
                }
                continue;
            }
            refusals = 0;
            actions++;
            if (decision.operation === Operation.WAIT) {
                if (++waits >= MAX_CONSECUTIVE_WAITS) {
                    const stuck: string = `${waits} waits in a row`;
                    if (await unstick(stuck, RunStatus.BLOCKED)) {
                        continue;
                    }
                    return stalled(RunStatus.BLOCKED, stuck);
                }
                continue;
            }
            waits = 0;
            // A secret typed into a password field is invisible to the
            // fingerprint by design; that is progress, not a stall.
            const invisibleProgress: boolean = typed?.source === TextSource.SECRET || control?.password === true;
            unchanged = pageChanged || invisibleProgress ? 0 : unchanged + 1;
            if (unchanged >= MAX_UNCHANGED_ACTIONS) {
                const stuck: string = `${unchanged} actions in a row changed nothing observable`;
                if (await unstick(stuck, RunStatus.BLOCKED)) {
                    continue;
                }
                return stalled(RunStatus.BLOCKED, stuck);
            }
            // Actions that do change the page can still go round in a circle (Products → Cart → Products).
            const repeatKey: string = JSON.stringify([pageContentKey(previous), decision.operation, target, typed?.shown ?? decision.key]);
            const repeated: number = (repeats.get(repeatKey) ?? 0) + 1;
            repeats.set(repeatKey, repeated);
            if (repeated >= MAX_REPEATED_ACTIONS) {
                const stuck: string = `a loop: ${target ?? decision.operation} taken ${repeated} times on the same page`;
                if (await unstick(stuck, RunStatus.BLOCKED)) {
                    continue;
                }
                return stalled(RunStatus.BLOCKED, stuck);
            }
            // …or round through several pages: no page state it has not been in for a while.
            const state: string = pageStateKey(snapshot);
            sinceNewState = states.has(state) ? sinceNewState + 1 : 0;
            states.add(state);
            if (sinceNewState >= MAX_ACTIONS_WITHOUT_NEW_STATE && !atControls) {
                const stuck: string = `${sinceNewState} actions in a row reached no page it had not been on`;
                sinceNewState = 0;
                await unstick(stuck);
            }
        }
    }

    /**
     * What the text model may look at while it has the controls, read now and secret-masked. A fresh
     * snapshot becomes the agent's current one (its ids are what the model acts on). Every text
     * output is masked in the encoded forms too (a console line carries a URL, a request a body).
     * No screenshot when a secret could show on the screen: the run-level gate (only password
     * secrets, drawn as dots), and per look — refused while the page the agent is on (`current`)
     * shows one, and for good once a secret was typed where it shows. No HTTP headers when this
     * process types the secrets itself: a header can carry one in a form the masking does not
     * cover (`Authorization: Basic` is a base64 of user and secret together), and only DevTools
     * holding the secrets masks at the source.
     */
    private looks(sinceMs: number, current: () => ControlSnapshot, onSnapshot: (page: ControlSnapshot) => void): TakeoverLooks {
        const client: DevtoolsClient = this.options.client;
        const secrets: Record<string, string> = this.options.text.secrets;
        const withholdHeaders: boolean = Object.keys(secrets).length > 0 && this.options.text.secretsInDevtools !== true;
        return {
            snapshot: async (): Promise<ControlSnapshot> => {
                const fresh: ControlSnapshot = await client.snapshot(this.limits);
                onSnapshot(fresh);
                return maskSecretsEncoded(fresh, secrets);
            },
            pageText: async (): Promise<string> => maskSecretsEncoded(await client.pageText(EVIDENCE_MAX_CHARS), secrets),
            ...(this.options.screenshotSafe
                ? {
                    screenshot: async (): Promise<TextImage> => {
                        if (this.secretShown) {
                            throw new Error("not taken: a secret was typed into a field that shows it; no screenshot for the rest of this run");
                        }
                        if (pageShowsSecret(current(), secrets)) {
                            throw new Error("not taken: the page shows a secret");
                        }
                        return client.screenshot();
                    },
                }
                : {}),
            // Masked before it is described: describing collapses whitespace and cuts bodies, and a cut or
            // reflowed value no longer matches any masking form.
            requests: async (): Promise<string> => describeApiResponses(maskSecretsEncoded(await client.appRequests(sinceMs), secrets), 3_000),
            console: async (): Promise<string> =>
                maskSecretsEncoded(
                    (await client.consoleErrors(sinceMs))
                        .map((e: { text: string }): string => e.text)
                        .join("\n"),
                    secrets
                ) || "no console errors",
            // The input is the model's (rescue.ts drops its `_`-prefixed keys: `_metadata` is the run's, never a model's).
            devtools: async (name: string, input: Record<string, unknown>): Promise<string> => {
                const { includeRequestHeaders, includeResponseHeaders, ...rest } = input;
                const headersAsked: boolean = includeRequestHeaders === true || includeResponseHeaders === true;
                const withheld: boolean = withholdHeaders && name === "o11y_get-http-requests" && headersAsked;
                const out: string =
                    JSON.stringify(
                        maskSecretsEncoded(await client.call<unknown>(name, withheld ? rest : input), secrets),
                        (key: string, value: unknown): unknown => (key.startsWith("_") ? undefined : value)
                    ) ?? "no output";
                return withheld ? `(request and response headers withheld: this run's secrets are typed by this process, not held by DevTools)\n${out}` : out;
            },
        };
    }

    /**
     * The operations the text model may take while it has the controls. What depends on the run
     * (history, hand-overs) is decided here; what depends on the page (scroll, tabs) is checked
     * per action against the page the model last looked at (`checkAction`), since a `snapshot` look
     * mid-turn can change it.
     */
    private rescueOperations(canGoBack: boolean, canGoForward: boolean, canAskUser: boolean): Operation[] {
        const ops: Operation[] = [
            Operation.CLICK,
            Operation.TYPE_TEXT,
            Operation.SELECT,
            Operation.PRESS_ENTER,
            Operation.HOVER,
            Operation.PRESS_KEY,
            Operation.WAIT,
            Operation.SCROLL_DOWN,
            Operation.SCROLL_UP,
            Operation.SWITCH_TAB,
            Operation.CLOSE_TAB,
        ];
        if (canGoBack) {
            ops.push(Operation.GO_BACK);
        }
        if (canGoForward) {
            ops.push(Operation.GO_FORWARD);
        }
        if (canAskUser) {
            ops.push(Operation.ASK_USER);
        }
        return ops;
    }

    /**
     * Asks the value again, naming the field, when the first pick looks wrong (`control` is from
     * `input.snapshot`, the decision's masked page): the same text was already typed into another
     * field this run, or a password field would get a plain value while the run has secrets. The
     * first request asks the value alongside the field, blind to which one wins.
     */
    private async recheckValue(decision: Decision, control: Control, input: DecisionInput, history: HistoryEntry[]): Promise<void> {
        if (decision.literalText !== undefined) {
            return;
        }
        const decider: Decider = this.options.decider;
        const choice: TextChoice | undefined = this.options.text.choices.find((c: TextChoice): boolean => c.key === decision.textKey);
        if (!decider.chooseValue || !choice || this.policyChoices.length < 2) {
            return;
        }
        const shown: string | undefined = choice.text !== undefined ? visibleText(choice, choice.text) : undefined;
        const field: string = describeControl(control);
        // The same value into a second field is asked again, naming the field: the engine, not a
        // word list, tells a slip from a field that repeats a value on purpose (TEXT_VALUE says so).
        const typedElsewhere: boolean =
            shown !== undefined &&
            history.some((h: HistoryEntry): boolean => h.operation === Operation.TYPE_TEXT && h.executed && h.text === shown && h.target !== field);
        // A written or user-typed value into a password field is a choice (a new password), not a slip.
        const plainIntoPassword: boolean =
            control.password === true &&
            (choice.source === TextSource.VALUE || choice.source === TextSource.GOAL_LITERAL) &&
            Object.keys(this.options.text.secrets).length > 0;
        if (!typedElsewhere && !plainIntoPassword) {
            return;
        }
        const started: number = performance.now();
        // The same input the decision was made with (earlier pages included); only the clock moved.
        const again: { textKey: string; probabilities: Record<string, number> } = await decider.chooseValue(
            { ...input, now: describeNow(new Date()) },
            control
        );
        decision.textKey = again.textKey;
        decision.textProbabilities = again.probabilities;
        // The second request is part of this decision's time.
        decision.latencyMs += Math.round(performance.now() - started);
    }

    /**
     * The text a field gets when it still holds text this run typed into it and a different text is
     * about to replace it (`control` and `page` are the decision's masked input). Typing replaces a
     * field's contents, so a form with one field for several parts of the goal (one address field for
     * a street, a city and a postal code) would keep only the last. The engine is asked what the
     * field should hold, each option naming the resulting text: the new text alone, or the two
     * joined. No word list decides it. Whether the new text belongs in this field at all is the value
     * question's (recheckValue); vetoing it here only made the engine choose the same step again.
     * Secrets and password fields are never joined; a field the page cleared or changed since holds
     * nothing of the run's.
     */
    private async settleFieldText(
        decision: Decision,
        control: Control,
        page: ControlSnapshot,
        input: DecisionInput,
        typed: TypedText
    ): Promise<TypedText> {
        const decider: Decider = this.options.decider;
        if (!decider.chooseFieldText || control.password === true || typed.source === TextSource.SECRET || typed.source === TextSource.USER) {
            return typed;
        }
        const held: TypedText | undefined = this.typedInto.get(fieldKey(control, page));
        if (!held || held.source === TextSource.SECRET || held.text === "" || typed.text === "") {
            return typed;
        }
        // Still there as typed: a page that cleared or reformatted the field holds nothing of the run's.
        if ((control.value ?? "").trim() !== held.shown.trim()) {
            return typed;
        }
        // The same text, or a new text that already keeps the old one (a text model saw the field's value).
        if (typed.text.includes(held.text)) {
            return typed;
        }
        const joined: (separator: string) => TypedText = (separator: string): TypedText => ({
            text: `${held.text}${separator}${typed.text}`,
            shown: `${held.shown}${separator}${typed.shown}`,
            source: TextSource.COMBINED,
            ref: { source: TextSource.COMBINED, parts: [held.ref, typed.ref], separator },
        });
        const texts: Record<FieldTextChoice, TypedText> = {
            [FieldTextChoice.REPLACE]: typed,
            [FieldTextChoice.JOIN_COMMA]: joined(", "),
            [FieldTextChoice.JOIN_SPACE]: joined(" "),
        };
        const options: Record<FieldTextChoice, string> = {
            [FieldTextChoice.REPLACE]: `the field holds only ${JSON.stringify(typed.shown)}; ${JSON.stringify(held.shown)} is removed`,
            [FieldTextChoice.JOIN_COMMA]: `the field holds ${JSON.stringify(texts[FieldTextChoice.JOIN_COMMA].shown)}`,
            [FieldTextChoice.JOIN_SPACE]: `the field holds ${JSON.stringify(texts[FieldTextChoice.JOIN_SPACE].shown)}`,
        };
        const started: number = performance.now();
        const answer: { choice: FieldTextChoice } = await decider.chooseFieldText({ ...input, now: describeNow(new Date()) }, control, options);
        // The second request is part of this decision's time.
        decision.latencyMs += Math.round(performance.now() - started);
        return texts[answer.choice];
    }

    /**
     * The text to type (`control` and `page` are the decision's masked input): a chosen candidate,
     * or the generator's value — or `none`, why there is nothing to type (the generator had no
     * confident value, or the text model failed: a run is not aborted by a reply that was not a value).
     */
    private async resolveText(
        decision: Decision,
        control: Control,
        page: ControlSnapshot,
        history: HistoryEntry[]
    ): Promise<TypedText | { none: string }> {
        if (decision.literalText !== undefined) {
            // Written by the text model while it had the controls: typed as it is, and labelled as its.
            return {
                text: decision.literalText,
                shown: decision.literalText,
                source: TextSource.TAKEOVER,
                ref: { source: TextSource.TAKEOVER, text: decision.literalText },
            };
        }
        const choice: TextChoice | undefined = this.options.text.choices.find(
            (c: TextChoice): boolean => c.key === decision.textKey
        );
        if (!choice) {
            throw new Error(`Unknown text choice ${decision.textKey}`);
        }
        if (choice.source === TextSource.USER) {
            // Typed by the user when the run pauses for it; nothing to type here.
            return { text: "", shown: "", source: TextSource.USER, ref: { source: TextSource.USER } };
        }
        if (choice.source !== TextSource.GENERATE) {
            return {
                text: choice.text!,
                shown: visibleText(choice, choice.text!),
                source: choice.source,
                ref: textRefOf(choice, choice.text!),
            };
        }
        const context: FieldContext = {
            goal: this.options.goal,
            // The control and the page as the decision's masked input shows them.
            field: { name: control.name, role: control.role, value: control.password ? undefined : control.value },
            page: { title: page.title, text: page.text },
            recentActions: history
                .slice(-6)
                .map((h: HistoryEntry): { operation: string; target?: string; text?: string } => ({
                    operation: h.operation,
                    target: h.target,
                    text: h.text,
                })),
        };
        // Same field, same value in it, same goal and the same actions DONE since: the same text. The
        // page text is left out: what changed it (a suggestion list opening) is what refused the attempt.
        const key: string = JSON.stringify({
            textKey: decision.textKey,
            field: context.field,
            done: history
                .filter((h: HistoryEntry): boolean => h.executed)
                .slice(-6)
                .map((h: HistoryEntry): [string, string?, string?] => [h.operation, h.target, h.text]),
        });
        if (this.pendingText?.key === key) {
            return { ...this.pendingText.typed, generatedMs: undefined, reused: true };
        }
        const startedMs: number = Date.now();
        let text: string | null;
        try {
            text = await this.options.text.generator!.generate(context);
        } catch (err: unknown) {
            return { none: err instanceof Error ? err.message : String(err) };
        }
        if (text === null) {
            return { none: "the text model had no confident value" };
        }
        const typed: TypedText = { text, shown: text, source: TextSource.GENERATE, ref: { source: TextSource.GENERATE, text }, generatedMs: Date.now() - startedMs };
        this.pendingText = { key, typed };
        return typed;
    }
}
