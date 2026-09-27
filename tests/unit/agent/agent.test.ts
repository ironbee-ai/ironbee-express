import { Agent, RunResult, RunStatus } from "../../../src/agent/agent";
import { Operation, UserActionKind } from "../../../src/agent/policy";
import { Takeover, TakeoverEnd, TakeoverLooks, TakeoverSession, TakeoverStep } from "../../../src/agent/rescue";
import { UserActionRequest } from "../../../src/agent/agent";
import { TextImage } from "../../../src/text/providers";
import { recordSteps } from "../../../src/scenario/recording";
import { GoalJudge } from "../../../src/verify";
import { FakeEngine, RecordedRequest } from "../../helpers/fake-engine";
import { NetworkWait } from "../../../src/devtools/client";
import { ActResult, Control, ControlOperation, ControlSnapshot } from "../../../src/devtools/types";
import { buildTextChoices, SuppliedValuesSource } from "../../../src/text/candidates";
import { FieldContext, TextGenerator, TextStrategy } from "../../../src/text/types";
import { FakeClient } from "../../helpers/fake-client";
import { answer, control, LOGIN_CONTROLS, snapshot } from "../../helpers/fixtures";
import { named, ScriptedDecider } from "../../helpers/scripted-decider";

function textStrategy(
    values: Record<string, string> = {},
    secrets: Record<string, string> = {},
    generator?: TextGenerator
): TextStrategy {
    return {
        choices: buildTextChoices("goal", [new SuppliedValuesSource(values, secrets)], generator !== undefined, secrets),
        generator,
        secrets,
    };
}

const GOAL_STATES: string[] = ["done", "not-yet", "failed"];

/** An engine that judges the goal `state` and points at evidence item `id` as the cause. */
function causeAt(state: string, id: string): (r: RecordedRequest) => Record<string, unknown> {
    return (r: RecordedRequest): Record<string, unknown> => ({
        goal_state: answer(state, GOAL_STATES),
        failure_cause: answer(id, Object.keys((r.questions.failure_cause as { criteria: Record<string, string> }).criteria)),
    });
}

describe("Agent", (): void => {
    it("types a secret without showing it and finishes on DONE", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, LOGIN_CONTROLS, { fingerprint: "fp-1" }) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(3, [], { url: "https://shop.test/products" }) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("Password"), textKey: "secret:password" },
            { operation: Operation.CLICK, target: named("Login") },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({
            client,
            decider,
            goal: "Log in",
            url: "https://shop.test",
            text: textStrategy({}, { password: "hunter2-SECRET" }),
        }).run();

        expect(result.status).toBe(RunStatus.DONE);
        expect(result.actions).toBe(2);
        // The real value reaches the browser, and only the browser.
        expect(client.acts[0].value).toBe("hunter2-SECRET");
        expect(client.acts[0].snapshotId).toBe(1);
        expect(client.acts[1].snapshotId).toBe(2);
        expect(result.steps[0].text).toBe("<secret password>");
        expect(JSON.stringify(decider.seen)).not.toContain("hunter2-SECRET");
        // One snapshot call at the start; every later observation came with an action.
        expect(client.snapshots).toBe(1);
    });

    it("masks a secret the page itself displays before the decider sees it", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(
            snapshot(1, LOGIN_CONTROLS, { text: "Demo login: demo / hunter2-SECRET" }),
            []
        );
        const decider: ScriptedDecider = new ScriptedDecider([{ operation: Operation.DONE }]);
        await new Agent({ client, decider, goal: "x", text: textStrategy({}, { password: "hunter2-SECRET" }) }).run();
        expect(decider.seen[0].snapshot.text).toBe("Demo login: demo / [secret:password]");
    });

    it("re-decides on the snapshot a refusal returns, without another call", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [
            (): ActResult => ({ executed: false, reason: "stale", snapshot: snapshot(2, LOGIN_CONTROLS) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(3, []) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.CLICK, target: named("Login") },
            { operation: Operation.CLICK, target: named("Login") },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({ client, decider, goal: "Log in", text: textStrategy() }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(result.actions).toBe(1);
        expect(client.acts[1].snapshotId).toBe(2);
        expect(decider.seen[1].history[0].executed).toBe(false);
        expect(client.snapshots).toBe(1);
    });

    it("types the text written for an attempt the page change refused, without writing it again", async (): Promise<void> => {
        const calls: string[] = [];
        const generator: TextGenerator = {
            label: "fake",
            generate: async (context: FieldContext): Promise<string | null> => {
                calls.push(context.field.name);
                return `city-${calls.length}`;
            },
        };
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [
            // A suggestion list opened under the first attempt: refused, a fresh snapshot comes back.
            (): ActResult => ({ executed: false, reason: "stale: the page changed", snapshot: snapshot(2, LOGIN_CONTROLS, { text: "Suggestions: …" }) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(3, LOGIN_CONTROLS) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(4, LOGIN_CONTROLS) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "GENERATE" },
            { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "GENERATE" },
            // Once typed, the next text is written afresh, even for the same field.
            { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "GENERATE" },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({ client, decider, goal: "x", text: textStrategy({}, {}, generator) }).run();
        expect(client.acts.map((a: { value?: string }): string | undefined => a.value)).toEqual(["city-1", "city-1", "city-2"]);
        expect(calls).toEqual(["Email", "Email"]);
        expect(result.steps[1]).toMatchObject({ executed: true, text: "city-1", textReused: true });
        expect(result.steps[1].textMs).toBeUndefined();
        expect(result.steps[2].textReused).toBeUndefined();
    });

    it("types a generated value, and types nothing when the generator has none", async (): Promise<void> => {
        const generator: TextGenerator = {
            label: "fake",
            generate: async (context: FieldContext): Promise<string | null> =>
                context.field.name === "Email" ? "a@b.c" : null,
        };
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, LOGIN_CONTROLS) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "GENERATE" },
            { operation: Operation.TYPE_TEXT, target: named("Password"), textKey: "GENERATE" },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({
            client,
            decider,
            goal: "x",
            text: textStrategy({}, {}, generator),
        }).run();
        expect(client.acts).toHaveLength(1);
        expect(client.acts[0].value).toBe("a@b.c");
        expect(result.steps[1].executed).toBe(false);
        expect(result.steps[1].reason).toMatch(/no value/);
    });

    it("stops as BLOCKED after actions that change nothing", async (): Promise<void> => {
        const same = (): ActResult => ({ executed: true, snapshot: snapshot(1, LOGIN_CONTROLS) });
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [same, same, same]);
        const decider: ScriptedDecider = new ScriptedDecider(
            Array.from({ length: 5 }, (): { operation: Operation; target: ReturnType<typeof named> } => ({
                operation: Operation.CLICK,
                target: named("Login"),
            }))
        );
        const result: RunResult = await new Agent({ client, decider, goal: "x", text: textStrategy() }).run();
        expect(result.status).toBe(RunStatus.BLOCKED);
        expect(result.reason).toMatch(/changed nothing/);
    });

    it("stops as BLOCKED when it goes round in a circle of pages", async (): Promise<void> => {
        const products = (): ActResult => ({ executed: true, snapshot: snapshot(2, LOGIN_CONTROLS, { url: "https://shop.test/products" }) });
        const cart = (): ActResult => ({ executed: true, snapshot: snapshot(3, LOGIN_CONTROLS, { url: "https://shop.test/cart" }) });
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS, { url: "https://shop.test/cart" }), [
            products, cart, products, cart, products, cart, products, cart,
        ]);
        const decider: ScriptedDecider = new ScriptedDecider(
            Array.from({ length: 8 }, (_: unknown, i: number): { operation: Operation; target: ReturnType<typeof named> } => ({
                operation: Operation.CLICK,
                target: named(i % 2 === 0 ? "Login" : "Email"),
            }))
        );
        const result: RunResult = await new Agent({ client, decider, goal: "x", text: textStrategy() }).run();
        expect(result.status).toBe(RunStatus.BLOCKED);
        expect(result.reason).toMatch(/a loop: .*Login.* 3 times/);
        expect(client.acts).toHaveLength(5);
    });

    it("observes the page again once the requests an action started are done", async (): Promise<void> => {
        const loading = (): ActResult => ({ executed: true, snapshot: snapshot(2, [], { url: "https://shop.test/products" }) });
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [loading]);
        client.waitForQuiet = async (): Promise<NetworkWait> => {
            client.setPage(snapshot(3, LOGIN_CONTROLS, { url: "https://shop.test/products" }));
            return NetworkWait.WAITED;
        };
        const decider: ScriptedDecider = new ScriptedDecider([{ operation: Operation.CLICK, target: named("Login") }, { operation: Operation.DONE }]);
        await new Agent({ client, decider, goal: "x", text: textStrategy() }).run();
        // The second decision is made on the page as loaded, not on the empty one the click returned.
        expect(decider.seen[1].snapshot.snapshotId).toBe(3);
    });

    it("selects an option by its real value when that value reads as a secret on the masked page", async (): Promise<void> => {
        // `--secret password=admin` and a role select whose option value is "admin".
        const role: Control = control(4, "combobox", "Role", [ControlOperation.SELECT], {
            options: [
                { value: "user", label: "User" },
                { value: "admin", label: "Administrator" },
            ],
        });
        const client: FakeClient = new FakeClient(snapshot(1, [role]), [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, [role], { fingerprint: "fp-2" }) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.SELECT, target: named("Role"), optionLabel: "Administrator" },
            { operation: Operation.DONE },
        ]);
        await new Agent({ client, decider, goal: "x", text: textStrategy({}, { password: "admin" }) }).run();
        expect(decider.seen[0].snapshot.controls[0].options?.[1].value).toBe("[secret:password]");
        expect(client.acts[0].value).toBe("admin");
    });

    it("asks DevTools to wait for the network, and stops asking on a site that never goes quiet", async (): Promise<void> => {
        const polling = (): ActResult => ({ executed: true, networkIdle: false, snapshot: snapshot(2, LOGIN_CONTROLS, { fingerprint: "fp-2" }) });
        const moved = (): ActResult => ({ executed: true, networkIdle: true, snapshot: snapshot(3, LOGIN_CONTROLS, { fingerprint: "fp-3" }) });
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [polling, moved]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.CLICK, target: named("Login") },
            { operation: Operation.CLICK, target: named("Email") },
            { operation: Operation.DONE },
        ]);
        await new Agent({ client, decider, goal: "x", text: textStrategy() }).run();
        expect(client.acts[0].waitForNetworkMs).toBeGreaterThan(0);
        expect(client.acts[1].waitForNetworkMs).toBeUndefined();
        expect(client.snapshots).toBe(1);
    });

    it("does not wait for the network behind a held dialog, nor mark its site busy", async (): Promise<void> => {
        // The act leaves networkIdle out when a dialog is held: that is not an old DevTools.
        const dialog = (): ActResult => ({
            executed: true,
            snapshot: snapshot(2, LOGIN_CONTROLS, { fingerprint: "fp-2", dialog: { type: "confirm", message: "Delete?" } }),
        });
        const moved = (): ActResult => ({ executed: true, networkIdle: true, snapshot: snapshot(3, LOGIN_CONTROLS, { fingerprint: "fp-3" }) });
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [dialog, moved]);
        let quietWaits: number = 0;
        client.waitForQuiet = async (): Promise<NetworkWait> => {
            quietWaits++;
            return NetworkWait.BUSY;
        };
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.CLICK, target: named("Login") },
            { operation: Operation.CLICK, target: named("Email") },
            { operation: Operation.DONE },
        ]);
        await new Agent({ client, decider, goal: "x", text: textStrategy() }).run();
        expect(quietWaits).toBe(0);
        expect(client.acts[1].waitForNetworkMs).toBeGreaterThan(0);
    });

    it("starts the run's clock after the first observation, once, and not when continuing one", async (): Promise<void> => {
        const events: string[] = [];
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), []);
        const snapshotOf = client.snapshot.bind(client);
        client.snapshot = async (limits) => {
            events.push("snapshot");
            return snapshotOf(limits);
        };
        await new Agent({
            client,
            decider: new ScriptedDecider([{ operation: Operation.DONE }]),
            goal: "x",
            text: textStrategy(),
            onClockStart: (): void => {
                events.push("clock");
            },
        }).run();
        expect(events.slice(0, 2)).toEqual(["snapshot", "clock"]);
        expect(events.filter((e: string): boolean => e === "clock")).toHaveLength(1);

        let continued: number = 0;
        await new Agent({
            client,
            decider: new ScriptedDecider([{ operation: Operation.DONE }]),
            goal: "x",
            text: textStrategy(),
            elapsedOffsetMs: 1_000,
            onClockStart: (): void => {
                continued++;
            },
        }).run();
        expect(continued).toBe(0);
    });

    it("stops at the action budget, and when cancelled", async (): Promise<void> => {
        let n: number = 1;
        const moving = (): ActResult => ({ executed: true, snapshot: snapshot(++n, LOGIN_CONTROLS) });
        const clicks: Array<{ operation: Operation; target: ReturnType<typeof named> }> = Array.from(
            { length: 5 },
            (): { operation: Operation; target: ReturnType<typeof named> } => ({
                operation: Operation.CLICK,
                target: named("Login"),
            })
        );
        const budget: RunResult = await new Agent({
            client: new FakeClient(snapshot(1, LOGIN_CONTROLS), [moving, moving]),
            decider: new ScriptedDecider(clicks),
            goal: "x",
            text: textStrategy(),
            maxActions: 2,
        }).run();
        expect(budget.status).toBe(RunStatus.BUDGET);
        expect(budget.actions).toBe(2);
        // The budget is checked before a decision is asked for: none is spent that could not run.
        expect(budget.decisions).toBe(2);

        const abort: AbortController = new AbortController();
        abort.abort();
        const cancelled: RunResult = await new Agent({
            client: new FakeClient(snapshot(1, LOGIN_CONTROLS), []),
            decider: new ScriptedDecider(clicks),
            goal: "x",
            text: textStrategy(),
            signal: abort.signal,
        }).run();
        expect(cancelled.status).toBe(RunStatus.CANCELLED);
    });

    it("rejects a DONE the engine does not see borne out, says why, and keeps going", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [
            (): ActResult => {
                client.pageTextValue = "Order #7 placed";
                return { executed: true, snapshot: snapshot(2, []) };
            },
        ]);
        // The judge reads the evidence it is given: done once the page shows the order.
        const judge: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => ({
            goal_state: JSON.stringify(r.state).includes("Order #7")
                ? answer("done", GOAL_STATES, 0.93)
                : answer("not-yet", GOAL_STATES, 0.9),
        }));
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.DONE },
            { operation: Operation.CLICK, target: named("Login") },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({
            client,
            decider,
            goal: "Place the order",
            text: textStrategy(),
            goalJudge: new GoalJudge(judge),
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(result.goal).toMatchObject({ state: "done", stateProbability: 0.93, achieved: true });
        expect(result.steps[0].executed).toBe(false);
        expect(result.steps[0].goal?.achieved).toBe(false);
        expect(decider.seen[1].history[0].reason).toMatch(/DONE rejected: the goal is not done yet/);
    });

    it("ends FAILED when the goal is never shown done, reading only the run's traffic", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), []);
        const before: number = Date.now();
        const result: RunResult = await new Agent({
            client,
            decider: new ScriptedDecider(
                Array.from({ length: 5 }, (): { operation: Operation } => ({ operation: Operation.DONE }))
            ),
            goal: "x",
            text: textStrategy(),
            goalJudge: new GoalJudge(
                new FakeEngine((): Record<string, unknown> => ({ goal_state: answer("not-yet", GOAL_STATES) }))
            ),
        }).run();
        expect(result.status).toBe(RunStatus.FAILED);
        expect(result.decisions).toBe(3);
        expect(client.evidenceReadsSince[0]).toBeGreaterThanOrEqual(before);
    });

    it("stops at once when the goal failed, and tells the policy why when it is only not done yet", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), []);
        client.requests = [
            {
                method: "GET",
                url: "https://shop.test/api/orders/42",
                resourceType: "fetch",
                status: 500,
                body: '{"error":"payment service unavailable"}',
                timestamp: Date.now() + 1_000,
            },
        ];
        const failed: RunResult = await new Agent({
            client,
            decider: new ScriptedDecider(Array.from({ length: 5 }, (): { operation: Operation } => ({ operation: Operation.DONE }))),
            goal: "Place the order",
            text: textStrategy(),
            goalJudge: new GoalJudge(new FakeEngine(causeAt("failed", "r1"))),
        }).run();
        expect(failed.status).toBe(RunStatus.FAILED);
        expect(failed.decisions).toBe(1);
        // The why is the evidence the engine points at, not a rule's.
        expect(failed.reason).toBe("the goal failed (p=0.90); the evidence shows GET /api/orders/42 → 500");

        const decider: ScriptedDecider = new ScriptedDecider([{ operation: Operation.DONE }, { operation: Operation.BLOCKED }]);
        await new Agent({
            client,
            decider,
            goal: "Place the order",
            text: textStrategy(),
            goalJudge: new GoalJudge(new FakeEngine(causeAt("not-yet", "r1"))),
        }).run();
        expect(decider.seen[1].history[0].reason).toContain("the evidence shows GET /api/orders/42 → 500");
    });

    describe("the user's turn", (): void => {
        const SSO: ReturnType<typeof snapshot> = snapshot(1, [control(7, "button", "Continue with Google", [ControlOperation.CLICK])], {
            url: "https://id.example.test/sso",
        });
        const SIGNED_IN: ReturnType<typeof snapshot> = snapshot(2, LOGIN_CONTROLS, { url: "https://shop.test/home", fingerprint: "fp-in" });

        it("hands the browser over, reads the page afresh when the user is done, and goes on", async (): Promise<void> => {
            const client: FakeClient = new FakeClient(SSO, []);
            const asked: UserActionRequest[] = [];
            const decider: ScriptedDecider = new ScriptedDecider([
                { operation: Operation.ASK_USER, userAction: UserActionKind.SIGN_IN },
                { operation: Operation.DONE, when: (i): boolean => i.snapshot.url.endsWith("/home") },
            ]);
            const result: RunResult = await new Agent({
                client,
                decider,
                goal: "Sign in",
                text: textStrategy(),
                askUser: async (request: UserActionRequest): Promise<boolean> => {
                    asked.push(request);
                    client.setPage(SIGNED_IN);
                    return true;
                },
            }).run();

            expect(result.status).toBe(RunStatus.DONE);
            expect(asked).toHaveLength(1);
            expect(asked[0].kind).toBe(UserActionKind.SIGN_IN);
            expect(asked[0].prompt).toMatch(/Sign in/);
            expect(decider.seen[0].canAskUser).toBe(true);
            expect(result.steps[0]).toMatchObject({ operation: Operation.ASK_USER, executed: true, pageChanged: true });
            expect(result.steps[0].userAction?.kind).toBe(UserActionKind.SIGN_IN);
            // The engine learns what the user was asked to do.
            expect(decider.seen[1].history.at(-1)?.note).toMatch(/Sign in/);
            expect(result.actions).toBe(0);
        });

        it("stops the run when the user stops it, and is not offered without a person", async (): Promise<void> => {
            const stopped: RunResult = await new Agent({
                client: new FakeClient(SSO, []),
                decider: new ScriptedDecider([{ operation: Operation.ASK_USER, userAction: UserActionKind.VERIFY }]),
                goal: "Sign in",
                text: textStrategy(),
                askUser: async (): Promise<boolean> => false,
            }).run();
            expect(stopped.status).toBe(RunStatus.CANCELLED);

            const alone: ScriptedDecider = new ScriptedDecider([]);
            await new Agent({ client: new FakeClient(SSO, []), decider: alone, goal: "Sign in", text: textStrategy() }).run();
            expect(alone.seen[0].canAskUser).toBe(false);
        });

        it("asks the user to type a value nothing else provides", async (): Promise<void> => {
            const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), []);
            const asked: UserActionRequest[] = [];
            const choices = buildTextChoices("goal", [new SuppliedValuesSource({}, {})], false, {}, true);
            expect(choices.map((c): string => c.key)).toEqual(["ASK_USER"]);
            const result: RunResult = await new Agent({
                client,
                decider: new ScriptedDecider([
                    { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "ASK_USER" },
                    { operation: Operation.DONE },
                ]),
                goal: "Sign in",
                text: { choices, secrets: {} },
                askUser: async (request: UserActionRequest): Promise<boolean> => {
                    asked.push(request);
                    return true;
                },
            }).run();
            expect(result.status).toBe(RunStatus.DONE);
            expect(asked[0]).toMatchObject({ kind: UserActionKind.ENTER_VALUE, field: expect.stringContaining("Email") });
            expect(asked[0].prompt).toMatch(/Type a value into .*Email/);
            // Nothing was typed by the run itself.
            expect(client.acts).toHaveLength(0);
        });
    });

    it("presses a key, hovers, and offers GO_BACK once the run left a page and GO_FORWARD after going back", async (): Promise<void> => {
        const home: ReturnType<typeof snapshot> = snapshot(1, LOGIN_CONTROLS, { url: "https://shop.test/" });
        const client: FakeClient = new FakeClient(home, [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, LOGIN_CONTROLS, { url: "https://shop.test/", fingerprint: "fp-esc" }) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(3, LOGIN_CONTROLS, { url: "https://shop.test/", fingerprint: "fp-menu" }) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(4, LOGIN_CONTROLS, { url: "https://shop.test/help" }) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(5, LOGIN_CONTROLS, { url: "https://shop.test/" }) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.PRESS_KEY, key: "Escape" },
            { operation: Operation.HOVER, target: named("Login") },
            { operation: Operation.CLICK, target: named("Login") },
            { operation: Operation.GO_BACK },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({ client, decider, goal: "Browse", text: textStrategy() }).run();

        expect(result.status).toBe(RunStatus.DONE);
        expect(client.acts.map((a): string => a.action)).toEqual(["press-key", "hover", "click", "go-back"]);
        expect(client.acts[0].value).toBe("Escape");
        expect(result.steps[0].key).toBe("Escape");
        expect(decider.seen.map((i): boolean => Boolean(i.canGoBack))).toEqual([false, false, false, true, true]);
        expect(decider.seen.map((i): boolean => Boolean(i.canGoForward))).toEqual([false, false, false, false, true]);
        expect(recordSteps(result.steps).map((r): string => `${r.operation}${r.key ? ` ${r.key}` : ""}`)).toEqual([
            "PRESS_KEY Escape",
            "HOVER",
            "CLICK",
            "GO_BACK",
        ]);
    });

    it("judges the goal on the steps and the earlier pages too, not only the final page", async (): Promise<void> => {
        const orders: ReturnType<typeof snapshot> = snapshot(1, LOGIN_CONTROLS, {
            url: "https://shop.test/orders",
            title: "Order history",
            text: "Order history: #1042 total 59.90 EUR",
        });
        const client: FakeClient = new FakeClient(orders, [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, LOGIN_CONTROLS, { url: "https://shop.test/", title: "Home", text: "Welcome" }) }),
        ]);
        client.pageTextValue = "Welcome";
        const seen: string[] = [];
        const judge: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
            const evidence: string = JSON.stringify(r.state);
            seen.push(evidence);
            // Done only when it can see both the total read earlier and the way back.
            return { goal_state: answer(evidence.includes("59.90") && evidence.includes("GO_BACK") ? "done" : "not-yet", GOAL_STATES, 0.9) };
        });
        const result: RunResult = await new Agent({
            client,
            decider: new ScriptedDecider([{ operation: Operation.GO_BACK }, { operation: Operation.DONE }]),
            goal: "Find the latest order's total, then go back",
            text: textStrategy(),
            goalJudge: new GoalJudge(judge),
        }).run();

        expect(result.status).toBe(RunStatus.DONE);
        expect(seen[0]).toContain("Earlier pages");
        expect(result.journey?.steps.map((j): string => j.operation)).toEqual(["GO_BACK", "DONE"]);
        expect(result.journey?.pages.map((p): string => p.url)).toEqual(["https://shop.test/orders", "https://shop.test/"]);
    });

    it("keeps secrets out of the journey", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS, { text: "Your code is hunter2-SECRET" }), []);
        const result: RunResult = await new Agent({
            client,
            decider: new ScriptedDecider([{ operation: Operation.DONE }]),
            goal: "Look",
            text: textStrategy({}, { password: "hunter2-SECRET" }),
        }).run();
        expect(JSON.stringify(result.journey)).not.toContain("hunter2-SECRET");
        expect(JSON.stringify(result.journey)).toContain("[secret:password]");
    });

    it("switches and closes tabs by index, and records the tab", async (): Promise<void> => {
        const tabs = [
            { index: 0, url: "https://shop.test/", title: "Shop", active: false },
            { index: 1, url: "https://shop.test/invoice", title: "Invoice", active: true },
        ];
        const client: FakeClient = new FakeClient({ ...snapshot(1, LOGIN_CONTROLS, { url: "https://shop.test/invoice" }), tabs }, [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, LOGIN_CONTROLS, { url: "https://shop.test/" }) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([{ operation: Operation.SWITCH_TAB, tab: 0 }, { operation: Operation.DONE }]);
        const result: RunResult = await new Agent({ client, decider, goal: "Back to the shop", text: textStrategy() }).run();
        expect(client.acts[0]).toMatchObject({ action: "switch-tab", value: "0" });
        expect(result.steps[0].tab).toBe(0);
        expect(recordSteps(result.steps)[0]).toMatchObject({ operation: "SWITCH_TAB", tab: 0 });
    });

    it("asks the value again for the chosen field when the first pick looks wrong", async (): Promise<void> => {
        const fields = [
            control(1, "textbox", "Card number", [ControlOperation.FILL], { value: "" }),
            control(2, "textbox", "Card PIN", [ControlOperation.FILL], { password: true, filled: false }),
        ];
        const client: FakeClient = new FakeClient(snapshot(1, fields), [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, fields, { fingerprint: "a" , text: "card typed" }) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(3, fields, { fingerprint: "b", text: "pin typed" }) }),
        ]);
        const asked: string[] = [];
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("Card number"), textKey: "value:card" },
            // The parallel value head picks the card number again, for the PIN.
            { operation: Operation.TYPE_TEXT, target: named("Card PIN"), textKey: "value:card" },
            { operation: Operation.DONE },
        ]);
        (decider as unknown as { chooseValue: unknown }).chooseValue = async (_input: unknown, field: { name: string }) => {
            asked.push(field.name);
            return { textKey: "secret:pin", probabilities: { "secret:pin": 0.9, "value:card": 0.1 } };
        };
        const result: RunResult = await new Agent({
            client,
            decider,
            goal: "Pay by card",
            text: textStrategy({ card: "4111" }, { pin: "1234" }),
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
        // Only the suspect pick was asked again, for its field.
        expect(asked).toEqual(["Card PIN"]);
        expect(client.acts.map((a) => a.value)).toEqual(["4111", "1234"]);
        expect(result.steps[1].text).toBe("<secret pin>");
    });

    it("asks again for a second field given the same value, and types what the engine then chooses", async (): Promise<void> => {
        const fields = [
            control(1, "textbox", "Email", [ControlOperation.FILL], { value: "" }),
            control(2, "textbox", "Confirm email", [ControlOperation.FILL], { value: "" }),
        ];
        const client: FakeClient = new FakeClient(snapshot(1, fields), [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, fields, { text: "one" }) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(3, fields, { text: "two" }) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "value:email" },
            { operation: Operation.TYPE_TEXT, target: named("Confirm email"), textKey: "value:email" },
            { operation: Operation.DONE },
        ]);
        // No word list decides which field repeats a value on purpose: the engine is asked, naming the field.
        const asked: string[] = [];
        (decider as unknown as { chooseValue: unknown }).chooseValue = async (_input: unknown, field: { name: string }) => {
            asked.push(field.name);
            return { textKey: "value:email", probabilities: { "value:email": 0.9, "value:name": 0.1 } };
        };
        await new Agent({ client, decider, goal: "Sign up", text: textStrategy({ email: "a@b.test", name: "Ada" }) }).run();
        expect(asked).toEqual(["Confirm email"]);
        expect(client.acts.map((a) => a.value)).toEqual(["a@b.test", "a@b.test"]);
    });

    it("does not re-ask the engine about a value the text model at the controls chose for a field", async (): Promise<void> => {
        const fields = [
            control(1, "textbox", "Email", [ControlOperation.FILL], { value: "" }),
            control(2, "textbox", "Confirm email", [ControlOperation.FILL], { value: "" }),
        ];
        // The engine types the email, then stalls; the model types it again into the confirm field, on purpose.
        const client: FakeClient = new FakeClient(snapshot(1, fields), [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, fields, { text: "one" }) }),
            (): ActResult => ({ executed: true, snapshot: snapshot(3, fields, { text: "two" }) }),
        ]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "value:email" },
            { operation: Operation.BLOCKED },
            { operation: Operation.DONE },
        ]);
        const asked: string[] = [];
        (decider as unknown as { chooseValue: unknown }).chooseValue = async (_input: unknown, field: { name: string }) => {
            asked.push(field.name);
            return { textKey: "value:name", probabilities: { "value:name": 0.9, "value:email": 0.1 } };
        };
        const takeover: Takeover = {
            label: "fake/model",
            start: (): TakeoverSession => {
                let turn: number = 0;
                return {
                    next: async (): Promise<TakeoverStep> =>
                        turn++ === 0
                            ? { act: { operation: Operation.TYPE_TEXT, controlId: 2, textKey: "value:email", confidence: 1, operationProbabilities: {}, latencyMs: 0 }, why: "confirm the email" }
                            : { end: TakeoverEnd.RESOLVED, why: "both fields filled" },
                };
            },
        };
        const result: RunResult = await new Agent({ client, decider, goal: "Sign up", text: textStrategy({ email: "a@b.test", name: "Ada" }), takeover }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(asked).toEqual([]);
        expect(client.acts.map((a) => a.value)).toEqual(["a@b.test", "a@b.test"]);
    });

    it("lets the engine act once before the text model is called, even on a one-action budget", async (): Promise<void> => {
        const started: string[] = [];
        const takeover: Takeover = {
            label: "fake/model",
            start: (stuck: string): TakeoverSession => {
                started.push(stuck);
                return { next: async (): Promise<TakeoverStep> => ({ end: TakeoverEnd.RESOLVED, why: "nothing to do" }) };
            },
        };
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [
            (): ActResult => ({ executed: true, snapshot: snapshot(2, LOGIN_CONTROLS, { text: "after" }) }),
        ]);
        const result: RunResult = await new Agent({
            client,
            decider: new ScriptedDecider([{ operation: Operation.CLICK, target: named("Login") }, { operation: Operation.CLICK, target: named("Login") }]),
            goal: "x",
            text: textStrategy(),
            takeover,
            maxActions: 1,
        }).run();
        expect(client.acts).toHaveLength(1);
        expect(result.status).toBe(RunStatus.BUDGET);
        // The share (75 % of one action) is one action, not none: the model is called after the click, not before.
        expect(started).toEqual(["1 actions without reaching the goal", "1-action budget reached"]);
    });

    it("ends a run stopped during the action that completes a stall as cancelled, not blocked", async (): Promise<void> => {
        const abort: AbortController = new AbortController();
        // Three clicks that change nothing: a stall — but the caller stops the run while the third is in flight.
        const same = (): ActResult => ({ executed: true, snapshot: snapshot(1, LOGIN_CONTROLS) });
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [
            same,
            same,
            (): ActResult => {
                abort.abort();
                return same();
            },
        ]);
        const result: RunResult = await new Agent({
            client,
            decider: new ScriptedDecider(Array.from({ length: 4 }, () => ({ operation: Operation.CLICK, target: named("Login") }))),
            goal: "x",
            text: textStrategy(),
            signal: abort.signal,
        }).run();
        expect(client.acts).toHaveLength(3);
        expect(result.status).toBe(RunStatus.CANCELLED);
        expect(result.reason).toBe("stopped by the caller");
    });

    it("acts no more when stopped while the text model writes a value", async (): Promise<void> => {
        const abort: AbortController = new AbortController();
        const generator: TextGenerator = {
            label: "fake",
            generate: async (): Promise<string | null> => {
                abort.abort();
                return "written while stopping";
            },
        };
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [(): ActResult => ({ executed: true, snapshot: snapshot(2, LOGIN_CONTROLS) })]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "GENERATE" },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({ client, decider, goal: "x", text: textStrategy({}, {}, generator), signal: abort.signal }).run();
        expect(result.status).toBe(RunStatus.CANCELLED);
        expect(result.reason).toBe("stopped by the caller");
        expect(client.acts).toHaveLength(0);
    });

    it("types nothing, and says why, when the text model fails instead of answering", async (): Promise<void> => {
        const generator: TextGenerator = {
            label: "fake",
            generate: async (): Promise<string | null> => {
                throw new Error("The text model returned no {\"text\": …} object; nothing typed");
            },
        };
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), []);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "GENERATE" },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({ client, decider, goal: "x", text: textStrategy({}, {}, generator) }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(client.acts).toHaveLength(0);
        expect(result.steps[0]).toMatchObject({ executed: false, reason: expect.stringMatching(/no value for .*Email.*: The text model returned no/) });
    });

    it("describes the acted control from the masked page: the history target, the recording's descriptor and the text model's field", async (): Promise<void> => {
        // A page that echoes a (non-password) secret: in a field's value and beside a button.
        const page = (id: number): ReturnType<typeof snapshot> =>
            snapshot(id, [
                control(1, "textbox", "PIN", [ControlOperation.FILL], { value: "1234" }),
                control(2, "button", "Continue", [ControlOperation.CLICK], { context: "your PIN 1234" }),
            ]);
        const seenFields: FieldContext["field"][] = [];
        const generator: TextGenerator = {
            label: "fake",
            generate: async (context: FieldContext): Promise<string | null> => {
                seenFields.push(context.field);
                return "9999";
            },
        };
        const client: FakeClient = new FakeClient(page(1), [(): ActResult => ({ executed: true, snapshot: page(2) }), (): ActResult => ({ executed: true, snapshot: page(3) })]);
        const decider: ScriptedDecider = new ScriptedDecider([
            { operation: Operation.TYPE_TEXT, target: named("PIN"), textKey: "GENERATE" },
            { operation: Operation.CLICK, target: named("Continue") },
            { operation: Operation.DONE },
        ]);
        const result: RunResult = await new Agent({ client, decider, goal: "Continue", text: textStrategy({}, { pin: "1234" }, generator) }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(seenFields).toEqual([{ name: "PIN", role: "textbox", value: "[secret:pin]" }]);
        const history: string = JSON.stringify(decider.seen[2].history);
        expect(history).not.toContain("1234");
        expect(decider.seen[2].history[1].target).toBe('[2] button "Continue" (your PIN [secret:pin])');
        expect(result.steps[1].targetDescriptor).toEqual({ role: "button", name: "Continue", context: "your PIN [secret:pin]", ordinal: 0 });
        expect(JSON.stringify(result.steps)).not.toContain("1234");
    });

    it("refuses an action on a control that is not on the page, instead of acting blindly", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), []);
        const decisions: Array<{ operation: Operation; controlId?: number }> = [
            { operation: Operation.TYPE_TEXT, controlId: 999 },
            { operation: Operation.CLICK, controlId: 998 },
            { operation: Operation.DONE },
        ];
        const result: RunResult = await new Agent({
            client,
            decider: {
                decide: async () => ({ ...decisions.shift()!, textKey: "value:email", confidence: 1, operationProbabilities: {}, latencyMs: 0 }),
            },
            goal: "x",
            text: textStrategy({ email: "a@b.c" }),
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(client.acts).toHaveLength(0);
        expect(result.steps.slice(0, 2).map((s) => s.reason)).toEqual(["no control 999 on the page", "no control 998 on the page"]);
    });
});

describe("what leaves the agent while the run has secrets", (): void => {
    class PicturingClient extends FakeClient {
        pictures: number = 0;
        override async screenshot(): Promise<TextImage> {
            this.pictures++;
            return { mimeType: "image/png", data: "iVBORw0" };
        }
    }
    const same = (): ActResult => ({ executed: true, snapshot: snapshot(1, LOGIN_CONTROLS) });
    const clicksOnEmail = (n: number): Array<{ operation: Operation; target: ReturnType<typeof named> }> =>
        Array.from({ length: n }, (): { operation: Operation; target: ReturnType<typeof named> } => ({ operation: Operation.CLICK, target: named("Email") }));
    /** A takeover whose only move is one look, whose outcome it reports. */
    function looking(look: (looks: TakeoverLooks) => Promise<string>): { takeover: Takeover; seen: string[] } {
        const seen: string[] = [];
        const takeover: Takeover = {
            label: "fake/model",
            start: (_stuck: string, looks: TakeoverLooks): TakeoverSession => ({
                next: async (): Promise<TakeoverStep> => {
                    seen.push(await look(looks));
                    return { end: TakeoverEnd.GAVE_UP, why: "seen enough" };
                },
            }),
        };
        return { takeover, seen };
    }
    const picture = async (looks: TakeoverLooks): Promise<string> => {
        if (!looks.screenshot) {
            return "not offered";
        }
        try {
            await looks.screenshot();
            return "taken";
        } catch (err: unknown) {
            return (err as Error).message;
        }
    };

    it("refuses the text model a screenshot while the page shows a secret, and takes one when it does not", async (): Promise<void> => {
        /** A stuck run on `page`, whose takeover asks for one screenshot. */
        const stuckOn = async (page: ControlSnapshot): Promise<{ client: PicturingClient; seen: string[] }> => {
            const stay = (): ActResult => ({ executed: true, snapshot: page });
            const client: PicturingClient = new PicturingClient(page, [stay, stay, stay]);
            const { takeover, seen } = looking(picture);
            await new Agent({ client, decider: new ScriptedDecider(clicksOnEmail(3)), goal: "Log in", text: textStrategy({}, { password: "hunter2" }), takeover, screenshotSafe: true }).run();
            return { client, seen };
        };
        // The password input was revealed: the page carries the value.
        const revealed: ControlSnapshot = snapshot(1, [control(4, "textbox", "Email", [ControlOperation.CLICK]), control(5, "textbox", "Password", [ControlOperation.FILL], { value: "hunter2" })]);
        const shown: { client: PicturingClient; seen: string[] } = await stuckOn(revealed);
        expect(shown.seen).toEqual(["not taken: the page shows a secret"]);
        expect(shown.client.pictures).toBe(0);
        // DevTools masked it at the source (seeded mode): the marker says the value is on the page.
        const marked: { client: PicturingClient; seen: string[] } = await stuckOn(snapshot(1, [control(4, "textbox", "Email", [ControlOperation.CLICK], { value: "[secret:password.password]" })]));
        expect(marked.seen).toEqual(["not taken: the page shows a secret"]);
        const hidden: { client: PicturingClient; seen: string[] } = await stuckOn(snapshot(1, LOGIN_CONTROLS));
        expect(hidden.seen).toEqual(["taken"]);
        expect(hidden.client.pictures).toBe(1);
    });

    it("takes no screenshot for the rest of the run once a secret was typed where it shows", async (): Promise<void> => {
        const client: PicturingClient = new PicturingClient(snapshot(1, LOGIN_CONTROLS), [same, same, same, same]);
        const { takeover, seen } = looking(picture);
        await new Agent({
            client,
            // The password goes into the Email field (a plain textbox): this process types it, nothing refuses.
            decider: new ScriptedDecider([{ operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "secret:password" }, ...clicksOnEmail(3)]),
            goal: "Log in",
            text: textStrategy({}, { password: "hunter2" }),
            takeover,
            screenshotSafe: true,
        }).run();
        expect(seen).toEqual(["not taken: a secret was typed into a field that shows it; no screenshot for the rest of this run"]);
        expect(client.pictures).toBe(0);
        // Without the flag the same run offers none at all.
        const { takeover: unsafe, seen: seenUnsafe } = looking(picture);
        await new Agent({
            client: new PicturingClient(snapshot(1, LOGIN_CONTROLS), [same, same, same]),
            decider: new ScriptedDecider(clicksOnEmail(3)),
            goal: "Log in",
            text: textStrategy({}, { password: "hunter2" }),
            takeover: unsafe,
        }).run();
        expect(seenUnsafe).toEqual(["not offered"]);
    });

    it("masks the encoded forms of a secret in every look, a URL in a console line included", async (): Promise<void> => {
        const client: FakeClient = new FakeClient(snapshot(1, LOGIN_CONTROLS), [same, same, same]);
        client.consoleEntries = [{ level: "error", text: "GET /login?pin=1%40x 401 (Unauthorized)", timestamp: 1 } as never];
        client.pageTextValue = 'Your pin is "1@x" (1%40x)';
        const { takeover, seen } = looking(async (looks: TakeoverLooks): Promise<string> => `${await looks.console()} | ${await looks.pageText()}`);
        await new Agent({ client, decider: new ScriptedDecider(clicksOnEmail(3)), goal: "Log in", text: textStrategy({}, { pin: "1@x" }), takeover }).run();
        expect(seen).toEqual(["GET /login?pin=[secret:pin] 401 (Unauthorized) | Your pin is \"[secret:pin]\" ([secret:pin])"]);
    });

    it("pauses for a value on the field the decision named among identical ones", async (): Promise<void> => {
        const twins: ControlSnapshot = snapshot(1, [control(1, "textbox", "Code", [ControlOperation.FILL]), control(2, "textbox", "Code", [ControlOperation.FILL])]);
        const choices = buildTextChoices("goal", [new SuppliedValuesSource({}, { token: "t0k" })], false, { token: "t0k" }, true);
        const result: RunResult = await new Agent({
            client: new FakeClient(twins, []),
            decider: new ScriptedDecider([
                { operation: Operation.TYPE_TEXT, target: (c): boolean => c.id === 2, textKey: "ASK_USER" },
                { operation: Operation.DONE },
            ]),
            goal: "Enter the code",
            text: { choices, secrets: { token: "t0k" } },
            askUser: async (): Promise<boolean> => true,
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(result.steps[0]).toMatchObject({ operation: Operation.ASK_USER, userAction: { kind: UserActionKind.ENTER_VALUE } });
        expect(result.steps[0].targetDescriptor).toEqual({ role: "textbox", name: "Code", ordinal: 1 });
    });

    it("withdraws the ask-the-user value once the hand-overs are used up, and says so", async (): Promise<void> => {
        const page: ControlSnapshot = snapshot(1, [control(1, "textbox", "Code", [ControlOperation.FILL])]);
        const choices = buildTextChoices("goal", [new SuppliedValuesSource({}, { token: "t0k" })], false, { token: "t0k" }, true);
        const decider: ScriptedDecider = new ScriptedDecider([
            ...Array.from({ length: 6 }, (): { operation: Operation; target: (c: Control) => boolean; textKey: string } => ({
                operation: Operation.TYPE_TEXT,
                target: (c: Control): boolean => c.id === 1,
                textKey: "ASK_USER",
            })),
            { operation: Operation.DONE },
        ]);
        let asked: number = 0;
        const result: RunResult = await new Agent({
            client: new FakeClient(page, []),
            decider,
            goal: "Enter the code",
            text: { choices, secrets: { token: "t0k" } },
            askUser: async (): Promise<boolean> => {
                asked++;
                return true;
            },
        }).run();
        expect(asked).toBe(5);
        expect(result.status).toBe(RunStatus.DONE);
        // The sixth ask: refused with the real reason, and the value was no longer offered.
        expect(result.steps[5]).toMatchObject({ executed: false, reason: expect.stringMatching(/the user was already asked 5 times; no more hand-overs/) });
        expect(decider.seen[5].textChoices.map((c): string => c.key)).not.toContain("ASK_USER");
        expect(decider.seen[4].textChoices.map((c): string => c.key)).toContain("ASK_USER");
    });

    it("masks the page's address in every event when a secret ended up in it", async (): Promise<void> => {
        // A GET form: the typed secret becomes a query parameter of the next page — encoded, as a browser submits it.
        const found: ControlSnapshot = snapshot(2, LOGIN_CONTROLS, { url: "https://shop.test/search?key=p%40ss+w0rd%21" });
        const asked: UserActionRequest[] = [];
        const result: RunResult = await new Agent({
            client: new FakeClient(snapshot(1, LOGIN_CONTROLS), [(): ActResult => ({ executed: true, snapshot: found })]),
            decider: new ScriptedDecider([
                { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "secret:key" },
                { operation: Operation.ASK_USER, userAction: UserActionKind.OTHER },
                { operation: Operation.DONE },
            ]),
            goal: "Search",
            text: textStrategy({}, { key: "p@ss w0rd!" }),
            askUser: async (request: UserActionRequest): Promise<boolean> => {
                asked.push(request);
                return true;
            },
        }).run();
        expect(result.status).toBe(RunStatus.DONE);
        expect(result.steps.map((s): string => s.url)).toEqual([
            "https://shop.test/login",
            "https://shop.test/search?key=[secret:key]",
            "https://shop.test/search?key=[secret:key]",
        ]);
        expect(asked[0].url).toBe("https://shop.test/search?key=[secret:key]");
        expect(result.finalSnapshot.url).toBe("https://shop.test/search?key=[secret:key]");
        expect(result.finalSnapshot.snapshotId).toBe(2);
        expect(JSON.stringify([result.steps, result.journey, asked])).not.toMatch(/p@ss|p%40ss/);
    });
});
