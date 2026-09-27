import { EngineDecider, Operation } from "../../../src/agent/policy";
import { RequestTooLargeError, SystemOneClient } from "../../../src/engine/systemone";
import { FakeEngine, RecordedRequest } from "../../helpers/fake-engine";
import { answer, LOGIN_CONTROLS, snapshot } from "../../helpers/fixtures";

describe("a request larger than the engine takes", (): void => {
    it("is told apart from other errors by the engine's error type", async (): Promise<void> => {
        const tooLarge: typeof fetch = (async (): Promise<Response> =>
            new Response('{"detail":{"error_type":"max_tokens_exceeded"}}', { status: 400 })) as typeof fetch;
        const other: typeof fetch = (async (): Promise<Response> => new Response('{"detail":"bad request"}', { status: 400 })) as typeof fetch;
        const ask = (fetchImpl: typeof fetch): Promise<unknown> =>
            new SystemOneClient({ url: "http://e/v1/systemone", label: "Jev", fetchImpl }).ask({}, {});
        await expect(ask(tooLarge)).rejects.toBeInstanceOf(RequestTooLargeError);
        await expect(ask(other)).rejects.not.toBeInstanceOf(RequestTooLargeError);
    });

    it("is asked again with less of the page, and the decision stands", async (): Promise<void> => {
        const page = snapshot(1, LOGIN_CONTROLS, { text: "x".repeat(6_000) });
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
            if (JSON.stringify(r.state).length > 5_000) {
                throw new RequestTooLargeError("Jev: HTTP 400 max_tokens_exceeded");
            }
            return { operation: answer("DONE", Object.keys((r.questions.operation as { criteria: Record<string, unknown> }).criteria)) };
        });
        const decision = await new EngineDecider(engine).decide({ goal: "g", snapshot: page, history: [], textChoices: [] });
        expect(decision.operation).toBe(Operation.DONE);
        // The full page, then half of it … until the engine takes it.
        expect(engine.requests.length).toBeGreaterThan(1);
        expect(JSON.stringify(engine.requests.at(-1)!.state).length).toBeLessThan(JSON.stringify(engine.requests[0].state).length);
    });
});

describe("a dropped connection to the engine", (): void => {
    it("is asked again, as a 5xx is", async (): Promise<void> => {
        let calls: number = 0;
        const flaky: typeof fetch = (async (): Promise<Response> => {
            calls++;
            if (calls === 1) {
                throw new TypeError("fetch failed");
            }
            return new Response(JSON.stringify({ model: "m", answers: {} }), { status: 200 });
        }) as typeof fetch;
        await new SystemOneClient({ url: "http://e/v1/systemone", label: "Jev", fetchImpl: flaky }).ask({}, {});
        expect(calls).toBe(2);
    });
});

describe("the moment of the decision", (): void => {
    it("is in the state the engine decides on, for goals that say 'tomorrow'", async (): Promise<void> => {
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => ({
            operation: answer("DONE", Object.keys((r.questions.operation as { criteria: Record<string, unknown> }).criteria)),
        }));
        await new EngineDecider(engine).decide({
            goal: "Open tomorrow's forecast",
            snapshot: snapshot(1, LOGIN_CONTROLS),
            history: [],
            textChoices: [],
            now: "Saturday 2026-09-26 15:04 (UTC+03:00)",
        });
        expect((engine.requests[0].state as { now?: string }).now).toBe("Saturday 2026-09-26 15:04 (UTC+03:00)");
    });
});
