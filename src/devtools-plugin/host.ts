/**
 * What the control tools use of IronBee DevTools, as shapes only: this plugin
 * runs inside DevTools (TOOL_PLUGINS) and never imports it. The values come in
 * at start-up through the plugin API (api.ts); these types describe them. They
 * mirror DevTools' plugin API version 1 and must change with it.
 */

import type { Locator, Page } from "playwright-core";
import type { z, ZodRawShape } from "zod";

/** The plugin API version these tools are written against. */
export const PLUGIN_API_VERSION: number = 1;

export interface ToolInput {
    [key: string]: unknown;
}

export interface ToolOutput {
    [key: string]: unknown;
}

export type ToolInputSchema = ZodRawShape;
export type ToolOutputSchema = ZodRawShape;

export interface Tool {
    name(): string;
    description(): string;
    inputSchema(): ToolInputSchema;
    outputSchema(): ToolOutputSchema;
    handle(context: BrowserToolSessionContext, args: ToolInput): Promise<ToolOutput>;
    isEnabled?(): boolean;
}

/** One open tab. */
export interface TabInfo {
    index: number;
    url: string;
    title: string;
    active: boolean;
}

/** A native dialog held open (BROWSER_DIALOG_MODE=hold). */
export interface PendingDialog {
    id: number;
    type: string;
    message: string;
    defaultValue?: string;
    openedAt: number;
}

/** The session's native-dialog keeper. */
export interface DialogKeeper {
    readonly mode: string;
    readonly disposed: boolean;
    pending(): PendingDialog | undefined;
    promptText(): string | undefined;
    setPromptText(text: string): void;
    resolve(accept: boolean, promptText?: string): Promise<PendingDialog>;
    /** Resolves when a dialog is held (at once when one already is; `page`: that page's only); `cancel` releases the wait. */
    whenOpened(page?: Page): { promise: Promise<void>; cancel: () => void };
}

/** What a race of some work against a dialog ended with. */
export type RaceOutcome<T> = { dialog: true } | { dialog: false; value: T };

/** The browser session a tool acts in (the members these tools use). */
export interface BrowserToolSessionContext {
    readonly page: Page;
    isRecording(): boolean;
    dialogs(): DialogKeeper;
    heldDialog(): PendingDialog | undefined;
    tabs(): Promise<TabInfo[]>;
    tabCount(): number;
    tabsSettled(): Promise<void>;
    tabGeneration(): number;
    takeTabSwitched(): boolean;
    switchTab(index: number): Promise<string | undefined>;
    closeTab(index?: number): Promise<string | undefined>;
    numOfInFlightRequests(sinceMs?: number): number;
    /** Emptied when the page is replaced, another tab becomes active or the session closes. */
    pageState(): Map<string, unknown>;
    sessionState(): Map<string, unknown>;
}

/** The browser platform's API for plugin tools (DevTools' `toolPluginApi`). */
export interface BrowserPluginApi {
    /** A selector, a Playwright locator expression or an ARIA ref (e5 / @e5) as a Locator, as DevTools' own tools resolve it. */
    resolveElement(context: BrowserToolSessionContext, selectorOrRef: string): Locator;
}

/** The kinds of destination a plugin tool may declare itself a secret sink for. */
export enum SecretSinkKind {
    FORM_FILL = "form-fill",
    HTTP_HEADER = "http-header",
    DB_CONNECT = "db-connect",
}

/** Where a tool is about to write a value that may carry secret references. */
export interface SecretDestination {
    kind: SecretSinkKind;
    /** The destination's origin or URL (a page element: its own frame's). */
    origin: string;
    /** A form fill: the element is a password input (login passwords go only there). */
    passwordField?: boolean;
}

/** What DevTools hands the plugin's factory, whatever the platform. */
export interface PluginApi {
    apiVersion: number;
    platform: string;
    z: typeof z;
    logger: {
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };
    carriesSecretReference: (value: unknown) => boolean;
    /** The value to write, its {{secret:…}} references resolved for `destination`; throws where they may not go. */
    resolveSecrets: (value: string, destination: SecretDestination) => string;
}

/** A plugin's tools for one platform. */
export interface PlatformTools {
    tools: Tool[];
    /** Its tools that may receive a {{secret:…}} reference, by the kind of destination they write it to. */
    secretSinks?: Record<string, SecretSinkKind>;
}

/**
 * What the plugin's factory returns: its tools per platform, each built with
 * that platform's API — the browser's is `BrowserPluginApi`; a platform this
 * plugin has no tools for is simply absent.
 */
export interface ToolPlugin {
    name: string;
    apiVersion: number;
    platforms: {
        browser?: (platformApi: BrowserPluginApi) => PlatformTools;
    };
}
