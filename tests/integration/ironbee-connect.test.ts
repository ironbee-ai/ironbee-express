/**
 * "Connect IronBee" end to end over HTTP, with the IronBee console played by
 * the test: the UI asks for a sign-in URL, the console's redirect lands on the
 * callback, the login is saved in the shared config file and used at once;
 * sign-out removes it. Plus the guards: a state this server did not issue, a
 * cross-origin request, and a credential the environment sets.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { AddressInfo } from "net";
import { createServer, Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { FastConfig, loadConfig } from "../../src/config/config";
import { startUiServer, UiServerHandle } from "../../src/server/ui-server";

async function freePort(): Promise<number> {
    const s: Server = createServer();
    await new Promise<void>((resolve: () => void): void => {
        s.listen(0, "127.0.0.1", resolve);
    });
    const port: number = (s.address() as AddressInfo).port;
    await new Promise<void>((resolve: () => void): void => {
        s.close((): void => resolve());
    });
    return port;
}

async function start(env: NodeJS.ProcessEnv): Promise<UiServerHandle> {
    const config: FastConfig = loadConfig({
        TYPESAFE_API_KEY: "k",
        // Never contacted here: these routes do not run anything.
        IRONBEE_DEVTOOLS_DAEMON_URL: "http://127.0.0.1:9",
        IBEXPRESS_UI_PORT: String(await freePort()),
        ...env,
    });
    return startUiServer(config);
}

const post: (url: string, origin?: string) => Promise<Response> = (url: string, origin?: string): Promise<Response> =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: "{}" });

describe("Connect IronBee", (): void => {
    let dir: string;
    let file: string;
    let ui: UiServerHandle;

    beforeAll(async (): Promise<void> => {
        dir = mkdtempSync(join(tmpdir(), "ibexpress-connect-"));
        file = join(dir, ".ironbee", "config.json");
        ui = await start({ IBEXPRESS_IRONBEE_CONFIG: file, IRONBEE_DOMAIN: "ironbee.dev" });
    });

    afterAll(async (): Promise<void> => {
        await ui.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const view: () => Promise<any> = async (): Promise<any> => (await (await fetch(`${ui.url}/api/config`)).json()).ironbee;

    it("offers to connect when no login is set", async (): Promise<void> => {
        expect(await view()).toMatchObject({ ok: false, canConnect: true, domain: "ironbee.dev", consoleUrl: "https://console.ironbee.dev" });
    });

    it("signs in through the console's cli-auth, saves the login and uses it at once; signs out", async (): Promise<void> => {
        const res: Response = await post(`${ui.url}/api/ironbee/connect`);
        expect(res.status).toBe(200);
        const { url }: { url: string } = await res.json();
        const login: URL = new URL(url);
        expect(login.searchParams.get("client")).toBe("IronBee Express");
        expect(login.origin + login.pathname).toBe("https://console.ironbee.dev/cli-auth");
        const callback: URL = new URL(login.searchParams.get("callback")!);
        expect(callback.hostname).toBe("127.0.0.1");
        expect(callback.pathname).toBe("/api/ironbee/callback");

        // The console's redirect, as the browser follows it.
        callback.searchParams.set("state", login.searchParams.get("state")!);
        callback.searchParams.set("access_token", "ibt_from_console");
        const landed: Response = await fetch(callback.href.replace(`127.0.0.1:${callback.port}`, new URL(ui.url).host));
        expect(landed.status).toBe(200);
        expect(landed.headers.get("referrer-policy")).toBe("no-referrer");
        expect(await landed.text()).toContain("Connected to IronBee");

        expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ service: { oauthToken: "ibt_from_console", domain: "ironbee.dev" } });
        expect(await view()).toMatchObject({ ok: true, source: "file", canConnect: true });

        expect((await post(`${ui.url}/api/ironbee/disconnect`)).status).toBe(200);
        expect(JSON.parse(readFileSync(file, "utf-8")).service.oauthToken).toBeUndefined();
        expect(await view()).toMatchObject({ ok: false, canConnect: true });
    });

    it("refuses a callback with a state it did not issue, saving nothing", async (): Promise<void> => {
        rmSync(file, { force: true });
        const res: Response = await fetch(`${ui.url}/api/ironbee/callback?state=forged&access_token=ibt_attacker`);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("Could not connect to IronBee");
        expect(existsSync(file)).toBe(false);
        expect((await view()).ok).toBe(false);
    });

    it("shows the console's error on the callback page", async (): Promise<void> => {
        const { url }: { url: string } = await (await post(`${ui.url}/api/ironbee/connect`)).json();
        const state: string = new URL(url).searchParams.get("state")!;
        const res: Response = await fetch(`${ui.url}/api/ironbee/callback?state=${state}&error=token_limit_exceeded`);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain("maximum number of access tokens");
    });

    it("starts a sign-in only for its own pages", async (): Promise<void> => {
        expect((await post(`${ui.url}/api/ironbee/connect`, "https://evil.test")).status).toBe(403);
    });

    it("leaves a credential from the environment alone", async (): Promise<void> => {
        const fromEnv: UiServerHandle = await start({ IBEXPRESS_IRONBEE_CONFIG: file, IRONBEE_API_KEY: "k-env", IRONBEE_DOMAIN: "ironbee.dev" });
        try {
            const ironbee: any = (await (await fetch(`${fromEnv.url}/api/config`)).json()).ironbee;
            expect(ironbee).toMatchObject({ ok: true, source: "env", canConnect: false });
            expect((await post(`${fromEnv.url}/api/ironbee/connect`)).status).toBe(409);
            expect((await post(`${fromEnv.url}/api/ironbee/disconnect`)).status).toBe(409);
        } finally {
            await fromEnv.close();
        }
    });
});
