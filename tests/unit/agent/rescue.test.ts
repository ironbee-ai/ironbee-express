import { Agent, RescueEvent, RescueState, RunResult, RunStatus, StepEvent, StepMode } from "../../../src/agent/agent";
import { DecisionInput, Operation, USER_ACTION_KINDS, UserActionKind } from "../../../src/agent/policy";
import {
    checkAction,
    LlmTakeover,
    LlmTakeoverSession,
    parseToolCall,
    Takeover,
    TakeoverEnd,
    TakeoverLooks,
    TakeoverSession,
    TakeoverStep,
} from "../../../src/agent/rescue";
import { DevtoolsClient } from "../../../src/devtools/client";
import { ActResult, ControlOperation, ControlSnapshot } from "../../../src/devtools/types";
import { TextProvider } from "../../../src/text/providers";
import { buildTextChoices, SuppliedValuesSource } from "../../../src/text/candidates";
import { TextStrategy } from "../../../src/text/types";
import { GoalJudge } from "../../../src/verify/goal";
import { FakeClient } from "../../helpers/fake-client";
import { FakeEngine } from "../../helpers/fake-engine";
import { answer, control, LOGIN_CONTROLS, snapshot } from "../../helpers/fixtures";
import { named, ScriptedDecider } from "../../helpers/scripted-decider";

function textStrategy(secrets: Record<string, string> = {}): TextStrategy {
    return { choices: buildTextChoices("goal", [new SuppliedValuesSource({ email: "a@b.c" }, secrets)], false, secrets), secrets };
}

const OPERATIONS: Operation[] = [Operation.CLICK, Operation.TYPE_TEXT, Operation.SELECT, Operation.PRESS_KEY, Operation.WAIT];

function input(): DecisionInput {
    return {
        goal: "Log in",
        snapshot: snapshot(1, [...LOGIN_CONTROLS, control(90, "combobox", "Size", [ControlOperation.SELECT], { options: [{ value: "l", label: "Large" }] })]),
        history: [],
        textChoices: textStrategy({ password: "pw" }).choices.map(({ text: _text, ...c }) => c),
    };
}

describe("the text model's actions, checked like the engine's", (): void => {
    it("takes what the agent can carry out: an offered value by key, or a text the model writes", (): void => {
        expect(checkAction({ operation: "CLICK", controlId: 6 }, input(), OPERATIONS)).toMatchObject({ decision: { operation: "CLICK", controlId: 6 } });
        expect(checkAction({ operation: "SELECT", controlId: 90, optionValue: "l" }, input(), OPERATIONS)).toMatchObject({ decision: { optionValue: "l" } });
        expect(checkAction({ operation: "TYPE_TEXT", controlId: 4, textKey: "secret:password" }, input(), OPERATIONS)).toMatchObject({
            decision: { textKey: "secret:password" },
        });
        expect(checkAction({ operation: "TYPE_TEXT", controlId: 4, text: "hello" }, input(), OPERATIONS)).toMatchObject({ decision: { literalText: "hello" } });
    });

    it("refuses a text over the cap by naming the cap, so the model can shorten it", (): void => {
        const long: string = "x".repeat(2_001);
        expect(checkAction({ operation: "TYPE_TEXT", controlId: 4, text: long }, input(), OPERATIONS)).toEqual({
            refused: "text must be 1–2000 characters (yours is 2001)",
        });
        expect(checkAction({ operation: "TYPE_TEXT", controlId: 4, text: "x".repeat(2_000) }, input(), OPERATIONS)).toMatchObject({
            decision: { literalText: expect.any(String) },
        });
        expect(checkAction({ operation: "TYPE_TEXT", controlId: 4, text: "" }, input(), OPERATIONS)).toEqual({
            refused: "TYPE_TEXT needs an offered textKey or a text",
        });
    });

    it("refuses a secret reference written as text: a secret is typed by its offered key only", (): void => {
        for (const text of ["{{secret:password.password}}", "{{ secret:pw }}", "pw: {{SECRET:x.y}}"]) {
            expect(checkAction({ operation: "TYPE_TEXT", controlId: 4, text }, input(), OPERATIONS)).toEqual({
                refused: "use the offered textKey for a secret",
            });
        }
    });

    it("takes an id the model quoted as a string, and refuses one that is not an integer", (): void => {
        expect(checkAction({ operation: "CLICK", controlId: "6" }, input(), OPERATIONS)).toMatchObject({ decision: { controlId: 6 } });
        expect(checkAction({ operation: "CLICK", controlId: "6.5" }, input(), OPERATIONS)).toHaveProperty("refused");
        expect(checkAction({ operation: "CLICK", controlId: "six" }, input(), OPERATIONS)).toHaveProperty("refused");
        const tabbed: DecisionInput = { ...input(), snapshot: { ...input().snapshot, tabs: [{ index: 0, url: "https://a.test/", title: "A", active: true }, { index: 1, url: "https://b.test/", title: "B", active: false }] } };
        expect(checkAction({ operation: "SWITCH_TAB", tabIndex: "1" }, tabbed, [Operation.SWITCH_TAB])).toMatchObject({ decision: { tabIndex: 1 } });
        expect(checkAction({ operation: "SWITCH_TAB", tabIndex: "2" }, tabbed, [Operation.SWITCH_TAB])).toHaveProperty("refused");
        // The active tab is not a switch: refused as the engine is never offered it.
        expect(checkAction({ operation: "SWITCH_TAB", tabIndex: 0 }, tabbed, [Operation.SWITCH_TAB])).toEqual({ refused: "tabIndex must be another open tab's" });
    });

    it("refuses, saying why, what the agent could not carry out", (): void => {
        for (const args of [
            { operation: "SUBMIT_FORM", controlId: 6 },
            { operation: "GO_BACK" },
            { operation: "CLICK", controlId: 99 },
            { operation: "SELECT", controlId: 90, optionValue: "x" },
            { operation: "TYPE_TEXT", controlId: 4 },
            { operation: "PRESS_KEY", key: "F13" },
        ]) {
            expect(checkAction(args, input(), OPERATIONS)).toHaveProperty("refused");
        }
        // A key is one of the offered ones, not anything an object inherits.
        expect(checkAction({ operation: "PRESS_KEY", key: "toString" }, input(), OPERATIONS)).toMatchObject({ refused: expect.stringMatching(/^key must be one of .*Escape/) });
        expect(checkAction({ operation: "PRESS_KEY", key: "Escape" }, input(), OPERATIONS)).toMatchObject({ decision: { key: "Escape" } });
    });

    it("takes ASK_USER with an offered kind of user action, OTHER by default", (): void => {
        const ops: Operation[] = [Operation.CLICK, Operation.ASK_USER];
        expect(checkAction({ operation: "ASK_USER" }, input(), ops)).toMatchObject({ decision: { operation: Operation.ASK_USER, userAction: UserActionKind.OTHER } });
        expect(checkAction({ operation: "ASK_USER", userAction: "VERIFY" }, input(), ops)).toMatchObject({ decision: { userAction: UserActionKind.VERIFY } });
        expect(checkAction({ operation: "ASK_USER", userAction: "dance" }, input(), ops)).toMatchObject({ refused: expect.stringMatching(/userAction must be one of/) });
        // ENTER_VALUE names a field; an ASK_USER carries none — the engine is not offered it either.
        expect(checkAction({ operation: "ASK_USER", userAction: "ENTER_VALUE" }, input(), ops)).toMatchObject({ refused: "userAction must be one of SIGN_IN, VERIFY, OTHER" });
        expect(USER_ACTION_KINDS).not.toContain(UserActionKind.ENTER_VALUE);
        expect(checkAction({ operation: "ASK_USER" }, input(), OPERATIONS)).toHaveProperty("refused");
    });

    it("reads one tool call from a reply, wrapped or not", (): void => {
        expect(parseToolCall('Sure. ```{"tool": "snapshot", "why": "look first"}```')).toEqual({ tool: "snapshot", args: {}, why: "look first" });
        expect(parseToolCall("no json")).toBeUndefined();
    });
});

describe("an LLM takeover session", (): void => {
    it("looks as much as it wants, then acts; the looks' results are in its next turn — never a secret's value", async (): Promise<void> => {
        const replies: string[] = [
            '{"tool": "snapshot", "why": "see the controls"}',
            '{"tool": "act", "args": {"operation": "CLICK", "controlId": 6}, "why": "submit"}',
        ];
        const prompts: string[] = [];
        const fetchImpl: typeof fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
            prompts.push(String(init.body));
            return new Response(JSON.stringify({ content: [{ type: "text", text: replies.shift() }] }), { status: 200 });
        }) as typeof fetch;
        const looks: TakeoverLooks = {
            snapshot: async (): Promise<ControlSnapshot> => snapshot(2, LOGIN_CONTROLS, { text: "Login page, fresh" }),
            pageText: async (): Promise<string> => "",
            requests: async (): Promise<string> => "",
            console: async (): Promise<string> => "",
            devtools: async (): Promise<string> => "",
        };
        const session: LlmTakeoverSession = new LlmTakeover({
            model: { provider: TextProvider.ANTHROPIC, model: "m" },
            settings: { apiKey: "k", baseUrl: "https://api.test/v1" },
            fetchImpl,
        }).start("3 actions in a row changed nothing observable", looks) as LlmTakeoverSession;
        const step: TakeoverStep = await session.next(input(), OPERATIONS);
        expect(step).toMatchObject({ act: { operation: Operation.CLICK, controlId: 6 }, why: "submit" });
        expect(session.calls).toBe(2);
        expect(prompts[1]).toContain("Login page, fresh");
        expect(prompts[0]).toContain("GET THE RUN UNSTUCK, NOT TO FINISH THE GOAL");
        expect(prompts.join()).not.toContain('"pw"');
    });

    it("checks an action against the page it last looked at, not the one it was handed", async (): Promise<void> => {
        const replies: string[] = [
            '{"tool": "snapshot", "why": "see the controls"}',
            // The stale id: the banner closed and the page's ids changed.
            '{"tool": "act", "args": {"operation": "CLICK", "controlId": 6}, "why": "submit"}',
            '{"tool": "act", "args": {"operation": "CLICK", "controlId": "77"}, "why": "submit the fresh one"}',
        ];
        const prompts: string[] = [];
        const fetchImpl: typeof fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
            prompts.push(String(init.body));
            return new Response(JSON.stringify({ content: [{ type: "text", text: replies.shift() }] }), { status: 200 });
        }) as typeof fetch;
        const fresh: ControlSnapshot = snapshot(2, [control(77, "button", "Login", [ControlOperation.CLICK])], { text: "Login page, fresh" });
        const looks: TakeoverLooks = {
            snapshot: async (): Promise<ControlSnapshot> => fresh,
            pageText: async (): Promise<string> => "",
            requests: async (): Promise<string> => "",
            console: async (): Promise<string> => "",
            devtools: async (): Promise<string> => "",
        };
        const step: TakeoverStep = await new LlmTakeover({
            model: { provider: TextProvider.ANTHROPIC, model: "m" },
            settings: { apiKey: "k", baseUrl: "https://api.test/v1" },
            fetchImpl,
        })
            .start("stuck", looks)
            .next(input(), OPERATIONS);
        expect(step).toMatchObject({ act: { operation: Operation.CLICK, controlId: 77 } });
        expect(prompts[2]).toContain("refused: no control 6 on the page");
        // Its next turn shows the page it looked at.
        expect(JSON.parse(prompts[1]).messages[0].content).toContain("Login page, fresh");
    });

    it("shows the model a hand-back note as a note, not as a refused WAIT", async (): Promise<void> => {
        const prompts: string[] = [];
        const fetchImpl: typeof fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
            prompts.push(String(init.body));
            return new Response(JSON.stringify({ content: [{ type: "text", text: '{"tool": "resolved", "why": "ok"}' }] }), { status: 200 });
        }) as typeof fetch;
        const history: DecisionInput["history"] = [
            { step: 1, operation: Operation.WAIT, executed: false, note: "the text model fake had the controls and handed them back: fine" },
            { step: 2, operation: Operation.CLICK, target: '[6] button "Login"', executed: true, pageChanged: true },
        ];
        await new LlmTakeover({ model: { provider: TextProvider.ANTHROPIC, model: "m" }, settings: { apiKey: "k", baseUrl: "https://api.test/v1" }, fetchImpl })
            .start("stuck", { snapshot: async (): Promise<ControlSnapshot> => input().snapshot, pageText: async (): Promise<string> => "", requests: async (): Promise<string> => "", console: async (): Promise<string> => "", devtools: async (): Promise<string> => "" })
            .next({ ...input(), history }, OPERATIONS);
        expect(prompts[0]).toContain("handed them back: fine");
        expect(prompts[0]).not.toContain('\\"executed\\":false');
        expect(prompts[0]).toContain('\\"executed\\":true');
    });

    it("gives up, saying so, when the text model cannot be asked", async (): Promise<void> => {
        const fetchImpl: typeof fetch = (async (): Promise<Response> => {
            throw new Error("connect ECONNREFUSED");
        }) as typeof fetch;
        const looks: TakeoverLooks = {
            snapshot: async (): Promise<ControlSnapshot> => snapshot(2, LOGIN_CONTROLS),
            pageText: async (): Promise<string> => "",
            requests: async (): Promise<string> => "",
            console: async (): Promise<string> => "",
            devtools: async (): Promise<string> => "",
        };
        const step: TakeoverStep = await new LlmTakeover({
            model: { provider: TextProvider.ANTHROPIC, model: "m" },
            settings: { apiKey: "k", baseUrl: "https://api.test/v1" },
            fetchImpl,
        })
            .start("stuck", looks)
            .next(input(), OPERATIONS);
        expect(step).toMatchObject({ end: TakeoverEnd.GAVE_UP, why: expect.stringContaining("the text model failed: connect ECONNREFUSED") });
    });
});

describe("the DevTools read tools at the model's hand", (): void => {
    it("calls an offered read tool with the model's input — its own fields only, never a `_metadata` — and refuses any other", async (): Promise<void> => {
        const replies: string[] = [
            '{"tool": "devtools", "args": {"name": "interaction_click", "input": {"selector": "#x"}}, "why": "try"}',
            '{"tool": "devtools", "args": {"name": "a11y_take-ax-tree-snapshot", "input": {"checkOcclusion": true, "_metadata": {"collectorUrl": "https://evil.test"}}}, "why": "what covers it"}',
            '{"tool": "resolved", "why": "seen"}',
        ];
        const prompts: string[] = [];
        const fetchImpl: typeof fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
            prompts.push(String(init.body));
            return new Response(JSON.stringify({ content: [{ type: "text", text: replies.shift() }] }), { status: 200 });
        }) as typeof fetch;
        const called: Array<[string, Record<string, unknown>]> = [];
        const looks: TakeoverLooks = {
            snapshot: async (): Promise<ControlSnapshot> => snapshot(2, LOGIN_CONTROLS),
            pageText: async (): Promise<string> => "",
            requests: async (): Promise<string> => "",
            console: async (): Promise<string> => "",
            devtools: async (name: string, toolInput: Record<string, unknown>): Promise<string> => {
                called.push([name, toolInput]);
                return '{"nodes":[{"role":"button","name":"Login","occludedBy":"div.cookie-banner"}]}';
            },
        };
        const step: TakeoverStep = await new LlmTakeover({
            model: { provider: TextProvider.ANTHROPIC, model: "m" },
            settings: { apiKey: "k", baseUrl: "https://api.test/v1" },
            fetchImpl,
        })
            .start("stuck", looks)
            .next(input(), OPERATIONS);
        expect(step).toMatchObject({ end: TakeoverEnd.RESOLVED });
        expect(called).toEqual([["a11y_take-ax-tree-snapshot", { checkOcclusion: true }]]);
        expect(prompts[0]).toContain("a11y_take-ax-tree-snapshot");
        expect(prompts[1]).toContain("name must be one of");
        expect(prompts[2]).toContain("div.cookie-banner");
    });
});

/** A takeover that plays a fixed script, one turn per call. */
class ScriptedTakeover implements Takeover {
    readonly label: string = "fake/model";
    readonly started: string[] = [];

    constructor(private readonly turns: Array<TakeoverStep | Error>) {}

    start(stuck: string): TakeoverSession {
        this.started.push(stuck);
        const turns: Array<TakeoverStep | Error> = this.turns;
        return {
            next: async (): Promise<TakeoverStep> => {
                const turn: TakeoverStep | Error = turns.shift() ?? { end: TakeoverEnd.GAVE_UP, why: "script over" };
                if (turn instanceof Error) {
                    throw turn;
                }
                return turn;
            },
        };
    }
}

const clickNext: TakeoverStep = {
    act: { operation: Operation.CLICK, controlId: 1, confidence: 1, operationProbabilities: {}, latencyMs: 0 },
    why: "one more page",
};

const clickLogin: TakeoverStep = {
    act: { operation: Operation.CLICK, controlId: 6, confidence: 1, operationProbabilities: {}, latencyMs: 0 },
    why: "the form is filled: submit it",
};

describe("the agent while the text model has the controls", (): void => {
    const same = (): ActResult => ({ executed: true, snapshot: snapshot(1, LOGIN_CONTROLS) });
    const home = (): ActResult => ({ executed: true, snapshot: snapshot(2, [], { url: "https://shop.test/home", text: "Welcome" }) });
    const clicksOnEmail = (n: number): Array<{ operation: Operation; target: ReturnType<typeof named> }> =>
        Array.from({ length: n }, (): { operation: Operation; target: ReturnType<typeof named> } => ({ operation: Operation.CLICK, target: named("Email") }));

    it("hands the controls over when the engine is stuck, carries out the model's steps, and takes them back", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [same, same, same, home]);
        const decider: ScriptedDecider = new ScriptedDecider([...clicksOnEmail(3), { operation: Operation.DONE }]);
        const takeover: ScriptedTakeover = new ScriptedTakeover([clickLogin, { end: TakeoverEnd.RESOLVED, why: "logged in" }]);
        const events: RescueEvent[] = [];
        const result: RunResult = await new Agent({
            client,
            decider,
            goal: "Log in",
            text: textStrategy(),
            takeover,
            onRescue: (e: RescueEvent): void => {
                events.push(e);
            },
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(takeover.started).toEqual(["3 actions in a row changed nothing observable"]);
        expect(events.map((e: RescueEvent): string => e.state)).toEqual([RescueState.ASKING, RescueState.ANSWERED]);
        expect(events[1]).toMatchObject({ end: TakeoverEnd.RESOLVED, why: "logged in" });
        expect(result.steps.find((s: StepEvent): boolean => s.mode === StepMode.RESCUE)).toMatchObject({
            operation: Operation.CLICK,
            rescue: { model: "fake/model", why: "the form is filled: submit it" },
        });
        // The engine reads who had the controls, and that they were handed back.
        const notes: string[] = decider.seen.at(-1)!.history.map((h): string => h.note ?? "");
        expect(notes.some((n: string): boolean => n.includes("taken by the text model fake/model"))).toBe(true);
        expect(notes.some((n: string): boolean => n.includes("handed them back: logged in"))).toBe(true);
    });

    it("gates a scroll or a tab switch on the page the model last looked at, not the one the turn began on", async (): Promise<void> => {
        // Before any look: the page cannot scroll.
        expect(checkAction({ operation: "SCROLL_DOWN" }, input(), [Operation.SCROLL_DOWN])).toEqual({ refused: "the page cannot scroll down" });
        expect(checkAction({ operation: "SCROLL_UP" }, input(), [Operation.SCROLL_UP])).toEqual({ refused: "the page cannot scroll up" });
        expect(checkAction({ operation: "CLOSE_TAB" }, input(), [Operation.CLOSE_TAB])).toEqual({ refused: "no other tab is open" });
        const scrollable: DecisionInput = { ...input(), snapshot: { ...input().snapshot, canScrollDown: true } };
        expect(checkAction({ operation: "SCROLL_DOWN" }, scrollable, [Operation.SCROLL_DOWN])).toMatchObject({ decision: { operation: Operation.SCROLL_DOWN } });
        // Mid-turn: a list finished loading; the model's own snapshot look brings the scrollable page, and the act is taken.
        const replies: string[] = [
            '{"tool": "snapshot", "why": "the list may have loaded"}',
            '{"tool": "act", "args": {"operation": "SCROLL_DOWN"}, "why": "reach the control"}',
        ];
        const fetchImpl: typeof fetch = (async (): Promise<Response> =>
            new Response(JSON.stringify({ content: [{ type: "text", text: replies.shift() }] }), { status: 200 })) as typeof fetch;
        const looks: TakeoverLooks = {
            snapshot: async (): Promise<ControlSnapshot> => ({ ...snapshot(2, LOGIN_CONTROLS), canScrollDown: true }),
            pageText: async (): Promise<string> => "",
            requests: async (): Promise<string> => "",
            console: async (): Promise<string> => "",
            devtools: async (): Promise<string> => "",
        };
        const session: TakeoverSession = new LlmTakeover({
            model: { provider: TextProvider.ANTHROPIC, model: "m" },
            settings: { apiKey: "k", baseUrl: "https://api.test/v1" },
            fetchImpl,
        }).start("3 actions in a row changed nothing observable", looks);
        const step: TakeoverStep = await session.next(input(), [...OPERATIONS, Operation.SCROLL_DOWN]);
        expect(step).toMatchObject({ act: { operation: Operation.SCROLL_DOWN }, why: "reach the control" });
    });

    it("ends the run DONE on the model's word, with who confirmed it", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), []);
        const judge: GoalJudge = new GoalJudge(new FakeEngine((): Record<string, unknown> => ({ goal_state: answer("not-yet", ["done", "not-yet", "failed"]) })));
        const result: RunResult = await new Agent({
            client,
            decider: new ScriptedDecider(Array.from({ length: 3 }, (): { operation: Operation } => ({ operation: Operation.DONE }))),
            goal: "Show Sunday's forecast",
            text: textStrategy(),
            goalJudge: judge,
            takeover: new ScriptedTakeover([{ end: TakeoverEnd.DONE, why: "Sunday's tab is highlighted" }]),
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(result.goal).toMatchObject({ achieved: true, confirmedBy: { model: "fake/model", why: "Sunday's tab is highlighted" } });
    });

    it("ends the run as it would have when the model gives up, or without a model", async (): Promise<void> => {
        const stuckRun = async (takeover?: Takeover): Promise<RunResult> =>
            new Agent({
                client: new FakeClient(snapshot(1, LOGIN_CONTROLS), [same, same, same]),
                decider: new ScriptedDecider(clicksOnEmail(5)),
                goal: "Log in",
                text: textStrategy(),
                ...(takeover ? { takeover } : {}),
            }).run();
        const gaveUp: RunResult = await stuckRun(new ScriptedTakeover([{ end: TakeoverEnd.GAVE_UP, why: "no way on" }]));
        expect(gaveUp.status).toBe(RunStatus.BLOCKED);
        expect(gaveUp.reason).toBe("3 actions in a row changed nothing observable; fake/model could not get past it: no way on");
        const alone: RunResult = await stuckRun();
        expect(alone.reason).toBe("3 actions in a row changed nothing observable");
    });

    it("does not call the model again for the engine's share right after it handed the controls back", async (): Promise<void> => {
        // maxActions 8 → the engine's share is 6. A stall at 3 brings the model in; its own 3
        // actions reach 6 — that was the share's call, not a second one before the engine decided.
        const takeover: ScriptedTakeover = new ScriptedTakeover([
            clickLogin,
            clickLogin,
            clickLogin,
            { end: TakeoverEnd.RESOLVED, why: "the banner is gone" },
            { end: TakeoverEnd.GAVE_UP, why: "nothing more" },
        ]);
        await new Agent({
            client: new FakeClient(snapshot(1, LOGIN_CONTROLS), Array.from({ length: 12 }, (): (() => ActResult) => same)),
            decider: new ScriptedDecider(clicksOnEmail(12)),
            goal: "Log in",
            text: textStrategy(),
            takeover,
            maxActions: 8,
        }).run();
        expect(takeover.started[0]).toBe("3 actions in a row changed nothing observable");
        expect(takeover.started.some((s: string): boolean => /without reaching the goal/.test(s))).toBe(false);
    });

    it("ends a run stopped while the model said done as cancelled", async (): Promise<void> => {
        const abort: AbortController = new AbortController();
        const takeover: Takeover = {
            label: "fake/model",
            start: (): TakeoverSession => ({
                next: async (): Promise<TakeoverStep> => {
                    abort.abort();
                    return { end: TakeoverEnd.DONE, why: "the order is placed" };
                },
            }),
        };
        const result: RunResult = await new Agent({
            client: new FakeClient(snapshot(1, LOGIN_CONTROLS), Array.from({ length: 6 }, (): (() => ActResult) => same)),
            decider: new ScriptedDecider(clicksOnEmail(5)),
            goal: "Log in",
            text: textStrategy(),
            takeover,
            signal: abort.signal,
        }).run();
        expect(result.status).toBe(RunStatus.CANCELLED);
        expect(result.goal?.confirmedBy).toBeUndefined();
    });

    it("ends a run stopped while the model had the controls as cancelled, and acts no more", async (): Promise<void> => {
        // Stop lands while the model thinks: its give-up must read CANCELLED, and an action it
        // answers with must not reach the page.
        const stoppedRun = async (turn: TakeoverStep): Promise<{ result: RunResult; acts: number }> => {
            const abort: AbortController = new AbortController();
            const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), Array.from({ length: 6 }, (): (() => ActResult) => same));
            const takeover: Takeover = {
                label: "fake/model",
                start: (): TakeoverSession => ({
                    next: async (): Promise<TakeoverStep> => {
                        abort.abort();
                        return turn;
                    },
                }),
            };
            const result: RunResult = await new Agent({
                client,
                decider: new ScriptedDecider(clicksOnEmail(5)),
                goal: "Log in",
                text: textStrategy(),
                takeover,
                signal: abort.signal,
            }).run();
            return { result, acts: client.acts.length };
        };
        const gaveUp: { result: RunResult; acts: number } = await stoppedRun({ end: TakeoverEnd.GAVE_UP, why: "no way on" });
        expect(gaveUp.result.status).toBe(RunStatus.CANCELLED);
        expect(gaveUp.result.reason).toBe("stopped by the caller");
        expect(gaveUp.acts).toBe(3);
        const acted: { result: RunResult; acts: number } = await stoppedRun(clickLogin);
        expect(acted.result.status).toBe(RunStatus.CANCELLED);
        expect(acted.acts).toBe(3);
    });

    it("lets the model's own steps change nothing without ending the run, and takes over at most three times", async (): Promise<void> => {
        const results: Array<() => ActResult> = Array.from({ length: 20 }, (): (() => ActResult) => same);
        const takeover: ScriptedTakeover = new ScriptedTakeover([
            // Four steps that change nothing: the stall check does not end the run while the model has the controls.
            clickLogin,
            clickLogin,
            clickLogin,
            clickLogin,
            { end: TakeoverEnd.RESOLVED, why: "try again" },
            { end: TakeoverEnd.RESOLVED, why: "again" },
            { end: TakeoverEnd.RESOLVED, why: "and again" },
            { end: TakeoverEnd.RESOLVED, why: "never asked" },
        ]);
        const result: RunResult = await new Agent({
            client: new FakeClient(snapshot(1, LOGIN_CONTROLS), results),
            decider: new ScriptedDecider(clicksOnEmail(12)),
            goal: "Log in",
            text: textStrategy(),
            takeover,
        }).run();
        expect(takeover.started).toHaveLength(3);
        expect(result.status).toBe(RunStatus.BLOCKED);
        expect(result.steps.filter((s: StepEvent): boolean => s.mode === StepMode.RESCUE)).toHaveLength(4);
    });

    /** Pages the run goes round through: each visit's text differs (a price, an ad), the page does not. */
    const roundTrip = (n: number): Array<() => ActResult> =>
        Array.from({ length: n }, (_: unknown, i: number): (() => ActResult) => (): ActResult => ({
            executed: true,
            snapshot: snapshot(100 + i, [control(1, "link", "Home", [ControlOperation.CLICK]), control(2, "link", "Rome", [ControlOperation.CLICK])], {
                url: i % 2 === 0 ? "https://stay.test/city/rome" : "https://stay.test/",
                text: `visit ${i}`,
            }),
        }));
    const alternating = (n: number): Array<{ operation: Operation; target: ReturnType<typeof named> }> =>
        Array.from({ length: n }, (_: unknown, i: number): { operation: Operation; target: ReturnType<typeof named> } => ({
            operation: Operation.CLICK,
            target: named(i % 2 === 0 ? "Rome" : "Home"),
        }));
    const start = (): ControlSnapshot =>
        snapshot(1, [control(1, "link", "Home", [ControlOperation.CLICK]), control(2, "link", "Rome", [ControlOperation.CLICK])], { url: "https://stay.test/" });

    it("hands the controls over when the run goes round through pages it has been on; a give-up there does not end a run that was not stuck", async (): Promise<void> => {
        const takeover: ScriptedTakeover = new ScriptedTakeover([{ end: TakeoverEnd.GAVE_UP, why: "no obstacle to get past" }]);
        const decider: ScriptedDecider = new ScriptedDecider([...alternating(12), { operation: Operation.DONE }]);
        const events: RescueEvent[] = [];
        const result: RunResult = await new Agent({
            client: new FakeClient(start(), roundTrip(12)),
            decider,
            goal: "Find a stay in Rome",
            text: textStrategy(),
            takeover,
            onRescue: (e: RescueEvent): void => {
                events.push(e);
            },
        }).run();
        expect(takeover.started).toEqual(["10 actions in a row reached no page it had not been on"]);
        expect(events.at(-1)).toMatchObject({ state: RescueState.NONE, error: "no obstacle to get past" });
        // The engine went on, and read why the model handed back without acting.
        expect(result.status).toBe(RunStatus.DONE);
        const notes: string[] = decider.seen.at(-1)!.history.map((h): string => h.note ?? "");
        expect(notes.some((n: string): boolean => n.includes("saw no way past it (no obstacle to get past); the run goes on"))).toBe(true);
    });

    it("goes on as well when the text model fails while called early, and ends as it would have when it fails on a real stall", async (): Promise<void> => {
        const early: RunResult = await new Agent({
            client: new FakeClient(start(), roundTrip(12)),
            decider: new ScriptedDecider([...alternating(12), { operation: Operation.DONE }]),
            goal: "Find a stay in Rome",
            text: textStrategy(),
            takeover: new ScriptedTakeover([new Error("HTTP 429")]),
        }).run();
        expect(early.status).toBe(RunStatus.DONE);
        const stalled: RunResult = await new Agent({
            client: new FakeClient(snapshot(1, LOGIN_CONTROLS), [same, same, same]),
            decider: new ScriptedDecider(clicksOnEmail(5)),
            goal: "Log in",
            text: textStrategy(),
            takeover: new ScriptedTakeover([new Error("HTTP 429")]),
        }).run();
        expect(stalled.status).toBe(RunStatus.BLOCKED);
        expect(stalled.reason).toBe("3 actions in a row changed nothing observable; fake/model could not get past it: HTTP 429");
    });

    it("ends BUDGET once the model hands back a run whose whole budget is spent, instead of restarting the engine", async (): Promise<void> => {
        const fresh: Array<() => ActResult> = Array.from({ length: 20 }, (_: unknown, i: number): (() => ActResult) => (): ActResult => ({
            executed: true,
            snapshot: snapshot(300 + i, [control(1, "button", `Next ${i}`, [ControlOperation.CLICK])], { url: `https://stay.test/q/${i}` }),
        }));
        // Share reached at 3 of 4 actions: handed back at once. Whole budget at 4: the model acts once and hands back.
        const takeover: ScriptedTakeover = new ScriptedTakeover([
            { end: TakeoverEnd.RESOLVED, why: "nothing in the way" },
            clickNext,
            { end: TakeoverEnd.RESOLVED, why: "the list is loaded" },
        ]);
        let decisions: number = 0;
        const result: RunResult = await new Agent({
            client: new FakeClient(snapshot(1, [control(1, "button", "Next", [ControlOperation.CLICK])], { url: "https://stay.test/" }), fresh),
            decider: {
                decide: async (input: DecisionInput) => {
                    decisions++;
                    return { operation: Operation.CLICK, controlId: input.snapshot.controls[0].id, confidence: 1, operationProbabilities: {}, latencyMs: 0 };
                },
            },
            goal: "Find a stay in Rome",
            text: textStrategy(),
            takeover,
            maxActions: 4,
        }).run();
        expect(takeover.started).toEqual(["3 actions without reaching the goal", "4-action budget reached"]);
        expect(result.status).toBe(RunStatus.BUDGET);
        expect(result.reason).toBe("4-action budget reached; fake/model handed the controls back: the list is loaded");
        // The engine's decisions: its four actions, and none once the budget was spent.
        expect(decisions).toBe(4);
        expect(result.actions).toBe(5);
    });

    it("acts on the control the model's own snapshot look found, and describes it from that page", async (): Promise<void> => {
        const cookies: ControlSnapshot = snapshot(7, [...LOGIN_CONTROLS, control(77, "button", "Accept cookies", [ControlOperation.CLICK], { context: "We use cookies" })]);
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [same, same, same, home]);
        const takeover: Takeover = {
            label: "fake/model",
            start: (_stuck: string, looks: TakeoverLooks): TakeoverSession => {
                let turn: number = 0;
                return {
                    next: async (): Promise<TakeoverStep> => {
                        if (turn++ === 0) {
                            client.setPage(cookies);
                            await looks.snapshot();
                            return { act: { operation: Operation.CLICK, controlId: 77, confidence: 1, operationProbabilities: {}, latencyMs: 0 }, why: "a banner covers the form" };
                        }
                        return { end: TakeoverEnd.RESOLVED, why: "gone" };
                    },
                };
            },
        };
        const result: RunResult = await new Agent({
            client,
            decider: new ScriptedDecider([...clicksOnEmail(3), { operation: Operation.DONE }]),
            goal: "Log in",
            text: textStrategy(),
            takeover,
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(client.acts[3]).toMatchObject({ controlId: 77, snapshotId: 7 });
        expect(result.steps.find((s: StepEvent): boolean => s.mode === StepMode.RESCUE)).toMatchObject({
            executed: true,
            target: '[77] button "Accept cookies" (We use cookies)',
            targetDescriptor: { role: "button", name: "Accept cookies", context: "We use cookies" },
        });
    });

    it("withholds HTTP headers from the model's look while this process types the secrets, and shows them when DevTools holds them", async (): Promise<void> => {
        class CallingClient extends FakeClient {
            readonly calls: Array<[string, object]> = [];
            override async call<T>(toolName: string, toolInput: object): Promise<T> {
                this.calls.push([toolName, toolInput]);
                return { requests: [{ url: "https://api.test/me", status: 200 }] } as T;
            }
        }
        const lookAt = async (secretsInDevtools: boolean): Promise<{ client: CallingClient; shown: string }> => {
            const client: CallingClient = new CallingClient(snapshot(1, LOGIN_CONTROLS), [same, same, same]);
            let shown: string = "";
            const takeover: Takeover = {
                label: "fake/model",
                start: (_stuck: string, looks: TakeoverLooks): TakeoverSession => ({
                    next: async (): Promise<TakeoverStep> => {
                        shown = await looks.devtools("o11y_get-http-requests", { includeRequestHeaders: true, includeResponseBody: true, limit: { count: 5 } });
                        return { end: TakeoverEnd.GAVE_UP, why: "seen enough" };
                    },
                }),
            };
            await new Agent({
                client,
                decider: new ScriptedDecider(clicksOnEmail(4)),
                goal: "Log in",
                text: { ...textStrategy({ token: "t0k" }), secretsInDevtools },
                takeover,
            }).run();
            return { client, shown };
        };
        const typedHere: { client: CallingClient; shown: string } = await lookAt(false);
        expect(typedHere.client.calls).toEqual([["o11y_get-http-requests", { includeResponseBody: true, limit: { count: 5 } }]]);
        expect(typedHere.shown).toMatch(/^\(request and response headers withheld/);
        const held: { client: CallingClient; shown: string } = await lookAt(true);
        expect(held.client.calls).toEqual([["o11y_get-http-requests", { includeRequestHeaders: true, includeResponseBody: true, limit: { count: 5 } }]]);
        expect(held.shown).not.toContain("withheld");
    });

    it("masks the requests look before it cuts and reflows the bodies, so no part of a value is left", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [same, same, same]);
        // Long enough to be cut in the middle of the secret, and one with the value's own spacing.
        client.requests = [
            { method: "POST", url: "https://shop.test/api/pay", resourceType: "fetch", status: 200, timestamp: Date.now(), body: `{"items":"${"x".repeat(2_985)}","number":"4111111111111111"}` },
            { method: "GET", url: "https://shop.test/api/me", resourceType: "fetch", status: 200, timestamp: Date.now(), body: "phrase: correct  horse" },
        ];
        let shown: string = "";
        const takeover: Takeover = {
            label: "fake/model",
            start: (_stuck: string, looks: TakeoverLooks): TakeoverSession => ({
                next: async (): Promise<TakeoverStep> => {
                    shown = await looks.requests();
                    return { end: TakeoverEnd.GAVE_UP, why: "seen enough" };
                },
            }),
        };
        await new Agent({
            client,
            decider: new ScriptedDecider(clicksOnEmail(4)),
            goal: "Pay",
            text: textStrategy({ card: "4111111111111111", phrase: "correct  horse" }),
            takeover,
        }).run();
        expect(shown).not.toMatch(/41111111|correct horse/);
    });

    it("without a model, going round does not end the run by itself", async (): Promise<void> => {
        const result: RunResult = await new Agent({
            client: new FakeClient(start(), roundTrip(14)),
            decider: new ScriptedDecider([...alternating(14), { operation: Operation.DONE }]),
            goal: "Find a stay in Rome",
            text: textStrategy(),
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
    });

    it("gives the model the rest of the budget once the engine has used its share", async (): Promise<void> => {
        // Every action lands on a page not seen before, so only the budget can call the model.
        const fresh: Array<() => ActResult> = Array.from({ length: 20 }, (_: unknown, i: number): (() => ActResult) => (): ActResult => ({
            executed: true,
            snapshot: snapshot(200 + i, [control(1, "button", `Next ${i}`, [ControlOperation.CLICK])], { url: `https://stay.test/p/${i}` }),
        }));
        const takeover: ScriptedTakeover = new ScriptedTakeover([clickNext, { end: TakeoverEnd.DONE, why: "the stays are listed" }]);
        const result: RunResult = await new Agent({
            client: new FakeClient(snapshot(1, [control(1, "button", "Next", [ControlOperation.CLICK])], { url: "https://stay.test/" }), fresh),
            decider: {
                decide: async (input: DecisionInput) => ({
                    operation: Operation.CLICK,
                    controlId: input.snapshot.controls[0].id,
                    confidence: 1,
                    operationProbabilities: {},
                    latencyMs: 0,
                }),
            },
            goal: "Find a stay in Rome",
            text: textStrategy(),
            takeover,
            maxActions: 8,
        }).run();
        expect(takeover.started).toEqual(["6 actions without reaching the goal"]);
        expect(result.status).toBe(RunStatus.DONE);
        expect(result.steps.filter((s: StepEvent): boolean => s.mode === StepMode.RESCUE)).toHaveLength(2);
    });
});

describe("the last tool call of a takeover", (): void => {
    /** A session over scripted replies; the prompts the model saw are kept. */
    function session(replies: string[]): { session: LlmTakeoverSession; prompts: string[] } {
        const prompts: string[] = [];
        const fetchImpl: typeof fetch = (async (_url: string, init: RequestInit): Promise<Response> => {
            prompts.push(String(init.body));
            return new Response(JSON.stringify({ content: [{ type: "text", text: replies.shift() ?? '{"tool": "give_up", "why": "script over"}' }] }), { status: 200 });
        }) as typeof fetch;
        const looks: TakeoverLooks = {
            snapshot: async (): Promise<ControlSnapshot> => snapshot(2, LOGIN_CONTROLS),
            pageText: async (): Promise<string> => "",
            requests: async (): Promise<string> => "",
            console: async (): Promise<string> => "no console errors",
            devtools: async (): Promise<string> => "",
        };
        return {
            session: new LlmTakeover({ model: { provider: TextProvider.ANTHROPIC, model: "m" }, settings: { apiKey: "k", baseUrl: "https://api.test/v1" }, fetchImpl }).start(
                "stuck",
                looks
            ) as LlmTakeoverSession,
            prompts,
        };
    }
    const looks: string[] = Array.from({ length: 14 }, (): string => '{"tool": "console", "why": "look"}');
    const act: string = '{"tool": "act", "args": {"operation": "CLICK", "controlId": 6}, "why": "submit"}';

    it("reports no look for a tool that is not one; the transcript names it unknown", async (): Promise<void> => {
        const { session: s, prompts } = session(['{"tool": "click", "why": "press it"}', '{"tool": "give_up", "why": "no way"}']);
        const seen: string[] = [];
        const step: TakeoverStep = await s.next(input(), OPERATIONS, (look: { tool: string }): void => {
            seen.push(look.tool);
        });
        expect(step).toEqual({ end: TakeoverEnd.GAVE_UP, why: "no way" });
        expect(seen).toEqual([]);
        expect(prompts[1]).toMatch(/unknown tool/);
    });

    it("refuses an act on it and gives the call back, so the model can still say how its turn ended", async (): Promise<void> => {
        const { session: s, prompts } = session([...looks, act, '{"tool": "resolved", "why": "the banner is gone"}']);
        const step: TakeoverStep = await s.next(input(), OPERATIONS);
        expect(step).toEqual({ end: TakeoverEnd.RESOLVED, why: "the banner is gone" });
        expect(s.calls).toBe(15);
        expect(prompts).toHaveLength(16);
        // The prompt is JSON inside the request's JSON: its quotes are escaped.
        expect(prompts[14]).toMatch(/tool_calls_left\\":1,/);
        expect(prompts[15]).toContain("your last call must end your turn: resolved / done / give_up");
        expect(prompts[15]).toMatch(/tool_calls_left\\":1,/);
    });

    it("gives up when the model acts on it again", async (): Promise<void> => {
        const { session: s } = session([...looks, act, act]);
        const step: TakeoverStep = await s.next(input(), OPERATIONS);
        expect(step).toEqual({ end: TakeoverEnd.GAVE_UP, why: "no way past it in 15 tool calls" });
        expect(s.calls).toBe(15);
    });
});
