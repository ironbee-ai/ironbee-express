/**
 * Replays a recording without a decision engine: each step finds its target
 * again by descriptor on the current snapshot and acts on it through the same
 * guarded DevTools call the engine's steps use. Instead of recorded WAITs, a
 * step waits (bounded) for its target to appear. The first step that cannot
 * be carried out ends the replay as DIVERGED, with where and why — the caller
 * decides whether the engine takes over from there.
 */

import { AskUser, originOf, pageContentKey, QUIET_TIMEOUT_MS, StepEvent, StepMode, tabAddress, userPrompt } from "../agent/agent";
import { describeControl, HistoryEntry, Operation, UserActionKind } from "../agent/policy";
import { DevtoolsClient } from "../devtools/client";
import {
    ActRequest,
    ActResult,
    Control,
    ControlAction,
    ControlOperation,
    ControlSnapshot,
    SnapshotLimits,
    TabInfo,
} from "../devtools/types";
import { maskSecretsEncoded } from "../text/mask";
import { TextChoice, TextRef, TextSource, TextStrategy } from "../text/types";
import { pathOf } from "../util/url";
import { Journey, JourneyRecorder } from "../verify/journey";
import { findTarget, formatDescriptor } from "./descriptor";
import { TARGETED } from "./recording";
import { RecordedStep, Recording } from "./types";

export const DEFAULT_STEP_TIMEOUT_MS: number = 8_000;
/** A page that has not changed for this long will not produce the target by waiting. */
export const DEFAULT_SETTLED_MS: number = 1_500;
const POLL_MS: number = 200;

const ACTION_OF: Partial<Record<Operation, ControlAction>> = {
    [Operation.CLICK]: ControlAction.CLICK,
    [Operation.TYPE_TEXT]: ControlAction.FILL,
    [Operation.SELECT]: ControlAction.SELECT,
    [Operation.PRESS_ENTER]: ControlAction.PRESS_ENTER,
    [Operation.SCROLL_DOWN]: ControlAction.SCROLL_DOWN,
    [Operation.SCROLL_UP]: ControlAction.SCROLL_UP,
    [Operation.HOVER]: ControlAction.HOVER,
    [Operation.PRESS_KEY]: ControlAction.PRESS_KEY,
    [Operation.GO_BACK]: ControlAction.GO_BACK,
    [Operation.GO_FORWARD]: ControlAction.GO_FORWARD,
    [Operation.SWITCH_TAB]: ControlAction.SWITCH_TAB,
    [Operation.CLOSE_TAB]: ControlAction.CLOSE_TAB,
};

const NEEDS: Partial<Record<Operation, ControlOperation>> = {
    [Operation.CLICK]: ControlOperation.CLICK,
    [Operation.TYPE_TEXT]: ControlOperation.FILL,
    [Operation.PRESS_ENTER]: ControlOperation.FILL,
    [Operation.SELECT]: ControlOperation.SELECT,
    [Operation.HOVER]: ControlOperation.CLICK,
    // ENTER_VALUE: the field the user types into must be there before the pause.
    [Operation.ASK_USER]: ControlOperation.FILL,
};

export interface ReplayOptions {
    client: DevtoolsClient;
    limits: SnapshotLimits;
    /** Resolves recorded values / secrets from THIS run's values. */
    text: TextStrategy;
    /** Navigate here first. */
    url?: string;
    /** When the run's own traffic began (the caller opened the page itself). Defaults to the replay's start. */
    evidenceSinceMs?: number;
    stepTimeoutMs?: number;
    /** Give up on a step once the page has been unchanged this long without its target. */
    settledMs?: number;
    signal?: AbortSignal;
    onStep?: (event: StepEvent) => void;
    /** The replay's clock starts (after the first observation): what `elapsedMs` counts from. */
    onClockStart?: () => void;
    /** The person a recorded ASK_USER step hands the browser to; without one the replay diverges there. */
    askUser?: AskUser;
}

export interface ReplayResult {
    completed: boolean;
    /** Index of the recorded step that could not be carried out. */
    divergedAt?: number;
    reason?: string;
    /** The user answered "stop" at a recorded hand-over: the run ends, nothing heals it. */
    stopped?: true;
    steps: StepEvent[];
    /** What happened, in the form the engine reads — for a takeover. */
    history: HistoryEntry[];
    snapshot: ControlSnapshot;
    elapsedMs: number;
    actions: number;
    /** When the replay started (before navigation, so the start page's own requests count): the evidence window. */
    startedAtMs: number;
    /** The steps replayed and the pages visited (secrets masked). */
    journey: Journey;
}

/**
 * The tab a recorded SWITCH_TAB goes to now: the one at the recorded address
 * (indexes shift as tabs close), else the recorded index. The recorded address
 * is masked (a secret can sit in a path): the live ones are compared masked too.
 */
export function recordedTabIndex(recorded: RecordedStep, page: ControlSnapshot, secrets: Record<string, string> = {}): number | undefined {
    if (recorded.tabUrl) {
        const match: TabInfo | undefined = page.tabs?.find(
            (t: TabInfo): boolean => maskSecretsEncoded(tabAddress(page, t.index), secrets) === recorded.tabUrl
        );
        if (match !== undefined) {
            return match.index;
        }
    }
    return recorded.tab;
}

/** Secret names the recording types that this run was not given. */
export function missingSecrets(recording: Recording, secrets: Record<string, string>): string[] {
    const names: Set<string> = new Set();
    for (const step of recording.steps) {
        if (step.text?.source === TextSource.SECRET && step.text.name && !Object.hasOwn(secrets, step.text.name)) {
            names.add(step.text.name);
        }
    }
    return [...names];
}

/** The text a recorded step types in this run: current values by name, recorded text otherwise. */
export function resolveTextRef(ref: TextRef, text: TextStrategy): string {
    if (ref.source === TextSource.COMBINED) {
        if (!ref.parts || ref.parts.length === 0 || ref.separator === undefined) {
            throw new Error("The recording has a combined value without its parts");
        }
        return ref.parts.map((part: TextRef): string => resolveTextRef(part, text)).join(ref.separator);
    }
    if (ref.source === TextSource.VALUE || ref.source === TextSource.SECRET) {
        const choice: TextChoice | undefined = text.choices.find(
            (c: TextChoice): boolean => c.key === `${ref.source === TextSource.SECRET ? "secret" : "value"}:${ref.name}`
        );
        if (choice?.text !== undefined) {
            return choice.text;
        }
        if (ref.source === TextSource.SECRET) {
            throw new Error(`The recording types the secret ${ref.name}, which this run was not given`);
        }
    }
    if (ref.text === undefined) {
        throw new Error(`The recording has no text for a ${ref.source} value`);
    }
    return ref.text;
}

function shown(ref: TextRef, text: string): string {
    return ref.source === TextSource.SECRET ? `<secret ${ref.name}>` : text;
}

export class Replayer {
    constructor(private readonly options: ReplayOptions) {}

    async run(recording: Recording): Promise<ReplayResult> {
        const { client, limits } = this.options;
        const stepTimeoutMs: number = this.options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
        const startedAtMs: number = this.options.evidenceSinceMs ?? Date.now();
        if (this.options.url) {
            await client.navigate(this.options.url);
        }
        let snapshot: ControlSnapshot = await client.snapshot(limits);
        const journey: JourneyRecorder = new JourneyRecorder();
        // Masked in its encoded forms as the agent masks: a URL carries a typed value encoded, and
        // the descriptors the agent recorded were read off a page masked the same way.
        const secrets: Record<string, string> = this.options.text.secrets;
        const see: (page: ControlSnapshot) => void = (page: ControlSnapshot): void =>
            journey.see(maskSecretsEncoded({ url: page.url, title: page.title, text: page.text, dialog: page.dialog }, secrets));
        see(snapshot);
        const started: number = performance.now();
        let pausedMs: number = 0;
        const elapsed: () => number = (): number => Math.round(performance.now() - started - pausedMs);
        this.options.onClockStart?.();
        const steps: StepEvent[] = [];
        const history: HistoryEntry[] = [];
        const busyOrigins: Set<string> = new Set();
        let actions: number = 0;
        const result: (completed: boolean, divergedAt?: number, reason?: string) => ReplayResult = (
            completed: boolean,
            divergedAt?: number,
            reason?: string
        ): ReplayResult => ({
            completed,
            divergedAt,
            reason,
            steps,
            history,
            snapshot: { ...snapshot, url: maskSecretsEncoded(snapshot.url, secrets) },
            elapsedMs: elapsed(),
            actions,
            startedAtMs,
            journey: journey.get(),
        });

        for (let i: number = 0; i < recording.steps.length; i++) {
            if (this.options.signal?.aborted) {
                return result(false, i, "stopped by the caller");
            }
            const recorded: RecordedStep = recording.steps[i];
            const deadline: number = Date.now() + stepTimeoutMs;
            const settledMs: number = this.options.settledMs ?? DEFAULT_SETTLED_MS;
            let lastFingerprint: string = snapshot.fingerprint;
            let unchangedSince: number = Date.now();
            // DevTools' last refusal of this step (a secret denied, a covered control): the divergence
            // names it, and the healing engine sees it in the history — as it does the agent's refusals.
            let lastRefusal: string | undefined;
            for (;;) {
                // A Stop while this step waits for its target must not cost the page the step's action.
                if (this.options.signal?.aborted) {
                    return result(false, i, "stopped by the caller");
                }
                // What describes the acted control (history target, step target, the journey, a
                // divergence, the user's prompt) is read off the masked page, as the agent reads
                // its own: a page can display a secret next to a field. Ids are the same, so the act
                // still goes by `snapshot`.
                const page: ControlSnapshot = maskSecretsEncoded(snapshot, secrets);
                // A step that acts on a control but names none cannot be carried out: diverge.
                if (TARGETED.has(recorded.operation) && recorded.target === undefined) {
                    return result(false, i, `${recorded.operation}: the recording names no control to act on`);
                }
                const control: Control | undefined = recorded.target ? findTarget(recorded.target, page) : undefined;
                const needs: ControlOperation | undefined = NEEDS[recorded.operation];
                const ready: boolean = recorded.target === undefined || (control !== undefined && control.ops.includes(needs!));
                if (ready && recorded.operation === Operation.ASK_USER) {
                    const kind: UserActionKind = recorded.userAction ?? UserActionKind.OTHER;
                    const field: string | undefined = control ? describeControl(control) : undefined;
                    const prompt: string = userPrompt(kind, field);
                    if (!this.options.askUser) {
                        return result(false, i, `the recording hands the browser to the user here (${prompt}), and no one is there`);
                    }
                    const waitStarted: number = performance.now();
                    const resumed: boolean = await this.options.askUser({ step: steps.length + 1, kind, prompt, field, url: page.url });
                    const waitMs: number = Math.round(performance.now() - waitStarted);
                    pausedMs += waitMs;
                    if (!resumed) {
                        // The pause the user ended the run at is a step of its own, as in an explored run.
                        const stoppedEvent: StepEvent = {
                            step: steps.length + 1,
                            mode: StepMode.REPLAY,
                            elapsedMs: elapsed(),
                            operation: Operation.ASK_USER,
                            confidence: 1,
                            decisionMs: 0,
                            operationProbabilities: {},
                            target: field,
                            targetDescriptor: recorded.target,
                            executed: false,
                            reason: "stopped by the user",
                            url: page.url,
                            userAction: { kind, prompt, waitMs },
                        };
                        steps.push(stoppedEvent);
                        journey.step(stoppedEvent);
                        this.options.onStep?.(stoppedEvent);
                        return { ...result(false, i, "stopped by the user"), stopped: true };
                    }
                    const before: string = pageContentKey(snapshot);
                    snapshot = await client.snapshot(limits);
                    see(snapshot);
                    const pageChanged: boolean = pageContentKey(snapshot) !== before;
                    const event: StepEvent = {
                        step: steps.length + 1,
                        mode: StepMode.REPLAY,
                        elapsedMs: elapsed(),
                        operation: Operation.ASK_USER,
                        confidence: 1,
                        decisionMs: 0,
                        operationProbabilities: {},
                        target: field,
                        targetDescriptor: recorded.target,
                        executed: true,
                        // The page the pause was decided on, like every step; the page it led to is in the journey.
                        url: page.url,
                        pageChanged,
                        userAction: { kind, prompt, waitMs },
                    };
                    steps.push(event);
                    journey.step(event);
                    this.options.onStep?.(event);
                    history.push({ step: history.length + 1, operation: Operation.ASK_USER, target: field, executed: true, pageChanged, note: `the user was asked: ${prompt}` });
                    break;
                }
                if (ready) {
                    let value: string | undefined;
                    if (recorded.operation === Operation.TYPE_TEXT && recorded.text) {
                        try {
                            value = resolveTextRef(recorded.text, this.options.text);
                        } catch (err: unknown) {
                            // Text this run cannot supply is a divergence (the engine may take over), not a crash.
                            return result(false, i, err instanceof Error ? err.message : String(err));
                        }
                    } else if (recorded.operation === Operation.PRESS_KEY) {
                        value = recorded.key;
                    } else if (recorded.operation === Operation.SWITCH_TAB) {
                        const index: number | undefined = recordedTabIndex(recorded, snapshot, secrets);
                        value = index !== undefined ? String(index) : undefined;
                    } else if (recorded.operation === Operation.SELECT) {
                        // `ready` holds a control for a targeted step (a SELECT without one diverged above).
                        value = control?.options?.find(
                            (o: { label: string }): boolean => o.label === recorded.optionLabel
                        )?.value;
                        if (value === undefined) {
                            const where: string = control ? describeControl(control) : "the page";
                            return result(false, i, `option ${JSON.stringify(recorded.optionLabel)} is no longer offered by ${where}`);
                        }
                    }
                    // As the agent does: the next step reads the page once what this one loads is in
                    // (a single-page app renders the next view after its requests end).
                    const waitForNetwork: boolean = !busyOrigins.has(originOf(snapshot.url));
                    const request: ActRequest = {
                        action: ACTION_OF[recorded.operation]!,
                        snapshotId: control ? snapshot.snapshotId : undefined,
                        controlId: control?.id,
                        value,
                        observe: true,
                        ...(waitForNetwork ? { waitForNetworkMs: QUIET_TIMEOUT_MS } : {}),
                        ...limits,
                    };
                    const actStarted: number = performance.now();
                    const acted: ActResult = await client.act(request);
                    const next: ControlSnapshot = acted.snapshot!;
                    if (acted.networkIdle === false) {
                        // A site that never goes quiet is not waited for again — the site the
                        // action landed on, as the agent marks it.
                        busyOrigins.add(originOf(next.url));
                    }
                    if (acted.executed) {
                        // What the page SAYS, as the agent measures it: DevTools' fingerprint also
                        // changes with the document's identity, so a reload of the same page would read as progress.
                        const pageChanged: boolean = pageContentKey(next) !== pageContentKey(snapshot);
                        const target: string | undefined = control ? describeControl(control) : undefined;
                        const text: string | undefined =
                            recorded.text && value !== undefined && recorded.operation === Operation.TYPE_TEXT
                                ? shown(recorded.text, value)
                                : undefined;
                        const event: StepEvent = {
                            step: steps.length + 1,
                            mode: StepMode.REPLAY,
                            elapsedMs: elapsed(),
                            operation: recorded.operation,
                            confidence: 1,
                            decisionMs: 0,
                            operationProbabilities: {},
                            target,
                            text,
                            textSource: recorded.text?.source,
                            targetDescriptor: recorded.target,
                            textRef: recorded.text,
                            optionLabel: recorded.optionLabel,
                            ...(recorded.key ? { key: recorded.key } : {}),
                            ...(recorded.tab !== undefined ? { tab: recorded.tab } : {}),
                            ...(recorded.tabUrl ? { tabUrl: recorded.tabUrl } : {}),
                            executed: true,
                            actMs: Math.round(performance.now() - actStarted),
                            url: page.url,
                            pageChanged,
                        };
                        see(next);
                        steps.push(event);
                        journey.step(event);
                        this.options.onStep?.(event);
                        history.push({
                            step: history.length + 1,
                            operation: recorded.operation,
                            target,
                            // The engine reads which key was pressed where the typed text would be.
                            text: text ?? recorded.key,
                            executed: true,
                            pageChanged,
                        });
                        actions++;
                        snapshot = next;
                        break;
                    }
                    // Stale, covered or refused: try again on the fresh snapshot it returned. Each
                    // distinct refusal is recorded once (a retry every poll would drown the history).
                    if (acted.reason && acted.reason !== lastRefusal) {
                        lastRefusal = acted.reason;
                        const target: string | undefined = control ? describeControl(control) : undefined;
                        // The event is shaped as the executed one (a key travels as `key`); the history
                        // entry, as the agent's, carries the key as its text.
                        const text: string | undefined =
                            recorded.text && value !== undefined && recorded.operation === Operation.TYPE_TEXT
                                ? shown(recorded.text, value)
                                : undefined;
                        const refused: StepEvent = {
                            step: steps.length + 1,
                            mode: StepMode.REPLAY,
                            elapsedMs: elapsed(),
                            operation: recorded.operation,
                            confidence: 1,
                            decisionMs: 0,
                            operationProbabilities: {},
                            target,
                            text,
                            textSource: recorded.text?.source,
                            targetDescriptor: recorded.target,
                            textRef: recorded.text,
                            optionLabel: recorded.optionLabel,
                            ...(recorded.key ? { key: recorded.key } : {}),
                            ...(recorded.tab !== undefined ? { tab: recorded.tab } : {}),
                            ...(recorded.tabUrl ? { tabUrl: recorded.tabUrl } : {}),
                            executed: false,
                            reason: acted.reason,
                            actMs: Math.round(performance.now() - actStarted),
                            url: page.url,
                        };
                        // Journaled as the agent journals its refusals: the goal judge reads why.
                        see(next);
                        steps.push(refused);
                        journey.step(refused);
                        this.options.onStep?.(refused);
                        history.push({
                            step: history.length + 1,
                            operation: recorded.operation,
                            target,
                            text: text ?? recorded.key,
                            executed: false,
                            reason: acted.reason,
                        });
                    }
                    snapshot = next;
                }
                if (snapshot.fingerprint !== lastFingerprint) {
                    lastFingerprint = snapshot.fingerprint;
                    unchangedSince = Date.now();
                }
                const settled: boolean = Date.now() - unchangedSince >= settledMs;
                if (Date.now() >= deadline || settled) {
                    const what: string = recorded.target
                        ? `${recorded.operation} ${formatDescriptor(recorded.target)}`
                        : recorded.operation;
                    if (lastRefusal !== undefined) {
                        return result(false, i, `${what}: refused: ${lastRefusal}`);
                    }
                    const why: string = settled
                        ? `the page settled without it for ${settledMs} ms`
                        : `not found within ${stepTimeoutMs} ms`;
                    return result(false, i, `${what}: not on ${pathOf(page.url)} (${why})`);
                }
                const waited: ActResult = await client.act({ action: ControlAction.WAIT, waitMs: POLL_MS, observe: true, ...limits });
                snapshot = waited.snapshot!;
                // A page that appears while waiting for the step's target is a page the run saw.
                see(snapshot);
            }
        }
        return result(true);
    }
}
