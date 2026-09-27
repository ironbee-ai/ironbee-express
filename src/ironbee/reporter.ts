/**
 * Reports a run to the IronBee platform as the session lifecycle the IronBee
 * CLI emits, so a run shows up like any verification:
 *
 *   session_start → activity_start → verification_start
 *     (tool_call events: sent by the DevTools daemon itself, from the `_metadata`
 *      every call carries — see `metadataFor`)
 *   verdict_write → verification_end → activity_end → session_end
 *
 * The verdict is `platformVerdict`'s (run/runner.ts): the engine's review when
 * there is one — the goal line as a check, each problem it found as an issue —
 * else the run's status; the user writes no checks.
 *
 * FAIL-SAFE: reporting never fails or slows a run beyond `SEND_TIMEOUT_MS`. A
 * send that fails is dropped, warned once (`onWarning`) and kept as `failure`,
 * which the run reports as `platform.reportError`.
 */

import { randomBytes, randomUUID } from "crypto";
import { authHeaders, IronBeeConfig } from "./config";

const SEND_TIMEOUT_MS: number = 5_000;

export enum VerdictStatus {
    PASS = "pass",
    FAIL = "fail",
}

export interface RunVerdict {
    status: VerdictStatus;
    checks: string[];
    issues: string[];
}

export interface RunIds {
    sessionId: string;
    activityId: string;
    verificationId: string;
    /** W3C trace id (32 hex) pinned for the run: browser spans and backend spans share it. */
    traceId: string;
}

export function newTraceId(): string {
    return randomBytes(16).toString("hex");
}

export class RunReporter {
    readonly ids: RunIds;
    private readonly startedAt: number = Date.now();
    private warned: boolean = false;
    /** The first failure of a send, if any: the run is not (fully) on the platform. */
    failure: string | undefined;
    private readonly pending: Array<Promise<void>> = [];

    constructor(
        private readonly config: IronBeeConfig,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly onWarning: (message: string) => void = (m: string): void => {
            console.warn(m);
        }
    ) {
        this.ids = {
            sessionId: randomUUID(),
            activityId: randomUUID(),
            verificationId: randomUUID(),
            traceId: newTraceId(),
        };
    }

    /**
     * What every DevTools call carries so the daemon correlates it: its
     * tool_call events, uploaded video and browser spans land under this run.
     */
    metadataFor(): Record<string, unknown> {
        return {
            projectName: this.config.projectName,
            sessionId: this.ids.sessionId,
            activityId: this.ids.activityId,
            verificationId: this.ids.verificationId,
            traceId: this.ids.traceId,
            // The collector files browser spans under the run by this W3C tracestate entry.
            traceState: this.traceState(),
            agentName: "ibexpress",
            collectorUrl: this.config.collectorUrl,
            apiUrl: this.config.apiUrl,
            ...(this.config.userEmail ? { userEmail: this.config.userEmail } : {}),
            ...(this.config.oauthToken
                ? { serviceOAuthToken: this.config.oauthToken }
                : { serviceApiKey: this.config.apiKey }),
        };
    }

    /** `ironbee=prj:…;sid:…;aid:…;vid:…` — the IronBee CLI's correlation tracestate. */
    traceState(): string {
        const parts: string[] = [
            `prj:${this.config.projectName}`,
            `sid:${this.ids.sessionId}`,
            `aid:${this.ids.activityId}`,
            `vid:${this.ids.verificationId}`,
        ];
        return `ironbee=${parts.join(";")}`;
    }

    private base(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            id: randomUUID(),
            type,
            timestamp: Date.now(),
            session_id: this.ids.sessionId,
            project_name: this.config.projectName,
            ...(this.config.userEmail ? { user_email: this.config.userEmail } : {}),
            ...extra,
        };
    }

    private send(events: Array<Record<string, unknown>>): void {
        const task: Promise<void> = (async (): Promise<void> => {
            try {
                const response: Response = await this.fetchImpl(`${this.config.collectorUrl.replace(/\/$/, "")}/v1/events`, {
                    method: "POST",
                    headers: { "content-type": "application/json", ...authHeaders(this.config) },
                    body: JSON.stringify(events),
                    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
                });
                if (!response.ok) {
                    this.warn(`IronBee platform rejected run events: HTTP ${response.status}`);
                }
            } catch (err: unknown) {
                this.warn(`IronBee platform unreachable: ${err instanceof Error ? err.message : err}`);
            }
        })();
        this.pending.push(task);
    }

    private warn(message: string): void {
        this.failure ??= message;
        if (!this.warned) {
            this.warned = true;
            this.onWarning(message);
        }
    }

    /** Opens the session, the activity and the verification. */
    start(name: string, goal: string): void {
        const activity: Record<string, unknown> = { activity_id: this.ids.activityId, agent_name: "ibexpress" };
        this.send([
            this.base("session_start", { source: "startup", client: "ibexpress" }),
            this.base("activity_start", { ...activity, source: "user_prompt" }),
            this.base("verification_start", {
                ...activity,
                verification_id: this.ids.verificationId,
                trace_id: this.ids.traceId,
                name: name.slice(0, 255) || goal.slice(0, 255),
                platforms: ["browser"],
            }),
        ]);
    }

    /** Closes everything with the run's verdict. */
    finish(verdict: RunVerdict, status: string, reason?: string): void {
        const duration: number = Date.now() - this.startedAt;
        const activity: Record<string, unknown> = { activity_id: this.ids.activityId, agent_name: "ibexpress" };
        const verification: Record<string, unknown> = {
            ...activity,
            verification_id: this.ids.verificationId,
            trace_id: this.ids.traceId,
        };
        this.send([
            this.base("verdict_write", {
                ...verification,
                verdict: {
                    status: verdict.status,
                    ...(verdict.checks.length ? { checks: verdict.checks } : {}),
                    ...(verdict.issues.length ? { issues: verdict.issues } : {}),
                },
            }),
            this.base("verification_end", {
                ...verification,
                duration,
                status: verdict.status,
                ...(reason ? { reason: `${status}: ${reason}`.slice(0, 500) } : {}),
                platforms: ["browser"],
            }),
            this.base("activity_end", { ...activity, duration }),
            this.base("session_end", { duration, reason: status }),
        ]);
    }

    /** Waits for in-flight sends (bounded by their own timeouts). */
    async flush(): Promise<void> {
        await Promise.all(this.pending);
    }
}
