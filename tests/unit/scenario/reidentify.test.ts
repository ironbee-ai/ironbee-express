import { Operation } from "../../../src/agent/policy";
import { SAME_CONTROL, SHORT_SAME_CONTROL } from "../../../src/agent/prompts";
import { ControlOperation, ControlSnapshot } from "../../../src/devtools/types";
import { ChoiceQuestion } from "../../../src/engine/systemone";
import { EngineReidentifier, MIN_SAME_CONTROL_PROBABILITY, NO_CONTROL, Reidentified, ReidentifyRequest, sameControlRequest } from "../../../src/scenario/reidentify";
import { FakeEngine, RecordedRequest } from "../../helpers/fake-engine";
import { answer, COMPACT_PROFILE, control, snapshot } from "../../helpers/fixtures";

const GOAL: string = "Log in, add the Aurora Headphones to the cart, and place the order";

function request(): ReidentifyRequest {
    const candidates = [
        control(11, "button", "Add to cart", [ControlOperation.CLICK], { context: "Nimbus Speaker $59.00" }),
        control(12, "button", "Add to cart", [ControlOperation.CLICK], { context: "Aurora Headphones $119.00" }),
    ];
    const page: ControlSnapshot = snapshot(3, candidates, { url: "https://shop.test/products", title: "Products", text: "Products Nimbus Speaker Aurora Headphones" });
    return {
        operation: Operation.CLICK,
        recorded: { role: "button", name: "Add to cart", context: "Aurora Headphones $129.00", ordinal: 0 },
        recordedPath: "/products",
        candidates,
        page,
        history: [{ step: 1, operation: Operation.CLICK, target: '[4] button "Log in"', executed: true, pageChanged: true }],
    };
}

const OPTIONS: string[] = ["11", "12", NO_CONTROL];

describe("finding a changed control again", (): void => {
    it("asks one choice question: the candidates by id, or none — the goal and the recorded control beside them", (): void => {
        const { state, question, offered } = sameControlRequest(GOAL, request(), false, 250, 6_000);
        expect(offered.map((c): number => c.id)).toEqual([11, 12]);
        expect(Object.keys(question.criteria)).toEqual(OPTIONS);
        expect(question.criteria["12"]).toEqual({ element: '[12] button "Add to cart"', context: "Aurora Headphones $119.00" });
        expect(question.instructions).toEqual({ goal: GOAL, rules: SAME_CONTROL });
        expect(state).toEqual({
            recorded: {
                operation: Operation.CLICK,
                role: "button",
                name: "Add to cart",
                context_when_recorded: "Aurora Headphones $129.00",
                page_when_recorded: "/products",
            },
            page: { title: "Products", url: "https://shop.test/products", text: "Products Nimbus Speaker Aurora Headphones" },
            replayed_steps: [{ step: 1, operation: Operation.CLICK, target: '[4] button "Log in"', executed: true }],
        });
    });

    it("keeps a compact engine's question short, its goal in the state, and its options within the engine's cap", (): void => {
        const many: ReidentifyRequest = {
            ...request(),
            candidates: Array.from({ length: 30 }, (_: unknown, i: number) => control(100 + i, "button", "Add to cart", [ControlOperation.CLICK], { context: `Item ${i}` })),
        };
        const { state, question, offered } = sameControlRequest(GOAL, many, true, COMPACT_PROFILE.maxOptions, 20);
        expect(question.instructions).toBe(SHORT_SAME_CONTROL);
        expect(state.goal).toBe(GOAL);
        expect(offered).toHaveLength(COMPACT_PROFILE.maxOptions - 1);
        expect(Object.keys(question.criteria)).toHaveLength(COMPACT_PROFILE.maxOptions);
        expect((state.page as { text: string }).text.length).toBeLessThanOrEqual(20);
    });

    it("takes the control the engine is sure of; one it is unsure of is not acted on; none is none", async (): Promise<void> => {
        const replies: Array<Record<string, unknown>> = [
            { same_control: answer("12", OPTIONS, 0.96) },
            { same_control: answer("12", OPTIONS, MIN_SAME_CONTROL_PROBABILITY - 0.1) },
            { same_control: answer(NO_CONTROL, OPTIONS, 0.9) },
        ];
        const engine: FakeEngine = new FakeEngine((): Record<string, unknown> => replies.shift()!);
        const reidentifier: EngineReidentifier = new EngineReidentifier(engine, GOAL);

        const sure: Reidentified = await reidentifier.reidentify(request());
        expect(sure.control?.id).toBe(12);
        expect(sure.probability).toBeCloseTo(0.96);
        const unsure: Reidentified = await reidentifier.reidentify(request());
        expect(unsure.control).toBeUndefined();
        expect(unsure.unsure?.id).toBe(12);
        const none: Reidentified = await reidentifier.reidentify(request());
        expect(none).toMatchObject({ probability: 0.9 });
        expect(none.control).toBeUndefined();
        expect(none.unsure).toBeUndefined();

        expect(engine.requests).toHaveLength(3);
        const asked: RecordedRequest = engine.requests[0];
        expect(Object.keys(asked.questions)).toEqual(["same_control"]);
        expect(Object.keys((asked.questions.same_control as ChoiceQuestion).criteria)).toEqual(OPTIONS);
    });

    it("answers without a control, and why, when the engine cannot be asked or answers out of turn", async (): Promise<void> => {
        const failing: EngineReidentifier = new EngineReidentifier(
            new FakeEngine((): Record<string, unknown> => {
                throw new Error("engine unreachable");
            }),
            GOAL
        );
        expect(await failing.reidentify(request())).toMatchObject({ probability: 0, error: "engine unreachable" });
        // An option that was not offered is not an answer.
        const stray: EngineReidentifier = new EngineReidentifier(new FakeEngine((): Record<string, unknown> => ({ same_control: answer("99", [...OPTIONS, "99"]) })), GOAL);
        const out: Reidentified = await stray.reidentify(request());
        expect(out.control).toBeUndefined();
        expect(out.error).toBeDefined();
    });
});
