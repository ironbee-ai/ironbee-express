import { CredentialSource, IronBeeConfig, reloadStoredCredential, resolveIronBeeConfig } from "../../../src/ironbee/config";
import { clearCredential, IronBeeLogin, LOGIN_TIMEOUT_MS, LoginCredential, LoginError, saveCredential } from "../../../src/ironbee/login";

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CALLBACK: string = "http://127.0.0.1:15986/api/ironbee/callback";

function stateOf(url: string): string {
    return new URL(url).searchParams.get("state")!;
}

describe("IronBeeLogin", (): void => {
    it("opens the console's cli-auth with the callback, a fresh state and the token's label", (): void => {
        const login: IronBeeLogin = new IronBeeLogin();
        const url: URL = new URL(login.start("https://console.ironbee.dev", CALLBACK, "ironbee-express:mac"));
        expect(url.origin + url.pathname).toBe("https://console.ironbee.dev/cli-auth");
        expect(url.searchParams.get("callback")).toBe(CALLBACK);
        expect(url.searchParams.get("name")).toBe("ironbee-express:mac");
        // The console shows it (it takes names starting with "IronBee").
        expect(url.searchParams.get("client")).toBe("IronBee Express");
        expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{48}$/);
        expect(stateOf(login.start("https://console.ironbee.dev", CALLBACK))).not.toBe(url.searchParams.get("state"));
    });

    it("hands back the token for a state it issued, once", (): void => {
        const login: IronBeeLogin = new IronBeeLogin();
        const state: string = stateOf(login.start("https://c", CALLBACK));
        expect(login.complete({ state, access_token: "ibt_abc" })).toEqual({ oauthToken: "ibt_abc" });
        // Spent: a replayed callback is refused.
        expect((): LoginCredential => login.complete({ state, access_token: "ibt_abc" })).toThrow(LoginError);
    });

    it("takes a shared API key when the console sends one", (): void => {
        const login: IronBeeLogin = new IronBeeLogin();
        const state: string = stateOf(login.start("https://c", CALLBACK));
        expect(login.complete({ state, api_key: "k1" })).toEqual({ apiKey: "k1" });
    });

    it("refuses a state it never issued, or one that expired", (): void => {
        let now: number = 1_000;
        const login: IronBeeLogin = new IronBeeLogin((): number => now);
        expect((): LoginCredential => login.complete({ state: "forged", access_token: "ibt_x" })).toThrow(/not one this app started/);
        const state: string = stateOf(login.start("https://c", CALLBACK));
        now += LOGIN_TIMEOUT_MS + 1;
        expect((): LoginCredential => login.complete({ state, access_token: "ibt_x" })).toThrow(LoginError);
    });

    it("explains the console's errors, the token limit in words", (): void => {
        const login: IronBeeLogin = new IronBeeLogin();
        const limit: string = stateOf(login.start("https://c", CALLBACK));
        expect((): LoginCredential => login.complete({ state: limit, error: "token_limit_exceeded" })).toThrow(/maximum number of access tokens/);
        const other: string = stateOf(login.start("https://c", CALLBACK));
        expect((): LoginCredential => login.complete({ state: other, error: "boom" })).toThrow("The IronBee console reported an error (boom).");
        const none: string = stateOf(login.start("https://c", CALLBACK));
        expect((): LoginCredential => login.complete({ state: none })).toThrow(/did not return an access token/);
    });
});

describe("the shared IronBee config", (): void => {
    let dir: string;
    let file: string;

    beforeEach((): void => {
        dir = mkdtempSync(join(tmpdir(), "ibexpress-ironbee-"));
        file = join(dir, "config.json");
    });
    afterEach((): void => {
        rmSync(dir, { recursive: true, force: true });
    });

    const read: () => Record<string, any> = (): Record<string, any> => JSON.parse(readFileSync(file, "utf-8"));
    const env: (extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        IBEXPRESS_IRONBEE_CONFIG: file,
        ...extra,
    });

    it("saves a login the way the IronBee CLI does, keeping the rest of the file, readable by its owner only", (): void => {
        writeFileSync(file, JSON.stringify({ collector: { oauthToken: "old", url: "u" }, service: { apiKey: "k" }, verification: { enable: true } }));
        saveCredential(file, "ironbee.dev", { oauthToken: "ibt_new" });
        expect(read()).toEqual({ service: { oauthToken: "ibt_new", domain: "ironbee.dev" }, collector: { url: "u" }, verification: { enable: true } });
        expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it("creates the file when there is none", (): void => {
        const nested: string = join(dir, ".ironbee", "config.json");
        saveCredential(nested, "ironbee.ai", { apiKey: "k2" });
        expect(JSON.parse(readFileSync(nested, "utf-8"))).toEqual({ service: { apiKey: "k2", domain: "ironbee.ai" } });
    });

    it("signs out by removing the credential only", (): void => {
        writeFileSync(file, JSON.stringify({ service: { oauthToken: "ibt", domain: "ironbee.dev" }, collector: { apiKey: "x" }, other: 1 }));
        clearCredential(file);
        expect(read()).toEqual({ service: { domain: "ironbee.dev" }, other: 1 });
    });

    it("uses the saved login when the environment sets no key, on the login's own domain", (): void => {
        saveCredential(file, "ironbee.dev", { oauthToken: "ibt_saved" });
        const config: IronBeeConfig = resolveIronBeeConfig(env());
        expect(config).toMatchObject({
            oauthToken: "ibt_saved",
            source: CredentialSource.FILE,
            domain: "ironbee.dev",
            consoleUrl: "https://console.ironbee.dev",
            collectorUrl: "https://collector.service.ironbee.dev",
            enabled: true,
        });
    });

    it("lets the environment win, and ignores a saved login of another domain", (): void => {
        saveCredential(file, "ironbee.dev", { oauthToken: "ibt_saved" });
        expect(resolveIronBeeConfig(env({ IRONBEE_API_KEY: "k-env" }))).toMatchObject({ apiKey: "k-env", source: CredentialSource.ENV });
        expect(resolveIronBeeConfig(env({ IRONBEE_API_KEY: "k-env" })).oauthToken).toBeUndefined();
        const prod: IronBeeConfig = resolveIronBeeConfig(env({ IRONBEE_DOMAIN: "ironbee.ai" }));
        expect(prod).toMatchObject({ domain: "ironbee.ai", enabled: false });
        expect(prod.source).toBeUndefined();
    });

    it("reads the older collector.* login, its domain from a standard collector URL", (): void => {
        writeFileSync(file, JSON.stringify({ collector: { oauthToken: "ibt_old", url: "https://collector.service.ironbee.us" } }));
        expect(resolveIronBeeConfig(env())).toMatchObject({ oauthToken: "ibt_old", domain: "ironbee.us", enabled: true });
    });

    it("takes the current service.* login over a stale collector.* token, with its own domain", (): void => {
        writeFileSync(file, JSON.stringify({ service: { apiKey: "k-current", domain: "ironbee.dev" }, collector: { oauthToken: "ibt_stale" } }));
        const config: IronBeeConfig = resolveIronBeeConfig(env({ IRONBEE_DOMAIN: "ironbee.dev" }));
        expect(config).toMatchObject({ apiKey: "k-current", domain: "ironbee.dev", enabled: true });
        expect(config.oauthToken).toBeUndefined();
    });

    it("keeps a saved login off when reporting is switched off", (): void => {
        saveCredential(file, "ironbee.ai", { oauthToken: "ibt" });
        expect(resolveIronBeeConfig(env({ IBEXPRESS_IRONBEE_REPORT: "off" }))).toMatchObject({ enabled: false, reportingOff: true });
    });

    it("picks up a connect and a sign-out at runtime, never touching a credential from the environment", (): void => {
        let config: IronBeeConfig = resolveIronBeeConfig(env({ IRONBEE_DOMAIN: "ironbee.dev" }));
        expect(config.enabled).toBe(false);
        saveCredential(file, config.domain, { oauthToken: "ibt_now" });
        config = reloadStoredCredential(config);
        expect(config).toMatchObject({ oauthToken: "ibt_now", source: CredentialSource.FILE, enabled: true });
        clearCredential(file);
        config = reloadStoredCredential(config);
        expect(config.enabled).toBe(false);
        expect(config.oauthToken).toBeUndefined();
        const fromEnv: IronBeeConfig = resolveIronBeeConfig(env({ IRONBEE_API_KEY: "k" }));
        expect(reloadStoredCredential(fromEnv)).toBe(fromEnv);
    });

    it("reads a broken file as no login", (): void => {
        writeFileSync(file, "{ not json");
        expect(resolveIronBeeConfig(env()).enabled).toBe(false);
    });

    it("never replaces a file it cannot read: connecting and signing out refuse, the file stays", (): void => {
        writeFileSync(file, "{ not json");
        expect((): void => saveCredential(file, "ironbee.dev", { oauthToken: "ibt_new" })).toThrow(LoginError);
        expect((): void => clearCredential(file)).toThrow(/not valid JSON/);
        expect(readFileSync(file, "utf-8")).toBe("{ not json");
        writeFileSync(file, "[]");
        expect((): void => saveCredential(file, "ironbee.dev", { apiKey: "k" })).toThrow(/JSON object/);
        expect(readFileSync(file, "utf-8")).toBe("[]");
    });
});
