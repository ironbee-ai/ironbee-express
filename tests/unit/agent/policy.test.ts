import {
    buildRequest,
    BuiltRequest,
    Decision,
    DecisionInput,
    EngineDecider,
    HistoryEntry,
    interpretResponse,
    isNote,
    Operation,
    UserActionKind,
} from "../../../src/agent/policy";
import { JEV_PROFILE } from "../../../src/engine/jev";
import { buildTextChoices, SuppliedValuesSource } from "../../../src/text/candidates";
import { withoutText } from "../../../src/text/mask";
import { TextChoice } from "../../../src/text/types";
import { FakeEngine, RecordedRequest } from "../../helpers/fake-engine";
import { answer, COMPACT_PROFILE, LOGIN_CONTROLS, productControls, snapshot } from "../../helpers/fixtures";

const GOAL: string = "Log in and open the cart";

function choices(): TextChoice[] {
    return withoutText(
        buildTextChoices(
            GOAL,
            [new SuppliedValuesSource({ email: "demo@example.com" }, { password: "hunter2-SECRET" })],
            false,
            { password: "hunter2-SECRET" }
        )
    );
}

function input(extra: Partial<DecisionInput> = {}): DecisionInput {
    return { goal: GOAL, snapshot: snapshot(1, LOGIN_CONTROLS), history: [], textChoices: choices(), ...extra };
}

describe("buildRequest (full profile)", (): void => {
    it("offers only operations that have targets, plus hover / keys and WAIT/DONE/BLOCKED", (): void => {
        const built: BuiltRequest = buildRequest(input(), JEV_PROFILE);
        expect(built.operations).toEqual([
            Operation.CLICK,
            Operation.TYPE_TEXT,
            Operation.SELECT,
            Operation.PRESS_ENTER,
            Operation.HOVER,
            Operation.PRESS_KEY,
            Operation.WAIT,
            Operation.DONE,
            Operation.BLOCKED,
        ]);
        expect(Object.keys(built.questions.type_text_target.criteria)).toEqual(["4", "5"]);
        expect(Object.keys(built.questions.click_target.criteria)).toEqual(["4", "5", "6"]);
        expect(Object.keys(built.questions.select_target.criteria)).toEqual(["9:1", "9:2"]);
        // Enter is offered on a filled password field but not on an empty text field.
        expect(Object.keys(built.questions.press_enter_target.criteria)).toEqual(["5"]);
    });

    it("offers scrolling only in the direction the page can scroll", (): void => {
        const built: BuiltRequest = buildRequest(
            input({ snapshot: snapshot(1, [], { canScrollDown: true }), textChoices: [] }),
            JEV_PROFILE
        );
        expect(built.operations).toEqual([Operation.PRESS_KEY, Operation.SCROLL_DOWN, Operation.WAIT, Operation.DONE, Operation.BLOCKED]);
    });

    it("drops TYPE_TEXT when there is nothing to type", (): void => {
        const built: BuiltRequest = buildRequest(input({ textChoices: [] }), JEV_PROFILE);
        expect(built.operations).not.toContain(Operation.TYPE_TEXT);
        expect(built.questions.text_value).toBeUndefined();
    });

    it("never puts a secret value into the request", (): void => {
        const built: BuiltRequest = buildRequest(
            input({
                history: [
                    {
                        step: 1,
                        operation: Operation.TYPE_TEXT,
                        target: '[5] textbox "Password"',
                        text: "<secret password>",
                        executed: true,
                        pageChanged: false,
                    },
                ],
            }),
            JEV_PROFILE
        );
        const wire: string = JSON.stringify({ state: built.state, questions: built.questions });
        expect(wire).not.toContain("hunter2-SECRET");
        expect(wire).toContain("secret:password");
        expect(wire).toContain("demo@example.com");
    });
});

describe("buildRequest (compact profile)", (): void => {
    it("puts the goal in the state and keeps instructions short", (): void => {
        const built: BuiltRequest = buildRequest(input(), COMPACT_PROFILE);
        expect((built.state as { goal: string }).goal).toBe(GOAL);
        expect(typeof built.questions.operation.instructions).toBe("string");
        expect(String(built.questions.operation.instructions)).not.toContain(GOAL);
        expect(built.state).not.toHaveProperty("elements");
    });

    it("shortlists options to the profile, keeping the goal-relevant one and navigation", (): void => {
        const built: BuiltRequest = buildRequest(
            input({ goal: "Add the Sony headphones to the cart", snapshot: snapshot(1, productControls(40)) }),
            COMPACT_PROFILE
        );
        const offered: string[] = Object.keys(built.questions.click_target.criteria);
        expect(offered.length).toBeLessThanOrEqual(COMPACT_PROFILE.maxOptions);
        expect(offered).toContain("139");
        // Forty identical buttons may not crowd out navigation.
        expect(offered).toContain("8");
        expect(String(built.questions.click_target.criteria["139"])).toContain("Sony");
        expect(String(built.questions.click_target.criteria["139"]).length).toBeLessThanOrEqual(
            COMPACT_PROFILE.maxLabelChars
        );
    });
});

describe("tabs", (): void => {
    it("offers SWITCH_TAB over the other tabs and CLOSE_TAB only when there is more than one", (): void => {
        expect(buildRequest(input(), JEV_PROFILE).operations).not.toContain(Operation.SWITCH_TAB);
        const tabs = [
            { index: 0, url: "https://shop.test/", title: "Shop", active: false },
            { index: 1, url: "https://shop.test/invoice", title: "Invoice", active: true },
        ];
        const built: BuiltRequest = buildRequest(input({ snapshot: { ...snapshot(1, LOGIN_CONTROLS), tabs } }), JEV_PROFILE);
        expect(built.operations).toEqual(expect.arrayContaining([Operation.SWITCH_TAB, Operation.CLOSE_TAB]));
        expect(Object.keys(built.questions.tab.criteria)).toEqual(["0"]);
        expect(built.state.page).toMatchObject({ open_tabs: ["Shop https://shop.test/", "(this tab) Invoice https://shop.test/invoice"] });
        const decision: Decision = interpretResponse(
            built,
            { answers: { operation: answer("SWITCH_TAB", built.operations), tab: answer("0", ["0"]) } },
            10
        );
        expect(decision).toMatchObject({ operation: Operation.SWITCH_TAB, tabIndex: 0 });
    });
});

describe("earlier pages", (): void => {
    it("are in the decision state, except the current one, clipped", (): void => {
        const built: BuiltRequest = buildRequest(
            input({
                earlierPages: [
                    { url: "https://shop.test/orders", title: "Orders", excerpt: `#1042 total 59.90 ${"x".repeat(400)}` },
                    { url: snapshot(1, LOGIN_CONTROLS).url, title: "Here", excerpt: "the current page" },
                ],
            }),
            JEV_PROFILE
        );
        const earlier: string[] = built.state.earlier_pages as string[];
        expect(earlier).toHaveLength(1);
        expect(earlier[0]).toMatch(/^Orders https:\/\/shop\.test\/orders: #1042 total 59\.90/);
        expect(earlier[0].length).toBeLessThanOrEqual(220);
        expect(buildRequest(input(), JEV_PROFILE).state).not.toHaveProperty("earlier_pages");
    });
});

describe("a click that changed nothing", (): void => {
    it("marks that control until something changes", (): void => {
        const login: string = '[6] button "Login"';
        const vain: BuiltRequest = buildRequest(
            input({ history: [{ step: 1, operation: Operation.CLICK, target: login, executed: true, pageChanged: false }] }),
            JEV_PROFILE
        );
        // Not offered to CLICK again; still hoverable, on a head of its own.
        expect(Object.keys(vain.questions.click_target.criteria)).toEqual(["4", "5"]);
        expect(vain.questions.hover_target.criteria["6"]).toMatchObject({ clicking_it_changed_nothing: true });
        expect(vain.heads.HOVER).toBe("hover_target");
        // In the state too: the operation question reads only the state.
        const rows: Array<Record<string, unknown>> = vain.state.elements as Array<Record<string, unknown>>;
        expect(rows.find((r): boolean => r.index === "6")).toMatchObject({ clicking_it_changed_nothing: true });

        const moved: BuiltRequest = buildRequest(
            input({
                history: [
                    { step: 1, operation: Operation.CLICK, target: login, executed: true, pageChanged: false },
                    { step: 2, operation: Operation.PRESS_KEY, text: "Escape", executed: true, pageChanged: true },
                ],
            }),
            JEV_PROFILE
        );
        expect(moved.questions.click_target.criteria["6"]).not.toHaveProperty("clicking_it_changed_nothing");
        expect(moved.questions.hover_target).toBeUndefined();
        expect(moved.heads.HOVER).toBe("click_target");
    });
});

describe("a note-only history entry (the controls handed back)", (): void => {
    const note: HistoryEntry = { step: 1, operation: Operation.WAIT, executed: false, note: "the text model fake had the controls and handed them back: done" };
    const clicked: HistoryEntry = { step: 2, operation: Operation.CLICK, target: '[6] button "Login"', executed: true, pageChanged: true };
    const refused: HistoryEntry = { step: 3, operation: Operation.CLICK, target: '[6] button "Login"', executed: false, reason: "stale" };

    it("is a note: neither executed nor refused; an entry with a reason or an execution is not", (): void => {
        expect(isNote(note)).toBe(true);
        expect(isNote(clicked)).toBe(false);
        expect(isNote(refused)).toBe(false);
        expect(isNote({ ...clicked, note: "taken by the text model" })).toBe(false);
    });

    it("is shown to the engine as a note, not a refused WAIT, in both state forms", (): void => {
        const full: Array<Record<string, unknown>> = buildRequest(input({ history: [note, clicked, refused] }), JEV_PROFILE).state.recent_actions as Array<Record<string, unknown>>;
        expect(full[0]).toEqual({ step: 1, operation: Operation.WAIT, note: note.note });
        expect(full[0]).not.toHaveProperty("refused");
        expect(full[2]).toMatchObject({ refused: "stale" });
        const compact: string[] = buildRequest(input({ history: [note, clicked, refused] }), COMPACT_PROFILE).state.recent_actions as string[];
        expect(compact[0]).toBe(`WAIT ${note.note}`);
        expect(compact[0]).not.toContain("refused");
        expect(compact[2]).toContain("refused: stale");
    });
});

describe("WAITs that changed nothing", (): void => {
    const wait: (step: number, pageChanged: boolean) => { step: number; operation: Operation; executed: boolean; pageChanged: boolean } = (
        step: number,
        pageChanged: boolean
    ): { step: number; operation: Operation; executed: boolean; pageChanged: boolean } => ({ step, operation: Operation.WAIT, executed: true, pageChanged });
    const waitCriterion: (history: DecisionInput["history"]) => string = (history: DecisionInput["history"]): string =>
        String(buildRequest(input({ history }), JEV_PROFILE).questions.operation.criteria.WAIT);

    it("are named on the WAIT option once two in a row left the page as it was", (): void => {
        expect(waitCriterion([wait(1, false)])).not.toMatch(/changed nothing/);
        expect(waitCriterion([wait(1, false), wait(2, false)])).toMatch(/The last 2 WAITs changed nothing/);
        expect(waitCriterion([wait(1, false), wait(2, false), wait(3, false)])).toMatch(/The last 3 WAITs changed nothing/);
    });

    it("count only the latest run: a change, or another operation, starts over", (): void => {
        expect(waitCriterion([wait(1, false), wait(2, true), wait(3, false)])).not.toMatch(/changed nothing/);
        expect(
            waitCriterion([wait(1, false), wait(2, false), { step: 3, operation: Operation.CLICK, target: '[6] button "Login"', executed: true, pageChanged: false }])
        ).not.toMatch(/changed nothing/);
    });
});

describe("interpretResponse", (): void => {
    it("answers HOVER from the click head, PRESS_KEY from its key head; history only when there is some", (): void => {
        const plain: BuiltRequest = buildRequest(input(), JEV_PROFILE);
        expect(plain.questions.hover_target).toBeUndefined();
        expect(plain.heads.HOVER).toBe("click_target");
        expect(plain.operations).not.toContain(Operation.GO_BACK);
        const built: BuiltRequest = buildRequest(input({ canGoBack: true, canGoForward: true }), JEV_PROFILE);
        expect(built.operations).toEqual(expect.arrayContaining([Operation.GO_BACK, Operation.GO_FORWARD]));

        const hover: Decision = interpretResponse(
            built,
            { answers: { operation: answer("HOVER", built.operations), click_target: answer("6", ["4", "5", "6"]) } },
            10
        );
        expect(hover).toMatchObject({ operation: Operation.HOVER, controlId: 6 });

        const key: Decision = interpretResponse(
            built,
            { answers: { operation: answer("PRESS_KEY", built.operations), key: answer("Escape", Object.keys(built.questions.key.criteria)) } },
            10
        );
        expect(key).toMatchObject({ operation: Operation.PRESS_KEY, key: "Escape" });
        expect(key.controlId).toBeUndefined();
    });

    it("offers ASK_USER with its reason only when a person is there, and reads the reason", (): void => {
        expect(buildRequest(input(), JEV_PROFILE).operations).not.toContain(Operation.ASK_USER);
        const built: BuiltRequest = buildRequest(input({ canAskUser: true }), JEV_PROFILE);
        expect(built.operations.slice(-2)).toEqual([Operation.ASK_USER, Operation.BLOCKED]);
        expect(Object.keys(built.questions.ask_user_reason.criteria)).toEqual(["SIGN_IN", "VERIFY", "OTHER"]);
        const decision: Decision = interpretResponse(
            built,
            {
                answers: {
                    operation: answer("ASK_USER", built.operations),
                    ask_user_reason: answer("SIGN_IN", ["SIGN_IN", "VERIFY", "OTHER"]),
                },
            },
            10
        );
        expect(decision.operation).toBe(Operation.ASK_USER);
        expect(decision.userAction).toBe(UserActionKind.SIGN_IN);
    });

    it("uses only the head of the chosen operation", (): void => {
        const built: BuiltRequest = buildRequest(input(), JEV_PROFILE);
        const decision: Decision = interpretResponse(
            built,
            {
                answers: {
                    operation: answer("TYPE_TEXT", built.operations),
                    type_text_target: answer("5", ["4", "5"]),
                    text_value: answer("secret:password", ["value:email", "secret:password"]),
                    // A malformed unused head must not matter.
                    click_target: { choice: "nope" },
                },
            },
            150
        );
        expect(decision.operation).toBe(Operation.TYPE_TEXT);
        expect(decision.controlId).toBe(5);
        expect(decision.textKey).toBe("secret:password");
        expect(decision.targetLabels?.["5"]).toBe('[5] textbox "Password"');
    });

    it("maps a SELECT option index back to its value", (): void => {
        const built: BuiltRequest = buildRequest(input(), JEV_PROFILE);
        const decision: Decision = interpretResponse(
            built,
            {
                answers: {
                    operation: answer("SELECT", built.operations),
                    select_target: answer("9:2", ["9:1", "9:2"]),
                },
            },
            150
        );
        expect(decision.controlId).toBe(9);
        expect(decision.optionValue).toBe("uk");
    });

    it("rejects a target that was not offered", (): void => {
        const built: BuiltRequest = buildRequest(input(), JEV_PROFILE);
        expect((): Decision =>
            interpretResponse(
                built,
                {
                    answers: {
                        operation: answer("CLICK", built.operations),
                        click_target: answer("99", ["4", "5", "99"]),
                    },
                },
                1
            )
        ).toThrow();
    });
});

describe("EngineDecider", (): void => {
    it("shapes the request by the engine's profile", async (): Promise<void> => {
        const engine: FakeEngine = new FakeEngine(
            (r: RecordedRequest): Record<string, unknown> => ({
                operation: answer("DONE", Object.keys(r.questions.operation.criteria as object)),
            }),
            COMPACT_PROFILE
        );
        const decision: Decision = await new EngineDecider(engine).decide(input());
        expect(decision.operation).toBe(Operation.DONE);
        expect((engine.requests[0].state as { goal: string }).goal).toBe(GOAL);
    });

    it("asks once more when an answer cannot be acted on, and gives up on a second one", async (): Promise<void> => {
        let calls: number = 0;
        const flaky: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> =>
            ++calls === 1
                ? { operation: { choice: "NOT_OFFERED", probabilities: {}, confidence: 1 } }
                : { operation: answer("DONE", Object.keys(r.questions.operation.criteria as object)) }
        );
        await expect(new EngineDecider(flaky).decide(input())).resolves.toMatchObject({ operation: Operation.DONE });
        expect(flaky.requests).toHaveLength(2);

        const broken: FakeEngine = new FakeEngine((): Record<string, unknown> => ({ operation: { choice: "NOT_OFFERED" } }));
        await expect(new EngineDecider(broken).decide(input())).rejects.toThrow(/Invalid choice answer/);
        expect(broken.requests).toHaveLength(2);
    });
});
