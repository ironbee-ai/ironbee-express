/**
 * The scenario lifecycle through runGoal, on a fake site with a scripted
 * engine: save + explore (the recording is cached), replay from the cache with
 * no engine calls, heal after a change.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunStatus, StepEvent, StepMode } from "../../../src/agent/agent";
import { Operation, UserActionKind } from "../../../src/agent/policy";
import { FastConfig, loadConfig } from "../../../src/config/config";
import { ActRequest, ControlOperation, SecretBundle } from "../../../src/devtools/types";
import { ChoiceQuestion } from "../../../src/engine/systemone";
import { RunOutcome, runGoal } from "../../../src/run/runner";
import { RecordingCache } from "../../../src/scenario/cache";
import { promptHash, ScenarioStore } from "../../../src/scenario/store";
import { Recording, RunMode, Scenario, SCENARIO_FORMAT_VERSION } from "../../../src/scenario/types";
import { Severity, Verdict } from "../../../src/verify/types";
import { FakeEngine, RecordedRequest } from "../../helpers/fake-engine";
import { answer, control } from "../../helpers/fixtures";
import { SitePage, SiteClient } from "../../helpers/site-client";

function site(cartName: string = "Cart"): Record<string, SitePage> {
    return {
        login: {
            controls: [
                control(1, "textbox", "Password", [ControlOperation.FILL, ControlOperation.CLICK], { password: true }),
                control(2, "button", "Login", [ControlOperation.CLICK]),
            ],
            links: { Login: "products" },
        },
        products: {
            controls: [
                control(3, "button", "Add to cart", [ControlOperation.CLICK], { context: "MacBook" }),
                control(4, "button", "Add to cart", [ControlOperation.CLICK], { context: "Sony headphones" }),
                control(5, "button", cartName, [ControlOperation.CLICK]),
            ],
            links: { [cartName]: "cart" },
        },
        cart: { controls: [], text: "Your cart: Sony headphones" },
    };
}

/** Whether a request is a step decision (not a goal judgement or a review). */
export function isDecision(r: RecordedRequest): boolean {
    return "operation" in r.questions;
}

/**
 * Clicks through `plan` by element name (then DONE); types the secret into the
 * password field first. As the judge: the goal is done when the evidence shows
 * `doneText`; every anomaly gets `severity` — or, with `reviewFails`, the
 * review (the request that asks about anomalies) fails as an unreachable engine's would.
 */
function scriptedEngine(
    plan: string[],
    doneText: string = "Your cart: Sony headphones",
    severity: Severity = Severity.NONE,
    reviewFails: boolean = false
): FakeEngine {
    let typed: boolean = false;
    let next: number = 0;
    return new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
        const q: Record<string, ChoiceQuestion> = r.questions as Record<string, ChoiceQuestion>;
        if (!isDecision(r)) {
            if (reviewFails && Object.keys(q).some((k: string): boolean => k.startsWith("issue_"))) {
                throw new Error("engine unreachable");
            }
            const answers: Record<string, unknown> = {
                goal_state: answer(JSON.stringify(r.state).includes(doneText) ? "done" : "not-yet", ["done", "not-yet", "failed"]),
            };
            for (const id of Object.keys(q).filter((k: string): boolean => k.startsWith("issue_"))) {
                answers[id] = answer(severity, Object.values(Severity));
            }
            return answers;
        }
        const ops: string[] = Object.keys(q.operation.criteria);
        const head: ChoiceQuestion | undefined = q.type_text_target;
        if (!typed && head && ops.includes("TYPE_TEXT")) {
            typed = true;
            const keys: string[] = Object.keys(head.criteria);
            return {
                operation: answer("TYPE_TEXT", ops),
                type_text_target: answer(keys[0], keys),
                text_value: answer("secret:password", Object.keys(q.text_value.criteria)),
            };
        }
        const click: ChoiceQuestion | undefined = q.click_target;
        const want: string | undefined = plan[next];
        const key: string | undefined = click
            ? Object.keys(click.criteria).find((k: string): boolean => JSON.stringify(click.criteria[k]).includes(want ?? "\u0000"))
            : undefined;
        if (want && key) {
            next++;
            return { operation: answer("CLICK", ops), click_target: answer(key, Object.keys(click!.criteria)) };
        }
        return { operation: answer(want ? "WAIT" : "DONE", ops) };
    });
}

describe("scenarios through runGoal", (): void => {
    let dir: string;
    let cacheDir: string;
    let config: FastConfig;
    const spec = {
        goal: "Log in and put the Sony headphones in the cart, then open the cart",
        url: "https://site.test/login",
        secrets: { password: "pw" },
        passwords: ["password"],
    };

    beforeEach((): void => {
        dir = mkdtempSync(join(tmpdir(), "ibexpress-run-"));
        cacheDir = mkdtempSync(join(tmpdir(), "ibexpress-cache-"));
        config = { ...loadConfig({}), scenarioDir: dir, cacheDir };
    });
    afterEach((): void => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
    });

    /** The recording cached for the scenario's own prompt. */
    function cached(name: string): Recording | undefined {
        return new RecordingCache(cacheDir).peek(name, promptHash(spec.goal, spec.url));
    }

    it("explores and saves; replays without the engine; heals after the page changes", async (): Promise<void> => {
        // 1) explore + save
        const explore: RunOutcome = await runGoal(
            { ...spec, saveAs: "cart" },
            config,
            new SiteClient(site(), "login"),
            {},
            undefined,
            { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
        );
        expect(explore.mode).toBe(RunMode.EXPLORE);
        expect(explore.result.status).toBe(RunStatus.DONE);
        expect(explore.recordingSaved).toBe(true);
        const saved: Scenario = new ScenarioStore(dir).get("cart");
        expect(saved.secretNames).toEqual(["password"]);
        expect(JSON.stringify(saved)).not.toContain('"pw"');
        expect(saved).not.toHaveProperty("recording");
        expect(cached("cart")?.steps.map((s): string => s.target?.name ?? s.operation)).toEqual([
            "Password",
            "Login",
            "Add to cart",
            "Cart",
        ]);

        // 2) replay: no engine decisions at all (the engine only judges the result)
        const idle: FakeEngine = scriptedEngine([]);
        const client: SiteClient = new SiteClient(site(), "login");
        const replay: RunOutcome = await runGoal(
            { scenario: "cart", secrets: { password: "pw2" } },
            config,
            client,
            {},
            undefined,
            { engine: idle }
        );
        expect(replay.mode).toBe(RunMode.REPLAY);
        expect(replay.result.status).toBe(RunStatus.DONE);
        expect(replay.analysis?.verdict).toBe(Verdict.PASSED);
        expect(idle.requests.filter(isDecision)).toHaveLength(0);
        expect(client.typed.Password).toBe("pw2");
        // Each replayed step waits for what it loads, as the agent's do.
        expect(client.acts.every((a: ActRequest): boolean => (a.waitForNetworkMs ?? 0) > 0)).toBe(true);

        // 3) the site renamed "Cart" → "Basket": replay diverges, the engine finishes, the recording is healed
        const healer: FakeEngine = scriptedEngine(["Basket"]);
        const healed: RunOutcome = await runGoal(
            { scenario: "cart", secrets: { password: "pw" } },
            { ...config },
            new SiteClient(site("Basket"), "login"),
            {},
            undefined,
            { engine: healer }
        );
        expect(healed.mode).toBe(RunMode.REPLAY_HEALED);
        expect(healed.divergence).toMatch(/button "Cart"/);
        expect(healed.result.status).toBe(RunStatus.DONE);
        const repaired: Recording | undefined = cached("cart");
        expect(repaired?.healedAt).toBeDefined();
        expect(repaired?.steps.at(-1)?.target?.name).toBe("Basket");
    });

    it("seeds the run's secrets into DevTools, types them by reference, and clears them", async (): Promise<void> => {
        const calls: string[] = [];
        let bundle: SecretBundle | undefined;
        class SeedingClient extends SiteClient {
            override get canSeedSecrets(): boolean {
                return true;
            }
            override async seedSecrets(b: SecretBundle): Promise<void> {
                calls.push("seed");
                bundle = b;
            }
            override async clearSecrets(): Promise<void> {
                calls.push("clear");
            }
        }
        const client: SeedingClient = new SeedingClient(site(), "login");
        const outcome: RunOutcome = await runGoal(
            { ...spec, saveAs: "cart", valueDescriptions: { password: "the shopper's password" } },
            config,
            client,
            {},
            undefined,
            { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
        );
        expect(outcome.result.status).toBe(RunStatus.DONE);
        expect(calls).toEqual(["seed", "clear"]);
        expect(bundle?.secrets).toEqual([
            {
                name: "password",
                description: "the shopper's password",
                type: "login-credentials",
                fields: { password: "pw" },
                boundOrigins: ["site.test"],
            },
        ]);
        // The value never travels in a tool call: DevTools resolves the reference at the field.
        expect(client.typed.Password).toBe("{{secret:password.password}}");
        expect(new ScenarioStore(dir).get("cart").descriptions).toEqual({ password: "the shopper's password" });
        // Which secret is a login password is kept with the scenario; the value never is.
        expect(new ScenarioStore(dir).get("cart").passwordSecrets).toEqual(["password"]);
    });

    it("with IBEXPRESS_IFRAMES, binds a secret (not a password) to a start-site frame's host as its controls appear", async (): Promise<void> => {
        const bundles: SecretBundle[] = [];
        class SeedingClient extends SiteClient {
            override get canSeedSecrets(): boolean {
                return true;
            }
            override async seedSecrets(b: SecretBundle): Promise<void> {
                bundles.push(b);
            }
            override async clearSecrets(): Promise<void> {}
        }
        const framed: Record<string, SitePage> = site();
        framed.products.controls = [
            ...framed.products.controls,
            control(90, "textbox", "Card PIN", [ControlOperation.FILL], { frame: "pay.test" }),
        ];
        const secrets: Record<string, string> = { password: "pw", pin: "1234" };
        const origins = (b: SecretBundle): Record<string, string[]> =>
            Object.fromEntries(b.secrets.map((x): [string, string[]] => [x.name, x.boundOrigins]));
        const outcome: RunOutcome = await runGoal(
            { ...spec, secrets },
            { ...config, daemon: { ...config.daemon, iframes: true } },
            new SeedingClient(framed, "login"),
            {},
            undefined,
            { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
        );
        expect(outcome.result.status).toBe(RunStatus.DONE);
        expect(bundles.map(origins)).toEqual([
            { password: ["site.test"], pin: ["site.test"] },
            { password: ["site.test"], pin: ["site.test", "pay.test"] },
        ]);

        // Off by default: the start site only, and no second seed.
        bundles.length = 0;
        await runGoal({ ...spec, secrets }, config, new SeedingClient(framed, "login"), {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"]),
        });
        expect(bundles).toHaveLength(1);
    });

    it("keeps the run's browser profile in the scenario it saves", async (): Promise<void> => {
        const outcome: RunOutcome = await runGoal({ ...spec, saveAs: "cart", profile: "shopper" }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"]),
        });
        expect(outcome.profile).toBe("shopper");
        expect(new ScenarioStore(dir).get("cart").profile).toBe("shopper");
    });

    it("records a hand-over to the user, and pauses there again on replay", async (): Promise<void> => {
        // The login page is left to the user; the engine carries on from the products page.
        let asked: number = 0;
        const handOver = (client: SiteClient) => async (): Promise<boolean> => {
            asked++;
            client.page = "products";
            return true;
        };
        let decided: boolean = false;
        let clicks: number = 0;
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
            const q: Record<string, ChoiceQuestion> = r.questions as Record<string, ChoiceQuestion>;
            if (!isDecision(r)) {
                const answers: Record<string, unknown> = {
                    goal_state: answer(JSON.stringify(r.state).includes("Your cart: Sony headphones") ? "done" : "not-yet", ["done", "not-yet", "failed"]),
                };
                for (const id of Object.keys(q).filter((k: string): boolean => k.startsWith("issue_"))) {
                    answers[id] = answer("none", Object.values(Severity));
                }
                return answers;
            }
            const ops: string[] = Object.keys(q.operation.criteria);
            if (!decided) {
                decided = true;
                return { operation: answer("ASK_USER", ops), ask_user_reason: answer("SIGN_IN", Object.keys(q.ask_user_reason.criteria)) };
            }
            const want: string | undefined = ["Sony", "Cart"][clicks];
            const click: ChoiceQuestion | undefined = q.click_target;
            const key: string | undefined =
                want && click ? Object.keys(click.criteria).find((k: string): boolean => JSON.stringify(click.criteria[k]).includes(want)) : undefined;
            if (key) {
                clicks++;
                return { operation: answer("CLICK", ops), click_target: answer(key, Object.keys(click!.criteria)) };
            }
            return { operation: answer("DONE", ops) };
        });
        const first: SiteClient = new SiteClient(site(), "login");
        const explored: RunOutcome = await runGoal({ ...spec, saveAs: "sso" }, config, first, { onUserAction: handOver(first) }, undefined, { engine });
        expect(explored.result.status).toBe(RunStatus.DONE);
        expect(asked).toBe(1);
        expect(cached("sso")?.steps[0]).toMatchObject({ operation: "ASK_USER", userAction: "SIGN_IN" });

        const second: SiteClient = new SiteClient(site(), "login");
        const replayed: RunOutcome = await runGoal(
            { scenario: "sso", secrets: { password: "pw" } },
            config,
            second,
            { onUserAction: handOver(second) },
            undefined,
            { engine: scriptedEngine([]) }
        );
        expect(replayed.mode).toBe(RunMode.REPLAY);
        expect(replayed.result.status).toBe(RunStatus.DONE);
        expect(asked).toBe(2);

        // Nobody to hand it to: the replay diverges there.
        const alone: RunOutcome = await runGoal({ scenario: "sso", secrets: { password: "pw" }, heal: false }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine([]),
        });
        expect(alone.divergence).toMatch(/hands the browser to the user/);

        // "stop" at the recorded hand-over ends the run: no signal, and nothing heals it.
        const stopper: SiteClient = new SiteClient(site(), "login");
        const stopped: RunOutcome = await runGoal(
            { scenario: "sso", secrets: { password: "pw" } },
            config,
            stopper,
            { onUserAction: async (): Promise<boolean> => false },
            undefined,
            { engine: scriptedEngine([]) }
        );
        expect(stopped.mode).toBe(RunMode.REPLAY);
        expect(stopped.result.status).toBe(RunStatus.CANCELLED);
        expect(stopped.result.reason).toBe("stopped by the user");
        expect(stopped.result.decisions).toBe(0);
        expect(stopper.acts).toHaveLength(0);
    });

    it("counts the replay's hand-overs toward the run's limit when the engine heals it", async (): Promise<void> => {
        // Two recorded hand-overs, then a step the page no longer has: the engine heals, and may
        // hand over only three more times — five in the run, not five more.
        const now: string = new Date().toISOString();
        const hash: string = promptHash(spec.goal, spec.url);
        new ScenarioStore(dir).save({ formatVersion: SCENARIO_FORMAT_VERSION, name: "handovers", goal: spec.goal, url: spec.url, values: {}, secretNames: [], createdAt: now, updatedAt: now });
        new RecordingCache(cacheDir).put("handovers", {
            promptHash: hash,
            goal: spec.goal,
            url: spec.url,
            recording: {
                promptHash: hash,
                recordedAt: now,
                engine: "e",
                elapsedMs: 0,
                steps: [
                    { operation: Operation.ASK_USER, userAction: UserActionKind.SIGN_IN },
                    { operation: Operation.ASK_USER, userAction: UserActionKind.SIGN_IN },
                    { operation: Operation.CLICK, target: { role: "button", name: "Gone", ordinal: 0 } },
                ],
            },
        });
        const client: SiteClient = new SiteClient(site(), "login");
        let asked: number = 0;
        const handOver = async (): Promise<boolean> => {
            asked++;
            // Each turn changes the page, so no stall ends the run first.
            client.page = client.page === "login" ? "products" : "login";
            return true;
        };
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
            const q: Record<string, ChoiceQuestion> = r.questions as Record<string, ChoiceQuestion>;
            if (!isDecision(r)) {
                const answers: Record<string, unknown> = { goal_state: answer("done", ["done", "not-yet", "failed"]) };
                for (const id of Object.keys(q).filter((k: string): boolean => k.startsWith("issue_"))) {
                    answers[id] = answer("none", Object.values(Severity));
                }
                return answers;
            }
            const ops: string[] = Object.keys(q.operation.criteria);
            if (ops.includes("ASK_USER")) {
                return { operation: answer("ASK_USER", ops), ask_user_reason: answer("SIGN_IN", Object.keys(q.ask_user_reason.criteria)) };
            }
            return { operation: answer("DONE", ops) };
        });
        const outcome: RunOutcome = await runGoal({ scenario: "handovers" }, config, client, { onUserAction: handOver }, undefined, { engine });
        expect(outcome.mode).toBe(RunMode.REPLAY_HEALED);
        expect(asked).toBe(5);
        expect(outcome.result.steps.filter((e: StepEvent): boolean => e.operation === Operation.ASK_USER && e.executed)).toHaveLength(5);
    }, 20_000);

    it("counts the replay's re-judging as run time: the healed or finished clock carries it on", async (): Promise<void> => {
        await runGoal({ ...spec, saveAs: "cart" }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"]),
        });
        // Judged not yet once, then done: one re-judge pause (1 s) lies between.
        let judged: number = 0;
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
            const q: Record<string, ChoiceQuestion> = r.questions as Record<string, ChoiceQuestion>;
            const answers: Record<string, unknown> = {};
            if (q.goal_state) {
                judged++;
                answers.goal_state = answer(judged === 1 ? "not-yet" : "done", ["done", "not-yet", "failed"]);
            }
            for (const id of Object.keys(q).filter((k: string): boolean => k.startsWith("issue_"))) {
                answers[id] = answer("none", Object.values(Severity));
            }
            return answers;
        });
        const replayed: RunOutcome = await runGoal({ scenario: "cart", secrets: { password: "pw" } }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine,
        });
        expect(replayed.mode).toBe(RunMode.REPLAY);
        expect(replayed.result.status).toBe(RunStatus.DONE);
        expect(replayed.result.elapsedMs).toBeGreaterThanOrEqual(1_000);
        expect(replayed.result.steps[replayed.result.steps.length - 1]).toMatchObject({ operation: Operation.DONE });
        expect(replayed.result.steps[replayed.result.steps.length - 1].elapsedMs).toBeGreaterThanOrEqual(1_000);
    }, 20_000);

    it("tells the healing engine that the replayed run was judged not done, before it decides", async (): Promise<void> => {
        await runGoal({ ...spec, saveAs: "cart" }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"]),
        });
        // Never done: the replay completes, is judged not yet (and re-judged), and the engine heals.
        const engine: FakeEngine = new FakeEngine((r: RecordedRequest): Record<string, unknown> => {
            const q: Record<string, ChoiceQuestion> = r.questions as Record<string, ChoiceQuestion>;
            if (isDecision(r)) {
                return { operation: answer("DONE", Object.keys(q.operation.criteria)) };
            }
            const answers: Record<string, unknown> = {};
            if (q.goal_state) {
                answers.goal_state = answer("not-yet", ["done", "not-yet", "failed"]);
            }
            for (const id of Object.keys(q).filter((k: string): boolean => k.startsWith("issue_"))) {
                answers[id] = answer("none", Object.values(Severity));
            }
            return answers;
        });
        const healed: RunOutcome = await runGoal({ scenario: "cart", secrets: { password: "pw" } }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine,
        });
        expect(healed.mode).toBe(RunMode.REPLAY_HEALED);
        const rejected: StepEvent | undefined = healed.result.steps.find(
            (e: StepEvent): boolean => e.mode === StepMode.REPLAY && e.operation === Operation.DONE && !e.executed
        );
        expect(rejected?.reason).toMatch(/^DONE rejected: the goal is not done yet \(p=/);
        const first: RecordedRequest | undefined = engine.requests.find(isDecision);
        expect(JSON.stringify(first?.state)).toContain("DONE rejected: the goal is not done yet");
        expect(healed.result.journey?.steps.some((s: { operation: string; refused?: string }): boolean => s.operation === Operation.DONE && /DONE rejected/.test(s.refused ?? ""))).toBe(true);
    }, 30_000);

    it("refuses a run whose secret is empty, before anything is typed", async (): Promise<void> => {
        const client: SiteClient = new SiteClient(site(), "login");
        await expect(
            runGoal({ ...spec, secrets: { password: "" } }, config, client, {}, undefined, {
                engine: scriptedEngine(["Login", "Sony", "Cart"]),
            })
        ).rejects.toThrow(/secret\(s\) password have no value/);
        expect(client.acts).toHaveLength(0);
    });

    it("refuses to replay without the secrets the scenario needs", async (): Promise<void> => {
        await runGoal({ ...spec, saveAs: "cart" }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"]),
        });
        await expect(
            runGoal({ scenario: "cart" }, config, new SiteClient(site(), "login"), {}, undefined, {
                engine: scriptedEngine([]),
            })
        ).rejects.toThrow(/needs the secret\(s\) password/);
    });

    it("asks for a loaded scenario's secrets before saving it under any name, and keeps them in the save", async (): Promise<void> => {
        await runGoal({ ...spec, saveAs: "cart" }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"]),
        });
        // A copy without the secret: refused before anything is written.
        await expect(
            runGoal({ scenario: "cart", saveAs: "cart-copy", explore: true }, config, new SiteClient(site(), "login"), {}, undefined, {
                engine: scriptedEngine([]),
            })
        ).rejects.toThrow(/needs the secret\(s\) password/);
        expect(new ScenarioStore(dir).exists("cart-copy")).toBe(false);
        // Saved over itself without the secret: refused, and the original keeps its declaration.
        await expect(
            runGoal({ scenario: "cart", saveAs: "cart", explore: true }, config, new SiteClient(site(), "login"), {}, undefined, {
                engine: scriptedEngine([]),
            })
        ).rejects.toThrow(/needs the secret\(s\) password/);
        expect(new ScenarioStore(dir).get("cart")).toMatchObject({ secretNames: ["password"], passwordSecrets: ["password"] });
        // With the secret (and no --password this time), the copy keeps the password marking.
        await runGoal(
            { scenario: "cart", saveAs: "cart-copy", explore: true, secrets: { password: "pw" } },
            config,
            new SiteClient(site(), "login"),
            {},
            undefined,
            { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
        );
        expect(new ScenarioStore(dir).get("cart-copy")).toMatchObject({ secretNames: ["password"], passwordSecrets: ["password"] });
    });

    it("adds an explicit --password to a loaded scenario's markings, never drops one, and saves both", async (): Promise<void> => {
        await runGoal(
            { ...spec, secrets: { password: "pw", pin: "1234" }, passwords: ["password"], saveAs: "cart" },
            config,
            new SiteClient(site(), "login"),
            {},
            undefined,
            { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
        );
        expect(new ScenarioStore(dir).get("cart")).toMatchObject({ secretNames: ["password", "pin"], passwordSecrets: ["password"] });
        let bundle: SecretBundle | undefined;
        class SeedingClient extends SiteClient {
            override get canSeedSecrets(): boolean {
                return true;
            }
            override async seedSecrets(b: SecretBundle): Promise<void> {
                bundle = b;
            }
            override async clearSecrets(): Promise<void> {}
        }
        // `--secret password=… --password pin=…`: the scenario's `password` marking stays.
        await runGoal(
            { scenario: "cart", saveAs: "cart", explore: true, secrets: { password: "pw", pin: "1234" }, passwords: ["pin"] },
            config,
            new SeedingClient(site(), "login"),
            {},
            undefined,
            { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
        );
        expect(bundle?.secrets.map((x: { name: string; type: string }): [string, string] => [x.name, x.type]).sort()).toEqual([
            ["password", "login-credentials"],
            ["pin", "login-credentials"],
        ]);
        expect([...(new ScenarioStore(dir).get("cart").passwordSecrets ?? [])].sort()).toEqual(["password", "pin"]);
    });

    it("does not count a run refused for its secrets as a use of the recording", async (): Promise<void> => {
        await runGoal({ ...spec, saveAs: "cart" }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"]),
        });
        const file: string = join(cacheDir, "cart.json");
        const usedBefore: string = (JSON.parse(readFileSync(file, "utf-8")) as { entries: Array<{ lastUsedAt: string }> }).entries[0].lastUsedAt;
        await new Promise<void>((resolve: () => void): void => {
            setTimeout(resolve, 5);
        });
        await expect(
            runGoal({ scenario: "cart" }, config, new SiteClient(site(), "login"), {}, undefined, { engine: scriptedEngine([]) })
        ).rejects.toThrow(/needs the secret\(s\) password/);
        const usedAfter: string = (JSON.parse(readFileSync(file, "utf-8")) as { entries: Array<{ lastUsedAt: string }> }).entries[0].lastUsedAt;
        expect(usedAfter).toBe(usedBefore);
    });

    it("does not save a run whose review finds a critical problem, and names it", async (): Promise<void> => {
        const client: SiteClient = new SiteClient(site(), "login");
        client.requests = [
            { method: "POST", url: "https://site.test/api/cart", resourceType: "fetch", status: 500, body: "{}", timestamp: Date.now() + 1_000 },
        ];
        const outcome: RunOutcome = await runGoal({ ...spec, saveAs: "cart" }, config, client, {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"], "Your cart: Sony headphones", Severity.CRITICAL),
        });
        expect(outcome.result.status).toBe(RunStatus.DONE);
        expect(outcome.analysis?.verdict).toBe(Verdict.FAILED);
        expect(outcome.analysis?.findings[0]).toMatchObject({ severity: Severity.CRITICAL, title: "POST /api/cart → 500" });
        expect(outcome.recordingSaved).toBe(false);
        // The scenario was saved explicitly (`saveAs`); only its recording is not cached.
        expect(new ScenarioStore(dir).exists("cart")).toBe(true);
        expect(cached("cart")).toBeUndefined();
    });

    it("does not cache a recording when nothing reviewed the run", async (): Promise<void> => {
        // A failed request gives the review an anomaly to judge; the engine is unreachable by then.
        const client: SiteClient = new SiteClient(site(), "login");
        client.requests = [
            { method: "POST", url: "https://site.test/api/cart", resourceType: "fetch", status: 500, body: "{}", timestamp: Date.now() + 1_000 },
        ];
        const outcome: RunOutcome = await runGoal({ ...spec, saveAs: "cart" }, config, client, {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"], "Your cart: Sony headphones", Severity.NONE, true),
        });
        expect(outcome.result.status).toBe(RunStatus.DONE);
        expect(outcome.analysis).toBeUndefined();
        expect(outcome.analysisError).toMatch(/engine unreachable/);
        expect(outcome.recordingSaved).toBe(false);
        expect(cached("cart")).toBeUndefined();
    });

    it("warns, and keeps the verdict, when the recording cache cannot be written", async (): Promise<void> => {
        const blocked: string = join(cacheDir, "not-a-dir");
        writeFileSync(blocked, "a file where the cache directory should be");
        const warnings: string[] = [];
        const outcome: RunOutcome = await runGoal(
            { ...spec, saveAs: "cart" },
            { ...config, cacheDir: blocked },
            new SiteClient(site(), "login"),
            {
                onWarning: (m: string): void => {
                    warnings.push(m);
                },
            },
            undefined,
            { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
        );
        expect(outcome.result.status).toBe(RunStatus.DONE);
        expect(outcome.analysis?.verdict).toBe(Verdict.PASSED);
        expect(outcome.recordingSaved).toBe(false);
        expect(warnings).toEqual([expect.stringMatching(/recording cache .* could not be written/)]);
    });

    it("warns when secrets could not be extended to a frame's host, and goes on with the binding as it was", async (): Promise<void> => {
        const bundles: SecretBundle[] = [];
        class FailingSeedClient extends SiteClient {
            override get canSeedSecrets(): boolean {
                return true;
            }
            override async seedSecrets(b: SecretBundle): Promise<void> {
                if (b.secrets.some((x): boolean => x.boundOrigins.includes("pay.test")) && bundles.length === 1) {
                    bundles.push(b);
                    throw new Error("daemon refused the bundle");
                }
                bundles.push(b);
            }
            override async clearSecrets(): Promise<void> {}
        }
        const framed: Record<string, SitePage> = site();
        framed.products.controls = [...framed.products.controls, control(90, "textbox", "Card PIN", [ControlOperation.FILL], { frame: "pay.test" })];
        const warnings: string[] = [];
        const outcome: RunOutcome = await runGoal(
            { ...spec, secrets: { password: "pw", pin: "1234" } },
            { ...config, daemon: { ...config.daemon, iframes: true } },
            new FailingSeedClient(framed, "login"),
            {
                onWarning: (m: string): void => {
                    warnings.push(m);
                },
            },
            undefined,
            { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
        );
        expect(outcome.result.status).toBe(RunStatus.DONE);
        expect(warnings).toEqual([expect.stringMatching(/secrets were not extended to pay\.test: daemon refused the bundle/)]);
        // Extended once (refused), then re-seeded as before; not tried on every snapshot after that.
        expect(bundles).toHaveLength(3);
        expect(bundles[2].secrets.every((x): boolean => !x.boundOrigins.includes("pay.test"))).toBe(true);
    });

    it("closes the platform session with the error when the run throws", async (): Promise<void> => {
        const batches: Array<Array<Record<string, any>>> = [];
        const fetchSpy: jest.SpyInstance = jest.spyOn(global, "fetch").mockImplementation((async (_url: string, init: RequestInit): Promise<Response> => {
            batches.push(JSON.parse(String(init.body)));
            return new Response("{}", { status: 202 });
        }) as typeof fetch);
        class BrokenSite extends SiteClient {
            override async navigate(): Promise<number> {
                throw new Error("the browser is gone");
            }
        }
        const reported: FastConfig = { ...config, ironbee: { ...config.ironbee, apiKey: "k", enabled: true, collectorUrl: "https://c.test", apiUrl: "https://a.test" } };
        try {
            await expect(
                runGoal({ ...spec, record: true }, reported, new BrokenSite(site(), "login"), {}, undefined, { engine: scriptedEngine(["Login"]) })
            ).rejects.toThrow(/browser is gone/);
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
            expect(events[3].verdict).toEqual({ status: "fail", issues: ["the browser is gone"] });
            expect(events[4].reason).toBe("error: the browser is gone");
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("tells how the final sends went, and warns once, when the platform rejects them", async (): Promise<void> => {
        let calls: number = 0;
        const fetchSpy: jest.SpyInstance = jest.spyOn(global, "fetch").mockImplementation(async (): Promise<Response> => {
            // The opening batch lands; the verdict does not.
            calls++;
            return new Response("{}", { status: calls === 1 ? 202 : 401 });
        });
        class QuietSite extends SiteClient {
            override async call<T>(tool: string, input: Record<string, unknown>): Promise<T> {
                if (tool === "o11y_get-trace") {
                    return { count: 1, services: [{ name: "frontend", spanCount: 1, errorCount: 0 }], spans: [] } as T;
                }
                if (tool === "o11y_get-trace-logs") {
                    return { logs: [] } as T;
                }
                return super.call<T>(tool, input);
            }
        }
        const reported: FastConfig = { ...config, ironbee: { ...config.ironbee, apiKey: "k", enabled: true, collectorUrl: "https://c.test", apiUrl: "https://a.test" } };
        const warnings: string[] = [];
        try {
            const outcome: RunOutcome = await runGoal(
                spec,
                reported,
                new QuietSite(site(), "login"),
                {
                    onWarning: (m: string): void => {
                        warnings.push(m);
                    },
                },
                undefined,
                { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
            );
            expect(outcome.result.status).toBe(RunStatus.DONE);
            expect(outcome.platform?.reportError).toMatch(/401/);
            expect(warnings).toEqual(["IronBee platform rejected run events: HTTP 401"]);
        } finally {
            fetchSpy.mockRestore();
        }
    }, 30_000);

    it("masks a secret's encoded forms in the evidence and the trace read after the run", async (): Promise<void> => {
        // The read comes after DevTools' secrets are cleared (or from a daemon that never held them):
        // a form body carries the value url-encoded, a span attribute JSON-escaped.
        const secret: string = 'p@ss "w0rd"';
        const fetchSpy: jest.SpyInstance = jest
            .spyOn(global, "fetch")
            .mockImplementation(async (): Promise<Response> => new Response("{}", { status: 200 }));
        class LeakySite extends SiteClient {
            override async call<T>(tool: string, input: Record<string, unknown>): Promise<T> {
                if (tool === "o11y_get-trace") {
                    return {
                        count: 1,
                        services: [{ name: "frontend", spanCount: 1, errorCount: 0 }],
                        spans: [{ spanId: "a", name: "POST /api/login", serviceName: "frontend", attributes: { "http.request.body": '{"password":"p@ss \\"w0rd\\""}' } }],
                    } as T;
                }
                if (tool === "o11y_get-trace-logs") {
                    return { logs: [] } as T;
                }
                return super.call<T>(tool, input);
            }
        }
        const client: LeakySite = new LeakySite(site(), "login");
        client.requests = [
            { method: "POST", url: "https://site.test/api/login", resourceType: "xhr", status: 200, requestBody: "password=p%40ss+%22w0rd%22", timestamp: Date.now() },
        ];
        const traced: FastConfig = { ...config, ironbee: { ...config.ironbee, apiKey: "k", enabled: true, collectorUrl: "https://c.test", apiUrl: "https://a.test" } };
        try {
            const outcome: RunOutcome = await runGoal(
                { ...spec, secrets: { password: secret } },
                traced,
                client,
                {},
                undefined,
                { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
            );
            expect(outcome.result.status).toBe(RunStatus.DONE);
            expect(outcome.requests?.[0].requestBody).toBe("password=[secret:password]");
            const trace: string = JSON.stringify(outcome.trace);
            expect(trace).toContain("[secret:password]");
            expect(trace).not.toContain("w0rd");
        } finally {
            fetchSpy.mockRestore();
        }
    }, 30_000);

    it("says a cancelled replay was stopped, not that the engine could not take over", async (): Promise<void> => {
        await runGoal({ ...spec, saveAs: "cart" }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine(["Login", "Sony", "Cart"]),
        });
        expect(cached("cart")).toBeDefined();
        const abort: AbortController = new AbortController();
        abort.abort();
        const outcome: RunOutcome = await runGoal({ scenario: "cart", secrets: { password: "pw" } }, config, new SiteClient(site(), "login"), {}, abort.signal, {
            engine: scriptedEngine([]),
        });
        expect(outcome.result.status).toBe(RunStatus.CANCELLED);
        expect(outcome.result.reason).toBe("replay diverged at recorded step 1: stopped by the caller");
    });

    it("rejects a DONE the evidence does not bear out, and fails the run when it never does", async (): Promise<void> => {
        const outcome: RunOutcome = await runGoal({ ...spec }, config, new SiteClient(site(), "login"), {}, undefined, {
            engine: scriptedEngine(["Login"], "never on the page"),
        });
        expect(outcome.result.status).toBe(RunStatus.FAILED);
        expect(outcome.result.steps.filter((st): boolean => st.operation === "DONE" && !st.executed)).toHaveLength(3);
        expect(outcome.analysis?.verdict).toBe(Verdict.FAILED);
    });

    it("reads the trace for every run, and hands the review over later when deferred", async (): Promise<void> => {
        const fetchSpy: jest.SpyInstance = jest
            .spyOn(global, "fetch")
            .mockImplementation(async (): Promise<Response> => new Response("{}", { status: 200 }));
        class TracedSite extends SiteClient {
            override async call<T>(tool: string, input: Record<string, unknown>): Promise<T> {
                if (tool === "o11y_get-trace") {
                    return { count: 3, services: [{ name: "frontend", spanCount: 3, errorCount: 0 }], spans: [] } as T;
                }
                if (tool === "o11y_get-trace-logs") {
                    return { logs: [{ serviceName: "cart-service", severityText: "INFO", severityNumber: 9, body: "cart updated" }] } as T;
                }
                return super.call<T>(tool, input);
            }
        }
        const traced: FastConfig = {
            ...config,
            ironbee: { ...config.ironbee, apiKey: "k", enabled: true, collectorUrl: "https://c.test", apiUrl: "https://a.test" },
        };
        try {
            const outcome: RunOutcome = await runGoal(
                { ...spec, deferReview: true },
                traced,
                new TracedSite(site(), "login"),
                {},
                undefined,
                { engine: scriptedEngine(["Login", "Sony", "Cart"]) }
            );
            expect(outcome.result.status).toBe(RunStatus.DONE);
            expect(outcome.trace).toBeUndefined();
            const later = await outcome.reviewReady!;
            expect(later.trace?.spanCount).toBe(3);
            expect(later.trace?.logs.map((l): string => l.body)).toEqual(["cart updated"]);
            expect(later.analysis?.verdict).toBe(Verdict.PASSED);
        } finally {
            fetchSpy.mockRestore();
        }
    }, 30_000);
});
