/**
 * EXPERIMENT (IBEXPRESS_GENERIC_TOOLS=1): the agent's observe/act pair built on
 * IronBee DevTools' general tools instead of its `control` domain.
 *
 * - The snapshot is Playwright's ARIA snapshot (`a11y_take-aria-snapshot`):
 *   roles and names as the browser's accessibility computation gives them,
 *   refs to act on. The whole tree is read for text, state and the context of
 *   identical controls; then its interactive part, whose refs are the ones
 *   the next action uses (a snapshot replaces the session's refs).
 * - An action is the matching `interaction_*` / `navigation_*` tool on the
 *   control's ref (Playwright's own checks: visible, stable, receives the
 *   click), then — with `waitForNetworkMs` — `sync_wait-for-network-idle`,
 *   then the next snapshot.
 *
 * Same `snapshot()` / `act()` contract as DevtoolsClient, so the agent does
 * not change. What this cannot know: whether a field is a password (the
 * accessibility tree does not say; DevTools itself still checks where a
 * password secret goes), which controls are on screen (the ARIA snapshot
 * covers the whole page; a click scrolls to its target), and where the page
 * is scrolled to (no general tool reads that without scrolling), so both
 * scroll directions are offered.
 */

import { createHash } from "crypto";
import { DEFAULT_LIMITS, DevtoolsClient, DevtoolsClientOptions, DevtoolsError, SECRET_DENIED } from "./client";
import { sleep } from "../util/time";
import {
    ActRequest,
    ActResult,
    Control,
    ControlAction,
    ControlOperation,
    ControlOption,
    ControlSnapshot,
    SnapshotLimits,
    TabInfo,
} from "./types";

const ACTION_TIMEOUT_MS: number = 3_000;
const SCROLL_STEP_PX: number = 600;
const NETWORK_IDLE_MS: number = 150;
const CONTEXT_CHARS: number = 140;
const TYPE_ROLES: string[] = ["textbox", "searchbox", "spinbutton", "combobox"];
const STATE_ROLES: string[] = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"];

/** One line of an ARIA snapshot, as a tree. */
interface AriaNode {
    role: string;
    name?: string;
    attrs: string[];
    ref?: string;
    value?: string;
    texts: string[];
    children: AriaNode[];
    parent?: AriaNode;
}

interface AriaTree {
    url: string;
    title: string;
    root: AriaNode;
}

interface AriaSnapshotOutput {
    output: string;
    refs: Record<string, { role: string; name: string }>;
}

/** Reads the YAML-like ARIA snapshot the tool prints into a tree. */
export function parseAriaSnapshot(output: string): AriaTree {
    const url: string = /- Page URL: (.*)/.exec(output)?.[1]?.trim() ?? "";
    const title: string = /- Page Title: (.*)/.exec(output)?.[1]?.trim() ?? "";
    const yaml: string = /```yaml\n([\s\S]*?)```/.exec(output)?.[1] ?? "";
    const root: AriaNode = { role: "root", attrs: [], texts: [], children: [] };
    const stack: Array<{ indent: number; node: AriaNode }> = [{ indent: -1, node: root }];
    for (const line of yaml.split("\n")) {
        const m: RegExpExecArray | null = /^(\s*)- (.*)$/.exec(line);
        if (!m) {
            continue;
        }
        const indent: number = m[1].length;
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }
        const parent: AriaNode = stack[stack.length - 1].node;
        const content: string = m[2];
        if (content.startsWith("/")) {
            continue; // /url, /placeholder: properties, not content
        }
        const text: RegExpExecArray | null = /^text: (.*)$/.exec(content);
        if (text) {
            parent.texts.push(unquote(text[1]));
            continue;
        }
        const node: AriaNode = parseNode(content, parent);
        parent.children.push(node);
        stack.push({ indent, node });
    }
    return { url, title, root };
}

function unquote(s: string): string {
    const t: string = s.trim().replace(/:$/, "");
    if (t.startsWith('"') && t.endsWith('"')) {
        try {
            return JSON.parse(t) as string;
        } catch {
            return t.slice(1, -1);
        }
    }
    return t;
}

function parseNode(content: string, parent: AriaNode): AriaNode {
    let rest: string = content;
    const role: string = /^[a-zA-Z]+/.exec(rest)?.[0] ?? "generic";
    rest = rest.slice(role.length);
    let name: string | undefined;
    const quoted: RegExpExecArray | null = /^ ("(?:[^"\\]|\\.)*")/.exec(rest);
    if (quoted) {
        name = unquote(quoted[1]);
        rest = rest.slice(quoted[0].length);
    }
    const attrs: string[] = [];
    let attr: RegExpExecArray | null;
    while ((attr = /^ \[([^\]]*)\]/.exec(rest))) {
        attrs.push(attr[1]);
        rest = rest.slice(attr[0].length);
    }
    const ref: string | undefined = attrs.find((a: string): boolean => a.startsWith("ref="))?.slice(4);
    const inline: RegExpExecArray | null = /^: (.+)$/.exec(rest);
    return {
        role,
        ...(name !== undefined ? { name } : {}),
        attrs: attrs.filter((a: string): boolean => !a.startsWith("ref=")),
        ...(ref ? { ref } : {}),
        ...(inline ? { value: unquote(inline[1]) } : {}),
        texts: [],
        children: [],
        parent,
    };
}

function walk(node: AriaNode, visit: (n: AriaNode) => void): void {
    for (const child of node.children) {
        visit(child);
        walk(child, visit);
    }
}

/** All the words a subtree shows: names, values and text. */
function subtreeText(node: AriaNode): string {
    const parts: string[] = [];
    const add: (n: AriaNode) => void = (n: AriaNode): void => {
        if (n.name) {parts.push(n.name);}
        if (n.value) {parts.push(n.value);}
        parts.push(...n.texts);
    };
    add(node);
    walk(node, add);
    return parts.join(" ").replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function attrValue(attrs: string[], key: string): string | undefined {
    for (const a of attrs) {
        if (a === key) {return "true";}
        if (a.startsWith(`${key}=`)) {return a.slice(key.length + 1);}
    }
    return undefined;
}

export class GenericDevtoolsClient extends DevtoolsClient {
    private snapshotCount: number = 0;
    private latest?: { snapshotId: number; refs: Map<number, string> };

    override async snapshot(limits: SnapshotLimits): Promise<ControlSnapshot> {
        const page: ControlSnapshot = await this.readSnapshot(limits);
        await this.onSnapshot?.(page);
        return page;
    }

    private async readSnapshot(limits: SnapshotLimits): Promise<ControlSnapshot> {
        // The whole tree first (text, state, context); then the interactive part, whose refs the next action uses.
        const full: AriaSnapshotOutput = await this.call<AriaSnapshotOutput>("a11y_take-aria-snapshot", {});
        const interactive: AriaSnapshotOutput = await this.call<AriaSnapshotOutput>("a11y_take-aria-snapshot", {
            interactiveOnly: true,
        });
        const tree: AriaTree = parseAriaSnapshot(full.output);
        const flat: AriaTree = parseAriaSnapshot(interactive.output);

        // The full tree's nodes by role + name, in order: where the interactive refs sit in it.
        const byKey: Map<string, AriaNode[]> = new Map();
        // A disabled node is never offered: left out here too, so the index lines up with the
        // offered controls whether or not the interactive tree lists it.
        walk(tree.root, (n: AriaNode): void => {
            if (n.attrs.includes("disabled")) {
                return;
            }
            const key: string = `${n.role}\u0000${n.name ?? ""}`;
            byKey.set(key, [...(byKey.get(key) ?? []), n]);
        });
        const seen: Map<string, number> = new Map();
        const refs: Map<number, string> = new Map();
        const controls: Control[] = [];
        let omitted: number = 0;
        walk(flat.root, (n: AriaNode): void => {
            if (!n.ref || n.attrs.includes("disabled")) {
                return;
            }
            if (controls.length >= limits.maxControls) {
                omitted++;
                return;
            }
            const key: string = `${n.role}\u0000${n.name ?? ""}`;
            const index: number = seen.get(key) ?? 0;
            seen.set(key, index + 1);
            const inTree: AriaNode | undefined = byKey.get(key)?.[index];
            const id: number = Number(n.ref.replace(/^\D+/, ""));
            refs.set(id, n.ref);
            controls.push(this.toControl(id, n, inTree));
        });
        this.addContext(controls, tree.root);

        const tabs: TabInfo[] = await this.call<{ tabs: TabInfo[] }>("navigation_list-tabs", {})
            .then((r: { tabs: TabInfo[] }): TabInfo[] => r.tabs)
            .catch((): TabInfo[] => []);
        const text: string = await this.pageText(limits.maxTextChars).catch((): string => subtreeText(tree.root));
        const snapshotId: number = ++this.snapshotCount;
        this.latest = { snapshotId, refs };
        return {
            snapshotId,
            url: tree.url,
            title: tree.title,
            text: text.slice(0, limits.maxTextChars),
            controls,
            omittedControls: omitted,
            offscreenControls: 0,
            // Unknown (see the header): scrolling is offered both ways, not measured.
            canScrollUp: true,
            canScrollDown: true,
            fingerprint: createHash("sha256").update(full.output).digest("hex").slice(0, 16),
            ...(tabs.length > 1 ? { tabs } : {}),
        };
    }

    private toControl(id: number, n: AriaNode, inTree: AriaNode | undefined): Control {
        const source: AriaNode = inTree ?? n;
        const options: ControlOption[] = source.children
            .filter((c: AriaNode): boolean => c.role === "option" && !c.attrs.includes("selected"))
            .map((c: AriaNode): ControlOption => ({ value: c.name ?? "", label: c.name ?? "" }));
        const ops: ControlOperation[] = [];
        if (n.role === "combobox" && options.length > 0) {
            ops.push(ControlOperation.SELECT);
        } else if (TYPE_ROLES.includes(n.role)) {
            ops.push(ControlOperation.FILL, ControlOperation.CLICK);
        } else {
            ops.push(ControlOperation.CLICK);
        }
        const value: string | undefined = n.value ?? source.value ?? (TYPE_ROLES.includes(n.role) ? source.texts[0] : undefined);
        const checked: string | undefined =
            attrValue(n.attrs, "checked") ?? (STATE_ROLES.includes(n.role) ? "false" : undefined);
        const selected: string | undefined = attrValue(n.attrs, "selected");
        const expanded: string | undefined = attrValue(n.attrs, "expanded");
        return {
            id,
            role: n.role,
            name: clip(n.name ?? n.role, 160),
            ops,
            ...(value ? { value: clip(value, 200) } : {}),
            ...(checked ? { checked } : {}),
            ...(selected ? { selected } : {}),
            ...(expanded ? { expanded } : {}),
            ...(ops.includes(ControlOperation.SELECT) ? { options } : {}),
        };
    }

    /**
     * Identical controls (role + name) are told apart by what the page shows
     * between the previous one and each: the accessibility tree flattens the
     * boxes a page groups them in (a product card), so that stretch — its
     * title, its text — is what goes with each.
     */
    private addContext(controls: Control[], root: AriaNode): void {
        const count: Map<string, number> = new Map();
        for (const c of controls) {
            const key: string = `${c.role}\u0000${c.name}`;
            count.set(key, (count.get(key) ?? 0) + 1);
        }
        // The tree in reading order: text pieces, and the controls among them.
        const sequence: Array<{ text: string } | { key: string }> = [];
        const visit: (n: AriaNode) => void = (n: AriaNode): void => {
            const key: string = `${n.role}\u0000${clip(n.name ?? n.role, 160)}`;
            // Only a control that was offered takes a slot: a disabled twin is text here, or every
            // later twin would be labelled with the text before its neighbour.
            if (n.ref && !n.attrs.includes("disabled") && (count.get(key) ?? 0) > 1) {
                sequence.push({ key });
            } else {
                for (const part of [n.name, n.value]) {
                    if (part) {
                        sequence.push({ text: part });
                    }
                }
            }
            for (const t of n.texts) {
                sequence.push({ text: t });
            }
            for (const child of n.children) {
                visit(child);
            }
        };
        for (const child of root.children) {
            visit(child);
        }
        const since: Map<string, string[]> = new Map();
        const contexts: Map<string, string[]> = new Map();
        for (const item of sequence) {
            if ("text" in item) {
                for (const texts of since.values()) {
                    texts.push(item.text);
                }
                continue;
            }
            const before: string[] = since.get(item.key) ?? [];
            contexts.set(item.key, [...(contexts.get(item.key) ?? []), before.join(" ").replace(/\s+/g, " ").trim()]);
            since.set(item.key, []);
        }
        // The first one has no previous: what came before it on the page (its own card) is all there is.
        const firstBefore: Map<string, string> = new Map();
        const running: string[] = [];
        for (const item of sequence) {
            if ("text" in item) {
                running.push(item.text);
            } else if (!firstBefore.has(item.key)) {
                firstBefore.set(item.key, running.slice(-12).join(" "));
            }
        }
        const used: Map<string, number> = new Map();
        for (const c of controls) {
            const key: string = `${c.role}\u0000${c.name}`;
            if ((count.get(key) ?? 0) < 2) {
                continue;
            }
            const index: number = used.get(key) ?? 0;
            used.set(key, index + 1);
            const text: string = index === 0 ? (firstBefore.get(key) ?? "") : (contexts.get(key)?.[index] ?? "");
            if (text.length >= 2) {
                c.context = clip(text, CONTEXT_CHARS);
            }
        }
    }

    protected override async actOnce(request: ActRequest): Promise<ActResult> {
        const limits: SnapshotLimits = {
            maxControls: request.maxControls ?? DEFAULT_LIMITS.maxControls,
            maxTextChars: request.maxTextChars ?? DEFAULT_LIMITS.maxTextChars,
        };
        const observe: () => Promise<ControlSnapshot | undefined> = async (): Promise<ControlSnapshot | undefined> =>
            request.observe === false ? undefined : this.readSnapshot(limits);
        if (request.controlId !== undefined && request.snapshotId !== this.latest?.snapshotId) {
            return { executed: false, reason: `stale: snapshot ${request.snapshotId} is not the latest`, snapshot: await observe() };
        }
        const ref: string | undefined =
            request.controlId === undefined ? undefined : this.latest?.refs.get(request.controlId);
        if (request.controlId !== undefined && ref === undefined) {
            return { executed: false, reason: `no control ${request.controlId}`, snapshot: await observe() };
        }
        try {
            await this.perform(request, ref);
        } catch (err: unknown) {
            if (err instanceof DevtoolsError && err.code !== SECRET_DENIED) {
                return { executed: false, reason: err.message, snapshot: await observe() };
            }
            throw err;
        }
        let networkIdle: boolean | undefined;
        if (request.waitForNetworkMs) {
            const idle: { finalInFlightRequests?: number } = await this.call<{ finalInFlightRequests?: number }>(
                "sync_wait-for-network-idle",
                { timeoutMs: request.waitForNetworkMs, idleTimeMs: NETWORK_IDLE_MS }
            ).catch((): { finalInFlightRequests?: number } => ({ finalInFlightRequests: 1 }));
            networkIdle = (idle.finalInFlightRequests ?? 0) === 0;
        }
        return { executed: true, ...(networkIdle !== undefined ? { networkIdle } : {}), snapshot: await observe() };
    }

    private async perform(request: ActRequest, ref: string | undefined): Promise<void> {
        const timeoutMs: number = ACTION_TIMEOUT_MS;
        switch (request.action) {
            case ControlAction.CLICK:
                await this.call("interaction_click", { selector: ref, timeoutMs });
                return;
            case ControlAction.FILL:
                await this.call("interaction_fill", { selector: ref, value: request.value ?? "", timeoutMs });
                return;
            case ControlAction.SELECT:
                await this.call("interaction_select", { selector: ref, value: request.value ?? "", timeoutMs });
                return;
            case ControlAction.PRESS_ENTER:
                await this.call("interaction_press-key", { key: "Enter", selector: ref, timeoutMs });
                return;
            case ControlAction.PRESS_KEY:
                await this.call("interaction_press-key", { key: request.value ?? "", ...(ref ? { selector: ref } : {}), timeoutMs });
                return;
            case ControlAction.HOVER:
                await this.call("interaction_hover", { selector: ref, timeoutMs });
                return;
            case ControlAction.SCROLL_DOWN:
            case ControlAction.SCROLL_UP:
                await this.call("interaction_scroll", {
                    mode: "by",
                    dy: request.action === ControlAction.SCROLL_DOWN ? SCROLL_STEP_PX : -SCROLL_STEP_PX,
                });
                return;
            case ControlAction.WAIT:
                await sleep(request.waitMs ?? 300);
                return;
            case ControlAction.GO_BACK:
            case ControlAction.GO_FORWARD:
                await this.call("navigation_go-back-or-forward", {
                    direction: request.action === ControlAction.GO_BACK ? "back" : "forward",
                });
                return;
            case ControlAction.SWITCH_TAB:
                await this.call("navigation_switch-tab", { index: Number(request.value) });
                return;
            case ControlAction.CLOSE_TAB:
                // No value: the active tab (the tool's own default), not `index: NaN`.
                await this.call("navigation_close-tab", request.value ? { index: Number(request.value) } : {});
                return;
        }
    }
}

/** The client the agent uses: this experiment's with IBEXPRESS_GENERIC_TOOLS=1, else the control-domain one. */
export function createDevtoolsClient(options: DevtoolsClientOptions): DevtoolsClient {
    return process.env.IBEXPRESS_GENERIC_TOOLS === "1" ? new GenericDevtoolsClient(options) : new DevtoolsClient(options);
}
