import { RunResult, RunStatus } from "../../../src/agent/agent";
import { DevtoolsClient } from "../../../src/devtools/client";
import { authHeaders, daemonEnvFor, IronBeeConfig, resolveIronBeeConfig } from "../../../src/ironbee/config";
import { RunReporter, VerdictStatus } from "../../../src/ironbee/reporter";
import { readTrace, TraceReport } from "../../../src/ironbee/trace";
import { platformVerdict } from "../../../src/run/runner";
import { FindingSource, GoalState, RunAnalysis, Severity, Verdict } from "../../../src/verify/types";
import { snapshot } from "../../helpers/fixtures";

const DEV: IronBeeConfig = resolveIronBeeConfig({ IRONBEE_API_KEY: "k-dev", IRONBEE_DOMAIN: "ironbee.dev", IBEXPRESS_PROJECT_NAME: "shop" });

describe("resolveIronBeeConfig / daemonEnvFor", (): void => {
    it("derives both endpoints from the domain and is on only with a credential", (): void => {
        expect(DEV).toMatchObject({
            enabled: true,
            collectorUrl: "https://collector.service.ironbee.dev",
            apiUrl: "https://api.service.ironbee.dev",
            projectName: "shop",
        });
        expect(resolveIronBeeConfig({}).enabled).toBe(false);
        expect(resolveIronBeeConfig({ IRONBEE_API_KEY: "k", IBEXPRESS_IRONBEE_REPORT: "off" }).enabled).toBe(false);
        expect(resolveIronBeeConfig({ SERVICE_DOMAIN: "https://ironbee.dev/" }).domain).toBe("ironbee.dev");
        // A template's empty IRONBEE_API_KEY= does not shadow the IronBee CLI's SERVICE_API_KEY.
        expect(resolveIronBeeConfig({ IRONBEE_API_KEY: "", SERVICE_API_KEY: "k-cli" })).toMatchObject({ enabled: true, apiKey: "k-cli" });
        expect(resolveIronBeeConfig({ IRONBEE_OAUTH_TOKEN: " ", SERVICE_OAUTH_TOKEN: "t" })).toMatchObject({ enabled: true, oauthToken: "t" });
        // The same for the endpoints and the project: an empty assignment is unset, not "".
        expect(
            resolveIronBeeConfig({ IRONBEE_API_KEY: "k", IRONBEE_DOMAIN: "ironbee.dev", IRONBEE_COLLECTOR_URL: "", IRONBEE_API_URL: " ", IRONBEE_CONSOLE_URL: "", IBEXPRESS_PROJECT_NAME: "" })
        ).toMatchObject({
            collectorUrl: "https://collector.service.ironbee.dev",
            apiUrl: "https://api.service.ironbee.dev",
            consoleUrl: "https://console.ironbee.dev",
        });
        expect(resolveIronBeeConfig({ IRONBEE_API_KEY: "k", IBEXPRESS_PROJECT_NAME: "" }).projectName).not.toBe("");
        expect(resolveIronBeeConfig({ IRONBEE_API_KEY: "k", IRONBEE_USER_EMAIL: " " }).userEmail).toBeUndefined();
    });

    it("prefers the personal token over the key", (): void => {
        expect(authHeaders(DEV)).toEqual({ "X-API-Key": "k-dev" });
        expect(authHeaders({ ...DEV, oauthToken: "t" })).toEqual({ "X-OAuth-Token": "t" });
    });

    it("configures the daemon for metadata, OTLP export and trace reads", (): void => {
        expect(daemonEnvFor(DEV)).toMatchObject({
            TOOL_INPUT_METADATA_ENABLE: "true",
            SERVICE_DOMAIN: "ironbee.dev",
            SERVICE_API_KEY: "k-dev",
            OTEL_ENABLE: "true",
            OTEL_EXPORTER_TYPE: "otlp/http-protobuf",
            OTEL_EXPORTER_HTTP_URL: "https://collector.service.ironbee.dev",
            OTEL_EXPORTER_HTTP_HEADERS: "X-API-Key=k-dev",
        });
        expect(daemonEnvFor(resolveIronBeeConfig({}))).toEqual({});
    });
});

describe("RunReporter", (): void => {
    function capture(status: number = 202): { fetchImpl: typeof fetch; batches: Array<Array<Record<string, any>>>; headers: Array<Record<string, string>> } {
        const batches: Array<Array<Record<string, any>>> = [];
        const headers: Array<Record<string, string>> = [];
        const fetchImpl: typeof fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
            batches.push(JSON.parse(String(init.body)));
            headers.push(init.headers as Record<string, string>);
            return new Response("{}", { status });
        }) as typeof fetch;
        return { fetchImpl, batches, headers };
    }

    it("reports the session lifecycle with the verdict, correlated by ids", async (): Promise<void> => {
        const { fetchImpl, batches, headers } = capture();
        const reporter: RunReporter = new RunReporter(DEV, fetchImpl, (): void => {});
        reporter.start("checkout", "Buy the headphones");
        reporter.finish({ status: VerdictStatus.FAIL, checks: ["a"], issues: ["b"] }, "failed", "why");
        await reporter.flush();
        const events: Array<Record<string, any>> = batches.flat();
        expect(events.map((e): string => e.type)).toEqual([
            "session_start",
            "activity_start",
            "verification_start",
            "verdict_write",
            "verification_end",
            "activity_end",
            "session_end",
        ]);
        expect(new Set(events.map((e): string => e.session_id))).toEqual(new Set([reporter.ids.sessionId]));
        expect(events[2]).toMatchObject({ name: "checkout", trace_id: reporter.ids.traceId, verification_id: reporter.ids.verificationId });
        expect(events[3].verdict).toEqual({ status: "fail", checks: ["a"], issues: ["b"] });
        expect(events.every((e): boolean => e.project_name === "shop")).toBe(true);
        expect(headers[0]["X-API-Key"]).toBe("k-dev");
        expect(reporter.failure).toBeUndefined();
    });

    it("gives DevTools the ids, the credential and the correlation tracestate", (): void => {
        const reporter: RunReporter = new RunReporter(DEV, capture().fetchImpl);
        const m: Record<string, unknown> = reporter.metadataFor();
        expect(m).toMatchObject({ projectName: "shop", serviceApiKey: "k-dev", apiUrl: DEV.apiUrl, collectorUrl: DEV.collectorUrl });
        expect(reporter.ids.traceId).toMatch(/^[0-9a-f]{32}$/);
        expect(m.traceState).toBe(
            `ironbee=prj:shop;sid:${reporter.ids.sessionId};aid:${reporter.ids.activityId};vid:${reporter.ids.verificationId}`
        );
    });

    it("never fails the run: a rejected or unreachable send is recorded and warned once", async (): Promise<void> => {
        const warnings: string[] = [];
        const reporter: RunReporter = new RunReporter(DEV, capture(401).fetchImpl, (m: string): void => {
            warnings.push(m);
        });
        reporter.start("x", "y");
        reporter.finish({ status: VerdictStatus.PASS, checks: [], issues: [] }, "done");
        await expect(reporter.flush()).resolves.toBeUndefined();
        expect(warnings).toEqual(["IronBee platform rejected run events: HTTP 401"]);
        expect(reporter.failure).toMatch(/401/);
    });
});

describe("platformVerdict", (): void => {
    const base: RunResult = { status: RunStatus.DONE, elapsedMs: 1, actions: 1, decisions: 1, steps: [], finalSnapshot: snapshot(1, []) };

    it("reports the review: the goal line and every problem", (): void => {
        const analysis: RunAnalysis = {
            verdict: Verdict.FAILED,
            summary: "critical: …",
            goal: { state: GoalState.DONE, stateProbability: 0.9, probability: 0.9, achieved: true },
            candidates: 3,
            findings: [
                { source: FindingSource.LOG, title: "order-service: PAYMENT_FAILED", detail: "2 records", severity: Severity.CRITICAL, probability: 0.8 },
            ],
        };
        expect(platformVerdict(base, "Buy", analysis)).toEqual({
            status: VerdictStatus.FAIL,
            checks: ["goal done (p=0.90): Buy"],
            issues: ["critical: order-service: PAYMENT_FAILED — 2 records"],
        });
    });

    it("uses the status when there is no review", (): void => {
        expect(platformVerdict(base, "Open the cart")).toEqual({ status: VerdictStatus.PASS, checks: ["goal reached: Open the cart"], issues: [] });
        expect(platformVerdict({ ...base, status: RunStatus.BLOCKED, reason: "stuck" }, "g").issues).toEqual(["blocked: stuck"]);
    });
});

describe("readTrace", (): void => {
    class TraceClient extends DevtoolsClient {
        readonly calls: Array<{ tool: string; input: any }> = [];
        spanCounts: number[] = [3, 5, 5];
        constructor() {
            super({ baseUrl: "http://t" });
        }
        override async call<T>(tool: string, input: any): Promise<T> {
            this.calls.push({ tool, input });
            if (tool === "o11y_get-trace" && input.detail === "attributes") {
                // Two pages: the chart follows nextOffset.
                return (input.offset === 0
                    ? {
                          spans: [{ spanId: "b", parentSpanId: "a", name: "POST /pay", serviceName: "payment", status: "ERROR", statusMessage: "declined", startTimeUnixNano: "2000", durationMs: 4 }],
                          hasMore: true,
                          nextOffset: 1,
                      }
                    : { spans: [{ spanId: "a", name: "checkout", serviceName: "frontend", status: "OK", startTimeUnixNano: "1000", durationMs: 9 }] }) as T;
            }
            if (tool === "o11y_get-trace") {
                const count: number = this.spanCounts.shift() ?? 5;
                return { count, services: [{ name: "payment", spanCount: count, errorCount: 1 }] } as T;
            }
            return {
                logs: [
                    { body: "EVENT RECEIVED PAYMENT_FAILED 1", serviceName: "order", severityText: "INFO", severityNumber: 9 },
                    { body: "order ended PAYMENT_FAILED", serviceName: "frontend", severityText: "WARN", severityNumber: 13 },
                ],
            } as T;
        }
    }

    it("reads services, every span (paged) and every log, settling the span count first", async (): Promise<void> => {
        const client: TraceClient = new TraceClient();
        const report: TraceReport = await readTrace(client, "t".repeat(32), { waitMs: 0, settleSpansMs: 10_000 });
        expect(report.spanCount).toBe(5);
        expect(report.spans.map((s): string => s.spanId)).toEqual(["a", "b"]);
        expect(report.logs).toHaveLength(2);
    }, 15_000);
});

describe("DevtoolsClient metadata", (): void => {
    afterEach((): void => {
        jest.restoreAllMocks();
    });

    it("sends _metadata, and drops it once when the daemon refuses the key", async (): Promise<void> => {
        const bodies: any[] = [];
        jest.spyOn(global, "fetch").mockImplementation((async (_url: string, init: RequestInit): Promise<Response> => {
            const body: any = JSON.parse(String(init.body));
            bodies.push(body);
            if (body.toolInput._metadata) {
                return new Response(JSON.stringify({ error: { message: "Invalid Tool Request: input: Unrecognized key(s) in object: '_metadata'" } }), { status: 400 });
            }
            return new Response(JSON.stringify({ toolOutput: { ok: true } }));
        }) as typeof fetch);
        const client: DevtoolsClient = new DevtoolsClient({ baseUrl: "http://d" });
        const rejected: string[] = [];
        client.onMetadataRejected = (tool: string): void => {
            rejected.push(tool);
        };
        client.setMetadata({ sessionId: "s" });
        await expect(client.call("a", {})).resolves.toEqual({ ok: true });
        await expect(client.call("b", {})).resolves.toEqual({ ok: true });
        expect(rejected).toEqual(["a"]);
        expect(bodies.map((b): boolean => "_metadata" in b.toolInput)).toEqual([true, false, false]);
    });
});
