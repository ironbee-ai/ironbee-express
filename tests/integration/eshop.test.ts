/**
 * Live runs against https://eshop.demo.ironbee.dev through a real DevTools
 * daemon. Skipped unless IBEXPRESS_E2E_DAEMON_URL points at one.
 *
 * - The scripted run replaces the engine with a fixed script: it exercises the
 *   DevTools tools, the executor, the guards and the loop — everything but the model.
 * - With IBEXPRESS_E2E_ENGINE=jev (and that engine configured in the
 *   environment) the same goal also runs with the real engine, which also
 *   reviews it.
 *
 *   IBEXPRESS_E2E_DAEMON_URL=http://127.0.0.1:2099 npx jest tests/integration/eshop
 */

import { Agent, RunResult, RunStatus, StepEvent } from "../../src/agent/agent";
import { Operation } from "../../src/agent/policy";
import { Verdict } from "../../src/verify";
import { FastConfig, loadConfig } from "../../src/config/config";
import { DevtoolsClient } from "../../src/devtools/client";
import { RunOutcome, runGoal } from "../../src/run/runner";
import { buildTextChoices, SuppliedValuesSource } from "../../src/text/candidates";
import { named, ScriptedDecider } from "../helpers/scripted-decider";

const DAEMON_URL: string | undefined = process.env.IBEXPRESS_E2E_DAEMON_URL;
const ENGINE: string | undefined = process.env.IBEXPRESS_E2E_ENGINE;
const SHOP: string = "https://eshop.demo.ironbee.dev/";
const GOAL: string = "Log in and put the Sony headphones in the cart, then open the cart";
const describeLive: jest.Describe = DAEMON_URL ? describe : describe.skip;

jest.setTimeout(120_000);

describeLive("eshop (live)", (): void => {
    it("scripted: logs in, adds the Sony headphones and opens the cart", async (): Promise<void> => {
        const client: DevtoolsClient = new DevtoolsClient({ baseUrl: DAEMON_URL! });
        const secrets: Record<string, string> = { password: "demo123" };
        try {
            const result: RunResult = await new Agent({
                client,
                decider: new ScriptedDecider([
                    { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "value:email" },
                    { operation: Operation.TYPE_TEXT, target: named("Password"), textKey: "secret:password" },
                    { operation: Operation.PRESS_ENTER, target: named("Password") },
                    {
                        operation: Operation.CLICK,
                        target: named("Add to cart", "Sony"),
                        when: (input: { snapshot: { url: string } }): boolean =>
                            new URL(input.snapshot.url).pathname.startsWith("/products"),
                    },
                    { operation: Operation.CLICK, target: named("Cart") },
                    {
                        operation: Operation.DONE,
                        when: (input: { snapshot: { url: string } }): boolean =>
                            new URL(input.snapshot.url).pathname.startsWith("/cart"),
                    },
                ]),
                goal: GOAL,
                url: SHOP,
                text: {
                    choices: buildTextChoices(
                        GOAL,
                        [new SuppliedValuesSource({ email: "demo@example.com" }, secrets)],
                        false,
                        secrets
                    ),
                    secrets,
                },
            }).run();
            expect(result.status).toBe(RunStatus.DONE);
            expect(result.finalSnapshot.url).toMatch(/\/cart/);
            expect(result.finalSnapshot.text).toMatch(/Sony WH-1000XM5/);
        } finally {
            await client.close();
        }
    });

    (ENGINE ? it : it.skip)(`engine ${ENGINE ?? ""}: the same goal, verified`, async (): Promise<void> => {
        const config: FastConfig = loadConfig();
        const client: DevtoolsClient = new DevtoolsClient({ baseUrl: DAEMON_URL! });
        const steps: string[] = [];
        try {
            const outcome: RunOutcome = await runGoal(
                {
                    goal: GOAL,
                    url: SHOP,
                    values: { email: "demo@example.com" },
                    secrets: { password: "demo123" },
                },
                config,
                client,
                {
                    onStep: (e: StepEvent): void => {
                        steps.push(`${e.operation} ${e.target ?? ""} ${e.executed ? "" : e.reason ?? ""}`);
                    },
                }
            );
            console.log(`${outcome.engine}: ${outcome.result.status} in ${outcome.result.elapsedMs} ms\n${steps.join("\n")}`);
            expect(outcome.result.status).toBe(RunStatus.DONE);
            expect(outcome.analysis?.goal.achieved).toBe(true);
            expect(outcome.analysis?.verdict).toBe(Verdict.PASSED);
        } finally {
            await client.close();
        }
    });
});
