import { browserDefaults, controlToolsPluginPath, daemonEnv, installedChromePaths, SESSION_IDLE_SECONDS, toolPluginsEnv } from "../../../src/devtools/daemon";

import path from "path";

describe("toolPluginsEnv", (): void => {
    const plugin: string = controlToolsPluginPath();

    it("names the control-tools plugin once, however many lists name it", (): void => {
        expect(toolPluginsEnv(plugin, plugin, plugin)).toBe(plugin);
    });

    it("keeps the caller's plugins, in order, before the control tools", (): void => {
        const other: string = path.resolve("/plugins/other.mjs");
        expect(toolPluginsEnv(other, undefined, plugin)).toBe([other, plugin].join(path.delimiter));
    });

    it("dedupes across lists and spellings of the same path, dropping empties", (): void => {
        const other: string = path.resolve("/plugins/other.mjs");
        const relative: string = path.relative(process.cwd(), other);
        const list: string = [other, "", " "].join(path.delimiter);
        expect(toolPluginsEnv(list, relative, plugin)).toBe([other, plugin].join(path.delimiter));
    });
});

describe("daemonEnv", (): void => {
    it("keeps a session through a long user's turn, unless the caller says otherwise", (): void => {
        const env: NodeJS.ProcessEnv = daemonEnv({ port: 1, headless: true }, "t", {});
        expect(env.DAEMON_SESSION_IDLE_SECONDS).toBe(String(SESSION_IDLE_SECONDS));
        expect(SESSION_IDLE_SECONDS).toBeGreaterThan(3_600);
        expect(daemonEnv({ port: 1, headless: true, env: { DAEMON_SESSION_IDLE_SECONDS: "60" } }, "t", {}).DAEMON_SESSION_IDLE_SECONDS).toBe("60");
    });

    it("sets what must hold after the caller's env", (): void => {
        const env: NodeJS.ProcessEnv = daemonEnv({ port: 1, headless: false, env: { PLATFORM: "backend", INTERNAL_TOKEN: "x" } }, "t", {});
        expect(env.PLATFORM).toBe("browser");
        expect(env.INTERNAL_TOKEN).toBe("t");
        expect(env.BROWSER_HEADLESS_ENABLE).toBe("false");
    });
});

describe("browserDefaults", (): void => {
    it("uses the installed Chrome, and sets no language", (): void => {
        expect(browserDefaults({}, { chromeInstalled: true })).toEqual({ BROWSER_USE_INSTALLED_ON_SYSTEM: "true" });
    });

    it("keeps the bundled browser when Chrome is not installed", (): void => {
        expect(browserDefaults({}, { chromeInstalled: false })).toEqual({});
    });

    it("leaves it to this process's environment when it sets it", (): void => {
        const base: NodeJS.ProcessEnv = { BROWSER_USE_INSTALLED_ON_SYSTEM: "false" };
        expect(browserDefaults(base, { chromeInstalled: true })).toEqual({});
        const env: NodeJS.ProcessEnv = daemonEnv({ port: 1, headless: true }, "t", base, browserDefaults(base, { chromeInstalled: true }));
        expect(env.BROWSER_USE_INSTALLED_ON_SYSTEM).toBe("false");
        expect(env.BROWSER_LOCALE).toBeUndefined();
    });

    it("lets the caller's env override it", (): void => {
        const env: NodeJS.ProcessEnv = daemonEnv(
            { port: 1, headless: true, env: { BROWSER_USE_INSTALLED_ON_SYSTEM: "false" } },
            "t",
            {},
            browserDefaults({}, { chromeInstalled: true })
        );
        expect(env.BROWSER_USE_INSTALLED_ON_SYSTEM).toBe("false");
    });
});

describe("installedChromePaths", (): void => {
    it("names Chrome's install paths per platform", (): void => {
        expect(installedChromePaths("darwin")).toEqual(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
        expect(installedChromePaths("linux")).toEqual(["/opt/google/chrome/chrome"]);
        expect(installedChromePaths("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" })).toEqual([
            "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
        ]);
        expect(installedChromePaths("aix")).toEqual([]);
    });
});
