import {
    browserDefaults,
    controlToolsPluginPath,
    daemonEnv,
    DEFAULT_SCREEN_SIZE,
    DEFAULT_WINDOW_SIZE,
    installedChromePaths,
    SESSION_IDLE_SECONDS,
    stealthEnv,
    toolPluginsEnv,
} from "../../../src/devtools/daemon";

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
    const NATURAL: Record<string, string> = {
        BROWSER_HEADLESS_SHELL: "false",
        BROWSER_WINDOW_SIZE: DEFAULT_WINDOW_SIZE,
        BROWSER_SCREEN_SIZE: DEFAULT_SCREEN_SIZE,
        BROWSER_BYPASS_CSP: "false",
    };

    it("uses the installed Chrome in a real window with the CSP enforced, and sets no language", (): void => {
        expect(browserDefaults({}, { chromeInstalled: true })).toEqual({ BROWSER_USE_INSTALLED_ON_SYSTEM: "true", ...NATURAL });
        expect(browserDefaults({}, { chromeInstalled: true }).BROWSER_LOCALE).toBeUndefined();
    });

    it("runs the full Chromium, never the headless shell, when Chrome is not installed", (): void => {
        expect(browserDefaults({}, { chromeInstalled: false })).toEqual(NATURAL);
    });

    it("leaves each to this process's environment when it sets it", (): void => {
        const base: NodeJS.ProcessEnv = { BROWSER_USE_INSTALLED_ON_SYSTEM: "false", BROWSER_BYPASS_CSP: "true", BROWSER_WINDOW_SIZE: "1440x900" };
        expect(browserDefaults(base, { chromeInstalled: true })).toEqual({
            BROWSER_HEADLESS_SHELL: "false",
            BROWSER_SCREEN_SIZE: DEFAULT_SCREEN_SIZE,
        });
        const env: NodeJS.ProcessEnv = daemonEnv({ port: 1, headless: true }, "t", base, browserDefaults(base, { chromeInstalled: true }));
        expect(env.BROWSER_USE_INSTALLED_ON_SYSTEM).toBe("false");
        expect(env.BROWSER_BYPASS_CSP).toBe("true");
        expect(env.BROWSER_WINDOW_SIZE).toBe("1440x900");
        expect(env.BROWSER_LOCALE).toBeUndefined();
    });

    it("lets the caller's env override it", (): void => {
        const env: NodeJS.ProcessEnv = daemonEnv(
            { port: 1, headless: true, env: { BROWSER_USE_INSTALLED_ON_SYSTEM: "false", BROWSER_BYPASS_CSP: "true" } },
            "t",
            {},
            browserDefaults({}, { chromeInstalled: true })
        );
        expect(env.BROWSER_USE_INSTALLED_ON_SYSTEM).toBe("false");
        expect(env.BROWSER_BYPASS_CSP).toBe("true");
    });
});

describe("stealthEnv", (): void => {
    it("drives the browser with patchright and puts nothing in the page: no OpenTelemetry script, no action marks", (): void => {
        expect(stealthEnv()).toEqual({ BROWSER_DRIVER: "patchright", OTEL_ENABLE: "false", BROWSER_ACTION_ANIMATION: "false" });
    });

    it("wins over the IronBee environment the run's env starts from", (): void => {
        const env: NodeJS.ProcessEnv = daemonEnv(
            { port: 1, headless: true, env: { OTEL_ENABLE: "true", OTEL_EXPORTER_TYPE: "otlp/http-protobuf", ...stealthEnv() } },
            "t",
            {}
        );
        expect(env.OTEL_ENABLE).toBe("false");
        expect(env.BROWSER_DRIVER).toBe("patchright");
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
