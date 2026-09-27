/**
 * The page side of the control snapshot (`control_take-snapshot`) and the
 * guarded executor (`control_act`).
 *
 * ONE self-contained function, dispatched on `req.op`, because Playwright
 * serializes the function source into the page: it may not close over
 * anything, so every helper lives inside it. Each call re-sends the source
 * (a few KB over CDP), which is cheaper than any install/version handshake.
 *
 * Node identity: a WeakMap gives each observed element a numeric id, and a Map
 * keeps the live reference the executor acts on. Replaced elements get new
 * ids; disconnected ones are pruned; a navigation starts a new cache. The
 * cache is a non-enumerable, symbol-keyed window property. The page can reach
 * it — this is a staleness guard, not a security boundary: a hostile page can
 * rearrange its own DOM just as well, and the model can only ever pick an id
 * the snapshot offered.
 */

/** Operations a control offers. Mirrored by `ControlOperation` on the Node side. */
export type RuntimeOperation = "click" | "fill" | "select";

export interface RuntimeOption {
    value: string;
    label: string;
}

export interface RuntimeControl {
    id: number;
    role: string;
    name: string;
    ops: RuntimeOperation[];
    value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
    /** A password field: offered for fill, its value never read. */
    password?: boolean;
    /** Password fields only: whether it holds anything — never what. */
    filled?: boolean;
    /** Nearby text, only for controls whose role + name repeat ("Add to cart"). */
    context?: string;
    options?: RuntimeOption[];
    /** Set on the Node side for a control inside an iframe: the frame's host. */
    frame?: string;
}

export interface RuntimeSnapshot {
    url: string;
    title: string;
    text: string;
    viewport: { width: number; height: number };
    scroll: { y: number; height: number };
    controls: RuntimeControl[];
    omittedControls: number;
    offscreenControls: number;
    /** Document + form-state key compared by target-scoped guards. */
    pageKey: unknown;
    /** Per control id: the target's own state and its nearby context. */
    guards: Record<string, unknown>;
    /** Everything the model saw; hashed on the Node side into the fingerprint. */
    marker: unknown;
}

export interface RuntimeSnapshotRequest {
    op: "snapshot";
    maxControls: number;
    maxTextChars: number;
    /**
     * A frame's part the page shows, in the frame's own viewport coordinates:
     * a control whose center is outside it is counted offscreen, not offered.
     */
    clip?: { x: number; y: number; width: number; height: number };
}

export interface RuntimeGuardRequest {
    op: "guard";
    id: number;
    /** The context the control was shown with (identical controls): checked to still hold. */
    context?: string;
}

export interface RuntimeLocateRequest {
    op: "locate";
    id: number;
    kind: RuntimeOperation;
    /** For `select`: the option value that must still be offered. */
    value?: string;
    /** A frame's control: keep how to put back a scrolled list, for a refusal on the page (`unscroll`). */
    keepUnscroll?: boolean;
}

export interface RuntimeSelectAllRequest {
    op: "select-all";
    /** The control the fill is for: focus on another field the page showed is not selected. */
    id?: number;
}

/** Puts back the list the last successful `locate` scrolled (a later check refused the click). */
export interface RuntimeUnscrollRequest {
    op: "unscroll";
}

export interface RuntimeSettleRequest {
    op: "settle";
    id?: number;
    kind: string;
    frameBudgetMs: number;
    autocompleteBudgetMs: number;
    /** Running animations that end within this (from the action) are waited for. */
    animationBudgetMs: number;
    /** The id of the action marks' host: its shadow root's own animations are not the page's. */
    skipHostId?: string;
}

export type RuntimeRequest =
    | RuntimeSnapshotRequest
    | RuntimeGuardRequest
    | RuntimeLocateRequest
    | RuntimeSelectAllRequest
    | RuntimeUnscrollRequest
    | RuntimeSettleRequest;

export interface RuntimeLocateResult {
    x?: number;
    y?: number;
    error?: string;
    /** A click here opens a new tab or window (a link with a new-browsing-context target). */
    opensTab?: boolean;
}

/**
 * Runs inside the page. Returns `null` for a snapshot while the document has
 * no body yet (navigating) — the caller retries.
 */
export function controlRuntime(req: RuntimeRequest): unknown {
    interface Cache {
        ids: WeakMap<Element, number>;
        nodes: Map<number, Element>;
        next: number;
        /** How to put back what the last successful `locate` scrolled. */
        unscroll?: () => void;
        /** The controls the last snapshot offered. */
        offered?: WeakSet<Element>;
    }
    const KEY: symbol = Symbol.for("ironbee.devtools.controls");
    const win: any = window as any;
    let cache: Cache | undefined = win[KEY];
    if (!cache) {
        cache = { ids: new WeakMap(), nodes: new Map(), next: 1 };
        Object.defineProperty(win, KEY, {
            value: cache,
            enumerable: false,
            configurable: true,
        });
    }
    const c: Cache = cache;

    const identity: (e: Element) => number = (e: Element): number => {
        let id: number | undefined = c.ids.get(e);
        if (id === undefined) {
            id = c.next++;
            c.ids.set(e, id);
        }
        c.nodes.set(id, e);
        return id;
    };
    for (const [id, e] of c.nodes) {
        if (!e.isConnected) {c.nodes.delete(id);}
    }

    const clip: (s: string, n: number) => string = (s: string, n: number): string => {
        const t: string = s.replace(/\s+/g, " ").trim();
        return t.length > n ? t.slice(0, n - 1) + "…" : t;
    };
    // A password field is offered (it is how a sign-in is driven) but its
    // value is never read — not into the snapshot, the guards or the
    // fingerprint. `safe` gates value reads; `offerable` gates candidates:
    // file/hidden inputs are not things a click or a typed value can drive.
    const isPassword: (e: Element) => boolean = (e: Element): boolean =>
        e.tagName === "INPUT" && (e as HTMLInputElement).type === "password";
    const safe: (e: Element) => boolean = (e: Element): boolean =>
        !isPassword(e) &&
        !["file", "hidden"].includes((e as HTMLInputElement).type);
    const offerable: (e: Element) => boolean = (e: Element): boolean =>
        !["file", "hidden"].includes((e as HTMLInputElement).type);
    // Whether an element is drawn at all (not display:none / visibility:
    // hidden, like a <style>, an SVG <title> or a collapsed part): a name is
    // made of text that is drawn, as an accessibility tree makes it.
    const rendered: (e: Element) => boolean = (e: Element): boolean => {
        const cv: any = (e as any).checkVisibility;
        if (typeof cv === "function") {
            return cv.call(e, { checkVisibilityCSS: true });
        }
        const s: CSSStyleDeclaration = getComputedStyle(e);
        return s.display !== "none" && s.visibility !== "hidden";
    };
    // Offered to a reader: seen on the screen and not hidden from assistive
    // technology.
    const visible: (e: Element) => boolean = (e: Element): boolean =>
        !inHiddenRegion(e) && shown(e);
    const disabled: (e: Element) => boolean = (e: Element): boolean =>
        e.matches(":disabled") || !!e.closest('[aria-disabled="true"]');
    const byId: (e: Element, id: string) => Element | null = (e: Element, id: string): Element | null => {
        const root: any = e.getRootNode();
        return typeof root.getElementById === "function"
            ? root.getElementById(id)
            : document.getElementById(id);
    };
    const name: (e: Element | null, seen?: Set<Element>) => string = (
        e: Element | null,
        seen: Set<Element> = new Set()
    ): string => {
        if (!e || seen.has(e)) {return "";}
        seen.add(e);
        const referenced: string = (e.getAttribute("aria-labelledby") || "")
            .split(/\s+/)
            .filter(Boolean)
            .map((id: string): string => name(byId(e, id), seen))
            .filter(Boolean)
            .join(" ");
        if (referenced) {return referenced;}
        const label: string | null = e.getAttribute("aria-label");
        if (label && label.trim()) {return label;}
        const labels: NodeListOf<HTMLLabelElement> | null =
            (e as HTMLInputElement).labels ?? null;
        if (labels && labels.length) {
            const text: string = [...labels]
                .map((l: Element): string => name(l, seen))
                .filter(Boolean)
                .join(" ");
            if (text) {return text;}
        }
        const type: string = (e as HTMLInputElement).type;
        if (
            e.tagName === "INPUT" &&
            ["button", "submit", "reset"].includes(type)
        ) {
            return (e as HTMLInputElement).value;
        }
        const alt: string | null = e.getAttribute("alt");
        if (alt) {return alt;}
        if (!["INPUT", "TEXTAREA", "SELECT"].includes(e.tagName)) {
            const text: string = [...e.childNodes]
                .map((n: Node): string => {
                    if (n.nodeType === 3) {return n.textContent || "";}
                    if (n.nodeType !== 1) {return "";}
                    const child: Element = n as Element;
                    if (child.getAttribute("aria-hidden") === "true") {return "";}
                    if (!rendered(child)) {return "";}
                    if (child.tagName === "IMG") {
                        return child.getAttribute("alt") || "";
                    }
                    return name(child, seen);
                })
                .join(" ")
                .trim();
            if (text) {return text;}
        }
        return e.getAttribute("title") || e.getAttribute("placeholder") || "";
    };

    const ROLES: string[] = [
        "button",
        "link",
        "checkbox",
        "radio",
        "switch",
        "tab",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "option",
        "gridcell",
        "treeitem",
        "combobox",
        "textbox",
        "searchbox",
        "spinbutton",
    ];
    const SELECTOR: string =
        'a[href],button,input,textarea,select,summary,[contenteditable="true"],[contenteditable=""],' +
        ROLES.map((r: string): string => `[role="${r}"]`).join(",");
    const role: (e: Element) => string | null = (e: Element): string | null => {
        const explicit: string = (e.getAttribute("role") || "").split(/\s+/)[0];
        if (ROLES.includes(explicit)) {return explicit;}
        const tag: string = e.tagName;
        if (tag === "BUTTON" || tag === "SUMMARY") {return "button";}
        if (tag === "A") {return "link";}
        if (tag === "SELECT") {return "combobox";}
        if (tag === "TEXTAREA" || (e as HTMLElement).isContentEditable) {
            return "textbox";
        }
        if (tag === "INPUT") {
            const type: string = (e as HTMLInputElement).type;
            if (type === "checkbox" || type === "radio") {return type;}
            if (["button", "submit", "reset", "image"].includes(type)) {
                return "button";
            }
            if (type === "search") {return "searchbox";}
            if (type === "password") {return "textbox";}
            if (type === "number") {return "spinbutton";}
            if (
                [
                    "text",
                    "email",
                    "url",
                    "tel",
                    "date",
                    "time",
                    "datetime-local",
                    "month",
                    "week",
                ].includes(type)
            ) {
                return "textbox";
            }
        }
        return null;
    };
    const editable: (e: Element, r: string) => boolean = (e: Element, r: string): boolean => {
        if ((e as HTMLInputElement).readOnly) {return false;}
        if (e.getAttribute("aria-readonly") === "true") {return false;}
        if (["textbox", "searchbox", "spinbutton"].includes(r)) {return true;}
        return (
            r === "combobox" &&
            (e.tagName === "INPUT" || e.tagName === "TEXTAREA")
        );
    };
    // Seen on the screen: aria-hidden hides from assistive technology, not
    // from the eye, so it does not count here.
    const shown: (e: Element) => boolean = (e: Element): boolean => {
        if (inInertRegion(e)) {return false;}
        const cv: any = (e as any).checkVisibility;
        if (typeof cv === "function") {
            return cv.call(e, { checkOpacity: true, checkVisibilityCSS: true });
        }
        const s: CSSStyleDeclaration = getComputedStyle(e);
        return (
            s.display !== "none" &&
            s.visibility !== "hidden" &&
            s.opacity !== "0"
        );
    };
    const composedParent: (e: Element) => Element | null = (e: Element): Element | null => {
        const n: Node | null = e.assignedSlot ?? e.parentNode ?? null;
        if (!n) {return null;}
        return n.nodeType === Node.ELEMENT_NODE
            ? (n as Element)
            : ((n as ShadowRoot).host ?? null);
    };
    // What a click at (x, y) in `e`'s document or shadow root lands on.
    const hitAt: (e: Element, x: number, y: number) => Element | null = (e: Element, x: number, y: number): Element | null => {
        const root: any = e.getRootNode();
        return typeof root.elementFromPoint === "function"
            ? root.elementFromPoint(x, y)
            : document.elementFromPoint(x, y);
    };
    // Whether the element or a region above it — through slots and shadow
    // hosts, the tree a reader walks; `Element.closest` stops at a shadow
    // boundary — matches `test`.
    const composedAny: (start: Element | null, test: (n: Element) => boolean) => boolean = (
        start: Element | null,
        test: (n: Element) => boolean
    ): boolean => {
        for (let n: Element | null = start; n; n = composedParent(n)) {
            if (test(n)) {return true;}
        }
        return false;
    };
    const ariaHidden: (n: Element) => boolean = (n: Element): boolean =>
        n.getAttribute("aria-hidden") === "true";
    const inert: (n: Element) => boolean = (n: Element): boolean => n.hasAttribute("inert");
    // Hidden from assistive technology: the element itself or a region above it.
    const inHiddenRegion: (e: Element) => boolean = (e: Element): boolean =>
        composedAny(e, ariaHidden);
    // Inert: the element or a region above it takes no input.
    const inInertRegion: (e: Element) => boolean = (e: Element): boolean =>
        composedAny(e, inert);
    // Only a region ABOVE the element is hidden (the element itself may be).
    const hiddenAbove: (e: Element) => boolean = (e: Element): boolean =>
        composedAny(composedParent(e), ariaHidden);
    // What a person clicks for a control: the control itself when it is seen,
    // else a label of it that is seen (HTML: clicking a label activates its
    // control). A control nothing visible stands for is not offered. A control
    // inside a region hidden from assistive technology (the page behind a
    // modal) is not offered; only its label may be marked hidden (the control
    // carries the name).
    // A control a site made invisible and draws itself (a custom checkbox's
    // circle, a menu button over its own label, a styled select): the site's
    // drawing is what a person sees and clicks, and the click lands on the
    // invisible control laid over it. Which invisible things are such a
    // control is decided by what they ARE to a reader, not by tag: a toggle,
    // a choice or a button — something a click operates, that nothing is typed
    // into and that goes nowhere. Links (an invisible ad over an article),
    // text fields (a spam trap) and menu items (one mid-animation) are not.
    const OPERATED_BY_CLICK: string[] = ["checkbox", "radio", "switch", "button"];
    const operatedByClick: (e: Element) => boolean = (e: Element): boolean => {
        const r: string | null = role(e);
        if (!r) {return false;}
        if (OPERATED_BY_CLICK.includes(r)) {return true;}
        // A choice list that is not typed into (a select).
        return r === "combobox" && !editable(e, r);
    };
    // The box that lays an element out: past a slot and `display: contents`
    // wrappers, which render nothing of their own.
    const layoutParent: (e: Element) => Element | null = (e: Element): Element | null => {
        let n: Element | null = composedParent(e);
        while (n && (n.tagName === "SLOT" || getComputedStyle(n).display === "contents")) {
            n = composedParent(n);
        }
        return n;
    };
    // Laid over its drawing, an invisible control is as large as the drawing;
    // one smaller than this is a visually hidden control ("sr-only", 1 px)
    // whose label is what a person clicks — reached through the label instead.
    const MIN_OVERLAY_PX: number = 8;
    // Made invisible on purpose — its OWN opacity is 0 while its container is
    // shown (a control hidden with its container, a closed menu, is not one),
    // not hidden from assistive technology, and big enough to be the thing
    // clicked.
    const overlayCandidate: (e: Element) => boolean = (e: Element): boolean => {
        if (!operatedByClick(e)) {return false;}
        if (inHiddenRegion(e) || inInertRegion(e)) {return false;}
        if (getComputedStyle(e).opacity !== "0") {return false;}
        const parent: Element | null = layoutParent(e);
        if (!parent || !visible(parent)) {return false;}
        const r: DOMRect = e.getBoundingClientRect();
        return r.width >= MIN_OVERLAY_PX && r.height >= MIN_OVERLAY_PX;
    };
    // ...and a click at its center reaches it: a person's click there does too.
    const invisibleOverlay: (e: Element) => boolean = (e: Element): boolean => {
        if (!overlayCandidate(e)) {return false;}
        const p: { x: number; y: number; ok: boolean } = center(e);
        return p.ok && composedContains(e, hitAt(e, p.x, p.y));
    };
    // Such a control whose only fault is lying outside the viewport: counted
    // with the controls a scroll reaches.
    const overlayOffscreen: (e: Element) => boolean = (e: Element): boolean =>
        overlayCandidate(e) && !center(e).ok;
    const clickTarget: (e: Element) => Element | null = (e: Element): Element | null => {
        if (visible(e)) {return e;}
        if (invisibleOverlay(e)) {return e;}
        if (inHiddenRegion(e)) {return null;}
        const labels: NodeListOf<HTMLLabelElement> | null =
            (e as HTMLInputElement).labels ?? null;
        if (labels) {
            for (const l of labels) {
                // The label itself may be hidden from assistive technology;
                // a region around it may not.
                if (hiddenAbove(l)) {continue;}
                if (shown(l)) {return l;}
            }
        }
        return null;
    };
    const center: (e: Element) => { x: number; y: number; ok: boolean } = (e: Element): { x: number; y: number; ok: boolean } => {
        const r: DOMRect = e.getBoundingClientRect();
        const x: number = r.x + r.width / 2;
        const y: number = r.y + r.height / 2;
        return {
            x,
            y,
            ok:
                r.width > 0 &&
                r.height > 0 &&
                x >= 0 &&
                y >= 0 &&
                x < innerWidth &&
                y < innerHeight,
        };
    };
    // The lists a person can scroll (overflow auto / scroll — not hidden or
    // clip: a carousel or a collapsed "read more" is revealed by its own
    // controls) that hide the element's center, innermost first.
    const hidingScrollers: (e: Element) => Element[] = (e: Element): Element[] => {
        const out: Element[] = [];
        const at: { x: number; y: number; ok: boolean } = center(e);
        let n: Element | null = composedParent(e);
        while (n && n !== document.documentElement && n !== document.body) {
            const s: CSSStyleDeclaration = getComputedStyle(n);
            if (/(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`)) {
                const r: DOMRect = n.getBoundingClientRect();
                if (
                    at.x < r.left ||
                    at.x >= r.right ||
                    at.y < r.top ||
                    at.y >= r.bottom
                ) {
                    out.push(n);
                }
            }
            n = composedParent(n);
        }
        return out;
    };
    // Scrolls those lists — only them, never the window or a parent frame —
    // so the element sits in their middle (clear of a sticky header or
    // footer). Returns how to put them back.
    const revealInScrollers: (e: Element) => () => void = (e: Element): (() => void) => {
        const moved: Array<[Element, number, number]> = [];
        for (const scroller of hidingScrollers(e)) {
            const at: { x: number; y: number; ok: boolean } = center(e);
            const r: DOMRect = scroller.getBoundingClientRect();
            moved.push([scroller, scroller.scrollLeft, scroller.scrollTop]);
            scroller.scrollBy({
                left: at.x - (r.left + r.width / 2),
                top: at.y - (r.top + r.height / 2),
                behavior: "instant" as ScrollBehavior,
            });
        }
        return (): void => {
            for (const [scroller, left, top] of moved) {
                scroller.scrollTo({
                    left,
                    top,
                    behavior: "instant" as ScrollBehavior,
                });
            }
        };
    };
    const composedContains: (
        outer: Element,
        inner: Element | null
    ) => boolean = (
        outer: Element,
        inner: Element | null
    ): boolean => {
        let n: Node | null = inner;
        while (n) {
            if (n === outer) {return true;}
            n =
                (n as Element).assignedSlot ??
                n.parentNode ??
                ((n as ShadowRoot).host || null);
        }
        return false;
    };
    // Whether a click at a point that lands on `hit` reaches `target`: on it
    // or inside it, or on a label of it (a floating label drawn over a field
    // passes the click on to the field).
    const clickReaches: (target: Element, hit: Element | null) => boolean = (target: Element, hit: Element | null): boolean => {
        if (composedContains(target, hit)) {return true;}
        const label: HTMLLabelElement | null =
            (hit?.closest("label") as HTMLLabelElement | null) ?? null;
        return !!label && label.control === target;
    };
    // The document a decision was made in: a navigation makes a new one. Its
    // address changing in place (a map's view, a filter in the query), its
    // scroll, its other fields and content do not make the decision stale —
    // only a change to the control it names does (guard, below).
    const docKey: () => unknown = (): unknown => [performance.timeOrigin];
    // The heading a control sits under: the last shown h1–h6 / role=heading
    // before it (identical controls with no text around them).
    const headingAbove: (e: Element) => string | undefined = (e: Element): string | undefined => {
        let found: Element | undefined;
        for (const h of document.querySelectorAll(
            'h1,h2,h3,h4,h5,h6,[role="heading"]'
        )) {
            if (!shown(h)) {continue;}
            if (
                !h.contains(e) &&
                h.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING
            ) {
                found = h;
            } else {
                break;
            }
        }
        const t: string = clip(
            ((found as HTMLElement | undefined)?.innerText || "").trim(),
            100
        );
        return t.length >= 2 ? t : undefined;
    };
    // The text around a control that tells it apart from identical ones: an
    // ancestor's text without the control's own name.
    const aroundText: (holder: Element, controlName: string) => string = (holder: Element, controlName: string): string => {
        const text: string = (holder as HTMLElement).innerText || "";
        return clip(controlName ? text.split(controlName).join(" ") : text, 140);
    };
    // The name a control is offered under: its accessible name, else its role.
    const controlName: (e: Element) => string = (e: Element): string =>
        clip(name(e) || "", 160) || (role(e) ?? "");
    // Whether a control still has the context it was shown with, read again
    // the way the snapshot read it — with the same name (a nameless control's
    // is its role, at the snapshot and here): some ancestor's text, or the
    // heading above it (its order among same-named ones is not rechecked).
    const inContext: (e: Element, context: string) => boolean = (e: Element, context: string): boolean => {
        const own: string = controlName(e);
        let a: Element | null = e.parentElement;
        for (let depth: number = 0; a && depth < 8; depth++) {
            // An ancestor's text is compared whole: it may end in " · 4/5" of its own.
            if (aroundText(a, own) === context) {return true;}
            a = a.parentElement;
        }
        // Only a heading-derived context carries the " · N/M" order suffix.
        return headingAbove(e) === context.replace(/ · \d+\/\d+$/, "");
    };
    // What a decision on a control relies on: the same element, meaning the
    // same thing — role, name, value and state, where a link goes, and for
    // identical controls the context that told them apart. Nothing else on
    // the page: a new field, a ticker or an ad elsewhere leave it standing.
    const guard: (e: Element | undefined, context?: string) => unknown = (e: Element | undefined, context?: string): unknown => {
        if (!e || !e.isConnected) {return null;}
        const target: Element | null = clickTarget(e);
        if (!target) {return null;}
        const f: HTMLInputElement = e as HTMLInputElement;
        return [
            identity(e),
            role(e),
            name(e),
            safe(e) ? (f.value ?? null) : null,
            f.checked ?? null,
            (e as HTMLSelectElement).selectedIndex ?? null,
            f.readOnly ?? null,
            e.matches(":disabled"),
            e.getAttribute("aria-disabled"),
            e.getAttribute("aria-expanded"),
            e.getAttribute("aria-checked"),
            e.getAttribute("aria-selected"),
            e.getAttribute("href"),
            context === undefined ? null : inContext(e, context),
        ];
    };
    const deepActive: () => Element | null = (): Element | null => {
        let a: Element | null = document.activeElement;
        while (a && a.shadowRoot && a.shadowRoot.activeElement) {
            a = a.shadowRoot.activeElement;
        }
        return a;
    };

    if (req.op === "guard") {
        return [docKey(), guard(c.nodes.get(req.id), req.context)];
    }

    if (req.op === "unscroll") {
        c.unscroll?.();
        c.unscroll = undefined;
        return true;
    }

    if (req.op === "select-all") {
        const a: Element | null = deepActive();
        if (!a) {return false;}
        // Focus moved to another control the snapshot offered (not the
        // target, not a field the click opened — which may have been in the
        // page, hidden, all along): typing there would fill the wrong field.
        const target: Element | undefined =
            req.id === undefined ? undefined : c.nodes.get(req.id);
        if (
            target &&
            a !== target &&
            !composedContains(target, a) &&
            c.offered?.has(a)
        ) {
            return false;
        }
        // Date and time inputs take no typed text (`insertText` leaves them empty): false sends
        // the fill to Playwright's own fill, which sets them.
        if (a.tagName === "INPUT" && ["date", "time", "datetime-local", "month", "week"].includes((a as HTMLInputElement).type)) {
            return false;
        }
        if (a.tagName === "INPUT" || a.tagName === "TEXTAREA") {
            try {
                (a as HTMLInputElement).select();
                return true;
            } catch {
                return false;
            }
        }
        if ((a as HTMLElement).isContentEditable) {
            const sel: Selection | null = getSelection();
            sel?.selectAllChildren(a);
            return true;
        }
        return false;
    }

    if (req.op === "locate") {
        c.unscroll = undefined;
        const e: Element | undefined = c.nodes.get(req.id);
        if (!e || !e.isConnected) {return { error: "the element is gone" };}
        if (disabled(e)) {return { error: "the element is disabled" };}
        const target: Element | null = clickTarget(e);
        if (!target) {return { error: "the element is not visible" };}
        if (req.kind === "fill") {
            if (!editable(e, role(e) || "")) {
                return { error: "the element is not editable" };
            }
        }
        if (req.kind === "select") {
            const s: HTMLSelectElement = e as HTMLSelectElement;
            if (
                e.tagName !== "SELECT" ||
                ![...s.options].some(
                    (o: HTMLOptionElement): boolean =>
                        o.value === req.value &&
                        !o.disabled &&
                        !o.closest("optgroup[disabled]")
                )
            ) {
                return { error: "the option is not available" };
            }
        }
        let p: { x: number; y: number; ok: boolean } = center(target);
        if (!p.ok) {return { error: "the element is outside the viewport" };}
        if (!clickReaches(target, hitAt(target, p.x, p.y))) {
            // Inside a scrolled list (a language picker, a dropdown's options)
            // the target can sit past the list's visible part: in the
            // viewport, yet clipped. A person scrolls the list first; so does
            // this — only when the click would miss (a menu drawn outside a
            // scrolled panel is not in it, and scrolling the panel may close
            // it), and back again when the click still cannot go ahead.
            const restore: () => void = revealInScrollers(target);
            p = center(target);
            if (!p.ok) {
                restore();
                return { error: "the element is outside the viewport" };
            }
            if (!clickReaches(target, hitAt(target, p.x, p.y))) {
                restore();
                return { error: "the element is covered by another element" };
            }
            // A check outside this document (the page over this frame) may
            // still refuse the click: it can put the list back (`unscroll`).
            if (req.keepUnscroll) {c.unscroll = restore;}
        }
        // A link whose target names a new browsing context: the tab it opens
        // arrives some milliseconds after the click, so the caller waits for it.
        const link: Element | null = e.closest("a[href], area[href]");
        const linkTarget: string = (
            link?.getAttribute("target") || ""
        ).toLowerCase();
        const opensTab: boolean =
            req.kind === "click" &&
            linkTarget !== "" &&
            !["_self", "_top", "_parent"].includes(linkTarget);
        return opensTab ? { x: p.x, y: p.y, opensTab } : { x: p.x, y: p.y };
    }

    if (req.op === "settle") {
        const settle: RuntimeSettleRequest = req;
        const field: Element | undefined =
            settle.id === undefined ? undefined : c.nodes.get(settle.id);
        const autocomplete: boolean =
            settle.kind === "fill" &&
            !!field &&
            (field.getAttribute("role") === "combobox" ||
                field.hasAttribute("aria-autocomplete") ||
                field.hasAttribute("list"));
        return new Promise((resolve: (v: boolean) => void): void => {
            let frames: number = 0;
            let done: boolean = false;
            let waiting: boolean = false;
            const deadline: number =
                performance.now() + settle.animationBudgetMs;
            const finish: () => void = (): void => {
                if (!done) {
                    done = true;
                    resolve(true);
                }
            };
            // The longest time a running, finite animation (a CSS transition,
            // a panel sliding in) has left: a snapshot taken mid-way reads
            // controls where they are passing through and text that is about
            // to change, and the next action is refused as stale or covered.
            // Endless ones (spinners) never end and are not waited for. An
            // animation inside a shadow root (a web component's own drawer)
            // is not in `document.getAnimations()`: the page's open shadow
            // roots are asked too — except the action marks' own host
            // (`skipHostId`), whose ripple and box animate for 0.7–0.9 s
            // after every marked action and are not the page's.
            const shadowRoots: () => ShadowRoot[] = (): ShadowRoot[] => {
                const roots: ShadowRoot[] = [];
                const collect: (root: ParentNode) => void = (root: ParentNode): void => {
                    for (const e of root.querySelectorAll("*")) {
                        if (e.shadowRoot && e.id !== settle.skipHostId) {
                            roots.push(e.shadowRoot);
                            collect(e.shadowRoot);
                        }
                    }
                };
                collect(document);
                return roots;
            };
            const animationLeftMs: () => number = (): number => {
                let left: number = 0;
                const animations: Animation[] = [
                    ...document.getAnimations(),
                    ...shadowRoots().flatMap((r: ShadowRoot): Animation[] => r.getAnimations()),
                ];
                for (const a of animations) {
                    if (a.playState !== "running") {continue;}
                    const end: unknown = a.effect?.getComputedTiming().endTime;
                    if (typeof end !== "number" || !isFinite(end)) {continue;}
                    const rate: number = Math.abs(a.playbackRate) || 1;
                    left = Math.max(
                        left,
                        (end - Number(a.currentTime ?? 0)) / rate
                    );
                }
                return left;
            };
            const afterFrames: () => void = (): void => {
                if (done) {return;}
                const left: number = animationLeftMs();
                if (left <= 0 || performance.now() + left > deadline) {
                    finish();
                } else {
                    setTimeout(afterFrames, Math.min(left, 100) + 10);
                }
            };
            const startWaiting: () => void = (): void => {
                if (waiting) {return;}
                waiting = true;
                afterFrames();
            };
            setTimeout(
                startWaiting,
                autocomplete
                    ? settle.autocompleteBudgetMs
                    : settle.frameBudgetMs
            );
            const optionsVisible: () => boolean = (): boolean => {
                const ids: string[] = (
                    field?.getAttribute("aria-controls") ||
                    field?.getAttribute("aria-owns") ||
                    ""
                )
                    .split(/\s+/)
                    .filter(Boolean);
                const roots: ParentNode[] = ids.length
                    ? (ids
                        .map((id: string): Element | null => byId(field!, id))
                        .filter(Boolean) as Element[])
                    : [document];
                return roots.some((r: ParentNode): boolean =>
                    [...r.querySelectorAll('[role="option"]')].some(
                        (o: Element): boolean => visible(o) && center(o).ok
                    )
                );
            };
            const tick: () => void = (): void => {
                if (done || waiting) {return;}
                frames++;
                if (frames >= 2 && (!autocomplete || optionsVisible())) {
                    startWaiting();
                } else {
                    requestAnimationFrame(tick);
                }
            };
            requestAnimationFrame(tick);
        });
    }

    // op === 'snapshot'
    if (!document.body) {return null;}
    const snap: RuntimeSnapshotRequest = req;
    const candidates: Element[] = [];
    const walk: (root: ParentNode) => void = (root: ParentNode): void => {
        for (const e of root.querySelectorAll("*")) {
            if (e.matches(SELECTOR)) {candidates.push(e);}
            if (e.shadowRoot) {walk(e.shadowRoot);}
        }
    };
    walk(document);

    const controls: RuntimeControl[] = [];
    let offscreen: number = 0;
    for (const e of candidates) {
        if (!offerable(e) || disabled(e)) {continue;}
        const r: string | null = role(e);
        if (!r) {continue;}
        const target: Element | null = clickTarget(e);
        if (!target) {
            // An invisible control below the fold: reachable by scrolling.
            if (overlayOffscreen(e)) {offscreen++;}
            continue;
        }
        const at: { x: number; y: number; ok: boolean } = center(target);
        const visibleArea:
            | { x: number; y: number; width: number; height: number }
            | undefined = snap.clip;
        if (
            !at.ok ||
            (visibleArea !== undefined &&
                (at.x < visibleArea.x ||
                    at.y < visibleArea.y ||
                    at.x >= visibleArea.x + visibleArea.width ||
                    at.y >= visibleArea.y + visibleArea.height))
        ) {
            offscreen++;
            continue;
        }
        // A control another element lies over — a popover over a calendar, a
        // modal over the page — is not one a person can click, and a click on
        // it would be refused: it is not offered, so the decision goes to
        // what covers it (a close button). A target past a scrolled list's
        // visible part is not covered: the action scrolls the list to it.
        if (
            !clickReaches(target, hitAt(target, at.x, at.y)) &&
            hidingScrollers(target).length === 0
        ) {
            continue;
        }
        const control: RuntimeControl = {
            id: identity(e),
            role: r,
            name: controlName(e),
            ops: [],
        };
        for (const key of ["checked", "selected", "expanded"] as const) {
            const v: string | null = e.getAttribute("aria-" + key);
            if (v !== null) {control[key] = v;}
        }
        const type: string = (e as HTMLInputElement).type;
        if (
            e.tagName === "INPUT" &&
            (type === "checkbox" || type === "radio")
        ) {
            control.checked = String((e as HTMLInputElement).checked);
        }
        if (e.tagName === "SELECT") {
            const s: HTMLSelectElement = e as HTMLSelectElement;
            control.value = clip(
                [...s.selectedOptions]
                    .map((o: HTMLOptionElement): string => o.label)
                    .join(", "),
                200
            );
            control.options = [...s.options]
                .filter(
                    (o: HTMLOptionElement): boolean =>
                        !o.selected &&
                        !o.disabled &&
                        !o.closest("optgroup[disabled]")
                )
                .slice(0, 50)
                .map(
                    (o: HTMLOptionElement): RuntimeOption => ({
                        value: o.value,
                        label: clip(o.label, 120),
                    })
                );
            if (control.options.length) {control.ops.push("select");}
        } else {
            const canFill: boolean = editable(e, r);
            const raw: string =
                "value" in e &&
                typeof (e as HTMLInputElement).value === "string"
                    ? (e as HTMLInputElement).value
                    : (e as HTMLElement).isContentEditable || r === "combobox"
                        ? (e as HTMLElement).innerText
                        : "";
            if (isPassword(e)) {
                control.password = true;
                control.filled = (e as HTMLInputElement).value.length > 0;
            } else if (canFill || r === "combobox" || raw) {
                control.value = clip(raw, 200);
            }
            if (canFill) {control.ops.push("fill");}
            control.ops.push("click");
        }
        if (control.ops.length) {controls.push(control);}
    }

    // A control whose click lands on another offered control inside it (a
    // calendar cell around its day button, a card link around its button)
    // is that control to a person: only the inner one is offered. When the
    // inner one is hidden, covered or disabled the click lands on the outer
    // one, which stays.
    const offeredElements: Set<Element> = new Set(
        controls.map(
            (control: RuntimeControl): Element => c.nodes.get(control.id)!
        )
    );
    for (let i: number = controls.length - 1; i >= 0; i--) {
        const outer: Element = c.nodes.get(controls[i].id)!;
        const target: Element | null = clickTarget(outer);
        if (!target) {continue;}
        const at: { x: number; y: number; ok: boolean } = center(target);
        for (
            let n: Element | null = hitAt(target, at.x, at.y);
            n && n !== outer;
            n = composedParent(n)
        ) {
            if (offeredElements.has(n) && composedContains(outer, n)) {
                offeredElements.delete(outer);
                controls.splice(i, 1);
                break;
            }
        }
    }

    // Identical controls ("Add to cart" per product) are told apart by the
    // text of their smallest ancestor that says more than the control itself
    // and holds no other control of the same group.
    const groups: Map<string, Element[]> = new Map();
    for (const control of controls) {
        const k: string = control.role + "\u0000" + control.name;
        const group: Element[] = groups.get(k) || [];
        group.push(c.nodes.get(control.id)!);
        groups.set(k, group);
    }
    for (const control of controls) {
        const group: Element[] =
            groups.get(control.role + "\u0000" + control.name) || [];
        if (group.length < 2) {continue;}
        const self: Element = c.nodes.get(control.id)!;
        let a: Element | null = self.parentElement;
        for (let depth: number = 0; a && depth < 8; depth++) {
            const holder: Element = a;
            if (
                group.some(
                    (other: Element): boolean =>
                        other !== self && holder.contains(other)
                )
            ) {
                break;
            }
            const t: string = aroundText(holder, control.name);
            if (t.length >= 2) {
                control.context = t;
                break;
            }
            a = a.parentElement;
        }
    }
    // Identical controls with no text around them (a demo's bare checkboxes)
    // are told apart by the heading they sit under, and their order there.
    const bare: Map<string, RuntimeControl[]> = new Map();
    for (const control of controls) {
        const group: Element[] =
            groups.get(control.role + "\u0000" + control.name) || [];
        if (group.length < 2 || control.context !== undefined) {continue;}
        const heading: string | undefined = headingAbove(
            c.nodes.get(control.id)!
        );
        if (heading === undefined) {continue;}
        const k: string =
            control.role + "\u0000" + control.name + "\u0000" + heading;
        bare.set(k, [...(bare.get(k) || []), control]);
        control.context = heading;
    }
    for (const same of bare.values()) {
        if (same.length < 2) {continue;}
        same.forEach((control: RuntimeControl, i: number): void => {
            control.context = `${control.context} · ${i + 1}/${same.length}`;
        });
    }

    const words: string[] = [];
    const walker: TreeWalker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
    );
    const range: Range = document.createRange();
    let length: number = 0;
    let node: Node | null;
    while ((node = walker.nextNode()) && length < snap.maxTextChars) {
        const value: string = (node.textContent || "").trim();
        const parent: Element | null = node.parentElement;
        if (!value || !parent) {continue;}
        if (parent.closest("script,style,noscript,template")) {continue;}
        if (!visible(parent)) {continue;}
        range.selectNodeContents(node);
        const r: DOMRect = range.getBoundingClientRect();
        if (
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.top < innerHeight &&
            r.right > 0 &&
            r.left < innerWidth
        ) {
            words.push(value);
            length += value.length + 1;
        }
    }
    const text: string = words.join("\n").slice(0, snap.maxTextChars);

    const omitted: number = Math.max(0, controls.length - snap.maxControls);
    controls.splice(snap.maxControls);
    c.offered = new WeakSet(
        controls.map(
            (control: RuntimeControl): Element => c.nodes.get(control.id)!
        )
    );
    const documentKey: unknown = docKey();
    const guards: Record<string, unknown> = {};
    for (const control of controls) {
        guards[String(control.id)] = guard(
            c.nodes.get(control.id),
            control.context
        );
    }
    const height: number = document.documentElement.scrollHeight;
    return {
        url: location.href,
        title: document.title,
        text,
        viewport: { width: innerWidth, height: innerHeight },
        scroll: { y: scrollY, height },
        controls,
        omittedControls: omitted,
        offscreenControls: offscreen,
        pageKey: documentKey,
        guards,
        // Meaning and identity only: geometry is re-read and hit-tested at
        // execution time, so an animation alone never invalidates a decision.
        marker: [
            performance.timeOrigin,
            location.href,
            scrollX,
            scrollY,
            innerWidth,
            innerHeight,
            document.title,
            text,
            controls,
            // Form values (not passwords): a value typed or ticked is a change.
            [...document.querySelectorAll("input,textarea,select")]
                .filter(safe)
                .map((e: Element): unknown[] => {
                    const f: HTMLInputElement = e as HTMLInputElement;
                    return [
                        identity(e),
                        f.value,
                        f.checked,
                        (e as HTMLSelectElement).selectedIndex,
                        f.disabled,
                        f.readOnly,
                    ];
                }),
        ],
    } satisfies RuntimeSnapshot;
}
