/**
 * The operations a decision can take, the question key of each element
 * operation's target head, and what executing a target means. Kept apart from
 * the policy so request formats can use them without an import cycle.
 */

export enum Operation {
    CLICK = "CLICK",
    TYPE_TEXT = "TYPE_TEXT",
    SELECT = "SELECT",
    PRESS_ENTER = "PRESS_ENTER",
    /** Point at an element without clicking (menus / tooltips that open on hover). */
    HOVER = "HOVER",
    /** Press a key where focus is (Escape, Tab, arrows). */
    PRESS_KEY = "PRESS_KEY",
    GO_BACK = "GO_BACK",
    GO_FORWARD = "GO_FORWARD",
    /** Bring another open tab to the front (the run follows new tabs by itself). */
    SWITCH_TAB = "SWITCH_TAB",
    /** Close the current tab; the previous one comes back. */
    CLOSE_TAB = "CLOSE_TAB",
    SCROLL_DOWN = "SCROLL_DOWN",
    SCROLL_UP = "SCROLL_UP",
    WAIT = "WAIT",
    DONE = "DONE",
    BLOCKED = "BLOCKED",
    /** Hand the browser to the person running the test; the run continues when they are done. */
    ASK_USER = "ASK_USER",
}

/** Why a run hands the browser to its user. */
export enum UserActionKind {
    /** A third-party / social / single sign-on login. */
    SIGN_IN = "SIGN_IN",
    /** A CAPTCHA, a verification code, a confirmation sent elsewhere. */
    VERIFY = "VERIFY",
    /** A field needs a value none of the run's values provides. */
    ENTER_VALUE = "ENTER_VALUE",
    /** Another step only a person can do. */
    OTHER = "OTHER",
}

/**
 * The kinds a decision may ASK_USER with — the engine's head and the text model at the controls
 * offer the same ones. ENTER_VALUE is not among them: it comes from the value choice (a field
 * with no value), which names the field; an ASK_USER carries no control.
 */
export const USER_ACTION_KINDS: readonly UserActionKind[] = [UserActionKind.SIGN_IN, UserActionKind.VERIFY, UserActionKind.OTHER];

/** The question key of ASK_USER's reason head. */
export const ASK_USER_HEAD: string = "ask_user_reason";

/** Operations that pick an element, and the question key of their target head. */
export const TARGET_HEADS: Partial<Record<Operation, string>> = {
    [Operation.CLICK]: "click_target",
    [Operation.TYPE_TEXT]: "type_text_target",
    [Operation.SELECT]: "select_target",
    [Operation.PRESS_ENTER]: "press_enter_target",
    // Usually the click head's answer (the same clickable elements, one head
    // less to send); a head of its own when the two lists differ — see
    // policy.buildRequest.
    [Operation.HOVER]: "hover_target",
};

/** The question key of SWITCH_TAB's tab head. */
export const TAB_HEAD: string = "tab";

/** The question key of PRESS_KEY's key head. */
export const KEY_HEAD: string = "key";

/** The keys PRESS_KEY offers, and what each is for. */
export const KEYS: Record<string, string> = {
    Escape: "Escape: close a dialog, popup, banner or open menu.",
    Tab: "Tab: move focus to the next field (e.g. to commit an autocomplete).",
    "Shift+Tab": "Shift+Tab: move focus to the previous field.",
    ArrowDown: "Arrow down: the next option in an open list or suggestion menu.",
    ArrowUp: "Arrow up: the previous option in an open list.",
};

export const TEXT_VALUE_HEAD: string = "text_value";
/** The text a field that already holds this run's text should hold (Agent.settleFieldText). */
export const FIELD_TEXT_HEAD: string = "field_text";

export interface Target {
    controlId: number;
    optionValue?: string;
}
