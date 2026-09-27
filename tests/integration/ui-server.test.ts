/**
 * The UI server end to end, hermetic: a fake DevTools daemon and a fake
 * System One engine on loopback. Covers the HTTP guards, the config view, a
 * full run started over the API and observed over the viewer websocket, and
 * that secret values never reach a viewer.
 */

import { mkdtempSync, writeFileSync } from "fs";
import { createServer, IncomingMessage, request, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { FastConfig, loadConfig } from "../../src/config/config";
import { startUiServer, UiServerHandle } from "../../src/server/ui-server";
import { answer, LOGIN_CONTROLS, snapshot } from "../helpers/fixtures";

async function listen(handler: (req: IncomingMessage, body: any, res: ServerResponse) => void): Promise<Server> {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
        let raw: string = "";
        req.on("data", (c: Buffer): void => {
            raw += c.toString();
        });
        req.on("end", (): void => handler(req, raw ? JSON.parse(raw) : {}, res));
    });
    await new Promise<void>((resolve: () => void): void => {
        server.listen(0, "127.0.0.1", (): void => resolve());
    });
    return server;
}

function portOf(server: Server): number {
    return (server.address() as AddressInfo).port;
}

function json(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

async function freePort(): Promise<number> {
    const s: Server = await listen((): void => {});
    const port: number = portOf(s);
    await new Promise<void>((resolve: () => void): void => {
        s.close((): void => resolve());
    });
    return port;
}

describe("UI server", (): void => {
    let daemon: Server;
    let engine: Server;
    let ui: UiServerHandle;
    let base: string;
    const calls: Array<{ toolName: string; toolInput: any }> = [];

    beforeAll(async (): Promise<void> => {
        daemon = await listen((req: IncomingMessage, body: any, res: ServerResponse): void => {
            if (req.url === "/health") {
                json(res, { status: "ok" });
                return;
            }
            if (req.method === "DELETE") {
                json(res, {});
                return;
            }
            calls.push(body);
            switch (body.toolName) {
                case "control_take-snapshot":
                    json(res, { toolOutput: snapshot(calls.length, LOGIN_CONTROLS, { text: "Hint: pw-SECRET-1" }) });
                    return;
                case "control_act":
                    json(res, {
                        toolOutput: {
                            executed: true,
                            snapshot: snapshot(calls.length, [], { url: "https://shop.test/home", text: "Welcome" }),
                        },
                    });
                    return;
                default:
                    json(res, { toolOutput: {} });
            }
        });
        let decisions: number = 0;
        engine = await listen((_req: IncomingMessage, body: any, res: ServerResponse): void => {
            if (!body.questions) {
                // The run opens the connection ahead of the first question (a bodiless HEAD).
                json(res, {});
                return;
            }
            if (!body.questions.operation) {
                // The goal judgement at DONE, and the review: done, nothing wrong.
                const answers: Record<string, unknown> = { goal_state: answer("done", ["done", "not-yet", "failed"]) };
                for (const id of Object.keys(body.questions).filter((k: string): boolean => k.startsWith("issue_"))) {
                    answers[id] = answer("none", ["none", "minor", "major", "critical"]);
                }
                json(res, { answers });
                return;
            }
            decisions++;
            const ops: string[] = Object.keys(body.questions.operation.criteria);
            if (decisions === 1) {
                json(res, {
                    answers: {
                        operation: answer("TYPE_TEXT", ops),
                        type_text_target: answer("5", Object.keys(body.questions.type_text_target.criteria)),
                        text_value: answer("secret:password", Object.keys(body.questions.text_value.criteria)),
                    },
                });
            } else {
                json(res, { answers: { operation: answer("DONE", ops) } });
            }
        });
        // The recording cache "directory" is a file: a saved scenario's passing run cannot cache, and warns.
        const dir: string = mkdtempSync(join(tmpdir(), "ibexpress-ui-"));
        writeFileSync(join(dir, "cache"), "");
        const config: FastConfig = loadConfig({
            TYPESAFE_API_KEY: "k",
            TYPESAFE_URL: `http://127.0.0.1:${portOf(engine)}/v1/systemone`,
            IRONBEE_DEVTOOLS_DAEMON_URL: `http://127.0.0.1:${portOf(daemon)}`,
            IBEXPRESS_UI_PORT: String(await freePort()),
            IBEXPRESS_SCENARIO_DIR: join(dir, "scenarios"),
            IBEXPRESS_CACHE_DIR: join(dir, "cache"),
        });
        ui = await startUiServer(config);
        base = ui.url;
    });

    afterAll(async (): Promise<void> => {
        await ui.close();
        daemon.close();
        engine.close();
    });

    it("serves the UI only under its own host", async (): Promise<void> => {
        expect((await fetch(`${base}/`)).status).toBe(200);
        // fetch cannot set Host; a raw request can (as a DNS-rebinding page would arrive).
        const status: number = await new Promise<number>((resolve: (s: number) => void): void => {
            const url: URL = new URL(`${base}/api/config`);
            request({ host: url.hostname, port: url.port, path: url.pathname, headers: { host: "evil.test" } }, (res: IncomingMessage): void => {
                res.resume();
                resolve(res.statusCode ?? 0);
            }).end();
        });
        expect(status).toBe(421);
    });

    it("reports the engine, IronBee, text-model providers and the live-view state", async (): Promise<void> => {
        const view: any = await (await fetch(`${base}/api/config`)).json();
        expect(view.engine).toMatchObject({ name: "Jev", ok: true });
        expect(view.ironbee.ok).toBe(false);
        expect(view.textProviders.map((p: { provider: string; ok: boolean }): string => `${p.provider}:${p.ok}`)).toEqual([
            "anthropic:false",
            "openai:false",
            "openrouter:false",
            "claude-code:false",
            "codex:false",
        ]);
        expect(view.defaultTextModel).toBe("none");
        expect(view.liveView).toBe(false);
    });

    it("refuses cross-origin and non-JSON posts", async (): Promise<void> => {
        const cross: Response = await fetch(`${base}/api/runs`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: "http://evil.test" },
            body: JSON.stringify({ goal: "x" }),
        });
        expect(cross.status).toBe(403);
        const form: Response = await fetch(`${base}/api/runs`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "goal=x",
        });
        expect(form.status).toBe(415);
    });

    it("refuses a scenario name it cannot store with the naming rule, not a bare not-found", async (): Promise<void> => {
        const saved: Response = await fetch(`${base}/api/scenarios/my%20test`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: "x", url: "https://shop.test/" }),
        });
        expect(saved.status).toBe(400);
        expect(((await saved.json()) as { error: string }).error).toMatch(/Invalid scenario name/);
        const cleared: Response = await fetch(`${base}/api/scenarios/my%20test/cache`, { method: "DELETE" });
        expect(cleared.status).toBe(400);
        // A malformed percent-escape is refused as the request's fault on every scenario route.
        for (const path of ["/api/scenarios/%E0%A4%A/cache", "/api/scenarios/%E0%A4%A"]) {
            expect((await fetch(`${base}${path}`, { method: "DELETE" })).status).toBe(400);
        }
    });

    it("runs a goal over the API and streams it to viewers without secret values", async (): Promise<void> => {
        const ws: WebSocket = new WebSocket(`${base.replace("http", "ws")}/ws`, { origin: base });
        const messages: any[] = [];
        const finished: Promise<any> = new Promise<any>((resolve: (m: any) => void): void => {
            ws.on("message", (data: WebSocket.RawData): void => {
                const message: any = JSON.parse(String(data));
                messages.push(message);
                if (message.type === "run" && message.run.phase === "finished") {
                    resolve(message.run);
                }
            });
        });
        await new Promise<void>((resolve: () => void): void => {
            ws.once("open", (): void => resolve());
        });
        const started: Response = await fetch(`${base}/api/runs`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: base },
            body: JSON.stringify({
                goal: "Log in",
                url: "https://shop.test/login",
                values: [{ name: "password", value: "pw-SECRET-1", secret: true }],
            }),
        });
        expect(started.status).toBe(202);
        const run: any = await finished;
        ws.close();

        expect(run.result.status).toBe("done");
        expect(run.analysis).toMatchObject({ verdict: "passed", goal: { achieved: true } });
        expect(run.steps.map((s: { operation: string }): string => s.operation)).toEqual(["TYPE_TEXT", "DONE"]);
        expect(run.steps[0].text).toBe("<secret password>");
        // The value reached the browser, and nothing a viewer received carries it.
        const fill: any = calls.find((c: any): boolean => c.toolName === "control_act");
        expect(fill.toolInput.value).toBe("pw-SECRET-1");
        expect(JSON.stringify(messages)).not.toContain("pw-SECRET-1");
        // The run was recorded (start + stop), so a live-view daemon would stream it.
        expect(calls.map((c: any): string => c.toolName)).toEqual(
            expect.arrayContaining(["content_start-recording", "content_stop-recording"])
        );
    });

    it("keeps a run's warnings on its record and sends them as they come", async (): Promise<void> => {
        const ws: WebSocket = new WebSocket(`${base.replace("http", "ws")}/ws`, { origin: base });
        const warnings: any[] = [];
        const finished: Promise<any> = new Promise<any>((resolve: (m: any) => void): void => {
            ws.on("message", (data: WebSocket.RawData): void => {
                const message: any = JSON.parse(String(data));
                if (message.type === "warning") {
                    warnings.push(message);
                }
                if (message.type === "run" && message.run.phase === "finished") {
                    resolve(message.run);
                }
            });
        });
        await new Promise<void>((resolve: () => void): void => {
            ws.once("open", (): void => resolve());
        });
        const started: Response = await fetch(`${base}/api/runs`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: base },
            body: JSON.stringify({ goal: "Log in", url: "https://shop.test/login", saveAs: "warned" }),
        });
        expect(started.status).toBe(202);
        const run: any = await finished;
        ws.close();

        expect(run.analysis?.verdict).toBe("passed");
        expect(run.recordingSaved).toBe(false);
        expect(warnings).toEqual([{ type: "warning", id: run.id, message: expect.stringContaining("recording cache") }]);
        // A viewer connecting later reads the same warning off the record.
        const view: any = await (await fetch(`${base}/api/runs`)).json();
        const listed: any = view.runs.find((r: any): boolean => r.id === run.id);
        expect(listed.warnings).toEqual([warnings[0].message]);
        expect(listed.phaseDetail).not.toContain("recording cache");
    });

    it("starts one run for two requests in flight at once", async (): Promise<void> => {
        const post: () => Promise<Response> = (): Promise<Response> =>
            fetch(`${base}/api/runs`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: base },
                body: JSON.stringify({ goal: "Log in", url: "https://shop.test/login" }),
            });
        const statuses: number[] = (await Promise.all([post(), post()])).map((r: Response): number => r.status).sort();
        expect(statuses).toEqual([202, 409]);
        // Let it finish before the server closes.
        for (let i: number = 0; i < 200; i++) {
            const view: any = await (await fetch(`${base}/api/runs`)).json();
            if (view.currentId === undefined) {
                return;
            }
            await new Promise<void>((resolve: () => void): void => {
                setTimeout(resolve, 50);
            });
        }
        throw new Error("the run did not finish");
    });
});
