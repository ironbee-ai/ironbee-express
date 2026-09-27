import {
    DecisionEngineError,
    SystemOneClient,
    SystemOneResponse,
    validateChoice,
} from "../../../src/engine/systemone";
import { answer } from "../../helpers/fixtures";

describe("validateChoice", (): void => {
    it("accepts a well-formed answer", (): void => {
        expect(validateChoice(answer("a", ["a", "b"]), ["a", "b"]).choice).toBe("a");
    });

    it("rejects probabilities that do not sum to 1", (): void => {
        expect((): unknown =>
            validateChoice({ choice: "a", probabilities: { a: 0.5, b: 0.1 }, confidence: 0.5 }, ["a", "b"])
        ).toThrow(DecisionEngineError);
    });

    it("rejects a choice that is not the most probable", (): void => {
        expect((): unknown =>
            validateChoice({ choice: "a", probabilities: { a: 0.3, b: 0.7 }, confidence: 0.5 }, ["a", "b"])
        ).toThrow(DecisionEngineError);
    });

    it("rejects missing, extra or unoffered options", (): void => {
        expect((): unknown => validateChoice({ choice: "a", probabilities: { a: 1 }, confidence: 1 }, ["a", "b"])).toThrow();
        expect((): unknown => validateChoice(answer("c", ["a", "c"]), ["a", "b"])).toThrow();
    });

    it("ignores extra fields an engine adds (answer_confidence, action)", (): void => {
        expect(
            validateChoice({ ...answer("a", ["a", "b"]), answer_confidence: 0.9, action: { act_probability: 1 } }, [
                "a",
                "b",
            ]).choice
        ).toBe("a");
    });
});

describe("SystemOneClient", (): void => {
    function fetchReturning(statuses: number[], seen: RequestInit[]): typeof fetch {
        return (async (_url: unknown, init: RequestInit): Promise<Response> => {
            seen.push(init);
            const status: number = statuses.shift() ?? 200;
            const body: SystemOneResponse = { model: "m", answers: {} };
            return new Response(JSON.stringify(body), { status });
        }) as typeof fetch;
    }

    it("sends model and bearer only when configured", async (): Promise<void> => {
        const seen: RequestInit[] = [];
        await new SystemOneClient({ url: "http://e/v1/systemone", label: "x", fetchImpl: fetchReturning([], seen) }).ask(
            "s",
            {}
        );
        expect(JSON.parse(String(seen[0].body))).toEqual({ state: "s", questions: {} });
        expect((seen[0].headers as Record<string, string>).authorization).toBeUndefined();

        await new SystemOneClient({
            url: "http://e/v1/systemone",
            label: "x",
            apiKey: "k",
            model: "jev-latest",
            fetchImpl: fetchReturning([], seen),
        }).ask("s", {});
        expect(JSON.parse(String(seen[1].body)).model).toBe("jev-latest");
        expect((seen[1].headers as Record<string, string>).authorization).toBe("Bearer k");
    });

    it("retries overload statuses, then fails without acting", async (): Promise<void> => {
        const seen: RequestInit[] = [];
        const client: SystemOneClient = new SystemOneClient({
            url: "http://e",
            label: "x",
            fetchImpl: fetchReturning([529, 200], seen),
        });
        await expect(client.ask("s", {})).resolves.toBeDefined();
        expect(seen).toHaveLength(2);

        const failing: SystemOneClient = new SystemOneClient({
            url: "http://e",
            label: "x",
            fetchImpl: fetchReturning([401], []),
        });
        await expect(failing.ask("s", {})).rejects.toThrow(/HTTP 401.*no action executed/);
    });

    it("retries a transient server error, and gives up after three tries", async (): Promise<void> => {
        const seen: RequestInit[] = [];
        const client: SystemOneClient = new SystemOneClient({ url: "http://e", label: "x", fetchImpl: fetchReturning([500, 200], seen) });
        await expect(client.ask("s", {})).resolves.toBeDefined();
        expect(seen).toHaveLength(2);

        const down: RequestInit[] = [];
        const failing: SystemOneClient = new SystemOneClient({ url: "http://e", label: "x", fetchImpl: fetchReturning([502, 504, 500], down) });
        await expect(failing.ask("s", {})).rejects.toThrow(/HTTP 500.*no action executed/);
        expect(down).toHaveLength(3);
    });
});
