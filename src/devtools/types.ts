/**
 * Wire shapes of the control tools the agent drives: `control_take-snapshot`
 * and `control_act`. They mirror the plugin's Zod schemas in
 * `src/devtools-plugin/` (`snapshot.ts` `buildSchemas`, `act.ts`
 * `Act.inputSchema` / `outputSchema`) and must change with them.
 */

export enum ControlOperation {
    CLICK = "click",
    FILL = "fill",
    SELECT = "select",
}

export enum ControlAction {
    CLICK = "click",
    FILL = "fill",
    SELECT = "select",
    PRESS_ENTER = "press-enter",
    SCROLL_DOWN = "scroll-down",
    SCROLL_UP = "scroll-up",
    WAIT = "wait",
    HOVER = "hover",
    PRESS_KEY = "press-key",
    GO_BACK = "go-back",
    GO_FORWARD = "go-forward",
    SWITCH_TAB = "switch-tab",
    CLOSE_TAB = "close-tab",
}

/** One open tab, as a snapshot lists them (only when there is more than one). */
export interface TabInfo {
    index: number;
    url: string;
    title: string;
    active: boolean;
}

export interface ControlOption {
    value: string;
    label: string;
}

export interface Control {
    id: number;
    role: string;
    name: string;
    ops: ControlOperation[];
    value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
    password?: boolean;
    /** Password fields only: whether it holds anything. */
    filled?: boolean;
    /** Nearby text, only on controls whose role + name repeat. */
    context?: string;
    options?: ControlOption[];
    /** Inside an iframe (IBEXPRESS_IFRAMES): the host of its document. */
    frame?: string;
}

export interface ControlSnapshot {
    snapshotId: number;
    url: string;
    title: string;
    text: string;
    controls: Control[];
    omittedControls: number;
    offscreenControls: number;
    canScrollUp: boolean;
    canScrollDown: boolean;
    fingerprint: string;
    /** A native dialog is open (the page is behind it): its message is the text, OK / Cancel the controls. */
    dialog?: { type: string; message: string };
    /** The open tabs, when there is more than one. */
    tabs?: TabInfo[];
}

export interface ActRequest {
    action: ControlAction;
    snapshotId?: number;
    controlId?: number;
    value?: string;
    waitMs?: number;
    /** After an executed action, wait up to this long for the requests in flight before observing. */
    waitForNetworkMs?: number;
    observe?: boolean;
    /** Mark the action in the page (click ripple / box); default: whether a recording runs. */
    animate?: boolean;
    maxControls?: number;
    maxTextChars?: number;
}

export interface ActResult {
    executed: boolean;
    reason?: string;
    /**
     * With waitForNetworkMs: false when requests were still in flight at the bound. Absent when a
     * native dialog is held (the wait ends at once: the page is frozen behind it).
     */
    networkIdle?: boolean;
    snapshot?: ControlSnapshot;
}

export interface SnapshotLimits {
    maxControls: number;
    maxTextChars: number;
}

/** DevTools' secret types: a login password goes only into a password input; a generic value anywhere on its site. */
export enum SecretType {
    LOGIN_CREDENTIALS = "login-credentials",
    GENERIC = "generic",
}

/** A secret in DevTools' seed format (`POST /internal/secrets`). */
export interface SeedSecret {
    name: string;
    description?: string;
    type: SecretType;
    fields: Record<string, string>;
    /** `host`, `*.host` or `host:port` — no scheme. */
    boundOrigins: string[];
}

export interface SecretBundle {
    secrets: SeedSecret[];
}
