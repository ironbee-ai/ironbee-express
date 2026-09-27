import { TextProvider } from "../../../src/text/providers";
import { describeNow } from "../../../src/verify/evidence";
import { explainFailure, explainPrompt } from "../../../src/verify/explain";
import { Explanation, FindingSource, PageEvidence, RunAnalysis, Severity, Verdict } from "../../../src/verify/types";

const EVIDENCE: PageEvidence = {
    url: "https://shop.test/orders/7",
    title: "Order",
    text: "Order placed successfully!",
    requests: [
        {
            method: "GET",
            url: "https://shop.test/api/orders/7",
            resourceType: "fetch",
            status: 200,
            body: '{"id":7,"status":"FAILED","reason":"Insufficient inventory"}',
            timestamp: 1,
        },
    ],
};

const ANALYSIS: RunAnalysis = {
    verdict: Verdict.FAILED,
    summary: "the goal is not done: GET /api/orders/7 → 200",
    goal: { state: "failed" as never, stateProbability: 0.9, probability: 0.05, achieved: false, signals: ["GET /api/orders/7 → 200"] },
    findings: [{ source: FindingSource.LOG, title: "order-service: ORDER_FAILED 7", detail: "", severity: Severity.CRITICAL, probability: 0.8 }],
    candidates: 1,
};

describe("explainFailure", (): void => {
    it("gives the text model the goal, the verdict, what the engine pointed at and the evidence", (): void => {
        const prompt: string = explainPrompt("Place the order", "done", ANALYSIS, EVIDENCE);
        expect(prompt).toContain("Goal: Place the order");
        expect(prompt).toContain("The engine pointed at: GET /api/orders/7 → 200");
        expect(prompt).toContain("- critical: order-service: ORDER_FAILED 7");
        // The body the engine pointed at, whole.
        expect(prompt).toContain('"reason":"Insufficient inventory"');
    });

    it("returns the model's words, with who wrote them", async (): Promise<void> => {
        const fetchImpl: typeof fetch = (async (): Promise<Response> =>
            new Response(JSON.stringify({ content: [{ type: "text", text: "  The order API answered 200\nwith status FAILED (insufficient inventory) while the page said it was placed. " }] }), {
                status: 200,
            })) as typeof fetch;
        const explanation: Explanation = await explainFailure(
            { model: { provider: TextProvider.ANTHROPIC, model: "claude-x" }, settings: { apiKey: "k", baseUrl: "https://api.test/v1" }, fetchImpl },
            "Place the order",
            "done",
            ANALYSIS,
            EVIDENCE
        );
        expect(explanation.model).toBe("anthropic/claude-x");
        expect(explanation.text).toBe("The order API answered 200 with status FAILED (insufficient inventory) while the page said it was placed.");
    });
});

describe("describeNow", (): void => {
    it("names the weekday, the date and the local time, for goals that say 'tomorrow'", (): void => {
        const text: string = describeNow(new Date(2026, 8, 26, 15, 4));
        expect(text).toMatch(/^Saturday 2026-09-26 15:04 \(UTC[+-]\d\d:\d\d\)$/);
    });
});
