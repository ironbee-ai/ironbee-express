/**
 * A secret typed through a real DevTools daemon's secret registry, on a local
 * login page: the run seeds it, the agent types `{{secret:…}}`, DevTools puts
 * the value into the password field — and nothing the run reads back carries
 * it. Skipped unless IBEXPRESS_E2E_DAEMON_SCRIPT points at a daemon-server.js.
 *
 *   IBEXPRESS_E2E_DAEMON_SCRIPT=../ironbee-devtools/dist/daemon-server.js npx jest tests/integration/secrets
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { Agent, RunResult, RunStatus } from "../../src/agent/agent";
import { Operation } from "../../src/agent/policy";
import { DevtoolsClient } from "../../src/devtools/client";
import { DaemonHandle, ensureDaemon } from "../../src/devtools/daemon";
import { boundOriginOf, SeededSecrets, secretBundle } from "../../src/devtools/secrets";
import { buildTextChoices, SuppliedValuesSource } from "../../src/text/candidates";
import { named, ScriptedDecider } from "../helpers/scripted-decider";

const DAEMON_SCRIPT: string | undefined = process.env.IBEXPRESS_E2E_DAEMON_SCRIPT;
const describeLive: jest.Describe = DAEMON_SCRIPT ? describe : describe.skip;
const PASSWORD: string = "local-test-S3CRET";
const GOAL: string = "Sign in";

const PAGE: string = `<!doctype html><title>Sign in</title>
<form method="post" action="/login">
  <label>Email <input name="email"></label>
  <label>Password <input name="password" type="password"></label>
  <button>Sign in</button>
</form>`;

jest.setTimeout(120_000);

describeLive("secrets through the DevTools registry (live daemon)", (): void => {
    let site: Server;
    let siteUrl: string;
    let posted: string | undefined;
    let daemon: DaemonHandle;

    beforeAll(async (): Promise<void> => {
        site = createServer((req: IncomingMessage, res: ServerResponse): void => {
            if (req.method === "POST") {
                let body: string = "";
                req.on("data", (c: Buffer): void => {
                    body += c.toString();
                });
                req.on("end", (): void => {
                    posted = new URLSearchParams(body).get("password") ?? undefined;
                    res.writeHead(200, { "content-type": "text/html" }).end("<title>Welcome</title><h1>Signed in</h1>");
                });
                return;
            }
            res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
        });
        await new Promise<void>((resolve: () => void): void => {
            site.listen(0, "127.0.0.1", resolve);
        });
        siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
        const probe: Server = createServer();
        await new Promise<void>((resolve: () => void): void => {
            probe.listen(0, "127.0.0.1", resolve);
        });
        const port: number = (probe.address() as AddressInfo).port;
        probe.close();
        daemon = await ensureDaemon({ port, headless: true, daemonScript: DAEMON_SCRIPT });
    });

    afterAll(async (): Promise<void> => {
        await daemon?.stop();
        site?.close();
    });

    it("types the password by reference into the password field, and never reads it back", async (): Promise<void> => {
        expect(daemon.internalToken).toBeDefined();
        const client: DevtoolsClient = new DevtoolsClient({ baseUrl: daemon.baseUrl, internalToken: daemon.internalToken });
        const secrets: Record<string, string> = { password: PASSWORD };
        const seeded: SeededSecrets = secretBundle(secrets, {}, ["password"], boundOriginOf(siteUrl)!);
        await client.seedSecrets(seeded.bundle);
        try {
            const result: RunResult = await new Agent({
                client,
                decider: new ScriptedDecider([
                    { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "value:email" },
                    // Typed into the email field first: DevTools refuses, the run goes on.
                    { operation: Operation.TYPE_TEXT, target: named("Email"), textKey: "secret:password" },
                    { operation: Operation.TYPE_TEXT, target: named("Password"), textKey: "secret:password" },
                    { operation: Operation.CLICK, target: named("Sign in") },
                    { operation: Operation.DONE, when: (input: { snapshot: { title: string } }): boolean => input.snapshot.title === "Welcome" },
                ]),
                goal: GOAL,
                url: siteUrl,
                text: {
                    choices: buildTextChoices(
                        GOAL,
                        [new SuppliedValuesSource({ email: "a@b.test" }, secrets, {}, seeded.refs)],
                        false,
                        secrets
                    ),
                    secrets,
                },
            }).run();
            expect(result.status).toBe(RunStatus.DONE);
            expect(posted).toBe(PASSWORD);
            expect(result.steps[1].executed).toBe(false);
            expect(result.steps[1].reason).toMatch(/password/);
            expect(JSON.stringify(result)).not.toContain(PASSWORD);
        } finally {
            await client.clearSecrets();
            await client.close();
        }
    });
});
