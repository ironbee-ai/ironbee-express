#!/usr/bin/env node
/**
 * ibexpress — run one goal in a browser driven through IronBee DevTools, or
 * serve the web UI.
 *
 *   ibexpress run --url https://example.com/ --goal "Open the settings page"
 *   ibexpress ui
 *
 * Configuration comes from the environment (and a `.env` in the working
 * directory); flags override it for one run. See docs/configuration.md.
 */

import { createDevtoolsClient } from "../devtools/generic-client";
import { Command } from "commander";
import { createInterface, Interface } from "readline/promises";
import { AskUser, RescueEvent, RescueState, RunStatus, StepEvent, StepMode, UserActionRequest } from "../agent/agent";
import { TakeoverEnd } from "../agent/rescue";
import { FastConfig, loadConfig, loadDotEnv, parseEnumList } from "../config/config";
import { DevtoolsClient } from "../devtools/client";
import { DaemonHandle, ensureDaemon, freePort } from "../devtools/daemon";
import { daemonEnvFor } from "../ironbee/config";
import { TraceReport } from "../ironbee/trace";
import { profileEnv, ProfileStore, ProfileSummary } from "../profile/profiles";
import { effectiveProfile, RunOutcome, runGoal, RunSpec } from "../run/runner";
import { CacheSummary, RecordingCache } from "../scenario/cache";
import { ScenarioStore, ScenarioSummary } from "../scenario/store";
import { startUiServer, UiServerHandle } from "../server/ui-server";
import { CandidateKind, validateValueName } from "../text/types";
import { Finding, RunAnalysis, Verdict } from "../verify";

interface RunOptions {
    goal?: string;
    scenario?: string;
    saveAs?: string;
    explore: boolean;
    heal: boolean;
    url?: string;
    value: string[];
    secret: string[];
    password: string[];
    valueDesc: string[];
    profile?: string;
    showLogs?: boolean;
    textModel?: string;
    textCandidates?: string;
    headed: boolean;
    daemonUrl?: string;
    daemonScript?: string;
    port?: string;
    record: boolean;
    keepOpen: boolean;
    json: boolean;
}

interface UiOptions {
    port?: string;
    host?: string;
    headed: boolean;
    daemonUrl?: string;
    daemonScript?: string;
}

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/** `name=value`; value may be `env:VAR` to read it from the environment. The name is a key: letters, digits, `.`, `-`, `_`. */
function pairs(list: string[], flag: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const item of list) {
        const eq: number = item.indexOf("=");
        if (eq <= 0) {
            throw new Error(`${flag} expects name=value, got ${item}`);
        }
        const name: string = validateValueName(item.slice(0, eq), flag);
        let value: string = item.slice(eq + 1);
        if (value.startsWith("env:")) {
            const fromEnv: string | undefined = process.env[value.slice(4)];
            if (fromEnv === undefined) {
                throw new Error(`${flag} ${name}: environment variable ${value.slice(4)} is not set`);
            }
            value = fromEnv;
        }
        out[name] = value;
    }
    return out;
}

/** The text model's help when the engine is stuck, as a line: asked, then what it chose or that it could not help. */
function formatRescue(e: RescueEvent): string {
    switch (e.state) {
        case RescueState.ASKING:
            return `    … the engine is stuck (${e.stuck}); ${e.model} takes the controls`;
        case RescueState.LOOKING:
            return `    … ${e.model} looks: ${e.action}${e.why ? ` — ${e.why}` : ""}`;
        case RescueState.ANSWERED:
            return e.end === TakeoverEnd.DONE
                ? `    … ${e.model} confirmed the goal done after ${e.ms}ms: ${e.why}`
                : `    … ${e.model} handed the controls back to the engine after ${e.ms}ms: ${e.why}`;
        case RescueState.NONE:
            return `    … ${e.model} could not get past it (${e.error ?? "no reason"})`;
    }
}

function formatStep(e: StepEvent): string {
    const mark: string = !e.executed ? "✗" : e.pageChanged ? "✓" : "·";
    const target: string = (e.key ? ` ${e.key}` : "") + (e.target ? ` ${e.target}` : "");
    const text: string = e.text !== undefined ? ` ← ${JSON.stringify(e.text)}` : "";
    const decider: string = e.mode === StepMode.RESCUE && e.rescue ? `${e.rescue.model} ` : "";
    const timing: string = `${decider}decide ${e.decisionMs}ms` + (e.actMs !== undefined ? ` act ${e.actMs}ms` : "");
    const reason: string = e.userAction
        ? `  (the user: ${e.userAction.prompt} — ${(e.userAction.waitMs / 1000).toFixed(1)}s)`
        : e.reason
            ? `  (${e.reason})`
            : "";
    return `${String(e.step).padStart(3)} +${(e.elapsedMs / 1000).toFixed(2)}s ${mark} ${e.operation}${target}${text}  [p=${e.confidence.toFixed(2)} ${timing}]${reason}`;
}

const SEVERITY_MARK: Record<string, string> = { critical: "✗✗", major: "✗ ", minor: "· " };

function formatFinding(f: Finding): string {
    return `  ${SEVERITY_MARK[f.severity] ?? "  "} ${f.severity.toUpperCase().padEnd(8)} [${f.source}] ${f.title}\n              ${f.detail}`;
}

function printAnalysis(analysis: RunAnalysis): void {
    console.log(
        `\n${analysis.verdict === Verdict.PASSED ? "PASSED" : "FAILED"} — ${analysis.summary}` +
            `\ngoal ${analysis.goal.state} (p=${analysis.goal.stateProbability.toFixed(2)}) · ` +
            `${analysis.findings.length} problem${analysis.findings.length === 1 ? "" : "s"} in ${analysis.candidates} anomal${analysis.candidates === 1 ? "y" : "ies"} reviewed`
    );
    for (const f of analysis.findings) {
        console.log(formatFinding(f));
    }
}

/**
 * The user's turn at a terminal: they act in the browser window, then press Enter (or type stop).
 * Under --json the prompt goes to stderr, like the warnings: stdout is the result.
 */
function askAtTerminal(json: boolean): AskUser {
    return async (request: UserActionRequest): Promise<boolean> => {
        const rl: Interface = createInterface({ input: process.stdin, output: json ? process.stderr : process.stdout });
        try {
            const answer: string = await rl.question(`\n⏸  Your turn: ${request.prompt}\n   Press Enter to continue, or type "stop": `);
            return answer.trim().toLowerCase() !== "stop";
        } finally {
            rl.close();
        }
    };
}

/** A `--port` flag: a positive integer, refused with the flag's name otherwise (like the env integers). */
function portFlag(value: string | undefined, fallback: number): number {
    if (value === undefined || value === "") {
        return fallback;
    }
    const n: number = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--port ${value} is not a positive integer`);
    }
    return n;
}

async function runCommand(options: RunOptions): Promise<number> {
    if (!options.goal && !options.scenario) {
        throw new Error("--goal or --scenario is required");
    }
    const config: FastConfig = loadConfig();
    // `none` = a fresh browser even when the scenario names a profile.
    const spec: RunSpec = options.profile === undefined ? {} : { profile: options.profile === "none" ? "" : options.profile };
    const profile: string | undefined = effectiveProfile(
        spec,
        options.scenario ? new ScenarioStore(config.scenarioDir).get(options.scenario) : undefined
    );
    const daemonUrl: string | undefined = options.daemonUrl ?? config.daemon.url;
    if (profile && daemonUrl) {
        throw new Error(`The browser profile ${profile} needs a daemon IronBee Express starts itself (drop --daemon-url)`);
    }
    // A profile is fixed when a daemon starts, so a run in one gets a daemon of its own, on a port
    // of its own: an explicit --port would name a daemon it does not use.
    const port: number = portFlag(options.port, config.daemon.port);
    if (profile && options.port !== undefined) {
        throw new Error("--port is not used with --profile: a profile's daemon gets a port of its own");
    }
    // Checked (and revived when local) before every run: an idle daemon exits by itself.
    const daemon: DaemonHandle = await ensureDaemon({
        url: daemonUrl,
        port: profile ? await freePort() : port,
        headless: !options.headed && config.daemon.headless,
        daemonScript: options.daemonScript ?? config.daemon.script,
        env: {
            ...daemonEnvFor(config.ironbee),
            ...(config.daemon.iframes ? { BROWSER_CONTROL_SNAPSHOT_FRAMES: "true" } : {}),
            ...(profile ? profileEnv(new ProfileStore(config.profileDir).ensure(profile)) : {}),
        },
    });
    const client: DevtoolsClient = createDevtoolsClient({ baseUrl: daemon.baseUrl, internalToken: daemon.internalToken });
    let outcome: RunOutcome;
    try {
        outcome = await runGoal(
            {
                goal: options.goal,
                url: options.url,
                values: pairs(options.value, "--value"),
                secrets: { ...pairs(options.secret, "--secret"), ...pairs(options.password, "--password") },
                ...(options.password.length ? { passwords: Object.keys(pairs(options.password, "--password")) } : {}),
                valueDescriptions: pairs(options.valueDesc, "--value-desc"),
                ...spec,
                scenario: options.scenario,
                saveAs: options.saveAs,
                explore: options.explore,
                heal: options.heal,
                textModel: options.textModel,
                textCandidates: options.textCandidates
                    ? parseEnumList(options.textCandidates, CandidateKind, "--text-candidates")
                    : undefined,
                record: options.record,
            },
            config,
            client,
            {
                onStep: options.json
                    ? undefined
                    : (e: StepEvent): void => {
                        console.log(formatStep(e));
                    },
                onRescue: options.json ? undefined : (e: RescueEvent): void => console.log(formatRescue(e)),
                // Under --json stdout is the result: warnings go to stderr, so the run's caveats still reach the operator.
                onWarning: options.json
                    ? (m: string): void => console.error(`warning: ${m}`)
                    : (m: string): void => console.log(`warning: ${m}`),
                // Only a person at a terminal, with a browser window to act in, can take over.
                onUserAction: options.headed && process.stdin.isTTY ? askAtTerminal(options.json === true) : undefined,
            }
        );
    } finally {
        if (!options.keepOpen) {
            await client.close();
            await daemon.stop();
        }
    }
    const result: RunOutcome["result"] = outcome.result;
    if (options.json) {
        // The text model's words on why it failed settle after the verdict; the JSON carries them too.
        await outcome.explanation;
        const { finalSnapshot, ...rest } = result;
        console.log(
            JSON.stringify(
                {
                    ...rest,
                    finalUrl: finalSnapshot.url,
                    mode: outcome.mode,
                    divergence: outcome.divergence,
                    scenario: outcome.scenario,
                    recordingSaved: outcome.recordingSaved,
                    profile: outcome.profile,
                    engine: outcome.engine,
                    generator: outcome.generator,
                    videoPath: outcome.videoPath,
                    videoParts: outcome.videoParts,
                    platform: outcome.platform,
                    analysis: outcome.analysis,
                    analysisError: outcome.analysisError,
                    trace: outcome.trace,
                    traceError: outcome.traceError,
                },
                null,
                2
            )
        );
    } else {
        console.log(
            `\n${result.status.toUpperCase()} in ${(result.elapsedMs / 1000).toFixed(2)}s — ` +
                `${result.actions} actions, ${result.decisions} decisions` +
                (result.reason ? ` (${result.reason})` : "") +
                `\nmode: ${outcome.mode}${outcome.divergence ? ` (${outcome.divergence})` : ""}` +
                `\nengine: ${outcome.engine}${outcome.generator ? ` · text: ${outcome.generator}` : ""}` +
                (outcome.scenario
                    ? `\nscenario: ${outcome.scenario}${outcome.recordingSaved ? " (recording cached)" : ""}`
                    : "") +
                `\nfinal page: ${result.finalSnapshot.url}` +
                (outcome.videoParts ? `\nvideo (${outcome.videoParts.length} parts, one per tab): ${outcome.videoParts.join(", ")}` : outcome.videoPath ? `\nvideo: ${outcome.videoPath}` : "")
        );
        if (outcome.analysis) {
            printAnalysis(outcome.analysis);
            if (outcome.explanation) {
                // The text model's words on why it failed: after the verdict, which they do not change.
                await outcome.explanation;
                const { explanation, explanationError } = outcome.analysis;
                console.log(
                    explanation
                        ? `\nwhy (${explanation.model}, ${(explanation.ms / 1000).toFixed(1)}s): ${explanation.text}`
                        : `\nno explanation: ${explanationError}`
                );
            }
        } else if (outcome.analysisError) {
            console.log(`\nnot reviewed: ${outcome.analysisError}`);
        }
        if (outcome.platform) {
            console.log(
                `IronBee (${outcome.platform.domain}): session ${outcome.platform.sessionId} · trace ${outcome.platform.traceId}` +
                    (outcome.platform.reportError ? ` — NOT reported: ${outcome.platform.reportError}` : " — reported")
            );
        }
        if (outcome.trace) {
            const t: TraceReport = outcome.trace;
            const services: string = t.services
                .map(
                    (s: { name: string; spanCount: number; errorCount: number }): string =>
                        `${s.name} ${s.spanCount}${s.errorCount ? ` (${s.errorCount} failed)` : ""}`
                )
                .join(", ");
            console.log(`trace: ${t.spanCount} spans, ${t.logs.length} logs — ${services || "no services"}`);
            if (options.showLogs) {
                for (const l of t.logs) {
                    console.log(`  · ${(l.severity ?? "LOG").padEnd(5)} ${l.service ? `${l.service}: ` : ""}${l.body}`);
                }
            }
        } else if (outcome.traceError) {
            console.log(`trace: not available — ${outcome.traceError}`);
        }
    }
    const passed: boolean = outcome.analysis ? outcome.analysis.verdict === Verdict.PASSED : result.status === RunStatus.DONE;
    return passed ? 0 : 1;
}

async function uiCommand(options: UiOptions): Promise<void> {
    const config: FastConfig = loadConfig();
    config.ui.port = portFlag(options.port, config.ui.port);
    if (options.host) {
        config.ui.host = options.host;
    }
    if (options.headed) {
        config.daemon.headless = false;
    }
    config.daemon.url = options.daemonUrl ?? config.daemon.url;
    config.daemon.script = options.daemonScript ?? config.daemon.script;
    const server: UiServerHandle = await startUiServer(config);
    console.log(`IronBee Express UI: ${server.url}`);
    const shutdown: () => void = (): void => {
        void server.close().finally((): void => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

export function buildProgram(): Command {
    const program: Command = new Command("ibexpress").description(
        "A fast goal-driven browser agent over IronBee DevTools"
    );
    const daemonOptions: (cmd: Command) => Command = (cmd: Command): Command =>
        cmd
            .option("--headed", "show the browser window", false)
            .option("--daemon-url <url>", "use a running IronBee DevTools daemon")
            .option("--daemon-script <path>", "daemon-server.js to start");

    daemonOptions(
        program
            .command("run")
            .description("run one goal")
            .option("--goal <text>", "what to accomplish (optional with --scenario)")
            .option("--scenario <name>", "run a saved scenario: replay its cached recording, the engine takes over if it diverges")
            .option("--save-as <name>", "save this prompt as a scenario of this name first, then run it as that scenario")
            .option("--explore", "ignore the cached recording: the engine decides every step", false)
            .option("--no-heal", "do not let the engine take over when a replay diverges")
            .option("--url <url>", "start page (default: the session's current page)")
            .option("--value <name=text>", "a value the agent may type (visible to the engine)", collect, [])
            .option(
                "--secret <name=text>",
                "a value typed but never shown to any model; text may be env:VAR",
                collect,
                []
            )
            .option(
                "--password <name=text>",
                "a secret that is a login password: typed into password fields of the start site only; text may be env:VAR",
                collect,
                []
            )
            .option("--value-desc <name=text>", "what a --value / --secret is for, so the engine matches it to the right field", collect, [])
            .option("--profile <name>", "run in this saved browser profile (cookies, storage and logins kept between runs); none = a fresh browser")
            .option("--show-logs", "print every log record of the run's IronBee trace", false)
            .option(
                "--text-model <provider/model>",
                "text model that writes a value when none of the offered ones fits — provider/model: anthropic/…, openai/…, openrouter/… (API key), claude-code/…, codex/… (CLI on PATH), or none"
            )
            .option("--text-candidates <list>", `comma list of ${Object.values(CandidateKind).join(", ")}`)
            .option("--port <n>", "port for a started daemon (not with --profile: its daemon gets a port of its own)")
            .option("--record", "record a video of the run", false)
            .option("--keep-open", "leave the session and daemon running", false)
            .option("--json", "print the result as JSON", false)
    ).action(async (options: RunOptions): Promise<void> => {
        process.exitCode = await runCommand(options);
    });

    const scenarioStores: () => { store: ScenarioStore; cache: RecordingCache } = (): { store: ScenarioStore; cache: RecordingCache } => {
        const config: FastConfig = loadConfig();
        return { store: new ScenarioStore(config.scenarioDir), cache: new RecordingCache(config.cacheDir, config.cacheEntries) };
    };
    const scenarios: Command = program.command("scenarios").description("saved scenarios and their recording cache");
    scenarios
        .command("list")
        .description("list saved scenarios, with how many recordings each has cached")
        .action((): void => {
            const { store, cache } = scenarioStores();
            const all: ScenarioSummary[] = store.list();
            if (all.length === 0) {
                console.log(`No scenarios in ${store.dir}`);
                return;
            }
            for (const s of all) {
                const cached: CacheSummary = cache.summary(s.name);
                const note: string = cached.entries ? `${cached.entries} cached, latest ${cached.latestAt}` : "nothing cached";
                console.log(`${s.name.padEnd(28)} ${note}\n  ${(s.description ?? s.goal).slice(0, 110)}`);
            }
        });
    scenarios
        .command("show <name>")
        .description("print a scenario (secrets are never stored in it)")
        .action((name: string): void => {
            console.log(JSON.stringify(scenarioStores().store.get(name), null, 2));
        });
    scenarios
        .command("delete <name>")
        .description("delete a scenario and its cached recordings")
        .action((name: string): void => {
            const { store, cache } = scenarioStores();
            const deleted: boolean = store.delete(name);
            cache.clear(name);
            console.log(deleted ? `Deleted ${name}` : `No scenario named ${name}`);
            process.exitCode = deleted ? 0 : 1;
        });
    scenarios
        .command("clear-cache [name]")
        .description("drop a scenario's cached recordings (every scenario's with --all): its next run explores")
        .option("--all", "every scenario's cache")
        .action((name: string | undefined, options: { all?: boolean }): void => {
            const { cache } = scenarioStores();
            const names: string[] = options.all ? cache.scenarios() : name ? [name] : [];
            if (names.length === 0) {
                console.log(options.all ? "Nothing cached" : "Name a scenario, or pass --all");
                process.exitCode = options.all ? 0 : 1;
                return;
            }
            for (const n of names) {
                console.log(cache.clear(n) ? `Cleared the cache of ${n}` : `Nothing cached for ${n}`);
            }
        });

    const profiles: Command = program.command("profiles").description("saved browser profiles (logins kept between runs)");
    profiles
        .command("list")
        .description("list saved browser profiles")
        .action((): void => {
            const store: ProfileStore = new ProfileStore(loadConfig().profileDir);
            const all: ProfileSummary[] = store.list();
            if (all.length === 0) {
                console.log(`No profiles in ${store.dir}`);
                return;
            }
            for (const p of all) {
                console.log(`${p.name.padEnd(24)} last used ${p.lastUsedAt}`);
            }
        });
    profiles
        .command("delete <name>")
        .description("delete a profile: every cookie, storage entry and login in it")
        .action((name: string): void => {
            new ProfileStore(loadConfig().profileDir).delete(name);
            console.log(`Deleted ${name}`);
        });

    daemonOptions(
        program
            .command("ui")
            .description("serve the web UI (live view of each run)")
            .option("--port <n>", "UI port")
            .option("--host <host>", "UI bind address (default 127.0.0.1)")
    ).action(async (options: UiOptions): Promise<void> => {
        await uiCommand(options);
    });
    return program;
}

if (require.main === module) {
    loadDotEnv();
    buildProgram()
        .parseAsync(process.argv)
        .catch((err: unknown): void => {
            console.error(err instanceof Error ? err.message : err);
            process.exitCode = 1;
        });
}
