/**
 * A thin client of the IronBee DevTools daemon (`POST /call`). The daemon owns
 * the browser; this process only sends tool calls, one session id per run.
 */

import { randomUUID } from "crypto";
import { sleep } from "../util/time";
import { CapturedRequest, ConsoleEntry } from "../verify/types";
import { controlToolsPluginPath } from "./daemon";
import { ActRequest, ActResult, ControlSnapshot, SecretBundle, SnapshotLimits } from "./types";

const CALL_TIMEOUT_MS: number = 60_000;
/** What DevTools' `content_get-as-text` appends to a text it cut (its own wording). */
const TRUNCATED_NOTE: string = "\n[Output truncated due to size limits]";
/** DevTools' own snapshot defaults, for a request that names none. */
/** Statuses a first-visit check answers with (403 forbidden, 429 too many requests, 503 a challenge page). */
const FIRST_VISIT_CHECK_STATUSES: Set<number> = new Set([403, 429, 503]);

export const DEFAULT_LIMITS: SnapshotLimits = { maxControls: 250, maxTextChars: 6_000 };

/** DevTools refused a `{{secret:…}}` reference (wrong field, origin or tool). */
export const SECRET_DENIED: string = "SECRET_DENIED";

export class DevtoolsError extends Error {
    constructor(
        message: string,
        readonly toolName: string,
        readonly code?: string
    ) {
        super(message);
        this.name = "DevtoolsError";
    }
}

export interface DevtoolsClientOptions {
    baseUrl: string;
    /** One browser context per session id. Defaults to a fresh random id. */
    sessionId?: string;
    /** The daemon's INTERNAL_TOKEN (a daemon this process started): enables seeding secrets. */
    internalToken?: string;
}

export interface RecordingStopped {
    /** Absolute path of the written video (the first part), when a recording was running. */
    filePath?: string;
    /** Every part in order, when the run switched tabs (one video per tab visit). */
    parts?: string[];
}

export enum NetworkWait {
    QUIET = "quiet",
    WAITED = "waited",
    BUSY = "busy",
}

export class DevtoolsClient {
    readonly baseUrl: string;
    readonly sessionId: string;
    /** Sent as `_metadata` with every call (IronBee correlation + credentials). */
    private metadata: Record<string, unknown> | undefined;
    /** Told once when the daemon refuses `_metadata` (not started with TOOL_INPUT_METADATA_ENABLE). */
    onMetadataRejected?: (toolName: string) => void;

    private readonly internalToken: string | undefined;

    constructor(options: DevtoolsClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, "");
        this.sessionId = options.sessionId ?? `ibexpress-${randomUUID()}`;
        this.internalToken = options.internalToken;
    }

    /** True when the run's secrets can live in DevTools (typed by reference, masked there). */
    get canSeedSecrets(): boolean {
        return this.internalToken !== undefined;
    }

    /** Replaces the daemon's secrets with this bundle (DevTools' seed format). */
    async seedSecrets(bundle: SecretBundle): Promise<void> {
        await this.clearSecrets();
        const response: Response = await this.internal("POST", JSON.stringify(bundle));
        if (!response.ok) {
            const body: { error?: string } = await response.json().catch((): object => ({}));
            // The message names fields, never values.
            throw new Error(`The DevTools daemon refused the run's secrets: ${body.error ?? `HTTP ${response.status}`}`);
        }
    }

    /** Forgets the daemon's secrets (the end of a run). */
    async clearSecrets(): Promise<void> {
        const response: Response = await this.internal("DELETE");
        if (!response.ok) {
            throw new Error(`The DevTools daemon did not clear its secrets: HTTP ${response.status}`);
        }
    }

    private async internal(method: string, body?: string): Promise<Response> {
        if (this.internalToken === undefined) {
            throw new Error("This daemon was not started by this process: its secrets cannot be seeded");
        }
        return fetch(`${this.baseUrl}/internal/secrets`, {
            method,
            headers: { authorization: `Bearer ${this.internalToken}`, ...(body ? { "content-type": "application/json" } : {}) },
            body,
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
    }

    /** Correlates every later call with an IronBee platform run; undefined stops it. */
    setMetadata(metadata: Record<string, unknown> | undefined): void {
        this.metadata = metadata;
    }

    async call<T>(toolName: string, toolInput: object): Promise<T> {
        if (this.metadata === undefined) {
            return this.post<T>(toolName, toolInput);
        }
        try {
            return await this.post<T>(toolName, { ...toolInput, _metadata: this.metadata });
        } catch (err: unknown) {
            // A daemon started without TOOL_INPUT_METADATA_ENABLE refuses the
            // key; the run goes on unreported rather than failing.
            if (err instanceof DevtoolsError && /_metadata/.test(err.message)) {
                this.metadata = undefined;
                this.onMetadataRejected?.(toolName);
                return this.post<T>(toolName, toolInput);
            }
            throw err;
        }
    }

    private async post<T>(toolName: string, toolInput: object): Promise<T> {
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/call`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "session-id": this.sessionId,
                },
                body: JSON.stringify({ toolName, toolInput }),
                signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            });
        } catch (err: unknown) {
            const why: string = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "is not reachable";
            throw new DevtoolsError(`${toolName}: the IronBee DevTools daemon at ${this.baseUrl} ${why}`, toolName);
        }
        const body: any = await response.json().catch((): unknown => ({}));
        if (body?.toolError) {
            throw new DevtoolsError(`${toolName}: ${body.toolError.message}`, toolName, body.toolError.code);
        }
        if (!response.ok) {
            const message: string = body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;
            throw new DevtoolsError(`${toolName}: ${message}`, toolName);
        }
        return body.toolOutput as T;
    }

    /**
     * Opens `url`; DevTools waits for the page's own requests to settle. A site may answer a
     * browser's first visit with an error page whose scripts set the cookies its next request is let
     * through with (a first-visit bot check). When the page answers with such a status, it is loaded
     * once more, as a person reloading it would. Once: a page that keeps refusing is left to the run.
     * Returns when the load the page now shows began: the refused visit's own traffic (its status,
     * its console error) is not the run's.
     */
    async navigate(url: string): Promise<number> {
        const firstAtMs: number = Date.now();
        const first: { status?: number } = await this.load(url);
        if (first.status === undefined || !FIRST_VISIT_CHECK_STATUSES.has(first.status)) {
            return firstAtMs;
        }
        const againAtMs: number = Date.now();
        await this.load(url);
        return againAtMs;
    }

    private load(url: string): Promise<{ status?: number }> {
        return this.call("navigation_go-to", { url, includeSnapshot: false });
    }

    async snapshot(limits: SnapshotLimits): Promise<ControlSnapshot> {
        let page: ControlSnapshot;
        try {
            page = await this.call<ControlSnapshot>("control_take-snapshot", limits);
        } catch (err: unknown) {
            // A daemon started without this package's control tools plugin.
            if (err instanceof DevtoolsError && /Tool Not Found/i.test(err.message)) {
                throw new DevtoolsError(
                    `${err.message}: the DevTools daemon at ${this.baseUrl} runs without the control tools — start it with TOOL_PLUGINS=${controlToolsPluginPath()}`,
                    err.toolName
                );
            }
            throw err;
        }
        await this.onSnapshot?.(page);
        return page;
    }

    protected async actOnce(request: ActRequest): Promise<ActResult> {
        return this.call<ActResult>("control_act", request);
    }

    /** Called with every snapshot read (alone or after an action) before it is returned. */
    onSnapshot?: (page: ControlSnapshot) => Promise<void>;

    /** A refused secret reference is a refused action (the engine reads why), not a failed run. */
    async act(request: ActRequest): Promise<ActResult> {
        try {
            const result: ActResult = await this.actOnce(request);
            if (result.snapshot) {
                await this.onSnapshot?.(result.snapshot);
            }
            return result;
        } catch (err: unknown) {
            if (err instanceof DevtoolsError && err.code === SECRET_DENIED) {
                // Refused before anything was typed: the page is as it was, read it like any refusal's.
                const snapshot: ControlSnapshot | undefined =
                    request.observe === false
                        ? undefined
                        : await this.snapshot({
                            maxControls: request.maxControls ?? DEFAULT_LIMITS.maxControls,
                            maxTextChars: request.maxTextChars ?? DEFAULT_LIMITS.maxTextChars,
                        });
                return {
                    executed: false,
                    reason: err.message.replace(/^control_act: /, ""),
                    ...(snapshot ? { snapshot } : {}),
                };
            }
            throw err;
        }
    }

    /**
     * The whole page's visible text. DevTools marks a cut with a trailing note; it is replaced by
     * "…", so a value shown on the page that straddles the cut is masked as a value cut short.
     */
    async pageText(maxLength: number): Promise<string> {
        const page: { output?: string } = await this.call("content_get-as-text", { maxLength });
        const out: string = page.output ?? "";
        return out.endsWith(TRUNCATED_NOTE) ? `${out.slice(0, -TRUNCATED_NOTE.length)}…` : out;
    }

    /**
     * The page's fetch / xhr requests since `sinceMs`, oldest first, with
     * response bodies (DevTools redacts credentials in them).
     */
    async appRequests(sinceMs: number, limit: number = 300): Promise<CapturedRequest[]> {
        const out: CapturedRequest[] = [];
        for (const resourceType of ["fetch", "xhr"]) {
            const page: { requests?: any[] } = await this.call("o11y_get-http-requests", {
                resourceType,
                timestamp: sinceMs,
                includeResponseBody: true,
                includeRequestHeaders: true,
                includeResponseHeaders: true,
                limit: { count: limit, from: "end" },
            });
            for (const r of page.requests ?? []) {
                out.push({
                    method: String(r.method),
                    url: String(r.url),
                    resourceType,
                    status: r.response?.status,
                    failure: r.failure ?? undefined,
                    body: r.response?.body,
                    ...(r.body !== undefined ? { requestBody: String(r.body) } : {}),
                    ...(r.headers ? { requestHeaders: r.headers } : {}),
                    ...(r.response?.headers ? { responseHeaders: r.response.headers } : {}),
                    timestamp: Number(r.timestamp ?? 0),
                });
            }
        }
        return out.sort((a: CapturedRequest, b: CapturedRequest): number => a.timestamp - b.timestamp);
    }

    /**
     * Waits (bounded) until the page's network is quiet, then a moment more:
     * DevTools logs a request only after reading its response body. Never throws —
     * a page that keeps polling just gets the bound.
     */
    async settleNetwork(timeoutMs: number = 2_000, idleTimeMs: number = 300): Promise<void> {
        try {
            await this.call("sync_wait-for-network-idle", { timeoutMs, idleTimeMs, maxConnections: 0 });
        } catch {
            // Still busy (long polling, a stream): read what is there.
        }
        await sleep(150);
    }

    /**
     * Waits (bounded) for the requests an action started, so the next snapshot shows what they
     * load: a list rendered from an API response is not on the page when the action returns.
     * For an act that returned no `networkIdle` (a native dialog was held when it ended).
     * Resolves how it went: `quiet` right away (nothing was loading), `waited` for a load that
     * finished, `busy` when the bound ran out (a page that keeps polling). Never throws.
     */
    async waitForQuiet(timeoutMs: number, idleTimeMs: number): Promise<NetworkWait> {
        try {
            const out: { waitedMs: number; finalInFlightRequests: number } = await this.call("sync_wait-for-network-idle", {
                timeoutMs,
                idleTimeMs,
                maxConnections: 0,
                pollIntervalMs: 25,
            });
            if (out.finalInFlightRequests > 0) {
                return NetworkWait.BUSY;
            }
            // Idle from the start resolves after about idleTimeMs; anything longer waited for a load.
            return out.waitedMs > idleTimeMs + 60 ? NetworkWait.WAITED : NetworkWait.QUIET;
        } catch {
            return NetworkWait.BUSY;
        }
    }

    /** What the screen shows now, as a JPEG (for a text model that asked to see it). */
    async screenshot(): Promise<{ mimeType: string; data: string }> {
        const out: { image?: { data?: unknown; mimeType?: string }; filePath?: string } = await this.call("content_take-screenshot", {
            type: "jpeg",
            quality: 70,
            includeBase64: true,
        });
        if (typeof out.image?.data !== "string") {
            throw new DevtoolsError("the screenshot came back without its image", "content_take-screenshot");
        }
        return { mimeType: out.image.mimeType ?? "image/jpeg", data: out.image.data };
    }

    /** Console errors (and uncaught exceptions) since `sinceMs`. */
    async consoleErrors(sinceMs: number): Promise<ConsoleEntry[]> {
        const page: { messages?: any[] } = await this.call("o11y_get-console-messages", {
            type: "error",
            timestamp: sinceMs,
            limit: { count: 100, from: "end" },
        });
        return (page.messages ?? []).map(
            (m: any): ConsoleEntry => ({ type: String(m.type), text: String(m.text), timestamp: Number(m.timestamp ?? 0) })
        );
    }

    /**
     * Starts the screencast; while it runs, actions are marked in the page and
     * frames reach a live view. Playwright's own action annotations stay off:
     * they hold every input ~0.5 s, and control_act marks actions itself.
     */
    async startRecording(outputDir?: string): Promise<void> {
        await this.call("content_start-recording", {
            name: "ibexpress",
            showActions: false,
            ...(outputDir ? { outputDir } : {}),
        });
    }

    stopRecording(): Promise<RecordingStopped> {
        return this.call<RecordingStopped>("content_stop-recording", {});
    }

    /** Closes this session's browser context. Never throws. */
    async close(): Promise<void> {
        try {
            await fetch(`${this.baseUrl}/session`, {
                method: "DELETE",
                headers: { "session-id": this.sessionId },
                signal: AbortSignal.timeout(5_000),
            });
        } catch {
            // The daemon may already be gone.
        }
    }
}
