/**
 * Makes sure an IronBee DevTools daemon is up before a run: reuses a healthy
 * one, or starts one and waits for it. A started daemon is owned by this
 * process and stopped by it.
 *
 * A daemon exits by itself once it has had no session for two idle checks
 * (~1 min by default), and every run closes its session at the end — so a
 * daemon given by URL may be gone by the next run. When that URL is on this
 * machine, a new daemon is started on the same port instead of failing.
 */

import { sleep } from "../util/time";

import { ChildProcess, spawn } from "child_process";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { AddressInfo, createServer as createNetServer, Server as NetServer } from "net";
import path from "path";

const HEALTH_TIMEOUT_MS: number = 1_000;
const START_TIMEOUT_MS: number = 30_000;
const POLL_MS: number = 200;

export interface StartDaemonOptions {
    /** A daemon to use; revived on its port when it is local and not answering. */
    url?: string;
    /** Port for a daemon started without a URL. */
    port: number;
    headless: boolean;
    /** Path to the daemon script; else IRONBEE_DEVTOOLS_DAEMON_SCRIPT, else the installed package. */
    daemonScript?: string;
    /** Extra environment for the daemon (e.g. the live-view hub). */
    env?: Record<string, string>;
    /**
     * How long a started daemon lingers with no session before it exits
     * (DevTools checks idleness at this interval and exits after two idle checks).
     */
    idleCheckSeconds?: number;
}

/** A started daemon lingers ~10 min without sessions (two 5-min checks). */
export const DEFAULT_IDLE_CHECK_SECONDS: number = 300;

/**
 * How long a started daemon keeps a session no call has touched (DevTools'
 * default is 5 min). A user's turn makes no call — the person acts through the
 * browser window or the live view — and may take longer (an SMS code, a social
 * login). Every run closes its own session at the end, so this only bounds a
 * session its caller left behind.
 */
export const SESSION_IDLE_SECONDS: number = 86_400;
const LOCAL_HOSTS: Set<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface DaemonHandle {
    baseUrl: string;
    /**
     * The INTERNAL_TOKEN a daemon started here was given: with it a run seeds
     * its secrets into DevTools. Absent for a daemon found already running.
     */
    internalToken?: string;
    /** True when this process started the daemon (and so should stop it). */
    owned: boolean;
    stop(): Promise<void>;
}

/** A port nothing listens on right now (for a daemon of our own). */
export function freePort(): Promise<number> {
    return new Promise<number>((resolve: (port: number) => void, reject: (err: Error) => void): void => {
        const probe: NetServer = createNetServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", (): void => {
            const port: number = (probe.address() as AddressInfo).port;
            probe.close((): void => resolve(port));
        });
    });
}

export async function isDaemonHealthy(baseUrl: string): Promise<boolean> {
    try {
        const response: Response = await fetch(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * The built control-tools plugin (scripts/build-devtools-plugin.js) DevTools
 * loads with TOOL_PLUGINS: next to this module in dist/, or in dist/ when this
 * runs from src/ (tests).
 */
export function controlToolsPluginPath(): string {
    const beside: string = path.join(__dirname, "..", "devtools-plugin", "control-tools.mjs");
    if (existsSync(beside)) {
        return beside;
    }
    return path.resolve(__dirname, "..", "..", "dist", "devtools-plugin", "control-tools.mjs");
}

/**
 * The daemon's TOOL_PLUGINS: the given lists (the process env's, the caller's)
 * and the control-tools plugin, each path once. DevTools refuses a tool name
 * registered twice, so a plugin named in both — the documented
 * `export TOOL_PLUGINS=…/control-tools.mjs` for a shared daemon and this
 * process's own entry — must not be loaded twice.
 */
export function toolPluginsEnv(...lists: (string | undefined)[]): string {
    const seen: Set<string> = new Set();
    for (const list of lists) {
        for (const entry of (list ?? "").split(path.delimiter)) {
            const trimmed: string = entry.trim();
            if (trimmed) {
                seen.add(path.resolve(trimmed));
            }
        }
    }
    return [...seen].join(path.delimiter);
}

function resolveDaemonScript(explicit?: string): string {
    const candidate: string | undefined = explicit ?? process.env.IRONBEE_DEVTOOLS_DAEMON_SCRIPT;
    if (candidate) {
        if (!existsSync(candidate)) {
            throw new Error(`Daemon script not found: ${candidate}`);
        }
        return candidate;
    }
    try {
        return require.resolve("@ironbee-ai/devtools/dist/daemon-server.js");
    } catch {
        throw new Error(
            "No IronBee DevTools daemon is reachable and none could be started: " +
                "install @ironbee-ai/devtools, set IRONBEE_DEVTOOLS_DAEMON_SCRIPT, " +
                "or pass --daemon-url to a running daemon."
        );
    }
}

/** Where Google Chrome is installed: the paths Playwright's `chrome` channel launches from. */
export function installedChromePaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
    switch (platform) {
        case "darwin":
            return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
        case "linux":
            return ["/opt/google/chrome/chrome"];
        case "win32":
            return [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]
                .filter((dir: string | undefined): dir is string => dir !== undefined)
                .map((dir: string): string => path.win32.join(dir, "Google", "Chrome", "Application", "chrome.exe"));
        default:
            return [];
    }
}

function hasInstalledChrome(): boolean {
    return installedChromePaths().some((p: string): boolean => existsSync(p));
}

/** The window a started browser opens: a common laptop window, its page about 1280x713. */
export const DEFAULT_WINDOW_SIZE: string = "1280x800";
/** The screen a headless browser reports: the most common desktop screen. */
export const DEFAULT_SCREEN_SIZE: string = "1920x1080";

/**
 * How a started browser presents itself to a site, as a person's browser does — sites behind bot
 * protection refuse what looks automated before the run takes a step:
 * - the Google Chrome installed on this machine when there is one, else Playwright's full Chromium
 *   (never its headless shell, which a page tells from Chrome);
 * - a real 1280x800 window on a 1920x1080 screen instead of Playwright's emulated 1280x720 viewport
 *   (headless: DevTools also drops `HeadlessChrome` from the user agent);
 * - pages' Content-Security-Policy enforced: a page can tell when it is bypassed, and Cloudflare's
 *   challenge then held every run (measured 0/2 bypassed, 4/4 enforced).
 * No language is set: Chrome sends this machine's languages itself, where Playwright's locale
 * emulation sends a single `Accept-Language` value in a place Chrome never puts it. Each is left out
 * when `base` (this process's environment) already sets it, so it can be changed there.
 */
export function browserDefaults(
    base: NodeJS.ProcessEnv,
    machine: { chromeInstalled: boolean } = { chromeInstalled: hasInstalledChrome() }
): Record<string, string> {
    const wanted: Record<string, string> = {
        ...(machine.chromeInstalled ? { BROWSER_USE_INSTALLED_ON_SYSTEM: "true" } : {}),
        BROWSER_HEADLESS_SHELL: "false",
        BROWSER_WINDOW_SIZE: DEFAULT_WINDOW_SIZE,
        BROWSER_SCREEN_SIZE: DEFAULT_SCREEN_SIZE,
        BROWSER_BYPASS_CSP: "false",
    };
    return Object.fromEntries(Object.entries(wanted).filter(([name]: [string, string]): boolean => base[name] === undefined));
}

/**
 * A stealth run's daemon: patchright drives the browser — Playwright patched to never enable CDP's
 * Runtime domain, which a page can detect (Kasada-protected sites refused every run without it) —
 * and nothing is put into its pages: no OpenTelemetry script (it patches `fetch` and XHR in the page's
 * own world) and no action marks (their overlay is an element the page can see). The cost: the run
 * captures no console messages, its trace has no browser spans, and the live view shows no marks.
 */
export function stealthEnv(): Record<string, string> {
    return { BROWSER_DRIVER: "patchright", OTEL_ENABLE: "false", BROWSER_ACTION_ANIMATION: "false" };
}

/** The environment a started daemon runs with: this process's, the run's defaults, the caller's `env`, then what must hold. */
export function daemonEnv(
    options: StartDaemonOptions,
    internalToken: string,
    base: NodeJS.ProcessEnv = process.env,
    browser: Record<string, string> = browserDefaults(base)
): NodeJS.ProcessEnv {
    return {
        ...base,
        ...browser,
        DAEMON_SESSION_IDLE_CHECK_SECONDS: String(options.idleCheckSeconds ?? DEFAULT_IDLE_CHECK_SECONDS),
        // A user's turn makes no call: the session must outlast it (SESSION_IDLE_SECONDS).
        DAEMON_SESSION_IDLE_SECONDS: String(SESSION_IDLE_SECONDS),
        // Native dialogs are held for the run to answer, not silently
        // dismissed (a confirm would otherwise always answer Cancel).
        // Before the caller's env, which may override it.
        BROWSER_DIALOG_MODE: "hold",
        // A tab the page opens (target=_blank, window.open) is followed, like a person would.
        BROWSER_FOLLOW_NEW_TABS: "true",
        ...options.env,
        // The agent's control tools run inside DevTools as its tool plugin,
        // beside whatever plugins the env names (each once).
        TOOL_PLUGINS: toolPluginsEnv(base.TOOL_PLUGINS, options.env?.TOOL_PLUGINS, controlToolsPluginPath()),
        PLATFORM: "browser",
        BROWSER_HEADLESS_ENABLE: String(options.headless),
        INTERNAL_TOKEN: internalToken,
    };
}

export async function ensureDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
    let baseUrl: string = `http://127.0.0.1:${options.port}`;
    let port: number = options.port;
    if (options.url) {
        const url: URL = new URL(options.url);
        baseUrl = options.url.replace(/\/$/, "");
        if (await isDaemonHealthy(baseUrl)) {
            return { baseUrl, owned: false, stop: async (): Promise<void> => {} };
        }
        if (!LOCAL_HOSTS.has(url.hostname)) {
            throw new Error(`The IronBee DevTools daemon at ${baseUrl} is not reachable`);
        }
        port = Number(url.port || 80);
    }
    // A given url was probed above; the default address is probed here.
    if (!options.url && (await isDaemonHealthy(baseUrl))) {
        return {
            baseUrl,
            owned: false,
            stop: async (): Promise<void> => {},
        };
    }
    const script: string = resolveDaemonScript(options.daemonScript);
    // A daemon revived for a given URL is shared, not ours: it outlives this
    // process and ends by its own idle timeout.
    const shared: boolean = options.url !== undefined;
    const internalToken: string = randomBytes(24).toString("hex");
    const child: ChildProcess = spawn(process.execPath, [script, "--port", String(port)], {
        stdio: "ignore",
        detached: shared,
        env: daemonEnv(options, internalToken),
    });
    const deadline: number = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`The DevTools daemon exited during start (code ${child.exitCode})`);
        }
        if (await isDaemonHealthy(baseUrl)) {
            if (shared) {
                child.unref();
                return { baseUrl, internalToken, owned: false, stop: async (): Promise<void> => {} };
            }
            return {
                baseUrl,
                internalToken,
                owned: true,
                stop: async (): Promise<void> => {
                    try {
                        await fetch(`${baseUrl}/shutdown`, {
                            method: "POST",
                            signal: AbortSignal.timeout(3_000),
                        });
                    } catch {
                        child.kill();
                    }
                },
            };
        }
        await sleep(POLL_MS);
    }
    child.kill();
    throw new Error("The DevTools daemon did not become healthy in time");
}
