/**
 * The decision: one engine request asks for the operation AND, speculatively,
 * the target of every operation that has one (plus which value to type). Only
 * the head matching the chosen operation is used; the others cost nothing
 * extra because the engine evaluates questions in parallel.
 *
 * Engine-agnostic: the request is shaped by the engine's profile (how many
 * options, how much text, whether instructions survive), never by its kind.
 */

import { Control, ControlOperation, ControlSnapshot, TabInfo } from "../devtools/types";
import { ChoiceAnswer, ChoiceQuestion, InvalidAnswerError, RequestTooLargeError, SystemOneResponse, validateChoice } from "../engine/systemone";
import { DecisionEngine, EngineProfile } from "../engine/types";
import { TextChoice } from "../text/types";
import { VisitedPage } from "../verify/journey";
import { FIELD_TEXT, NEXT_OPERATION, SHORT_FIELD_TEXT, SHORT_NEXT_OPERATION, SHORT_TARGET, SHORT_TEXT_VALUE, TARGET, TEXT_VALUE } from "./prompts";
import { ASK_USER_HEAD, FIELD_TEXT_HEAD, KEY_HEAD, KEYS, Operation, TAB_HEAD, Target, TARGET_HEADS, TEXT_VALUE_HEAD, USER_ACTION_KINDS, UserActionKind } from "./operations";
import { shortlistControls } from "./shortlist";

export { ASK_USER_HEAD, FIELD_TEXT_HEAD, Operation, Target, TARGET_HEADS, TEXT_VALUE_HEAD, USER_ACTION_KINDS, UserActionKind } from "./operations";


export interface HistoryEntry {
    step: number;
    operation: Operation;
    /** e.g. `[12] button "Edit" (Row 3 …)` */
    target?: string;
    /** What was typed, as the engine may see it (secrets by name only). */
    text?: string;
    executed: boolean;
    reason?: string;
    pageChanged?: boolean;
    /** ASK_USER: what the user was asked to do; a rescued step: who chose it; a note-only entry: what happened. */
    note?: string;
}

/**
 * An entry that records no action of its own (the text model handing the controls back): a note,
 * neither executed nor refused.
 */
export function isNote(entry: HistoryEntry): boolean {
    return !entry.executed && entry.reason === undefined && entry.note !== undefined;
}

export interface DecisionInput {
    goal: string;
    snapshot: ControlSnapshot;
    history: HistoryEntry[];
    /** Text choices WITHOUT their text. */
    textChoices: TextChoice[];
    /** Whether a person is there to take over (ASK_USER is offered). */
    canAskUser?: boolean;
    /** The run has left an earlier page (GO_BACK is offered). */
    canGoBack?: boolean;
    /** The last navigation was a GO_BACK (GO_FORWARD is offered). */
    canGoForward?: boolean;
    /** Pages the run visited before (secrets masked): what was read there counts toward the goal. */
    earlierPages?: VisitedPage[];
    /** The moment the decision is made (weekday, date, local time, offset): what "tomorrow" in a goal means. */
    now?: string;
}

export interface Decision {
    operation: Operation;
    controlId?: number;
    /** SELECT: the option value. */
    optionValue?: string;
    /** TYPE_TEXT: the chosen text choice key. */
    textKey?: string;
    /** TYPE_TEXT: a text the text model wrote itself while it had the controls (never a secret). */
    literalText?: string;
    confidence: number;
    operationProbabilities: Record<string, number>;
    /** The chosen operation's target head: offered key → probability. */
    targetProbabilities?: Record<string, number>;
    /** The chosen operation's target head: offered key → label, for display. */
    targetLabels?: Record<string, string>;
    textProbabilities?: Record<string, number>;
    /** ASK_USER: why. */
    userAction?: UserActionKind;
    /** PRESS_KEY: which key. */
    key?: string;
    /** SWITCH_TAB: the tab's index. */
    tabIndex?: number;
    latencyMs: number;
}

export interface Decider {
    decide(input: DecisionInput): Promise<Decision>;
    /**
     * The value for a field already chosen — asked again, naming the field,
     * when the first pick looks wrong (see Agent). The first request asks the
     * value in parallel with the field, so it cannot see which field won.
     */
    chooseValue?(input: DecisionInput, field: Control): Promise<{ textKey: string; probabilities: Record<string, number> }>;
    /**
     * What a field that already holds this run's text should hold, now that new text is about to
     * replace it (see Agent). `options` is each offered choice's resulting text, as the engine may see it.
     */
    chooseFieldText?(
        input: DecisionInput,
        field: Control,
        options: Record<FieldTextChoice, string>
    ): Promise<{ choice: FieldTextChoice; probabilities: Record<string, number> }>;
}

/** What a field that holds this run's text becomes when new text is typed into it. */
export enum FieldTextChoice {
    /** The new text only: the old is dropped. */
    REPLACE = "REPLACE",
    /** The old text, a comma, the new text. */
    JOIN_COMMA = "JOIN_COMMA",
    /** The old text, a space, the new text. */
    JOIN_SPACE = "JOIN_SPACE",
}

const OPERATION_DESCRIPTIONS: Record<Operation, string> = {
    [Operation.CLICK]: "Click an element: a button, link, tab, menu item, checkbox, radio, suggestion or date.",
    [Operation.TYPE_TEXT]: "Type into an editable field, replacing its contents, using one of the available values.",
    [Operation.SELECT]: "Choose an option of a native dropdown.",
    [Operation.PRESS_ENTER]: "Press Enter in a filled text field to submit it (search, login).",
    [Operation.HOVER]: "Point at an element without clicking: opens a menu or tooltip that appears on hover.",
    [Operation.PRESS_KEY]: "Press a key: Escape closes a dialog, popup or menu; Tab moves between fields; arrows move in an open list.",
    [Operation.GO_BACK]: "Go back to the previous page (the current one is a wrong turn).",
    [Operation.GO_FORWARD]: "Go forward again to the page left with GO_BACK.",
    [Operation.SWITCH_TAB]: "Bring another open tab to the front.",
    [Operation.CLOSE_TAB]: "Close this tab (done with it); the previous tab comes back.",
    [Operation.SCROLL_DOWN]: "Scroll down to reveal more of the page.",
    [Operation.SCROLL_UP]: "Scroll up to reveal an earlier part of the page.",
    [Operation.WAIT]: "Wait: a submitted action or the page is still loading.",
    [Operation.DONE]: "Every requirement of the goal is satisfied: on the current page, or by what the recent actions already did.",
    [Operation.BLOCKED]: "No offered operation can make progress.",
    [Operation.ASK_USER]:
        "The next step needs a person: a third-party or single sign-on login, a CAPTCHA, or a code sent elsewhere. The user does it, then the run continues.",
};

/** ASK_USER's reasons as the engine chooses among them: USER_ACTION_KINDS, described. */
const USER_ACTION_DESCRIPTIONS: Partial<Record<UserActionKind, string>> = Object.fromEntries(
    USER_ACTION_KINDS.map((kind: UserActionKind): [UserActionKind, string] => {
        switch (kind) {
            case UserActionKind.SIGN_IN:
                return [kind, "Sign in with a third-party, social or single sign-on account."];
            case UserActionKind.VERIFY:
                return [kind, "Pass a human check: a CAPTCHA, a verification code, a confirmation."];
            default:
                return [kind, "Another step only a person can do."];
        }
    })
);

const RECENT_HISTORY: number = 10;
/** Of each earlier page, in the decision state. */
const EARLIER_PAGE_CHARS: number = 220;
const COMPACT_RECENT_HISTORY: number = 5;


function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function describeControl(control: Control, maxContext: number = 60): string {
    const base: string = `[${control.id}] ${control.role} "${control.name}"`;
    return control.context === undefined ? base : `${base} (${clip(control.context, maxContext)})`;
}

function elementRow(control: Control, fruitless: Set<string>): Record<string, unknown> {
    const row: Record<string, unknown> = { index: String(control.id), role: control.role, name: control.name };
    // In the state, so the OPERATION question sees it too (it does not read the target heads).
    if (fruitless.has(describeControl(control))) {
        row.clicking_it_changed_nothing = true;
    }
    if (control.password) {
        row.password_field = true;
        row.filled = control.filled === true;
    }
    if (control.value !== undefined) {
        row.value = control.value;
    }
    for (const key of ["checked", "selected", "expanded", "context"] as const) {
        if (control[key] !== undefined) {
            row[key] = control[key];
        }
    }
    if (control.options) {
        row.options = control.options.map(
            (o: { label: string }, i: number): string => `${control.id}:${i + 1} ${o.label}`
        );
    }
    return row;
}

/** A short one-line label: what compact engines see as the option text. */
function compactLabel(control: Control, profile: EngineProfile): string {
    const parts: string[] = [`${control.role} ${control.name}`];
    if (control.context) {
        parts.push(control.context);
    }
    if (control.password) {
        parts.push(control.filled ? "filled" : "empty");
    } else if (control.value) {
        parts.push(`value ${control.value}`);
    } else if (control.ops.includes(ControlOperation.FILL)) {
        parts.push("empty");
    }
    if (control.checked !== undefined) {
        parts.push(`checked ${control.checked}`);
    }
    return clip(parts.join(" · "), profile.maxLabelChars);
}

/**
 * How many WAITs in a row, latest first, left the page as it was. A page that does not change is
 * not loading: after a couple of those, a visible control is the better move, and the WAIT option
 * says so (the engine weighs an option's own words more than a general rule).
 */
function fruitlessWaits(history: HistoryEntry[]): number {
    let n: number = 0;
    for (let i: number = history.length - 1; i >= 0; i--) {
        const h: HistoryEntry = history[i];
        if (h.operation !== Operation.WAIT || h.pageChanged !== false) {
            break;
        }
        n++;
    }
    return n;
}

/** From this many WAITs in a row that changed nothing, the WAIT option says so. */
const FRUITLESS_WAITS: number = 2;

/**
 * Controls a click just got nowhere with — it changed nothing, or it was
 * refused (covered, gone) — by their description, which is what history
 * carries (it embeds the id; ids are stable across an identical reload, the
 * runtime numbers a document's controls in walk order). Only the latest run
 * of such clicks counts: once something changes, they are fair game again.
 */
function fruitlessClicks(history: HistoryEntry[]): Set<string> {
    const out: Set<string> = new Set();
    for (let i: number = history.length - 1; i >= 0; i--) {
        const h: HistoryEntry = history[i];
        const nowhere: boolean = !h.executed || h.pageChanged === false;
        if (h.operation !== Operation.CLICK || !nowhere || !h.target) {
            break;
        }
        out.add(h.target);
    }
    return out;
}

function targetCriterion(control: Control, profile: EngineProfile, fruitless: Set<string> = new Set()): unknown {
    const clickedInVain: boolean = fruitless.has(describeControl(control));
    if (profile.compact) {
        const label: string = compactLabel(control, profile);
        return clickedInVain ? `${label} · clicking it changed nothing` : label;
    }
    const c: Record<string, unknown> = { element: clip(describeControl(control), profile.maxLabelChars) };
    if (clickedInVain) {
        c.clicking_it_changed_nothing = true;
    }
    if (control.password) {
        c.password_field = true;
        c.filled = control.filled === true;
    } else if (control.value !== undefined) {
        c.current_value = control.value;
    }
    for (const key of ["checked", "selected", "expanded", "context"] as const) {
        if (control[key] !== undefined) {
            c[key] = control[key];
        }
    }
    return c;
}

export interface BuiltRequest {
    state: Record<string, unknown>;
    questions: Record<string, ChoiceQuestion>;
    operations: Operation[];
    /** Per target head: offered key → what executing it means. */
    targets: Partial<Record<Operation, Map<string, Target>>>;
    /** Per target head: offered key → display label. */
    labels: Partial<Record<Operation, Record<string, string>>>;
    /** The question each targeted operation reads its target from (HOVER may read the click head). */
    heads: Partial<Record<Operation, string>>;
}

/** Builds the state and every question for one decision, shaped by the engine profile. Pure. */
export function buildRequest(input: DecisionInput, profile: EngineProfile): BuiltRequest {
    const { snapshot, goal } = input;
    // Rejections name what is missing; they steer the shortlist as much as the goal does.
    const hints: string = input.history
        .filter((h: HistoryEntry): boolean => !h.executed && h.operation === Operation.DONE)
        .map((h: HistoryEntry): string => h.reason ?? "")
        .join(" ");
    const pick: (controls: Control[]) => Control[] = (controls: Control[]): Control[] =>
        shortlistControls(controls, `${goal} ${hints}`, profile.maxOptions);
    const withOp: (op: ControlOperation) => Control[] = (op: ControlOperation): Control[] =>
        snapshot.controls.filter((c: Control): boolean => c.ops.includes(op));

    // A control a click just changed nothing on is not offered to CLICK again
    // until something changes (it stays hoverable: a menu may open on hover).
    const fruitless: Set<string> = fruitlessClicks(input.history);
    const pointable: Control[] = pick(withOp(ControlOperation.CLICK));
    const clickable: Control[] = pointable.filter((c: Control): boolean => !fruitless.has(describeControl(c)));
    const fillable: Control[] = pick(withOp(ControlOperation.FILL));
    const submittable: Control[] = pick(
        withOp(ControlOperation.FILL).filter((c: Control): boolean =>
            c.password ? c.filled === true : (c.value ?? "") !== ""
        )
    );
    const selectable: Control[] = withOp(ControlOperation.SELECT);

    const heads: BuiltRequest["heads"] = {};
    const targets: BuiltRequest["targets"] = {};
    const labels: BuiltRequest["labels"] = {};
    const questions: Record<string, ChoiceQuestion> = {};
    const operations: Operation[] = [];
    const targetInstructions: (operation: Operation) => unknown = (operation: Operation): unknown => {
        // The click head also answers HOVER when they offer the same elements.
        const named: string = operation === Operation.CLICK && fruitless.size === 0 ? "CLICK or HOVER" : operation;
        return profile.compact ? `${SHORT_TARGET} (${named})` : { goal, operation: named, rules: [NEXT_OPERATION, TARGET] };
    };

    const add: (operation: Operation, entries: Array<[string, unknown, Target, string]>) => void = (operation: Operation, entries: Array<[string, unknown, Target, string]>): void => {
        if (entries.length === 0) {
            return;
        }
        operations.push(operation);
        const map: Map<string, Target> = new Map();
        const criteria: Record<string, unknown> = {};
        const shown: Record<string, string> = {};
        for (const [key, criterion, target, label] of entries) {
            map.set(key, target);
            criteria[key] = criterion;
            shown[key] = label;
        }
        targets[operation] = map;
        labels[operation] = shown;
        heads[operation] = TARGET_HEADS[operation]!;
        questions[TARGET_HEADS[operation]!] = {
            type: "choice",
            criteria,
            instructions: targetInstructions(operation),
        };
    };
    const entry: (c: Control) => [string, unknown, Target, string] = (c: Control): [string, unknown, Target, string] => [
        String(c.id),
        targetCriterion(c, profile, fruitless),
        { controlId: c.id },
        describeControl(c),
    ];

    add(Operation.CLICK, clickable.map(entry));
    if (input.textChoices.length > 0) {
        add(Operation.TYPE_TEXT, fillable.map(entry));
    }
    add(
        Operation.SELECT,
        selectable
            .flatMap((c: Control): Array<[string, unknown, Target, string]> =>
                (c.options ?? []).map(
                    (o: { value: string; label: string }, i: number): [string, unknown, Target, string] => [
                        `${c.id}:${i + 1}`,
                        profile.compact
                            ? clip(`${c.name} → ${o.label}`, profile.maxLabelChars)
                            : { ...(targetCriterion(c, profile) as object), option: o.label },
                        { controlId: c.id, optionValue: o.value },
                        `${describeControl(c)} → ${o.label}`,
                    ]
                )
            )
            .slice(0, profile.maxOptions)
    );
    add(Operation.PRESS_ENTER, submittable.map(entry));
    if (fruitless.size > 0) {
        // The lists differ: hover gets its own head, with the elements a click left alone.
        add(Operation.HOVER, pointable.map(entry));
    } else if (targets[Operation.CLICK]) {
        // Hover shares the click head: same elements, same answer.
        operations.push(Operation.HOVER);
        targets[Operation.HOVER] = targets[Operation.CLICK];
        labels[Operation.HOVER] = labels[Operation.CLICK];
        heads[Operation.HOVER] = heads[Operation.CLICK];
    }
    operations.push(Operation.PRESS_KEY);
    questions[KEY_HEAD] = {
        type: "choice",
        criteria: { ...KEYS },
        instructions: profile.compact ? "Which key, for PRESS_KEY?" : { goal, rule: "Assume PRESS_KEY runs: which key advances the goal?" },
    };
    if (input.canGoBack) {
        operations.push(Operation.GO_BACK);
    }
    if (input.canGoForward) {
        operations.push(Operation.GO_FORWARD);
    }
    const otherTabs: TabInfo[] = (snapshot.tabs ?? []).filter((t: TabInfo): boolean => !t.active);
    if (otherTabs.length > 0) {
        operations.push(Operation.SWITCH_TAB, Operation.CLOSE_TAB);
        const tabCriteria: Record<string, string> = {};
        for (const tab of otherTabs) {
            tabCriteria[String(tab.index)] = clip(`${tab.title} ${tab.url}`, profile.maxLabelChars);
        }
        questions[TAB_HEAD] = {
            type: "choice",
            criteria: tabCriteria,
            instructions: profile.compact ? "Which tab, for SWITCH_TAB?" : { goal, rule: "Assume SWITCH_TAB runs: which tab advances the goal?" },
        };
    }
    if (snapshot.canScrollDown) {
        operations.push(Operation.SCROLL_DOWN);
    }
    if (snapshot.canScrollUp) {
        operations.push(Operation.SCROLL_UP);
    }
    operations.push(Operation.WAIT, Operation.DONE);
    if (input.canAskUser) {
        operations.push(Operation.ASK_USER);
        questions[ASK_USER_HEAD] = {
            type: "choice",
            criteria: { ...USER_ACTION_DESCRIPTIONS },
            instructions: profile.compact ? "Why a person is needed" : { goal, rule: "Why the next step needs a person." },
        };
    }
    operations.push(Operation.BLOCKED);

    const criteria: Record<string, string> = {};
    for (const op of operations) {
        criteria[op] = OPERATION_DESCRIPTIONS[op];
    }
    const idle: number = fruitlessWaits(input.history);
    if (criteria[Operation.WAIT] && idle >= FRUITLESS_WAITS) {
        criteria[Operation.WAIT] +=
            ` The last ${idle} WAITs changed nothing: nothing is loading. A visible control that advances the goal is the better choice.`;
    }
    questions.operation = {
        type: "choice",
        criteria,
        instructions: profile.compact ? SHORT_NEXT_OPERATION : { goal, rules: NEXT_OPERATION },
    };

    if (targets[Operation.TYPE_TEXT]) {
        const valueCriteria: Record<string, string> = {};
        for (const choice of input.textChoices.slice(0, profile.maxOptions)) {
            valueCriteria[choice.key] = clip(choice.description, profile.maxLabelChars * 2);
        }
        questions[TEXT_VALUE_HEAD] = {
            type: "choice",
            criteria: valueCriteria,
            instructions: profile.compact ? SHORT_TEXT_VALUE : { goal, rules: TEXT_VALUE },
        };
    }

    const recent: HistoryEntry[] = input.history.slice(-(profile.compact ? COMPACT_RECENT_HISTORY : RECENT_HISTORY));
    const state: Record<string, unknown> = profile.compact
        ? {
            goal,
            ...(input.now ? { now: input.now } : {}),
            page: `${snapshot.title} ${snapshot.url}\n${clip(snapshot.text, profile.maxTextChars)}`,
            recent_actions: recent.map((h: HistoryEntry): string =>
                [h.operation, h.target, h.text, h.note, h.executed || isNote(h) ? "" : `refused: ${h.reason ?? ""}`]
                    .filter(Boolean)
                    .join(" ")
            ),
        }
        : {
            ...(input.now ? { now: input.now } : {}),
            page: {
                url: snapshot.url,
                title: snapshot.title,
                visible_text: clip(snapshot.text, profile.maxTextChars),
                more_controls_offscreen: snapshot.offscreenControls,
                ...(snapshot.tabs && snapshot.tabs.length > 1
                    ? { open_tabs: snapshot.tabs.map((t: TabInfo): string => `${t.active ? "(this tab) " : ""}${t.title} ${t.url}`) }
                    : {}),
            },
            elements: snapshot.controls
                .slice(0, profile.maxStateElements)
                .map((c: Control): Record<string, unknown> => elementRow(c, fruitless)),
            recent_actions: recent.map((h: HistoryEntry): Record<string, unknown> => ({
                step: h.step,
                operation: h.operation,
                ...(h.target ? { target: h.target } : {}),
                ...(h.text ? { text: h.text } : {}),
                ...(h.executed || isNote(h) ? {} : { refused: h.reason ?? true }),
                ...(h.pageChanged === undefined ? {} : { page_changed: h.pageChanged }),
                ...(h.note ? { note: h.note } : {}),
            })),
        };
    const earlier: VisitedPage[] = (input.earlierPages ?? []).filter((p: VisitedPage): boolean => p.url !== snapshot.url);
    if (!profile.compact && earlier.length > 0) {
        state.earlier_pages = earlier.map((p: VisitedPage): string => clip(`${p.title} ${p.url}: ${p.excerpt}`, EARLIER_PAGE_CHARS));
    }
    if (!profile.compact && input.textChoices.length > 0) {
        state.available_values = input.textChoices.map((c: TextChoice): string => `${c.key}: ${c.description}`);
    }
    return { state, questions, operations, targets, labels, heads };
}

/** Turns a raw engine response into a validated decision. Pure. */
export function interpretResponse(built: BuiltRequest, response: SystemOneResponse, latencyMs: number): Decision {
    const answers: Record<string, unknown> = response.answers ?? {};
    const op: ChoiceAnswer = validateChoice(answers.operation, built.operations);
    const operation: Operation = op.choice as Operation;
    const decision: Decision = {
        operation,
        confidence: op.confidence,
        operationProbabilities: op.probabilities,
        latencyMs,
    };
    const head: string | undefined = built.heads[operation];
    const offered: Map<string, Target> | undefined = built.targets[operation];
    if (head !== undefined && offered !== undefined) {
        // Unused heads cannot cause an action; only the chosen one is validated.
        const target: ChoiceAnswer = validateChoice(answers[head], [...offered.keys()]);
        const chosen: Target = offered.get(target.choice)!;
        decision.controlId = chosen.controlId;
        decision.optionValue = chosen.optionValue;
        decision.targetProbabilities = target.probabilities;
        decision.targetLabels = built.labels[operation];
    }
    if (operation === Operation.SWITCH_TAB) {
        const tabs: string[] = Object.keys((built.questions[TAB_HEAD]?.criteria as Record<string, unknown> | undefined) ?? {});
        decision.tabIndex = Number(validateChoice(answers[TAB_HEAD], tabs).choice);
    }
    if (operation === Operation.PRESS_KEY) {
        decision.key = validateChoice(answers[KEY_HEAD], Object.keys(KEYS)).choice;
    }
    if (operation === Operation.ASK_USER) {
        // The head exists whenever ASK_USER was offered; its criteria are the kinds offered.
        const reasons: string[] = Object.keys((built.questions[ASK_USER_HEAD]?.criteria as Record<string, unknown> | undefined) ?? {});
        decision.userAction = validateChoice(answers[ASK_USER_HEAD], reasons).choice as UserActionKind;
    }
    if (operation === Operation.TYPE_TEXT) {
        // TYPE_TEXT is offered only with text choices, so the head's criteria are never empty.
        const offeredKeys: string[] = Object.keys((built.questions[TEXT_VALUE_HEAD]?.criteria as Record<string, unknown> | undefined) ?? {});
        const value: ChoiceAnswer = validateChoice(answers[TEXT_VALUE_HEAD], offeredKeys);
        decision.textKey = value.choice;
        decision.textProbabilities = value.probabilities;
    }
    return decision;
}

/** The value question alone, for one named field (the state as in the decision). Pure. */
export function buildValueRequest(
    input: DecisionInput,
    field: Control,
    profile: EngineProfile
): { state: Record<string, unknown>; questions: Record<string, ChoiceQuestion> } {
    const built: BuiltRequest = buildRequest(input, profile);
    const criteria: Record<string, string> = {};
    for (const choice of input.textChoices.slice(0, profile.maxOptions)) {
        criteria[choice.key] = clip(choice.description, profile.maxLabelChars * 2);
    }
    const target: string = `${describeControl(field)}${field.password ? " (a password field)" : ""}`;
    return {
        state: built.state,
        questions: {
            [TEXT_VALUE_HEAD]: {
                type: "choice",
                criteria,
                instructions: profile.compact
                    ? `${SHORT_TEXT_VALUE} Field: ${clip(target, profile.maxLabelChars)}`
                    : { goal: input.goal, field: target, rules: TEXT_VALUE },
            },
        },
    };
}

/**
 * The field-text question alone (the state as in the decision). Each option names the text the field
 * would hold, so the engine judges the result, not a rule. Pure.
 */
export function buildFieldTextRequest(
    input: DecisionInput,
    field: Control,
    options: Record<FieldTextChoice, string>,
    profile: EngineProfile
): { state: Record<string, unknown>; questions: Record<string, ChoiceQuestion> } {
    const built: BuiltRequest = buildRequest(input, profile);
    const criteria: Record<string, string> = {};
    for (const [choice, text] of Object.entries(options)) {
        criteria[choice] = clip(text, profile.maxLabelChars * 2);
    }
    const target: string = describeControl(field);
    return {
        state: built.state,
        questions: {
            [FIELD_TEXT_HEAD]: {
                type: "choice",
                criteria,
                instructions: profile.compact
                    ? `${SHORT_FIELD_TEXT} Field: ${clip(target, profile.maxLabelChars)}`
                    : { goal: input.goal, field: target, rules: FIELD_TEXT },
            },
        },
    };
}

/** Asks, and asks once more when the answer cannot be acted on (nothing was executed in between). */
async function withOneRetry<T>(attempt: () => Promise<T>): Promise<T> {
    try {
        return await attempt();
    } catch (err: unknown) {
        if (!(err instanceof InvalidAnswerError)) {
            throw err;
        }
        return attempt();
    }
}

/** A page too large for the engine is asked again with this share of the text, elements and options. */
const SHRINK_STEPS: number[] = [1, 0.5, 0.25];

/** The profile a request is built with at `share` of its size (at least a few options stay). */
export function shrunkProfile(profile: EngineProfile, share: number): EngineProfile {
    if (share >= 1) {
        return profile;
    }
    return {
        ...profile,
        maxTextChars: Math.floor(profile.maxTextChars * share),
        maxStateElements: Math.max(10, Math.floor(profile.maxStateElements * share)),
        maxOptions: Math.max(10, Math.floor(profile.maxOptions * share)),
    };
}

/**
 * Asks with the engine's full profile and, when the request is larger than the engine takes (a long
 * page, many controls with long names), again with less of the page — nothing was executed.
 */
async function withShrinking<T>(profile: EngineProfile, attempt: (profile: EngineProfile) => Promise<T>): Promise<T> {
    for (let i: number = 0; ; i++) {
        try {
            return await attempt(shrunkProfile(profile, SHRINK_STEPS[i]));
        } catch (err: unknown) {
            if (!(err instanceof RequestTooLargeError) || i === SHRINK_STEPS.length - 1) {
                throw err;
            }
        }
    }
}

/** Decides with any decision engine. */
export class EngineDecider implements Decider {
    constructor(private readonly engine: DecisionEngine) {}

    async decide(input: DecisionInput): Promise<Decision> {
        return withShrinking(this.engine.profile, async (profile: EngineProfile): Promise<Decision> => {
            const built: BuiltRequest = buildRequest(input, profile);
            return withOneRetry(async (): Promise<Decision> => {
                const started: number = performance.now();
                const response: SystemOneResponse = await this.engine.ask(built.state, built.questions);
                return interpretResponse(built, response, Math.round(performance.now() - started));
            });
        });
    }

    async chooseValue(input: DecisionInput, field: Control): Promise<{ textKey: string; probabilities: Record<string, number> }> {
        return withShrinking(
            this.engine.profile,
            async (profile: EngineProfile): Promise<{ textKey: string; probabilities: Record<string, number> }> => {
                const request: { state: Record<string, unknown>; questions: Record<string, ChoiceQuestion> } = buildValueRequest(
                    input,
                    field,
                    profile
                );
                return withOneRetry(async (): Promise<{ textKey: string; probabilities: Record<string, number> }> => {
                    const response: SystemOneResponse = await this.engine.ask(request.state, request.questions);
                    const value: ChoiceAnswer = validateChoice(
                        response.answers?.[TEXT_VALUE_HEAD],
                        Object.keys(request.questions[TEXT_VALUE_HEAD].criteria as Record<string, unknown>)
                    );
                    return { textKey: value.choice, probabilities: value.probabilities };
                });
            }
        );
    }

    async chooseFieldText(
        input: DecisionInput,
        field: Control,
        options: Record<FieldTextChoice, string>
    ): Promise<{ choice: FieldTextChoice; probabilities: Record<string, number> }> {
        return withShrinking(
            this.engine.profile,
            async (profile: EngineProfile): Promise<{ choice: FieldTextChoice; probabilities: Record<string, number> }> => {
                const request: { state: Record<string, unknown>; questions: Record<string, ChoiceQuestion> } = buildFieldTextRequest(
                    input,
                    field,
                    options,
                    profile
                );
                return withOneRetry(async (): Promise<{ choice: FieldTextChoice; probabilities: Record<string, number> }> => {
                    const response: SystemOneResponse = await this.engine.ask(request.state, request.questions);
                    const answer: ChoiceAnswer = validateChoice(response.answers?.[FIELD_TEXT_HEAD], Object.keys(options));
                    return { choice: answer.choice as FieldTextChoice, probabilities: answer.probabilities };
                });
            }
        );
    }
}
