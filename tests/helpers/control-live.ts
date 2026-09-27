/**
 * Shared pieces of the live control-tool suites (tests/integration/control):
 * a real DevTools daemon with the control-tools plugin, a local site that
 * serves each test's page, and a session that drives `control_take-snapshot`
 * / `control_act` over the daemon — and reaches into the page, where a test
 * must, through DevTools' `execute` tool (the Playwright `page` is in scope).
 *
 * Skipped unless IBEXPRESS_E2E_DAEMON_SCRIPT points at a daemon-server.js
 * (and the plugin is built: `npm run build`).
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { DevtoolsClient } from "../../src/devtools/client";
import { DaemonHandle, ensureDaemon, freePort } from "../../src/devtools/daemon";
import { ActRequest, ActResult, Control, ControlAction, ControlSnapshot } from "../../src/devtools/types";

export const DAEMON_SCRIPT: string | undefined = process.env.IBEXPRESS_E2E_DAEMON_SCRIPT;

/** An `ActRequest` whose action may be spelled by its wire value (`"click"`), as the tests write them. */
export type ActCall = Omit<ActRequest, "action"> & { action: ControlAction | `${ControlAction}` };
export const describeLive: jest.Describe = DAEMON_SCRIPT ? describe : describe.skip;

/** DevTools' own multi-page fixture (the stale-ref pages), as its tests had them. */
const MPA_PAGES: Record<string, string> = {
    "/mpa/login": `<title>Login</title>
        <h1>Login</h1>
        <form action="/mpa/home" method="get">
            <label>Email <input name="email" type="email"></label>
            <label>Password <input name="password" type="password"></label>
            <button type="submit">Sign in</button>
        </form>
        <a href="/mpa/register">Register</a>`,
    "/mpa/register": `<title>Register</title>
        <h1>Register</h1>
        <label>First name <input name="first"></label>
        <label>Last name <input name="last"></label>
        <a href="/mpa/login">Login</a>`,
    "/mpa/home": `<title>Home</title>
        <h1>Home</h1>
        <p id="greeting">Welcome</p>
        <label>Search <input name="q"></label>
        <a href="/mpa/login">Logout</a>`,
};

/**
 * A local site: `/p/<n>` serves a page registered with `page()`, `/mpa/*` the
 * multi-page fixture and `/api/slow?ms=N` answers after N ms.
 */
export class FixtureSite {
    private readonly pages: Map<string, string> = new Map<string, string>();
    private next: number = 0;
    private readonly open: Set<ServerResponse> = new Set<ServerResponse>();

    private constructor(
        private readonly server: Server,
        /** `http://127.0.0.1:<port>` */
        readonly url: string
    ) {}

    static async start(): Promise<FixtureSite> {
        let site: FixtureSite | undefined;
        const server: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
            site!.handle(req, res);
        });
        await new Promise<void>((resolve: () => void): void => {
            server.listen(0, "127.0.0.1", resolve);
        });
        site = new FixtureSite(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        return site;
    }

    get port(): number {
        return (this.server.address() as AddressInfo).port;
    }

    /** `host:port` of the site — how a secret is bound to it. */
    get host(): string {
        return new URL(this.url).host;
    }

    /** Serves `html` (a body; a `<title>` in it is kept) at a fresh URL, returned. */
    page(html: string): string {
        const path: string = `/p/${++this.next}`;
        this.pages.set(path, html);
        return `${this.url}${path}`;
    }

    private handle(req: IncomingMessage, res: ServerResponse): void {
        const url: URL = new URL(req.url ?? "/", this.url);
        if (url.pathname === "/api/slow") {
            this.open.add(res);
            const timer: NodeJS.Timeout = setTimeout((): void => {
                this.open.delete(res);
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ value: "done" }));
            }, Number(url.searchParams.get("ms") ?? 0));
            res.on("close", (): void => {
                clearTimeout(timer);
                this.open.delete(res);
            });
            return;
        }
        const html: string | undefined = this.pages.get(url.pathname) ?? MPA_PAGES[url.pathname];
        if (html === undefined) {
            res.writeHead(404, { "content-type": "text/plain" }).end("not found");
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${html}</body></html>`);
    }

    async close(): Promise<void> {
        for (const res of this.open) {
            res.destroy();
        }
        await new Promise<void>((resolve: () => void): void => {
            this.server.close((): void => resolve());
            this.server.closeAllConnections();
        });
    }
}

/**
 * A daemon of this test file's own (a free port), with the plugin. `env`
 * overrides ensureDaemon's defaults (BROWSER_DIALOG_MODE=hold,
 * BROWSER_FOLLOW_NEW_TABS=true) and adds e.g. BROWSER_CONTROL_SNAPSHOT_FRAMES.
 */
export async function startLiveDaemon(env: Record<string, string> = {}): Promise<DaemonHandle> {
    const port: number = await freePort();
    return ensureDaemon({ port, headless: true, daemonScript: DAEMON_SCRIPT, env });
}

export interface ExecuteOutput {
    result?: unknown;
    error?: string;
}

export interface LoadOptions {
    waitUntil?: "load" | "domcontentloaded" | "commit";
}

/** One browser session (its own browser context) on the daemon. */
export class ControlSession {
    readonly client: DevtoolsClient;

    constructor(daemon: DaemonHandle) {
        this.client = new DevtoolsClient({ baseUrl: daemon.baseUrl, internalToken: daemon.internalToken });
    }

    /** Opens `url` without waiting for the network (a test's own slow request must not hold it). */
    async go(url: string, options: LoadOptions = {}): Promise<void> {
        await this.client.call("navigation_go-to", {
            url,
            includeSnapshot: false,
            waitForNavigation: false,
            waitUntil: options.waitUntil ?? "load",
        });
    }

    /** Serves `html` on `site`, opens it and returns its snapshot. */
    async load(site: FixtureSite, html: string, options: LoadOptions = {}): Promise<ControlSnapshot> {
        await this.go(site.page(html), options);
        return this.snapshot();
    }

    snapshot(): Promise<ControlSnapshot> {
        return this.client.call<ControlSnapshot>("control_take-snapshot", {});
    }

    /** `control_act`, typed as the agent sends it (the action by its wire value too). */
    act(input: ActCall): Promise<ActResult> {
        return this.client.call<ActResult>("control_act", input);
    }

    /** Clicks the control named `name` (with `context` in its context) of `snapshot`. */
    click(snapshot: ControlSnapshot, name: string, extra: Partial<ActCall> = {}, context?: string): Promise<ActResult> {
        return this.act({ action: "click", snapshotId: snapshot.snapshotId, controlId: find(snapshot, name, context).id, ...extra });
    }

    fill(snapshot: ControlSnapshot, name: string, value: string): Promise<ActResult> {
        return this.act({ action: "fill", snapshotId: snapshot.snapshotId, controlId: find(snapshot, name).id, value });
    }

    /**
     * Runs `code` (a function body; `page` and `args` in scope, `sleep(ms)`
     * too) in DevTools' `execute` sandbox and returns what it returns. What
     * comes back is masked like every tool output: a seeded secret's value
     * reads `[secret:name.field]`.
     */
    async page<T>(code: string, args: Record<string, unknown> = {}): Promise<T> {
        const out: ExecuteOutput = await this.client.call<ExecuteOutput>("execute", { code, args });
        if (out.error !== undefined) {
            throw new Error(`execute: ${out.error}`);
        }
        return out.result as T;
    }

    /** The value of the input `selector` matches (in the frame whose URL contains `frameUrl`, if given). */
    inputValue(selector: string, frameUrl?: string): Promise<string> {
        return this.page<string>(
            `const frame = args.frameUrl ? page.frames().find((f) => f.url().includes(args.frameUrl)) : page.mainFrame();
            return frame.inputValue(args.selector);`,
            { selector, frameUrl }
        );
    }

    /** Waits for `selector` in the frame whose URL contains `frameUrl` (it may not be attached yet). */
    waitInFrame(frameUrl: string, selector: string): Promise<void> {
        return this.page<void>(
            `for (let i = 0; i < 100; i++) {
                const frame = page.frames().find((f) => f.url().includes(args.frameUrl));
                if (frame) {
                    await frame.waitForSelector(args.selector, { timeout: 10000 });
                    return;
                }
                await sleep(50);
            }
            throw new Error("no frame " + args.frameUrl);`,
            { frameUrl, selector }
        );
    }

    /** Closes every tab but the active one. */
    closeOtherTabs(): Promise<void> {
        return this.page<void>(`for (const p of page.context().pages()) { if (p !== page) { await p.close(); } }`);
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

export function find(snapshot: ControlSnapshot, name: string, context?: string): Control {
    const control: Control | undefined = snapshot.controls.find(
        (c: Control): boolean => c.name === name && (context === undefined || (c.context ?? "").includes(context))
    );
    if (!control) {
        throw new Error(`No control "${name}" in ${JSON.stringify(snapshot.controls)}`);
    }
    return control;
}

export function named(snapshot: ControlSnapshot, name: string): Control | undefined {
    return snapshot.controls.find((c: Control): boolean => c.name === name);
}

export function names(snapshot: ControlSnapshot): string[] {
    return snapshot.controls.map((c: Control): string => c.name);
}

export function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, ms);
    });
}
