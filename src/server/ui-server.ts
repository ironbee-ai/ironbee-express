/**
 * The local web UI: a form to start a run, a live view of the page with each
 * action marked, the decision behind every step, and the outcome checks.
 *
 * One process serves the static UI, a small JSON API, the viewers' websocket
 * and the live-view hub, and owns a DevTools daemon started with the hub's
 * address — so every run's recording streams here. One run at a time.
 *
 * Bound to loopback by default. Mutating requests and websocket upgrades must
 * come from the UI's own origin; the producer endpoint needs the per-process
 * token the daemon was started with.
 */

import { createDevtoolsClient } from "../devtools/generic-client";
import { randomUUID } from "crypto";
import { createReadStream, existsSync, readFileSync, ReadStream, statSync } from "fs";
import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from "http";
import { isIP } from "net";
import { extname, join } from "path";
import { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import { AskUser, RescueEvent, RunResult, StepEvent, UserActionRequest } from "../agent/agent";
import { CapturedRequest } from "../verify";
import { FastConfig } from "../config/config";
import { DevtoolsClient } from "../devtools/client";
import { DaemonHandle, ensureDaemon, freePort, isDaemonHealthy } from "../devtools/daemon";
import { profileEnv, ProfileStore, validateProfileName } from "../profile/profiles";
import { createEngine } from "../engine";
import { EngineHealth } from "../engine/types";
import { effectiveProfile, RunOutcome, RunPhase, RunReview, runGoal, RunSpec } from "../run/runner";
import {
    formatTextModel,
    listTextModels,
    parseTextModel,
    providerAvailable,
    PROVIDER_LABELS,
    PROVIDER_REQUIREMENTS,
    TextModelInfo,
    TextProvider,
} from "../text/providers";
import { CandidateKind, validateValueName } from "../text/types";
import { CacheSummary, RecordingCache } from "../scenario/cache";
import { promptHash, ScenarioStore, ScenarioSummary, validateScenarioName } from "../scenario/store";
import { Recording, RunMode, Scenario, SCENARIO_FORMAT_VERSION } from "../scenario/types";
import { CredentialSource, daemonEnvFor, reloadStoredCredential } from "../ironbee/config";
import { clearCredential, IronBeeLogin, LoginCredential, LoginError, saveCredential } from "../ironbee/login";
import { LiveHub } from "./live-hub";

const UI_DIR: string = join(__dirname, "ui");
const MAX_BODY_BYTES: number = 256 * 1024;
const KEPT_RUNS: number = 20;
/** Which set-up text-model provider the form suggests first: API keys, then the CLIs. */
const TEXT_PROVIDER_PREFERENCE: TextProvider[] = [
    TextProvider.ANTHROPIC,
    TextProvider.OPENAI,
    TextProvider.OPENROUTER,
    TextProvider.CLAUDE_CODE,
    TextProvider.CODEX,
];
const MODEL_LIST_TTL_MS: number = 10 * 60_000;
const STATIC_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
};
const VIDEO_TYPES: Record<string, string> = { ".webm": "video/webm", ".mp4": "video/mp4" };

export interface UiServerHandle {
    url: string;
    close(): Promise<void>;
}

/** What the UI shows of a run. Secret values are never part of it. */
interface RunRecord {
    id: string;
    goal: string;
    url?: string;
    engine?: string;
    generator?: string;
    phase: RunPhase;
    phaseDetail: string;
    /** What did not go as configured while the run went on (a send the platform rejected, a cache it could not write). */
    warnings: string[];
    steps: StepEvent[];
    mode?: RunMode;
    platform?: RunOutcome["platform"];
    trace?: RunOutcome["trace"];
    traceError?: string;
    /** The engine's review of the run: goal done?, problems found. */
    analysis?: RunOutcome["analysis"];
    analysisError?: string;
    /** The review is under way (the trace settles for seconds after the run, then the engine judges). */
    reviewing?: boolean;
    /** The app's fetch/xhr requests during the run. */
    requests?: CapturedRequest[];
    scenario?: string;
    recordingSaved?: boolean;
    divergence?: string;
    result?: Omit<RunResult, "finalSnapshot" | "steps"> & { finalUrl: string };
    error?: string;
    videoPath?: string;
    /** Every video part, when the run switched tabs. */
    videoParts?: string[];
    startedAt: number;
    /** When the run's own clock started (after the first page load): what the result's `elapsedMs` counts from. */
    clockStartedAt?: number;
    /** A failed run's explanation is being written by the text model (after the verdict). */
    explaining?: boolean;
    /** The text model's latest help when the engine got stuck (asked / answered / none). */
    rescue?: RescueEvent;
    /** The run's final time, once its clock stopped (before the result is published). */
    clockElapsedMs?: number;
    /** Set while the run waits for the user to act in the browser. */
    userAction?: UserActionRequest;
    /** When that turn began: a viewer that joins during it holds its stopwatch from there. */
    userActionSince?: number;
    /** The saved browser profile it runs in; absent = fresh. */
    profile?: string;
}

interface RunRequestBody {
    goal?: unknown;
    url?: unknown;
    values?: unknown;
    textModel?: unknown;
    textCandidates?: unknown;
    scenario?: unknown;
    saveAs?: unknown;
    explore?: unknown;
    /** A saved browser profile's name; "" = a fresh browser. */
    profile?: unknown;
    /** Saving the form: replace a scenario of that name (asked first in the UI). */
    overwrite?: unknown;
}

/** A save that would replace an existing scenario without `overwrite`. */
export class ScenarioExistsError extends Error {
    constructor(readonly scenario: string) {
        super(`A scenario named ${scenario} already exists`);
        this.name = "ScenarioExistsError";
    }
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c: string): string => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The page the IronBee console's redirect lands on. It drops the token from
 * its own address at once, so it does not stay in the tab's history, and
 * closes when the UI's window is still its opener.
 */
function sendCallbackPage(res: ServerResponse, status: number, title: string, message: string): void {
    res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
    });
    res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
            `<style>body{font:15px system-ui,sans-serif;background:#0f1216;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}` +
            `main{max-width:460px;padding:24px;text-align:center}h1{font-size:19px}p{color:#8b96a5;line-height:1.5}a{color:#58a6ff}</style></head>` +
            `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to IronBee Express</a></p></main>` +
            `<script>history.replaceState(null, "", "/api/ironbee/callback");` +
            // The console may cut the link to the opener (COOP): then the page stays, saying so.
            `${status === 200 ? "setTimeout(function(){ if (window.opener) { window.close(); } }, 1500);" : ""}</script>` +
            `</body></html>`
    );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
}

/** Binds that mean "every interface": nothing listens on them as an address. */
const WILDCARD_HOSTS: Set<string> = new Set(["", "0.0.0.0", "::"]);

/**
 * The address to bind as `listen` takes it: an IPv6 literal without the URL
 * brackets (`[::1]` is a name to `listen`, and resolves to nothing).
 */
export function bindHost(host: string): string {
    return host.trim().replace(/^\[|\]$/g, "");
}

/** The bound host as `URL` spells a hostname (lowercase, IPv6 canonical, no brackets); as given when it will not parse. */
function canonicalHost(host: string): string {
    try {
        return new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}`).hostname.replace(/^\[|\]$/g, "");
    } catch {
        return host;
    }
}

/** Whether a request's `Host` header is loopback on `port` (`localhost`, `127.0.0.1`, `[::1]`). */
export function loopbackHost(header: string | undefined, port: number): boolean {
    return hostAllowed(header, "127.0.0.1", port);
}

/**
 * Why Connect IronBee is refused for a request whose `Host` is not loopback: the
 * console calls back to a loopback address only. Under a concrete non-loopback
 * bind nothing listens there, so "use localhost" would send the user to a closed
 * port — the fix is the bind.
 */
export function connectRefusal(host: string): string {
    if (!WILDCARD_HOSTS.has(host) && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
        return "Connect IronBee needs the UI bound to loopback or a wildcard address — restart with --host 127.0.0.1 or 0.0.0.0";
    }
    if (host === "::1") {
        // The console accepts `localhost` and `127.0.0.1` callbacks only; `[::1]` is neither.
        return "Connect IronBee needs the UI bound to 127.0.0.1 or a wildcard address — the IronBee console does not call back to [::1]; restart with --host 127.0.0.1 or 0.0.0.0";
    }
    return "Connect IronBee from this machine (http://localhost or 127.0.0.1): the IronBee console only calls back to loopback";
}

/**
 * The host a client reaches the bound `host` through, as it goes into a URL:
 * the address itself when concrete (an IPv6 literal bracketed), loopback for a
 * wildcard bind. The daemon's live-view publisher and the IronBee console's
 * redirect are given this address; `127.0.0.1` for a bind on another address
 * would name a port nothing listens on.
 */
export function reachableHost(host: string): string {
    if (WILDCARD_HOSTS.has(host)) {
        return "127.0.0.1";
    }
    return isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * Whether a request's `Host` header names this server: the bound host, loopback
 * or `localhost` on the UI's port — and, for a wildcard bind, any IP literal on
 * that port (the machine's addresses are not known here). A DNS name other than
 * `localhost` or the bound name itself is never accepted: that is the DNS-rebinding guard.
 */
export function hostAllowed(header: string | undefined, host: string, port: number): boolean {
    if (!header) {
        return false;
    }
    let url: URL;
    try {
        url = new URL(`http://${header}`);
    } catch {
        return false;
    }
    if ((url.port || "80") !== String(port) || url.pathname !== "/" || url.search || url.hash || url.username) {
        return false;
    }
    const hostname: string = url.hostname.replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
        return true;
    }
    // `URL` lowercases a name and canonicalises an IPv6 literal: compare the bound host the same way.
    if (!WILDCARD_HOSTS.has(host) && hostname === canonicalHost(host)) {
        return true;
    }
    return WILDCARD_HOSTS.has(host) && isIP(hostname) !== 0;
}

/** Whether an `Origin` is this UI's own: `http://` + an allowed host. */
export function originAllowed(origin: string | undefined, host: string, port: number): boolean {
    return typeof origin === "string" && origin.startsWith("http://") && hostAllowed(origin.slice("http://".length), host, port);
}

/**
 * One `bytes=start-end` range against a file of `size` bytes: the inclusive
 * byte span; `undefined` when there is no range to honor (no header, another
 * unit, several ranges or a malformed one — the whole file is served, as RFC
 * 9110 has it); `null` for a well-formed one that cannot be satisfied (416).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
    if (header === undefined) {
        return undefined;
    }
    const match: RegExpMatchArray | null = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) {
        return undefined;
    }
    if (match[1] === "" && match[2] === "") {
        return null;
    }
    if (match[1] === "") {
        // The last N bytes.
        const suffix: number = Number(match[2]);
        if (suffix === 0 || size === 0) {
            return null;
        }
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start: number = Number(match[1]);
    const end: number = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start >= size || start > end) {
        return null;
    }
    return { start, end };
}

/**
 * Streams a video file, whole or one byte range (206): a player seeks, and
 * some refuse to play without ranges. A file that fails mid-stream ends the
 * response; it is never the process's error.
 */
export function serveVideo(res: ServerResponse, file: string, rangeHeader: string | undefined): void {
    const size: number = statSync(file).size;
    const type: string = VIDEO_TYPES[extname(file)] ?? "application/octet-stream";
    const range: { start: number; end: number } | null | undefined = parseRange(rangeHeader, size);
    if (range === null) {
        res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
        res.end();
        return;
    }
    const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes" };
    let stream: ReadStream;
    if (range) {
        headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
        headers["content-length"] = String(range.end - range.start + 1);
        res.writeHead(206, headers);
        stream = createReadStream(file, { start: range.start, end: range.end });
    } else {
        headers["content-length"] = String(size);
        res.writeHead(200, headers);
        stream = createReadStream(file);
    }
    stream.on("error", (): void => {
        res.destroy();
    });
    res.on("close", (): void => {
        stream.destroy();
    });
    stream.pipe(res);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size: number = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
            throw new Error("request body too large");
        }
        chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
}

/** A value's description is a hint, not a document. */
const MAX_DESCRIPTION_CHARS: number = 500;

function isEnumValue<T extends string>(value: unknown, allowed: Record<string, T>): value is T {
    return typeof value === "string" && (Object.values(allowed) as string[]).includes(value);
}

/** Validates a run request into a spec; throws a message fit for the UI. */
export function parseRunRequest(body: RunRequestBody): RunSpec {
    const scenario: string | undefined =
        typeof body.scenario === "string" && body.scenario.trim() ? validateScenarioName(body.scenario) : undefined;
    const saveAs: string | undefined =
        typeof body.saveAs === "string" && body.saveAs.trim() ? validateScenarioName(body.saveAs) : undefined;
    const goal: string | undefined = typeof body.goal === "string" && body.goal.trim() ? body.goal.trim() : undefined;
    if (!goal && !scenario) {
        throw new Error("goal is required");
    }
    if (goal && goal.length > 4_000) {
        throw new Error("goal is too long");
    }
    let url: string | undefined;
    if (typeof body.url === "string" && body.url.trim()) {
        const parsed: URL = new URL(body.url.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("url must be http(s)");
        }
        url = parsed.toString();
    }
    const values: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    const passwords: string[] = [];
    const valueDescriptions: Record<string, string> = {};
    for (const row of Array.isArray(body.values) ? body.values : []) {
        const r: { name?: unknown; value?: unknown; secret?: unknown; password?: unknown; description?: unknown } = row as object;
        if (typeof r.name !== "string" || !r.name.trim() || typeof r.value !== "string") {
            continue;
        }
        // The name is the key a recording and the engine's choices carry: the same rule as the CLI's.
        const name: string = validateValueName(r.name.trim(), r.secret === true ? "secret" : "value");
        (r.secret === true ? secrets : values)[name] = r.value;
        // A login password is marked in the form, never guessed from its name.
        if (r.secret === true && r.password === true) {
            passwords.push(name);
        }
        if (typeof r.description === "string" && r.description.trim()) {
            valueDescriptions[name] = r.description.trim().slice(0, MAX_DESCRIPTION_CHARS);
        }
    }
    return {
        goal,
        scenario,
        saveAs,
        explore: body.explore === true,
        url,
        values,
        secrets,
        passwords,
        valueDescriptions,
        ...(typeof body.profile === "string" ? { profile: body.profile.trim() ? validateProfileName(body.profile) : "" } : {}),
        // "none" = no text model for this run; a malformed name is refused (parseTextModel throws).
        textModel:
            typeof body.textModel === "string" && body.textModel.trim()
                ? (parseTextModel(body.textModel) ? body.textModel.trim() : "none")
                : undefined,
        textCandidates: Array.isArray(body.textCandidates)
            ? body.textCandidates.filter((k: unknown): k is CandidateKind => isEnumValue(k, CandidateKind))
            : undefined,
        record: true,
    };
}

/**
 * Saves the form as a scenario (the prompt) without running it: the only way a
 * scenario is written from the UI. Its recordings stay in the cache, keyed by
 * goal + start URL, so a changed goal or URL runs without one.
 */
export function saveScenarioDefinition(store: ScenarioStore, name: string, body: RunRequestBody): Scenario {
    const spec: RunSpec = parseRunRequest({ ...body, scenario: undefined, saveAs: undefined });
    if (!spec.goal) {
        throw new Error("goal is required");
    }
    const scenarioName: string = validateScenarioName(name);
    const base: Scenario | undefined = store.exists(scenarioName) ? store.get(scenarioName) : undefined;
    if (base !== undefined && body.overwrite !== true) {
        throw new ScenarioExistsError(scenarioName);
    }
    const now: string = new Date().toISOString();
    return store.save({
        formatVersion: SCENARIO_FORMAT_VERSION,
        name: scenarioName,
        description: base?.description,
        goal: spec.goal,
        url: spec.url,
        values: spec.values ?? {},
        // Secret values are never stored: only their names, and which of them are login passwords.
        secretNames: Object.keys(spec.secrets ?? {}),
        ...(spec.passwords?.length ? { passwordSecrets: spec.passwords } : {}),
        ...(Object.keys(spec.valueDescriptions ?? {}).length ? { descriptions: spec.valueDescriptions } : {}),
        textCandidates: spec.textCandidates,
        textModel: spec.textModel,
        ...(spec.profile ? { profile: spec.profile } : {}),
        createdAt: base?.createdAt ?? now,
        updatedAt: now,
    });
}


export async function startUiServer(config: FastConfig): Promise<UiServerHandle> {
    const hub: LiveHub = new LiveHub();
    const token: string = randomUUID();
    const port: number = config.ui.port;
    const host: string = bindHost(config.ui.host);
    /** Where the daemon and the IronBee console reach this server. */
    const ownAddress: string = `${reachableHost(host)}:${port}`;
    const ownHost: (header: string | undefined) => boolean = (header: string | undefined): boolean => hostAllowed(header, host, port);
    const ownOrigin: (origin: string | undefined) => boolean = (origin: string | undefined): boolean => originAllowed(origin, host, port);

    // The daemon is started per run when none is healthy: an idle DevTools
    // daemon exits on its own, and the UI may sit idle for minutes. The
    // browser profile is fixed when a daemon starts, so a run in another
    // profile (or fresh after one) gets a new daemon.
    let daemon: DaemonHandle | undefined;
    let daemonProfile: string | undefined;
    /** The IronBee environment the daemon was started with: a connect or sign-out needs a new one. */
    let daemonIronBee: string | undefined;
    const liveView: boolean = !config.daemon.url;
    const profiles: ProfileStore = new ProfileStore(config.profileDir);
    const ensureRunDaemon: (profile: string | undefined) => Promise<DaemonHandle> = async (
        profile: string | undefined
    ): Promise<DaemonHandle> => {
        if (config.daemon.url) {
            if (profile) {
                throw new Error(`The browser profile ${profile} needs a daemon IronBee Express starts itself; this UI uses ${config.daemon.url}`);
            }
            // Revived on its port when local; its own environment decides live view.
            return ensureDaemon({
                url: config.daemon.url,
                port: 0,
                headless: config.daemon.headless,
                daemonScript: config.daemon.script,
                env: daemonEnvFor(config.ironbee),
            });
        }
        const ironbeeEnv: string = JSON.stringify(daemonEnvFor(config.ironbee));
        if (daemon && daemonProfile === profile && daemonIronBee === ironbeeEnv && (await isDaemonHealthy(daemon.baseUrl))) {
            return daemon;
        }
        if (daemon) {
            await daemon.stop();
            daemon = undefined;
        }
        daemonProfile = profile;
        daemonIronBee = ironbeeEnv;
        daemon = await ensureDaemon({
            // Long idle (~2 h): the UI stops it on close, and restarts one that exited at the next run.
            idleCheckSeconds: 3_600,
            port: await freePort(),
            headless: config.daemon.headless,
            daemonScript: config.daemon.script,
            env: {
                ...daemonEnvFor(config.ironbee),
                ...(config.daemon.iframes ? { BROWSER_CONTROL_SNAPSHOT_FRAMES: "true" } : {}),
                LIVE_VIEW_WS_URL: `ws://${ownAddress}/live/producer`,
                LIVE_VIEW_TOKEN: token,
                LIVE_VIEW_EVENTS_ENABLE: "false",
                ...(profile ? profileEnv(profiles.ensure(profile)) : {}),
            },
        });
        return daemon;
    };

    const store: ScenarioStore = new ScenarioStore(config.scenarioDir);
    const cache: RecordingCache = new RecordingCache(config.cacheDir, config.cacheEntries);
    const ironbeeLogin: IronBeeLogin = new IronBeeLogin();
    const runs: RunRecord[] = [];
    let current: { record: RunRecord; abort: AbortController; resume?: (resumed: boolean) => void } | undefined;
    /** A `POST /api/runs` is reading its body: the run it may start is spoken for. */
    let starting: boolean = false;

    const publicRun: (record: RunRecord) => Omit<RunRecord, "videoPath" | "videoParts"> & { hasVideo: boolean; videoPartCount: number } = (
        record: RunRecord
    ): Omit<RunRecord, "videoPath" | "videoParts"> & { hasVideo: boolean; videoPartCount: number } => {
        const { videoPath, videoParts, ...rest } = record;
        return {
            ...rest,
            hasVideo: Boolean(videoPath && existsSync(videoPath)),
            videoPartCount: videoParts?.length ?? (videoPath ? 1 : 0),
        };
    };

    const startRun: (spec: RunSpec) => RunRecord = (spec: RunSpec): RunRecord => {
        const record: RunRecord = {
            id: randomUUID(),
            goal: spec.goal ?? `scenario ${spec.scenario}`,
            scenario: spec.scenario ?? spec.saveAs,
            url: spec.url,
            phase: RunPhase.PREPARING,
            phaseDetail: "starting",
            warnings: [],
            steps: [],
            startedAt: Date.now(),
            // Known from the start, so a running run's steps can name the model that wrote a text.
            ...(spec.textModel && spec.textModel !== "none" ? { generator: spec.textModel } : {}),
        };
        runs.unshift(record);
        runs.splice(KEPT_RUNS);
        const abort: AbortController = new AbortController();
        const run: { record: RunRecord; abort: AbortController; resume?: (resumed: boolean) => void } = { record, abort };
        current = run;
        /** Hands the browser to the user (through the live view) until they continue or stop the run. */
        const onUserAction: AskUser = (request: UserActionRequest): Promise<boolean> =>
            new Promise<boolean>((resolve: (resumed: boolean) => void): void => {
                const done: (resumed: boolean) => void = (resumed: boolean): void => {
                    if (run.resume !== done) {
                        return;
                    }
                    run.resume = undefined;
                    abort.signal.removeEventListener("abort", stopped);
                    record.userAction = undefined;
                    record.userActionSince = undefined;
                    hub.setHumanControl(false);
                    hub.broadcast({ type: "user-action-done", id: record.id });
                    resolve(resumed);
                };
                const stopped: () => void = (): void => done(false);
                if (abort.signal.aborted) {
                    resolve(false);
                    return;
                }
                run.resume = done;
                abort.signal.addEventListener("abort", stopped);
                record.userAction = request;
                record.userActionSince = Date.now();
                hub.setHumanControl(true);
                hub.broadcast({ type: "user-action", id: record.id, request });
            });
        hub.resetFrame();
        hub.broadcast({ type: "run", run: publicRun(record) });
        let client: DevtoolsClient | undefined;
        void Promise.resolve()
            .then((): Promise<DaemonHandle> => {
                const profile: string | undefined = effectiveProfile(spec, spec.scenario ? store.get(spec.scenario) : undefined);
                record.profile = profile;
                return ensureRunDaemon(profile);
            })
            .then((handle: DaemonHandle): Promise<RunOutcome> => {
                client = createDevtoolsClient({ baseUrl: handle.baseUrl, internalToken: handle.internalToken });
                return runGoal(
                    { ...spec, deferReview: true },
                    config,
                    client,
                    {
                        onPhase: (phase: RunPhase, detail: string): void => {
                            record.phase = phase;
                            record.phaseDetail = detail;
                            hub.broadcast({ type: "phase", id: record.id, phase, detail });
                        },
                        // Kept on the record (a viewer that connects later sees them) and sent as they come.
                        onWarning: (message: string): void => {
                            record.warnings.push(message);
                            hub.broadcast({ type: "warning", id: record.id, message });
                        },
                        onClockStart: (): void => {
                            record.clockStartedAt = Date.now();
                            hub.broadcast({ type: "clock", id: record.id });
                        },
                        onRescue: (event: RescueEvent): void => {
                            record.rescue = event;
                            hub.broadcast({ type: "rescue", id: record.id, event });
                        },
                        onClockStop: (elapsedMs: number): void => {
                            record.clockElapsedMs = elapsedMs;
                            hub.broadcast({ type: "clock-stop", id: record.id, elapsedMs });
                        },
                        onStep: (step: StepEvent): void => {
                            record.steps.push(step);
                            hub.broadcast({ type: "step", id: record.id, step });
                        },
                        onUserAction,
                    },
                    abort.signal
                );
            })
            .then(async (outcome: RunOutcome): Promise<void> => {
                const { finalSnapshot, steps: _steps, journey: _journey, ...result } = outcome.result;
                record.engine = outcome.engine;
                record.mode = outcome.mode;
                record.scenario = outcome.scenario;
                record.divergence = outcome.divergence;
                record.platform = outcome.platform;
                record.generator = outcome.generator;
                record.videoPath = outcome.videoPath;
                record.videoParts = outcome.videoParts;
                record.requests = outcome.requests;
                record.result = { ...result, finalUrl: finalSnapshot.url };
                if (outcome.reviewReady) {
                    // Show the run now; the review follows once the trace settled and the engine judged.
                    record.phase = RunPhase.REVIEWING;
                    record.reviewing = true;
                    hub.broadcast({ type: "run", run: publicRun(record) });
                    const review: RunReview = await outcome.reviewReady;
                    record.trace = review.trace;
                    record.traceError = review.traceError;
                    record.analysis = review.analysis;
                    record.analysisError = review.analysisError;
                    record.recordingSaved = review.recordingSaved;
                    record.reviewing = false;
                    if (review.explanation) {
                        // The text model explains a failed run after the verdict; shown when it answers.
                        record.explaining = true;
                        void review.explanation.finally((): void => {
                            record.explaining = false;
                            // Only while it is still the run on screen: never over a newer one.
                            if (runs[0] === record && !current) {
                                hub.broadcast({ type: "run", run: publicRun(record) });
                            }
                        });
                    }
                }
            })
            .catch((err: unknown): void => {
                record.error = err instanceof Error ? err.message : String(err);
            })
            .finally(async (): Promise<void> => {
                record.phase = RunPhase.FINISHED;
                await client?.close();
                current = undefined;
                hub.broadcast({ type: "run", run: publicRun(record) });
            });
        return record;
    };

    /** Each provider's text models, cached for 10 minutes. */
    const modelCache: Map<TextProvider, { at: number; models: TextModelInfo[] }> = new Map();
    const textModels: (provider: TextProvider) => Promise<TextModelInfo[]> = async (provider: TextProvider): Promise<TextModelInfo[]> => {
        const cached: { at: number; models: TextModelInfo[] } | undefined = modelCache.get(provider);
        if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) {
            return cached.models;
        }
        const models: TextModelInfo[] = await listTextModels(provider, config.text.providers[provider]);
        modelCache.set(provider, { at: Date.now(), models });
        return models;
    };

    /**
     * The model the form starts with: the configured one (IBEXPRESS_TEXT_MODEL), else the first
     * provider that is set up — an API key before a CLI — with its default model (the CLIs mark
     * one) or the first it lists; "none" when no provider is.
     */
    const suggestedTextModel: () => Promise<string> = async (): Promise<string> => {
        if (config.text.model) {
            return formatTextModel(config.text.model);
        }
        for (const provider of TEXT_PROVIDER_PREFERENCE) {
            if (!providerAvailable(provider, config.text.providers[provider])) {
                continue;
            }
            try {
                const models: TextModelInfo[] = await textModels(provider);
                const pick: TextModelInfo | undefined = models.find((m: TextModelInfo): boolean => m.default === true) ?? models[0];
                if (pick) {
                    return formatTextModel({ provider, model: pick.id });
                }
            } catch {
                // Its list cannot be read now: the next provider.
            }
        }
        return "none";
    };

    const configView: () => Promise<unknown> = async (): Promise<unknown> => {
        const health: EngineHealth = await createEngine(config.engine).health();
        return {
            engine: { name: "Jev", ...health },
            // Text-model providers: available when their key is set; models are listed on demand.
            textProviders: Object.values(TextProvider).map(
                (provider: TextProvider): { provider: TextProvider; label: string; ok: boolean; detail: string } => ({
                    provider,
                    label: PROVIDER_LABELS[provider],
                    ok: providerAvailable(provider, config.text.providers[provider]),
                    detail: providerAvailable(provider, config.text.providers[provider])
                        ? config.text.providers[provider].command ?? "API key configured"
                        : PROVIDER_REQUIREMENTS[provider],
                })
            ),
            defaultTextModel: await suggestedTextModel(),
            candidates: Object.values(CandidateKind),
            defaultCandidates: config.text.candidates,
            liveView,
            ironbee: {
                ok: config.ironbee.enabled,
                domain: config.ironbee.domain,
                project: config.ironbee.projectName,
                consoleUrl: config.ironbee.consoleUrl,
                // env: set by the environment, so not the UI's to change.
                ...(config.ironbee.source ? { source: config.ironbee.source } : {}),
                canConnect: config.ironbee.source !== CredentialSource.ENV && !config.ironbee.reportingOff,
                ...(config.ironbee.enabled
                    ? {}
                    : {
                        detail: config.ironbee.reportingOff
                            ? "IBEXPRESS_IRONBEE_REPORT is off: runs are not reported"
                            : "Not connected: runs are not reported and no backend trace is read",
                    }),
            },
        };
    };

    const serveStatic: (res: ServerResponse, name: string) => void = (res: ServerResponse, name: string): void => {
        const file: string = join(UI_DIR, name);
        if (!Object.keys(STATIC_TYPES).includes(extname(file)) || !existsSync(file)) {
            sendJson(res, 404, { error: "not found" });
            return;
        }
        res.writeHead(200, { "content-type": STATIC_TYPES[extname(file)], "cache-control": "no-store" });
        res.end(readFileSync(file));
    };

    const server: Server = createHttpServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            if (!ownHost(req.headers.host)) {
                sendJson(res, 421, { error: "unexpected host" });
                return;
            }
            const path: string = new URL(req.url ?? "/", "http://x").pathname;
            if (req.method !== "GET") {
                const origin: string | undefined = req.headers.origin;
                if (origin !== undefined && !ownOrigin(origin)) {
                    sendJson(res, 403, { error: "cross-origin request" });
                    return;
                }
            }
            if (req.method === "POST" || req.method === "PUT") {
                if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
                    sendJson(res, 415, { error: "JSON only" });
                    return;
                }
            }
            if (req.method === "GET" && (path === "/" || path === "/index.html")) {
                serveStatic(res, "index.html");
            } else if (req.method === "GET" && /^\/(app\.js|trace-view\.js|style\.css|favicon\.svg)$/.test(path)) {
                serveStatic(res, path.slice(1));
            } else if (req.method === "GET" && path === "/api/config") {
                sendJson(res, 200, await configView());
            } else if (req.method === "POST" && path === "/api/ironbee/connect") {
                if (config.ironbee.source === CredentialSource.ENV) {
                    sendJson(res, 409, { error: "The IronBee credential comes from the environment (IRONBEE_API_KEY / IRONBEE_OAUTH_TOKEN)" });
                    return;
                }
                // The console redirects the browser that clicked to a loopback callback: from
                // another machine that would be its own loopback, and the login would be lost.
                // A `::1` bind cannot work at all: the console accepts `localhost`/`127.0.0.1` callbacks only.
                if (host === "::1" || !loopbackHost(req.headers.host, port)) {
                    sendJson(res, 409, { error: connectRefusal(host) });
                    return;
                }
                const url: string = ironbeeLogin.start(config.ironbee.consoleUrl, `http://${ownAddress}/api/ironbee/callback`);
                sendJson(res, 200, { url });
            } else if (req.method === "GET" && path === "/api/ironbee/callback") {
                const query: URLSearchParams = new URL(req.url ?? "/", "http://x").searchParams;
                try {
                    const credential: LoginCredential = ironbeeLogin.complete({
                        state: query.get("state"),
                        access_token: query.get("access_token"),
                        api_key: query.get("api_key"),
                        error: query.get("error"),
                    });
                    saveCredential(config.ironbee.configFile, config.ironbee.domain, credential);
                    config.ironbee = reloadStoredCredential(config.ironbee);
                    sendCallbackPage(res, 200, "Connected to IronBee", `IronBee Express now reports its runs to ${config.ironbee.domain}. You can close this tab.`);
                } catch (err: unknown) {
                    const known: boolean = err instanceof LoginError;
                    sendCallbackPage(res, known ? 400 : 500, "Could not connect to IronBee", known ? (err as Error).message : "The login could not be saved.");
                }
            } else if (req.method === "POST" && path === "/api/ironbee/disconnect") {
                if (config.ironbee.source !== CredentialSource.FILE) {
                    sendJson(res, 409, { error: "Nothing to sign out of here: no saved IronBee login is in use" });
                    return;
                }
                clearCredential(config.ironbee.configFile);
                config.ironbee = reloadStoredCredential(config.ironbee);
                sendJson(res, 200, { ok: true });
            } else if (req.method === "GET" && path === "/api/text-models") {
                const provider: string | null = new URL(req.url ?? "/", "http://x").searchParams.get("provider");
                if (!isEnumValue(provider, TextProvider)) {
                    sendJson(res, 400, { error: `provider is one of ${Object.values(TextProvider).join(", ")}` });
                    return;
                }
                try {
                    sendJson(res, 200, { provider, models: await textModels(provider) });
                } catch (err: unknown) {
                    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
                }
            } else if (req.method === "GET" && path === "/api/profiles") {
                sendJson(res, 200, { dir: profiles.dir, profiles: profiles.list() });
            } else if (req.method === "POST" && path === "/api/profiles") {
                try {
                    const body: { name?: unknown } = (await readJson(req)) as { name?: unknown };
                    const name: string = validateProfileName(typeof body.name === "string" ? body.name : "");
                    profiles.ensure(name);
                    sendJson(res, 200, { profile: name, profiles: profiles.list() });
                } catch (err: unknown) {
                    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                }
            } else if (/^\/api\/profiles\/[\w-]+$/.test(path) && req.method === "DELETE") {
                const name: string = decodeURIComponent(path.split("/")[3]);
                // A run's profile is settled only once it starts: while any run is up or starting, no profile goes.
                if (current || starting) {
                    sendJson(res, 409, { error: `a run is in progress; the profile ${name} may be its` });
                    return;
                }
                try {
                    if (daemonProfile === name && daemon) {
                        // Its browser may still hold the directory open.
                        await daemon.stop();
                        daemon = undefined;
                        daemonProfile = undefined;
                    }
                    profiles.delete(name);
                    sendJson(res, 200, { deleted: name, profiles: profiles.list() });
                } catch (err: unknown) {
                    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                }
            } else if (req.method === "GET" && path === "/api/scenarios") {
                sendJson(res, 200, {
                    dir: store.dir,
                    cacheDir: cache.dir,
                    scenarios: store.list().map((s: ScenarioSummary): ScenarioSummary & { cached: CacheSummary } => ({ ...s, cached: cache.summary(s.name) })),
                });
            } else if (/^\/api\/scenarios\/[^/]+\/cache$/.test(path) && req.method === "DELETE") {
                try {
                    const name: string = decodeURIComponent(path.split("/")[3]);
                    sendJson(res, 200, { cleared: cache.clear(name) });
                } catch (err: unknown) {
                    // Any path segment reaches here: a name the store cannot hold is refused with its rule.
                    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                }
            } else if (/^\/api\/scenarios\/[^/]+$/.test(path) && req.method === "PUT") {
                try {
                    const saved: Scenario = saveScenarioDefinition(
                        store,
                        decodeURIComponent(path.split("/")[3]),
                        (await readJson(req)) as RunRequestBody
                    );
                    sendJson(res, 200, { scenario: saved });
                } catch (err: unknown) {
                    if (err instanceof ScenarioExistsError) {
                        // The UI asks, then saves again with overwrite.
                        sendJson(res, 409, { error: err.message, exists: err.scenario });
                        return;
                    }
                    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                }
            } else if (/^\/api\/scenarios\/[^/]+$/.test(path) && (req.method === "GET" || req.method === "DELETE")) {
                let name: string;
                try {
                    name = decodeURIComponent(path.split("/")[3]);
                } catch (err: unknown) {
                    // A malformed percent-escape is the request's fault, not the server's.
                    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                    return;
                }
                try {
                    if (req.method === "DELETE") {
                        const deleted: boolean = store.delete(name);
                        cache.clear(name);
                        sendJson(res, deleted ? 200 : 404, { deleted: name });
                    } else {
                        const scenario: Scenario = store.get(name);
                        // The recording a run of it as saved would replay, if one is cached.
                        const recording: Recording | undefined = cache.peek(name, promptHash(scenario.goal, scenario.url));
                        sendJson(res, 200, {
                            scenario,
                            cached: cache.summary(name),
                            ...(recording ? { recording: { steps: recording.steps.length, recordedAt: recording.recordedAt } } : {}),
                        });
                    }
                } catch (err: unknown) {
                    sendJson(res, 404, { error: err instanceof Error ? err.message : String(err) });
                }
            } else if (req.method === "GET" && path === "/api/runs") {
                sendJson(res, 200, { runs: runs.map(publicRun), currentId: current?.record.id });
            } else if (req.method === "POST" && path === "/api/runs") {
                // Reserved before the body is read: two requests in flight at once must not both start a run.
                if (current || starting) {
                    sendJson(res, 409, { error: "a run is in progress" });
                    return;
                }
                starting = true;
                let spec: RunSpec;
                try {
                    spec = parseRunRequest((await readJson(req)) as RunRequestBody);
                } catch (err: unknown) {
                    starting = false;
                    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                    return;
                }
                try {
                    sendJson(res, 202, { run: publicRun(startRun(spec)) });
                } finally {
                    starting = false;
                }
            } else if (req.method === "POST" && path === "/api/runs/continue") {
                // The user is done in the browser: the run goes on from where it paused.
                const resume: ((resumed: boolean) => void) | undefined = current?.resume;
                resume?.(true);
                sendJson(res, resume ? 200 : 409, resume ? { continued: true } : { error: "the run is not waiting for you" });
            } else if (req.method === "POST" && path === "/api/runs/stop") {
                current?.abort.abort();
                sendJson(res, 200, { stopping: Boolean(current) });
            } else if (req.method === "GET" && /^\/api\/runs\/[\w-]+\/video$/.test(path)) {
                const record: RunRecord | undefined = runs.find((r: RunRecord): boolean => r.id === path.split("/")[3]);
                // `?part=n` (from 0) picks one part of a run that switched tabs.
                const rawPart: string | null = new URL(req.url ?? "/", "http://x").searchParams.get("part");
                const part: number = rawPart === null ? 0 : /^\d+$/.test(rawPart) ? Number(rawPart) : -1;
                if (part < 0) {
                    sendJson(res, 400, { error: "part is a non-negative integer" });
                    return;
                }
                const file: string | undefined = part > 0 ? record?.videoParts?.[part] : record?.videoPath;
                if (!file || !existsSync(file)) {
                    sendJson(res, 404, { error: "no video" });
                    return;
                }
                serveVideo(res, file, req.headers.range);
            } else {
                sendJson(res, 404, { error: "not found" });
            }
        } catch (err: unknown) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    });

    const viewers: WebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    const producers: WebSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const path: string = new URL(req.url ?? "/", "http://x").pathname;
        if (path === "/live/producer" && req.headers.authorization === `Bearer ${token}`) {
            producers.handleUpgrade(req, socket, head, (ws: WebSocket): void => hub.addProducer(ws));
        } else if (path === "/ws" && ownHost(req.headers.host) && ownOrigin(req.headers.origin)) {
            viewers.handleUpgrade(req, socket, head, (ws: WebSocket): void => {
                hub.addViewer(ws);
                ws.send(
                    JSON.stringify({
                        type: "hello",
                        run: current ? publicRun(current.record) : runs[0] ? publicRun(runs[0]) : null,
                    })
                );
            });
        } else {
            socket.destroy();
        }
    });

    await new Promise<void>((resolve: () => void, reject: (err: Error) => void): void => {
        server.once("error", reject);
        server.listen(port, host, (): void => resolve());
    });


    return {
        url: `http://${ownAddress}`,
        close: async (): Promise<void> => {
            current?.abort.abort();
            hub.closeAll();
            await new Promise<void>((resolve: () => void): void => {
                server.close((): void => resolve());
            });
            await daemon?.stop();
        },
    };
}
