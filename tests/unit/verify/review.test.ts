import { decideVerdict, RunAnalyzer } from "../../../src/verify/analyzer";
import { collectCandidates } from "../../../src/verify/candidates";
import { bodyCap, describeApiResponses, describeEvidence, evidenceItems, itemsIn, logKey } from "../../../src/verify/describe";
import { GoalJudge } from "../../../src/verify/goal";
import {
    Candidate,
    CapturedRequest,
    Finding,
    FindingSource,
    PageEvidence,
    RunAnalysis,
    Severity,
    TraceItemKind,
    Verdict,
} from "../../../src/verify/types";
import { JEV_PROFILE } from "../../../src/engine/jev";
import { FakeEngine, RecordedRequest } from "../../helpers/fake-engine";
import { answer } from "../../helpers/fixtures";

function req(method: string, path: string, status: number | undefined, body?: unknown, failure?: string): CapturedRequest {
    return {
        method,
        url: `https://shop.test${path}`,
        resourceType: "fetch",
        status,
        failure,
        body: body === undefined ? undefined : JSON.stringify(body),
        timestamp: 1,
    };
}

const EVIDENCE: PageEvidence = {
    url: "https://shop.test/orders/70",
    title: "Order",
    text: "Order placed successfully!",
    requests: [
        req("POST", "/api/auth/login", 401),
        req("GET", "/api/products", 200, [{ id: 1, name: "Sony" }]),
        req("GET", "/api/orders/70", 200, { id: 70, status: "PENDING" }),
        req("GET", "/api/orders/70", 200, { id: 70, status: "PAYMENT_FAILED" }),
        req("GET", "/api/orders/71", 200, { id: 71, status: "PAYMENT_FAILED" }),
        req("GET", "/static/app.js", undefined, undefined, "net::ERR_ABORTED"),
    ],
    consoleErrors: [
        { type: "error", text: "Uncaught TypeError: x is undefined", timestamp: 1 },
        { type: "error", text: "Uncaught TypeError: x is undefined", timestamp: 2 },
    ],
    trace: {
        traceId: "t",
        spanCount: 3,
        services: [],
        spans: [
            { spanId: "a", name: "POST /pay", service: "payment-service", status: "ERROR", statusMessage: "declined", durationMs: 30 },
            { spanId: "b", name: "GET /api/orders", service: "api-gateway", status: "OK", durationMs: 4_200 },
            { spanId: "c", name: "GET /api/products", service: "api-gateway", status: "OK", durationMs: 20 },
        ],
        logs: [
            { service: "order-service", severityNumber: 9, body: "EVENT RECEIVED PAYMENT_FAILED 3f1c2a9e-1111-2222-3333-444455556666", timeNs: "1" },
            { service: "order-service", severityNumber: 9, body: "EVENT RECEIVED PAYMENT_FAILED 9a8b7c6d-1111-2222-3333-444455556666", timeNs: "2" },
            { service: "frontend", severityNumber: 13, body: "order ended with status PAYMENT_FAILED: 70", timeNs: "3" },
            { service: "cart-service", severityNumber: 9, body: "cart updated", timeNs: "4" },
        ],
    },
};

describe("collectCandidates", (): void => {
    const candidates: Candidate[] = collectCandidates(EVIDENCE);
    const titles: string[] = candidates.map((c: Candidate): string => c.title);

    it("finds HTTP errors, requests with no response, console errors, failed and slow spans, and WARN+ log records", (): void => {
        expect(titles).toEqual(
            expect.arrayContaining([
                "POST /api/auth/login → 401",
                "GET /static/app.js → failed (net::ERR_ABORTED)",
                "console: Uncaught TypeError: x is undefined",
                "failed span payment-service: POST /pay",
                "slow span api-gateway: GET /api/orders",
                "frontend: order ended with status PAYMENT_FAILED: 70",
            ])
        );
    });

    it("offers an item only where its own line is in the text, not where page text quotes its id", (): void => {
        const items = evidenceItems(EVIDENCE);
        const described: string = describeEvidence(EVIDENCE, 24_000);
        expect(itemsIn(items, described).map((i) => i.id)).toContain("r1");
        // A page that shows "[r1]" (or "[s1]") of its own carries no evidence item.
        expect(itemsIn(items, "Order summary [r1] [s1] [l1]\n[r1] see above")).toEqual([]);
    });

    it("reads no text: what a response body or an INFO line says is the engine's call, in the evidence", (): void => {
        // A failed state in a 200 body and INFO lines saying something failed are not candidates…
        expect(titles.some((t: string): boolean => t.includes("/api/orders/*:") || t.includes("EVENT RECEIVED") || t.includes("cart updated"))).toBe(false);
        expect(candidates).toHaveLength(6);
        // …the engine reads them.
        const evidence: string = describeEvidence(EVIDENCE, 24_000);
        expect(evidence).toContain('GET /api/orders/70 → 200 {"id":70,"status":"PAYMENT_FAILED"}');
        expect(evidence).toContain("EVENT RECEIVED PAYMENT_FAILED");
    });

    it("groups alike anomalies and keeps where each was seen, for the UI", (): void => {
        const byTitle: (title: string) => Candidate = (title: string): Candidate => candidates.find((c: Candidate): boolean => c.title === title)!;
        expect(byTitle("POST /api/auth/login → 401").occurrences).toEqual([
            { source: FindingSource.NETWORK, where: "POST /api/auth/login", what: "→ 401", count: 1 },
        ]);
        expect(byTitle("console: Uncaught TypeError: x is undefined").occurrences).toEqual([
            { source: FindingSource.CONSOLE, where: "console error", what: "Uncaught TypeError: x is undefined", count: 2 },
        ]);
        expect(byTitle("failed span payment-service: POST /pay").occurrences).toEqual([
            { source: FindingSource.TRACE, where: "payment-service: POST /pay", what: "declined", count: 1 },
        ]);
        const log: Candidate = byTitle("frontend: order ended with status PAYMENT_FAILED: 70");
        expect(log.trace).toEqual([{ kind: TraceItemKind.LOG, id: logKey(EVIDENCE.trace!.logs[2]) }]);
    });

    it("puts the likeliest problems first and caps the list", (): void => {
        expect(candidates[0].title).toBe("GET /static/app.js → failed (net::ERR_ABORTED)");
        expect(collectCandidates(EVIDENCE, 3)).toHaveLength(3);
    });

    it("ranks a log group by its worst record, not its first", (): void => {
        // A warning-only group comes first in the logs; the retry group starts as a warning and
        // turns into an error: it is the likelier problem, whatever its first record's level.
        const logs: PageEvidence = {
            url: "https://shop.test/",
            title: "Shop",
            text: "",
            trace: {
                traceId: "t",
                spanCount: 0,
                services: [],
                spans: [],
                logs: [
                    { service: "cart-service", severityNumber: 13, body: "cache slow for key 4", timeNs: "1" },
                    { service: "order-service", severityNumber: 13, body: "retry 1 for order 7", timeNs: "2" },
                    { service: "order-service", severityNumber: 17, body: "retry 2 for order 7", timeNs: "3" },
                ],
            },
        };
        const top: Candidate[] = collectCandidates(logs, 1);
        expect(top.map((c: Candidate): string => c.title)).toEqual(["order-service: retry 1 for order 7"]);
    });
});

describe("describeApiResponses", (): void => {
    it("keeps every body whole while they fit, and cuts only the longest, all to the same length", (): void => {
        expect(bodyCap([10, 20, 30], 100)).toBe(Infinity);
        // 10 stays whole; the 90 left is shared by the two longer ones.
        expect(bodyCap([10, 200, 300], 100)).toBe(45);
        const requests: CapturedRequest[] = [
            req("GET", "/a", 200, { small: 1 }),
            req("GET", "/b", 200, { big: "x".repeat(5_000) }),
        ];
        const text: string = describeApiResponses(requests, 1_000);
        expect(text).toContain('GET /a → 200 {"small":1}');
        expect(text.length).toBeLessThanOrEqual(1_050);
        expect(text.split("\n")[1].endsWith("…")).toBe(true);
    });

    it("says the final page's control state, which its text does not — never a password's value", (): void => {
        const text: string = describeEvidence(
            {
                ...EVIDENCE,
                controls: [
                    { id: 1, role: "checkbox", name: "Remember me", ops: [], checked: "true" },
                    { id: 2, role: "radio", name: "C", ops: [], checked: "false", context: "Radio Group" },
                    { id: 3, role: "textbox", name: "Password", ops: [], password: true, filled: true },
                    { id: 4, role: "combobox", name: "Size", ops: [], value: "Large" },
                    { id: 5, role: "button", name: "Save", ops: [] },
                ],
            },
            24_000
        );
        expect(text).toContain(`Its controls' state:
checkbox "Remember me": checked=true
radio "C" (Radio Group): checked=false
textbox "Password": filled=true
combobox "Size": value="Large"`);
        expect(text).not.toContain('button "Save"');
    });

    it("gives the API responses their share, so a long page does not push them out", (): void => {
        const evidence: string = describeEvidence({ ...EVIDENCE, text: "page ".repeat(20_000) }, 24_000).slice(0, 24_000);
        expect(evidence).toContain("API responses during the run:");
        expect(evidence).toContain("PAYMENT_FAILED");
    });
});

describe("RunAnalyzer", (): void => {
    it("asks the goal and every anomaly in one request, and keeps only real problems, worst first", async (): Promise<void> => {
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
            const answers: Record<string, unknown> = { goal_state: answer("failed", ["done", "not-yet", "failed"], 0.85) };
            for (const [id, q] of Object.entries(r.questions)) {
                if (!id.startsWith("issue_")) {
                    continue;
                }
                const anomaly: string = String((q.instructions as { anomaly: string }).anomaly);
                const severity: Severity = anomaly.includes("PAYMENT_FAILED")
                    ? Severity.CRITICAL
                    : anomaly.includes("slow")
                        ? Severity.MINOR
                        : Severity.NONE;
                answers[id] = answer(severity, Object.values(Severity));
            }
            return answers;
        });
        const analysis: RunAnalysis = await new RunAnalyzer(engine).analyze("Buy the Sony headphones", EVIDENCE, true);
        expect(engine.requests).toHaveLength(1);
        expect(JSON.stringify(engine.requests[0].state)).toContain("PAYMENT_FAILED");
        expect(analysis.verdict).toBe(Verdict.FAILED);
        expect(analysis.goal).toMatchObject({ state: "failed", stateProbability: 0.85, achieved: false });
        expect(analysis.goal.signals?.[0]).toBe("frontend: order ended with status PAYMENT_FAILED: 70");
        expect(analysis.findings.map((f: Finding): string => `${f.severity} ${f.title}`)).toEqual([
            "critical frontend: order ended with status PAYMENT_FAILED: 70",
            "minor slow span api-gateway: GET /api/orders",
        ]);
        expect(analysis.candidates).toBe(collectCandidates(EVIDENCE).length);
    });
});

describe("decideVerdict", (): void => {
    const minor: Finding = { source: FindingSource.LOG, title: "x", detail: "y", severity: Severity.MINOR, probability: 0.7 };
    const major: Finding = { ...minor, severity: Severity.MAJOR, title: "POST /api/orders → 500" };

    it("passes a done goal with only minor issues, fails on major ones or an undone goal", (): void => {
        expect(decideVerdict(true, true, [minor])).toEqual({ verdict: Verdict.PASSED, summary: "goal done; 1 minor issue" });
        expect(decideVerdict(true, true, [major]).verdict).toBe(Verdict.FAILED);
        expect(decideVerdict(false, true, []).summary).toBe("the evidence does not show the goal done");
        expect(decideVerdict(true, false, []).verdict).toBe(Verdict.FAILED);
        // The why: the evidence the engine pointed at, before the worst finding.
        expect(decideVerdict(false, true, [major], ["GET /api/orders/70 → 200"]).summary).toBe("the goal is not done: GET /api/orders/70 → 200");
        expect(decideVerdict(false, false, [major]).summary).toBe("the goal was not reached: POST /api/orders → 500");
    });
});

describe("GoalJudge", (): void => {
    it("asks where the goal stands, and which piece of evidence shows why — the engine points, nothing reads the text", async (): Promise<void> => {
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => ({
            goal_state: answer("failed", ["done", "not-yet", "failed"], 0.8),
            // The order's own response: its body says PAYMENT_FAILED behind a 200.
            failure_cause: answer("r4", Object.keys((r.questions.failure_cause as { criteria: Record<string, string> }).criteria), 0.7),
        }));
        const judged = await new GoalJudge(engine).judge("Buy", EVIDENCE);
        expect(judged).toMatchObject({ state: "failed", stateProbability: 0.8, achieved: false });
        expect(judged.signals).toEqual(["GET /api/orders/70 → 200"]);
        expect(Object.keys(engine.requests[0].questions)).toEqual(["goal_state", "failure_cause"]);
        // The option names the item; its content is in the evidence under the same id.
        expect(JSON.stringify(engine.requests[0].questions.failure_cause)).toContain("[r4] GET /api/orders/70 → 200");
        expect(JSON.stringify(engine.requests[0].state)).toContain('[r4] GET /api/orders/70 → 200 {\\"id\\":70,\\"status\\":\\"PAYMENT_FAILED\\"}');
    });

    it("reads the cause the engine picked when the evidence has more items than the engine takes options", async (): Promise<void> => {
        // 13 items, 10 options: 9 are offered beside `none`; the answer over those 10 keys must count.
        const engine: FakeEngine = new FakeEngine(
            (r: RecordedRequest): Record<string, unknown> => {
                const criteria: Record<string, string> = (r.questions.failure_cause as { criteria: Record<string, string> }).criteria;
                expect(Object.keys(criteria)).toHaveLength(10);
                const answers: Record<string, unknown> = {
                    goal_state: answer("failed", ["done", "not-yet", "failed"], 0.8),
                    failure_cause: answer("r4", Object.keys(criteria), 0.7),
                };
                for (const id of Object.keys(r.questions).filter((k: string): boolean => k.startsWith("issue_"))) {
                    answers[id] = answer(Severity.NONE, Object.values(Severity));
                }
                return answers;
            },
            { ...JEV_PROFILE, maxOptions: 10 }
        );
        expect((await new GoalJudge(engine).judge("Buy", EVIDENCE)).signals).toEqual(["GET /api/orders/70 → 200"]);
        const analysis: RunAnalysis = await new RunAnalyzer(engine).analyze("Buy", EVIDENCE, false);
        expect(analysis.goal.signals).toEqual(["GET /api/orders/70 → 200"]);
    });

    it("offers a compact engine's chunk only the items that chunk carries", async (): Promise<void> => {
        const engine: FakeEngine = new FakeEngine(
            (r: RecordedRequest): Record<string, unknown> => {
                const criteria: Record<string, string> | undefined = (r.questions.failure_cause as { criteria: Record<string, string> } | undefined)?.criteria;
                return {
                    goal_state: answer("not-yet", ["done", "not-yet", "failed"]),
                    ...(criteria ? { failure_cause: answer("none", Object.keys(criteria)) } : {}),
                };
            },
            { ...JEV_PROFILE, compact: true, maxTextChars: 1_000 }
        );
        const requests: CapturedRequest[] = Array.from(
            { length: 20 },
            (_: unknown, i: number): CapturedRequest => ({
                method: "GET",
                url: `https://shop.test/api/item/${i + 1}`,
                resourceType: "fetch",
                status: 200,
                timestamp: i,
                body: "{}",
            })
        );
        await new GoalJudge(engine).judge("Buy", { url: "https://shop.test/", title: "Shop", text: "lorem ipsum ".repeat(400), requests });
        expect(engine.requests.length).toBeGreaterThan(1);
        for (const request of engine.requests) {
            const text: string = JSON.stringify(request.state);
            const criteria: Record<string, string> = (request.questions.failure_cause as { criteria: Record<string, string> } | undefined)?.criteria ?? {};
            for (const id of Object.keys(criteria).filter((k: string): boolean => k !== "none")) {
                expect(text).toContain(`[${id}]`);
            }
        }
        // Some chunk carries no response: it is offered none.
        expect(engine.requests.some((request: RecordedRequest): boolean => request.questions.failure_cause === undefined)).toBe(true);
    });

    it("keeps no cause when the engine points at none", async (): Promise<void> => {
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => ({
            goal_state: answer("not-yet", ["done", "not-yet", "failed"]),
            failure_cause: answer("none", Object.keys((r.questions.failure_cause as { criteria: Record<string, string> }).criteria)),
        }));
        expect((await new GoalJudge(engine).judge("Buy", EVIDENCE)).signals).toBeUndefined();
    });
});

describe("the evidence of a long run", (): void => {
    const long: string = "x".repeat(400);
    const BIG: PageEvidence = {
        url: "https://shop.test/checkout",
        title: "Checkout",
        now: "Sunday, 27 September 2026, 09:00 (+03:00)",
        text: `Checkout ${"lorem ipsum ".repeat(3_000)}`,
        visibleText: "Place order",
        controls: Array.from({ length: 80 }, (_v: unknown, i: number) => ({
            id: i + 1,
            role: "checkbox",
            name: `Filter option number ${i + 1} with a long accessible name`,
            ops: [],
            checked: i % 2 ? "true" : "false",
            context: "Filters for the product list",
        })),
        requests: Array.from({ length: 40 }, (_v: unknown, i: number): CapturedRequest =>
            req("GET", `/api/items/${i}?page=${i}&${"q".repeat(100)}`, i === 39 ? 500 : 200, { id: i, text: long })
        ),
        consoleErrors: Array.from({ length: 10 }, (_v: unknown, i: number) => ({ type: "error", text: `TypeError ${i}: ${long}`, timestamp: i })),
        journey: {
            steps: Array.from({ length: 30 }, (_v: unknown, i: number) => ({
                step: i + 1,
                operation: "CLICK",
                target: `[${i}] checkbox "Filter option number ${i} with a long accessible name" (Filters for the product list)`,
                url: `https://shop.test/list?page=${i}`,
            })),
            pages: Array.from({ length: 8 }, (_v: unknown, i: number) => ({ url: `https://shop.test/p${i}`, title: `Page ${i}`, excerpt: long })),
        },
        trace: {
            traceId: "t",
            spanCount: 60,
            services: [{ name: "api-gateway", spanCount: 60, errorCount: 1 }],
            spans: Array.from({ length: 60 }, (_v: unknown, i: number) => ({
                spanId: `s${i}`,
                name: `GET /api/items/${i}`,
                service: "api-gateway",
                status: i === 59 ? "ERROR" : "OK",
                statusMessage: i === 59 ? long : undefined,
                durationMs: 20,
            })),
            logs: Array.from({ length: 80 }, (_v: unknown, i: number) => ({
                service: "order-service",
                severityNumber: 13,
                body: `slow query ${i}: ${long}`,
                timeNs: String(i),
            })),
        },
    };

    const offeredIds = (r: RecordedRequest): string[] =>
        Object.keys((r.questions.failure_cause as { criteria: Record<string, string> }).criteria).filter((id: string): boolean => id !== "none");

    it("fits the budget, every part within its share, and carries the latest response", (): void => {
        const text: string = describeEvidence(BIG, 24_000);
        expect(text.length).toBeLessThanOrEqual(24_000);
        expect(text).toContain("[r40] GET /api/items/39");
        expect(text).toContain("The run's distributed trace (IronBee):");
        expect(text).toContain("Console errors:");
        expect(describeEvidence(BIG, 3_000).length).toBeLessThanOrEqual(3_000);
    });

    it("is judged in one request by a large-context engine, and only the items it carries are offered", async (): Promise<void> => {
        const engine: FakeEngine = new FakeEngine((): Record<string, unknown> => ({ goal_state: answer("not-yet", ["done", "not-yet", "failed"]) }));
        await new GoalJudge(engine).judge("Place the order", BIG);
        expect(engine.requests).toHaveLength(1);
        const evidence: string = (engine.requests[0].state as { evidence: string }).evidence;
        expect(evidence.length).toBeLessThanOrEqual(24_000);
        const ids: string[] = offeredIds(engine.requests[0]);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
            expect(evidence).toContain(`[${id}]`);
        }
    });

    it("is reviewed within the budget, and every offered cause is in the evidence sent", async (): Promise<void> => {
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
            const answers: Record<string, unknown> = { goal_state: answer("failed", ["done", "not-yet", "failed"]) };
            for (const id of Object.keys(r.questions)) {
                if (id.startsWith("issue_")) {
                    answers[id] = answer(Severity.NONE, Object.values(Severity));
                }
            }
            return answers;
        });
        await new RunAnalyzer(engine).analyze("Place the order", BIG, true);
        expect(engine.requests).toHaveLength(1);
        const evidence: string = (engine.requests[0].state as { evidence: string }).evidence;
        expect(evidence.length).toBeLessThanOrEqual(24_000);
        for (const id of offeredIds(engine.requests[0])) {
            expect(evidence).toContain(`[${id}]`);
        }
    });
});
