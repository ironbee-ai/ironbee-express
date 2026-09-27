/**
 * One run, end to end, shared by the CLI and the web UI.
 *
 * - With a scenario whose recording cache holds one for its current prompt
 *   (goal + start URL), the recording is REPLAYED (no decision engine). If the replay diverges, or
 *   the goal is not shown done after it, the engine takes over from where it
 *   stopped (HEAL) — unless healing is off or the engine is unavailable.
 * - Otherwise the engine EXPLORES; a DONE the evidence does not bear out is
 *   rejected (agent.ts).
 * - Then the engine REVIEWS the run: the final page, the app's requests,
 *   console errors and — with IronBee — the settled trace (spans and logs).
 *   It judges whether the goal is done and which anomalies are real problems
 *   (verify/analyzer.ts). The user writes no checks.
 * - A scenario's run whose review passes, explored or healed, is cached as
 *   that prompt's recording. The scenario itself is never written by a run:
 *   only `saveAs` (an explicit save, before the run) writes one.
 *
 * Optionally records a video (which also marks actions and feeds a live
 * view). The daemon is the caller's: this function only uses a client.
 */

import { Agent, AskUser, RescueEvent, RunResult, RunStatus, StepEvent, StepMode } from "../agent/agent";
import { EngineDecider, Operation } from "../agent/policy";
import { LlmTakeover } from "../agent/rescue";
import { FastConfig } from "../config/config";
import { DevtoolsClient, RecordingStopped } from "../devtools/client";
import { boundOriginOf, newFrameHosts, SeededSecrets, secretBundle } from "../devtools/secrets";
import { ControlSnapshot } from "../devtools/types";
import { createEngine } from "../engine";
import { DecisionEngine, EngineHealth } from "../engine/types";
import { RunReporter, RunVerdict, VerdictStatus } from "../ironbee/reporter";
import { readTrace, TraceReport } from "../ironbee/trace";
import { recordSteps } from "../scenario/recording";
import { missingSecrets, ReplayResult, Replayer } from "../scenario/replayer";
import { RecordingCache } from "../scenario/cache";
import { promptHash, ScenarioStore, validateScenarioName } from "../scenario/store";
import { Recording, RunMode, Scenario, SCENARIO_FORMAT_VERSION } from "../scenario/types";
import { createTextStrategy, TextConfig } from "../text";
import { maskSecretsEncoded } from "../text/mask";
import { validateProfileName } from "../profile/profiles";
import { parseTextModel } from "../text/providers";
import { CandidateKind, TextStrategy } from "../text/types";
import { sleep } from "../util/time";
import { JourneyRecorder } from "../verify/journey";
import {
    CapturedRequest,
    explainFailure,
    Explanation,
    Finding,
    GoalJudge,
    GoalJudgement,
    GoalState,
    PageEvidence,
    readEvidence,
    ReadEvidence,
    RunAnalysis,
    RunAnalyzer,
    traceEvidence,
    Verdict,
} from "../verify";

export interface RunSpec {
    /** Required unless a scenario provides it. */
    goal?: string;
    url?: string;
    values?: Record<string, string>;
    secrets?: Record<string, string>;
    /** The secrets that are login passwords (typed into password inputs only); added to the loaded scenario's markings, never replacing them. */
    passwords?: string[];
    /** What each value / secret is for, by name — helps the engine match it to a field. */
    valueDescriptions?: Record<string, string>;
    /** Per-run overrides of the configured text setup; textModel `provider/model` or "none". */
    textModel?: string;
    textCandidates?: CandidateKind[];
    /**
     * The saved browser profile to run in; "" = a fresh browser even when the
     * scenario names a profile; absent = the scenario's (else fresh). The
     * caller starts the daemon in it — see {@link effectiveProfile}.
     */
    profile?: string;
    /** Run this saved scenario (its goal, URL, values — overridable above). */
    scenario?: string;
    /** Save this prompt as a scenario of this name first (an explicit save), then run it as that scenario. */
    saveAs?: string;
    /** Ignore a recording and let the engine decide every step. */
    explore?: boolean;
    /** Let the engine take over when a replay diverges (default true). */
    heal?: boolean;
    /** Record a video (and, with a live-view daemon, stream frames). */
    record?: boolean;
    recordDir?: string;
    /** Return before the review; `outcome.reviewReady` resolves with it. */
    deferReview?: boolean;
}

/** The engine's review of the run, and what it was read from. */
export interface RunReview {
    analysis?: RunAnalysis;
    /** Why there is no review (the engine is unavailable, the run was cancelled …). */
    analysisError?: string;
    /** The run's trace on the IronBee platform. */
    trace?: TraceReport;
    traceError?: string;
    /** The run's recording was cached for its scenario and prompt (explored or healed, and passed). */
    recordingSaved: boolean;
    /**
     * A failed run with a text model: its explanation, settling after the review (the verdict is not
     * held for it). It fills `analysis.explanation` (or `explanationError`) as it settles.
     */
    explanation?: Promise<void>;
}

/** Waiting for a run's spans to be ingested, then for their count to hold. */
const TRACE_WAIT_MS: number = 10_000;
const TRACE_SETTLE_MS: number = 8_000;

/** After a completed replay, a goal not shown done is re-judged this many times, this far apart. */
const REPLAY_REJUDGES: number = 3;
const REPLAY_REJUDGE_MS: number = 1_000;

/** Response bodies kept per request for the UI. */
const MAX_REQUEST_BODY_CHARS: number = 20_000;

export enum RunPhase {
    PREPARING = "preparing",
    RUNNING = "running",
    /** The run is over; the engine reviews it. */
    REVIEWING = "reviewing",
    FINISHED = "finished",
}

export interface RunHooks {
    onPhase?: (phase: RunPhase, detail: string) => void;
    /** Something did not go as configured, and the run goes on without it (a platform send failed, the daemon refused run metadata …). */
    onWarning?: (message: string) => void;
    onStep?: (event: StepEvent) => void;
    /** The run's clock starts: navigation and the first page load are over, `elapsedMs` counts from here. */
    onClockStart?: () => void;
    /** The run's clock stopped at `elapsedMs`, its result's time. */
    onClockStop?: (elapsedMs: number) => void;
    /** The engine got stuck and a text model is asked for the next step (asked, then answered or not). */
    onRescue?: (event: RescueEvent) => void;
    /**
     * A person who can take the browser over (a social login, a CAPTCHA, a
     * value nothing else provides). Resolve true when they are done, false to
     * stop the run. Without it the engine is never offered ASK_USER.
     */
    onUserAction?: AskUser;
}

export interface RunOutcome extends Partial<RunReview> {
    result: RunResult;
    mode: RunMode;
    engine: string;
    generator?: string;
    videoPath?: string;
    /** Every video part in order, when the run switched tabs (the first is `videoPath`). */
    videoParts?: string[];
    /** The scenario the run belonged to, if any. */
    scenario?: string;
    /** The saved browser profile it ran in; absent = a fresh browser. */
    profile?: string;
    /** Why a replay handed over to the engine. */
    divergence?: string;
    /** The run on the IronBee platform, when reporting is on. */
    platform?: { sessionId: string; traceId: string; domain: string; reportError?: string };
    /** The app's fetch/xhr requests during the run (bodies clipped, secrets masked). */
    requests?: CapturedRequest[];
    /** With `deferReview`: resolves with the review once the trace has settled and the engine judged. */
    reviewReady?: Promise<RunReview>;
}

/** The platform verdict: the review's, or the run's status when there is none. */
export function platformVerdict(result: RunResult, goal: string, analysis?: RunAnalysis): RunVerdict {
    if (!analysis) {
        const ok: boolean = result.status === RunStatus.DONE;
        return {
            status: ok ? VerdictStatus.PASS : VerdictStatus.FAIL,
            checks: ok ? [`goal reached: ${goal}`.slice(0, 300)] : [],
            issues: ok ? [] : [`${result.status}: ${result.reason ?? ""}`.slice(0, 300)],
        };
    }
    const goalLine: string = `goal ${analysis.goal.state} (p=${analysis.goal.stateProbability.toFixed(2)}): ${goal}`.slice(0, 300);
    const issues: string[] = analysis.findings.map((f: Finding): string => `${f.severity}: ${f.title} — ${f.detail}`.slice(0, 300));
    return {
        status: analysis.verdict === Verdict.PASSED ? VerdictStatus.PASS : VerdictStatus.FAIL,
        checks: analysis.goal.achieved ? [goalLine] : [],
        issues: analysis.goal.achieved ? issues : [goalLine, ...issues],
    };
}

/** The profile a run uses: its own choice ("" = fresh), else its scenario's; undefined = fresh. */
export function effectiveProfile(spec: RunSpec, scenario: Scenario | undefined): string | undefined {
    const profile: string | undefined = spec.profile !== undefined ? spec.profile : scenario?.profile;
    return profile ? validateProfileName(profile) : undefined;
}

/** The effective run: a scenario's definition overlaid with this run's inputs. */
interface EffectiveRun {
    goal: string;
    url?: string;
    values: Record<string, string>;
    secrets: Record<string, string>;
    /** Of `secrets`, the login passwords. */
    passwords: string[];
    descriptions: Record<string, string>;
    textModel?: string;
    textCandidates?: CandidateKind[];
    profile?: string;
}

/** Replaceable collaborators (tests pass a fake engine). */
export interface RunDeps {
    engine?: DecisionEngine;
}

export function textConfigFor(config: FastConfig, run: { textModel?: string; textCandidates?: CandidateKind[] }): TextConfig {
    return {
        ...config.text,
        model: run.textModel !== undefined ? parseTextModel(run.textModel) : config.text.model,
        candidates: run.textCandidates ?? config.text.candidates,
    };
}

/** Writes the run's prompt as a scenario (an explicit save): its values, secret names and text setup. */
function saveScenario(store: ScenarioStore, name: string, run: EffectiveRun, loaded: Scenario | undefined): Scenario {
    const now: string = new Date().toISOString();
    const base: Scenario | undefined = loaded?.name === name ? loaded : store.exists(name) ? store.get(name) : undefined;
    // Both markings: a loaded scenario's password stays one, whichever secrets this run passed.
    const passwordSecrets: string[] = [...new Set([...run.passwords, ...(loaded?.passwordSecrets ?? [])])];
    return store.save({
        formatVersion: SCENARIO_FORMAT_VERSION,
        name,
        ...(base?.description ? { description: base.description } : {}),
        goal: run.goal,
        url: run.url,
        values: run.values,
        // A loaded scenario's declared secrets and password markings are kept: a save must not
        // weaken the next run's binding (a password typed only into password inputs).
        secretNames: [...new Set([...Object.keys(run.secrets), ...(loaded?.secretNames ?? [])])],
        ...(passwordSecrets.length ? { passwordSecrets } : {}),
        ...(Object.keys(run.descriptions).length ? { descriptions: run.descriptions } : {}),
        textCandidates: run.textCandidates,
        textModel: run.textModel,
        ...(run.profile ? { profile: run.profile } : {}),
        createdAt: base?.createdAt ?? now,
        updatedAt: now,
    });
}

function effectiveRun(spec: RunSpec, scenario: Scenario | undefined): EffectiveRun {
    const goal: string | undefined = spec.goal?.trim() || scenario?.goal;
    if (!goal) {
        throw new Error("A goal is required (or a scenario that has one)");
    }
    return {
        goal,
        url: spec.url ?? scenario?.url,
        values: { ...scenario?.values, ...spec.values },
        secrets: { ...spec.secrets },
        // The union: an explicit --password adds a marking, it never drops the scenario's.
        passwords: [...new Set([...(spec.passwords ?? []), ...(scenario?.passwordSecrets ?? [])])].filter(
            (name: string): boolean => Object.hasOwn(spec.secrets ?? {}, name)
        ),
        descriptions: dropEmpty({ ...scenario?.descriptions, ...spec.valueDescriptions }),
        textModel: spec.textModel ?? scenario?.textModel,
        textCandidates: spec.textCandidates ?? scenario?.textCandidates,
        profile: effectiveProfile(spec, scenario),
    };
}

function dropEmpty(map: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(map).filter(([, v]: [string, string]): boolean => v.trim().length > 0));
}

/** A finished replay as a run result (no engine decisions). */
function replayResult(replay: ReplayResult, status: RunStatus, reason?: string, goal?: GoalJudgement): RunResult {
    return {
        status,
        reason,
        elapsedMs: replay.elapsedMs,
        actions: replay.actions,
        decisions: 0,
        steps: replay.steps,
        finalSnapshot: replay.snapshot,
        ...(goal ? { goal } : {}),
        journey: replay.journey,
    };
}

export async function runGoal(
    spec: RunSpec,
    config: FastConfig,
    client: DevtoolsClient,
    hooks: RunHooks = {},
    signal?: AbortSignal,
    deps: RunDeps = {}
): Promise<RunOutcome> {
    const store: ScenarioStore = new ScenarioStore(config.scenarioDir);
    // A cache directory the run cannot write is a warning, never the run's failure.
    const cache: RecordingCache = new RecordingCache(config.cacheDir, config.cacheEntries, (m: string): void => hooks.onWarning?.(m));
    const loaded: Scenario | undefined = spec.scenario ? store.get(spec.scenario) : undefined;
    const saveAs: string | undefined = spec.saveAs ? validateScenarioName(spec.saveAs) : undefined;
    const run: EffectiveRun = effectiveRun(spec, loaded);
    // An empty secret would be typed as nothing: the login fails and the run blames the page.
    const unset: string[] = Object.keys(run.secrets).filter((name: string): boolean => run.secrets[name] === "");
    if (unset.length) {
        throw new Error(`The secret(s) ${unset.join(", ")} have no value: enter them (secrets are never saved, so a loaded scenario asks for them again)`);
    }
    const hash: string = promptHash(run.goal, run.url);
    // Checked before anything is written: a run refused for its secrets saves nothing, and the
    // secrets a loaded scenario declares are asked for whatever name it is saved under.
    const target: string | undefined = saveAs ?? loaded?.name;
    // Read without marking it used: a run refused for its secrets never replayed, and must not
    // count as a use for the cache's least-recently-used order.
    const recording: Recording | undefined = !spec.explore && target ? cache.peek(target, hash) : undefined;
    const missing: string[] = recording ? missingSecrets(recording, run.secrets) : [];
    const expectedSecrets: string[] = (loaded?.secretNames ?? []).filter((n: string): boolean => !Object.hasOwn(run.secrets, n));
    if (missing.length || expectedSecrets.length) {
        throw new Error(
            `Scenario ${loaded?.name ?? target} needs the secret(s) ${[...new Set([...missing, ...expectedSecrets])].join(", ")} (pass --secret name=… )`
        );
    }
    // An explicit save writes the prompt now, whatever the run then does.
    const scenario: Scenario | undefined = saveAs ? saveScenario(store, saveAs, run, loaded) : loaded;
    if (recording) {
        cache.get(scenario!.name, hash);
    }

    const engine: DecisionEngine = deps.engine ?? createEngine(config.engine);
    const health: EngineHealth = await engine.health();
    const heal: boolean = spec.heal !== false && health.ok;
    if (!health.ok && !recording) {
        throw new Error(`${engine.label} is not usable: ${health.detail}`);
    }
    // Without the engine a replay still runs; nothing judges it.
    const goalJudge: GoalJudge | undefined = health.ok ? new GoalJudge(engine) : undefined;
    // Secrets live in DevTools when this process started the daemon: typed by
    // reference, bound to the start URL's site, masked in what DevTools returns.
    const origin: string | undefined = boundOriginOf(run.url);
    const seeded: SeededSecrets | undefined =
        client.canSeedSecrets && origin && Object.keys(run.secrets).length > 0
            ? secretBundle(run.secrets, run.descriptions, run.passwords, origin)
            : undefined;
    const textConfig: TextConfig = textConfigFor(config, run);
    // The text model that writes values also takes the controls when the engine is stuck.
    const takeover: LlmTakeover | undefined = textConfig.model
        ? new LlmTakeover({ model: textConfig.model, settings: textConfig.providers[textConfig.model.provider] })
        : undefined;
    const text: TextStrategy = createTextStrategy(run.goal, textConfig, {
        values: run.values,
        secrets: run.secrets,
        descriptions: run.descriptions,
        secretRefs: seeded?.refs,
    }, hooks.onUserAction !== undefined);
    const warmUp: (() => Promise<void>) | undefined = (text.generator as { warmUp?: () => Promise<void> } | undefined)
        ?.warmUp;
    // The engine's connection opens while the text model loads and the page navigates.
    engine.warmUp?.();
    if (warmUp && (!recording || heal)) {
        hooks.onPhase?.(RunPhase.PREPARING, `loading ${text.generator!.label}`);
        await warmUp.call(text.generator);
    }
    const limits: { maxControls: number; maxTextChars: number } = { maxControls: 250, maxTextChars: 6_000 };
    /** When the start page began to load: the run's own traffic is read from here. */
    let startPageAtMs: number | undefined;
    const agent: (options: { url?: string; replay?: ReplayResult }) => Agent = (options: { url?: string; replay?: ReplayResult }): Agent =>
        new Agent({
            client,
            decider: new EngineDecider(engine),
            goal: run.goal,
            url: options.url,
            text,
            goalJudge,
            maxActions: config.maxActions,
            maxDecisions: config.maxDecisions,
            signal,
            onStep: hooks.onStep,
            askUser: hooks.onUserAction,
            initialHistory: options.replay?.history,
            stepOffset: options.replay?.steps.length,
            initialJourney: options.replay?.journey,
            evidenceSinceMs: options.replay?.startedAtMs ?? startPageAtMs,
            elapsedOffsetMs: options.replay?.elapsedMs,
            // The replay's hand-overs count toward the run's limit: a heal does not start a new one.
            initialUserActions: options.replay?.steps.filter(
                (s: StepEvent): boolean => s.operation === Operation.ASK_USER && s.executed
            ).length,
            onClockStart: hooks.onClockStart,
            takeover,
            onRescue: hooks.onRescue,
            // A screenshot shows what is on the screen: only passwords are drawn as dots.
            screenshotSafe: Object.keys(run.secrets).every((name: string): boolean => run.passwords.includes(name)),
        });

    // IronBee platform: the run is a session there, every DevTools call carries its ids.
    const reporter: RunReporter | undefined = config.ironbee.enabled
        ? new RunReporter(config.ironbee, fetch, (m: string): void => hooks.onWarning?.(m))
        : undefined;
    if (reporter) {
        client.setMetadata(reporter.metadataFor());
        client.onMetadataRejected = (): void =>
            hooks.onWarning?.(
                "the DevTools daemon does not accept run metadata (TOOL_INPUT_METADATA_ENABLE): tool calls are not reported"
            );
        reporter.start(scenario?.name ?? run.goal, run.goal);
    }

    const runStartedMs: number = Date.now();
    let videoRecording: boolean = false;
    let videoPath: string | undefined;
    let videoParts: string[] | undefined;
    let result: RunResult;
    let mode: RunMode;
    let divergence: string | undefined;
    try {
        if (seeded) {
            await client.seedSecrets(seeded.bundle);
            if (config.daemon.iframes) {
                // IBEXPRESS_IFRAMES: a frame the START SITE embeds (its payment
                // form, its login widget) may be typed into as well — the
                // secrets (not a password) are bound to its host too, as soon
                // as its controls are offered. Frames on other sites the run
                // reaches are never added.
                const frameHosts: string[] = [];
                let rebindFailed: boolean = false;
                client.onSnapshot = async (page: ControlSnapshot): Promise<void> => {
                    // After a failed re-seed the binding stays as it is (no churn on every snapshot).
                    if (rebindFailed || boundOriginOf(page.url) !== origin) {
                        return;
                    }
                    const hosts: string[] = newFrameHosts(page, [origin!, ...frameHosts]);
                    if (hosts.length === 0) {
                        return;
                    }
                    const previous: SeededSecrets = secretBundle(run.secrets, run.descriptions, run.passwords, origin!, frameHosts);
                    frameHosts.push(...hosts);
                    try {
                        await client.seedSecrets(secretBundle(run.secrets, run.descriptions, run.passwords, origin!, frameHosts).bundle);
                    } catch (err: unknown) {
                        // Not left without secrets: the binding as it was, and said so.
                        rebindFailed = true;
                        frameHosts.splice(frameHosts.length - hosts.length);
                        await client.seedSecrets(previous.bundle).catch((): void => undefined);
                        hooks.onWarning?.(
                            `secrets were not extended to ${hosts.join(", ")}: ${err instanceof Error ? err.message : String(err)}`
                        );
                    }
                };
            }
        }
        // The start page opens before the video starts: a site's first-visit check page, which
        // `navigate` loads past, is not part of the run and is not shown in the video or live view.
        // After the secrets: a `headers` secret rides the start page's own requests.
        startPageAtMs = Date.now();
        if (run.url) {
            hooks.onPhase?.(RunPhase.PREPARING, `opening ${run.url}`);
            startPageAtMs = await client.navigate(run.url);
        }
        if (spec.record) {
            await client.startRecording(spec.recordDir);
            videoRecording = true;
        }
        if (recording) {
            hooks.onPhase?.(RunPhase.RUNNING, `replaying ${scenario!.name} (${recording.steps.length} steps)`);
            const replay: ReplayResult = await new Replayer({
                client,
                limits,
                text,
                evidenceSinceMs: startPageAtMs,
                signal,
                onStep: hooks.onStep,
                onClockStart: hooks.onClockStart,
                askUser: hooks.onUserAction,
            }).run(
                recording
            );
            let goal: GoalJudgement | undefined;
            if (replay.completed && goalJudge) {
                // The last step may still be loading its page: re-judge a few times
                // before handing a not-yet-done goal to the engine. The judging is run time,
                // as an explored run's DONE judgement is: the replay's clock carries it on.
                const judgeStarted: number = performance.now();
                for (let attempt: number = 0; ; attempt++) {
                    const read: ReadEvidence = await readEvidence(client, replay.startedAtMs, limits, run.secrets);
                    // The fresh page is the run's final page: masked as the replayer masks its own,
                    // and seen by the journey the judge reads (as the agent sees before judging).
                    const seen: ControlSnapshot = maskSecretsEncoded(read.snapshot, run.secrets);
                    replay.snapshot = { ...read.snapshot, url: seen.url };
                    const journey: JourneyRecorder = new JourneyRecorder(replay.journey);
                    journey.see(seen);
                    replay.journey = journey.get();
                    goal = await goalJudge.judge(run.goal, { ...read.evidence, journey: replay.journey });
                    if (goal.achieved || goal.state === GoalState.FAILED || attempt >= REPLAY_REJUDGES || signal?.aborted) {
                        break;
                    }
                    await sleep(REPLAY_REJUDGE_MS);
                }
                replay.elapsedMs += Math.round(performance.now() - judgeStarted);
            }
            if (replay.completed && (goal === undefined || goal.achieved)) {
                const done: StepEvent = {
                    step: replay.steps.length + 1,
                    mode: StepMode.REPLAY,
                    elapsedMs: replay.elapsedMs,
                    operation: Operation.DONE,
                    confidence: 1,
                    decisionMs: 0,
                    operationProbabilities: {},
                    executed: true,
                    url: replay.snapshot.url,
                    ...(goal ? { goal } : {}),
                };
                replay.steps.push(done);
                hooks.onStep?.(done);
                result = replayResult(replay, RunStatus.DONE, undefined, goal);
                mode = RunMode.REPLAY;
            } else if (replay.completed && goal?.state === GoalState.FAILED) {
                // The recording did its part and the app failed: nothing for the engine to heal.
                const replayDone: StepEvent = {
                    step: replay.steps.length + 1,
                    mode: StepMode.REPLAY,
                    elapsedMs: replay.elapsedMs,
                    operation: Operation.DONE,
                    confidence: 1,
                    decisionMs: 0,
                    operationProbabilities: {},
                    executed: false,
                    reason: `the goal failed${goal.signals?.length ? `; the evidence shows ${goal.signals.join("; ")}` : ""}`,
                    url: replay.snapshot.url,
                    goal,
                };
                replay.steps.push(replayDone);
                hooks.onStep?.(replayDone);
                result = replayResult(replay, RunStatus.FAILED, replayDone.reason, goal);
                mode = RunMode.REPLAY;
            } else {
                divergence = replay.completed
                    ? `replayed every step, but the goal is not done yet (p=${goal!.probability.toFixed(2)})`
                    : `recorded step ${(replay.divergedAt ?? 0) + 1}: ${replay.reason}`;
                if (replay.stopped) {
                    // "stop" at a recorded hand-over ends the run, as it does in an explored one.
                    result = replayResult(replay, RunStatus.CANCELLED, "stopped by the user", goal);
                    mode = RunMode.REPLAY;
                } else if (!heal || signal?.aborted) {
                    result = replayResult(
                        replay,
                        signal?.aborted ? RunStatus.CANCELLED : replay.completed ? RunStatus.FAILED : RunStatus.BLOCKED,
                        `replay diverged at ${divergence}${!health.ok ? ` (the engine could not take over: ${health.detail})` : ""}`,
                        goal
                    );
                    mode = RunMode.REPLAY;
                } else {
                    if (replay.completed && goal) {
                        // Every step replayed and the goal judged not done: the healing engine is told so,
                        // as the agent tells itself after a rejected DONE — its history otherwise ends in a
                        // finished-looking replay, and its first decision would be the same DONE again.
                        const shown: string = goal.signals?.length ? `; the evidence shows ${goal.signals.join("; ")}` : "";
                        const reason: string = `DONE rejected: the goal is not done yet (p=${goal.probability.toFixed(2)})${shown}`;
                        const rejected: StepEvent = {
                            step: replay.steps.length + 1,
                            mode: StepMode.REPLAY,
                            elapsedMs: replay.elapsedMs,
                            operation: Operation.DONE,
                            confidence: 1,
                            decisionMs: 0,
                            operationProbabilities: {},
                            executed: false,
                            reason,
                            url: replay.snapshot.url,
                            goal,
                        };
                        replay.steps.push(rejected);
                        replay.history.push({ step: replay.history.length + 1, operation: Operation.DONE, executed: false, reason });
                        const journey: JourneyRecorder = new JourneyRecorder(replay.journey);
                        journey.see(maskSecretsEncoded(replay.snapshot, run.secrets));
                        journey.step(rejected);
                        replay.journey = journey.get();
                        hooks.onStep?.(rejected);
                    }
                    hooks.onPhase?.(RunPhase.RUNNING, `replay diverged (${divergence}); ${engine.label} takes over`);
                    const rest: RunResult = await agent({ replay }).run();
                    result = {
                        ...rest,
                        // The agent's clock already continues from the replay's.
                        actions: replay.actions + rest.actions,
                        steps: [...replay.steps, ...rest.steps],
                    };
                    mode = RunMode.REPLAY_HEALED;
                }
            }
        } else {
            hooks.onPhase?.(RunPhase.RUNNING, `${engine.label}${text.generator ? ` + ${text.generator.label}` : ""}`);
            result = await agent({}).run();
            mode = RunMode.EXPLORE;
        }
        // The run's time is final; what follows (the video, the evidence read) is not the run's.
        hooks.onClockStop?.(result.elapsedMs);
    } catch (err: unknown) {
        // The run is over without a result: the platform's session closes with the error, not left open.
        if (reporter) {
            const message: string = err instanceof Error ? err.message : String(err);
            reporter.finish({ status: VerdictStatus.FAIL, checks: [], issues: [message.slice(0, 300)] }, "error", message);
            await reporter.flush();
        }
        throw err;
    } finally {
        if (seeded) {
            // The run types nothing more; the review reads with the values masked here.
            client.onSnapshot = undefined;
            await client.clearSecrets().catch((): void => undefined);
        }
        if (videoRecording) {
            const stopped: RecordingStopped = await client.stopRecording().catch((): RecordingStopped => ({}));
            videoPath = stopped.filePath;
            videoParts = stopped.parts && stopped.parts.length > 1 ? stopped.parts : undefined;
        }
    }

    // The evidence the review reads, now, while the page is as the run left it.
    let evidence: PageEvidence | undefined;
    let requests: CapturedRequest[] | undefined;
    try {
        // A request is logged once its body is read: let the last page's calls land.
        await client.settleNetwork(3_000);
        // From the load the start page shows: a refused first visit (see `navigate`) is not the run's.
        evidence = (await readEvidence(client, startPageAtMs ?? runStartedMs, limits, run.secrets, { console: true })).evidence;
        requests = (evidence.requests ?? []).map(
            (r: CapturedRequest): CapturedRequest => ({
                ...r,
                ...(r.body !== undefined ? { body: r.body.slice(0, MAX_REQUEST_BODY_CHARS) } : {}),
                ...(r.requestBody !== undefined ? { requestBody: r.requestBody.slice(0, MAX_REQUEST_BODY_CHARS) } : {}),
            })
        );
    } catch {
        // The review then says it had nothing to read.
    }
    const cancelled: boolean = result.status === RunStatus.CANCELLED;
    hooks.onPhase?.(cancelled ? RunPhase.FINISHED : RunPhase.REVIEWING, cancelled ? (videoPath ?? "") : `${engine.label} reviews the run`);

    /** Trace (settled) → engine review → platform verdict → recording. `outcome.platform` learns how the final sends went. */
    const review: (outcome: RunOutcome) => Promise<RunReview> = async (outcome: RunOutcome): Promise<RunReview> => {
        const out: RunReview = { recordingSaved: false };
        if (reporter && !cancelled) {
            try {
                // Read after the secrets left DevTools: masked here, encoded forms included.
                out.trace = maskSecretsEncoded(
                    await readTrace(client, reporter.ids.traceId, {
                        waitMs: TRACE_WAIT_MS,
                        settleSpansMs: TRACE_SETTLE_MS,
                        settleLogsMs: TRACE_SETTLE_MS,
                    }),
                    run.secrets
                );
            } catch (err: unknown) {
                out.traceError = err instanceof Error ? err.message : String(err);
            }
        }
        if (cancelled) {
            out.analysisError = "the run was cancelled";
        } else if (!health.ok) {
            out.analysisError = `${engine.label} is not usable: ${health.detail}`;
        } else if (!evidence) {
            out.analysisError = "the final page could not be read";
        } else {
            try {
                out.analysis = await new RunAnalyzer(engine).analyze(
                    run.goal,
                    {
                        ...evidence,
                        ...(result.journey ? { journey: result.journey } : {}),
                        ...(out.trace ? { trace: traceEvidence(out.trace) } : {}),
                    },
                    result.status === RunStatus.DONE,
                    result.goal?.confirmedBy
                );
            } catch (err: unknown) {
                out.analysisError = err instanceof Error ? err.message : String(err);
            }
        }
        // Why it failed, in words, by the text model when there is one — after the verdict, not before it.
        const analysis: RunAnalysis | undefined = out.analysis;
        if (analysis && evidence && analysis.verdict === Verdict.FAILED && textConfig.model) {
            const read: PageEvidence = {
                ...evidence,
                ...(result.journey ? { journey: result.journey } : {}),
                ...(out.trace ? { trace: traceEvidence(out.trace) } : {}),
            };
            out.explanation = explainFailure(
                { model: textConfig.model, settings: textConfig.providers[textConfig.model.provider] },
                run.goal,
                `${result.status}${result.reason ? `: ${result.reason}` : ""}`,
                analysis,
                read
            ).then(
                (explanation: Explanation): void => {
                    analysis.explanation = explanation;
                },
                (err: unknown): void => {
                    analysis.explanationError = err instanceof Error ? err.message : String(err);
                }
            );
        }
        if (reporter) {
            reporter.finish(platformVerdict(result, run.goal, out.analysis), result.status, out.analysis?.summary ?? result.reason);
            await reporter.flush();
            if (outcome.platform && reporter.failure) {
                outcome.platform.reportError = reporter.failure;
            }
        }
        // Cache what worked: a scenario's run explored or healed anew, for this prompt — and only one
        // the review PASSED; a run nothing reviewed (the engine unreachable, the page unreadable) is not cached.
        const passed: boolean = out.analysis?.verdict === Verdict.PASSED;
        if (scenario && mode !== RunMode.REPLAY && passed) {
            const now: string = new Date().toISOString();
            out.recordingSaved = cache.put(scenario.name, {
                promptHash: hash,
                goal: run.goal,
                ...(run.url ? { url: run.url } : {}),
                recording: {
                    promptHash: hash,
                    recordedAt: now,
                    engine: engine.label,
                    steps: recordSteps(result.steps),
                    elapsedMs: result.elapsedMs,
                    ...(mode === RunMode.REPLAY_HEALED ? { healedAt: now } : {}),
                },
            });
        }
        if (!cancelled) {
            // A cancelled run was announced finished above, before the review.
            hooks.onPhase?.(RunPhase.FINISHED, videoPath ?? "");
        }
        return out;
    };

    const outcome: RunOutcome = {
        result,
        mode,
        engine: engine.label,
        generator: text.generator?.label,
        videoPath,
        ...(videoParts ? { videoParts } : {}),
        scenario: scenario?.name,
        ...(run.profile ? { profile: run.profile } : {}),
        divergence,
        ...(requests ? { requests } : {}),
        ...(reporter
            ? {
                platform: {
                    sessionId: reporter.ids.sessionId,
                    traceId: reporter.ids.traceId,
                    domain: config.ironbee.domain,
                    ...(reporter.failure ? { reportError: reporter.failure } : {}),
                },
            }
            : {}),
    };
    if (spec.deferReview) {
        outcome.reviewReady = review(outcome);
    } else {
        Object.assign(outcome, await review(outcome));
    }
    return outcome;
}
