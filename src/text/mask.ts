import { TextChoice, TextRef, TextSource } from "./types";

/**
 * `maskSecretsEncoded` under the name the invariants use: there is one masking, and it covers
 * the encoded forms too (a raw-only variant was one a caller could pick by mistake).
 */
export function maskSecrets<T>(value: T, secrets: Record<string, string>): T {
    return maskSecretsEncoded(value, secrets);
}

/**
 * Replaces every occurrence of a secret value in page-derived data or a tool output with
 * `[secret:name]` — a page may display the very value (a demo login hint, an echoed field);
 * nothing sent to a model may carry it. Raw, and the ways a request body, a URL or a page's
 * source carries it: url-encoded (`encodeURIComponent` and the form-urlencoded shape a browser
 * submits — `!'()~` escaped, space as `+`), JSON-escaped, HTML-escaped — each masked under the
 * secret's own name. Also the shapes a page read gives back: whitespace collapsed, and a value
 * cut short (its first 16+ characters up to a `…`, DevTools' own truncation note — `CUT_MARKS` —
 * or the end of the text).
 */
export function maskSecretsEncoded<T>(value: T, secrets: Record<string, string>): T {
    const forms: Array<[string, string]> = [];
    for (const [name, secret] of Object.entries(secrets)) {
        forms.push(
            [name, secret],
            [name, encodeURIComponent(secret)],
            [name, encodeURIComponent(secret).replace(/%20/g, "+")],
            [name, new URLSearchParams([["", secret]]).toString().slice(1)],
            [name, JSON.stringify(secret).slice(1, -1)],
            ...htmlForms(secret).map((form: string): [string, string] => [name, form])
        );
    }
    return maskForms(value, forms);
}

/**
 * The HTML-escaped shapes of a value: `& < >` always, the quotes as the common escapers write
 * them — `"` as `&quot;` or `&#34;`, `'` left alone, `&#39;` (most template engines) or `&#x27;` (React).
 */
function htmlForms(secret: string): string[] {
    const base: string = secret.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const out: string[] = [];
    for (const dq of ["&quot;", "&#34;"]) {
        for (const sq of ["'", "&#39;", "&#x27;"]) {
            out.push(base.replace(/"/g, dq).replace(/'/g, sq));
        }
    }
    return out;
}

/** The shortest start of a value that is masked where it was cut off (at a cut mark or the end). */
const MIN_CUT_CHARS: number = 16;

/**
 * What follows a value cut short: "…" (the runtime's and this package's own cuts) or the note
 * DevTools appends to a text or HTML read it cut (`content_get-as-text` / `-as-html`) — read
 * unmasked when this process, not DevTools, holds the secrets.
 */
const CUT_MARKS: readonly string[] = ["…", "\n[Output truncated due to size limits]", "\n<!-- Output truncated due to size limits -->"];

/**
 * Masks a value that reached this process already cut short: a start of `form` of at least
 * MIN_CUT_CHARS that runs up to a cut mark (`CUT_MARKS`) or to the end of `s` (DevTools clips a
 * field's value and the page text before anything masks it). A start followed by other text is
 * not a cut value.
 */
function maskCut(s: string, name: string, form: string, wholeForms: ReadonlySet<string>): string {
    if (form.length <= MIN_CUT_CHARS) {
        return s;
    }
    const head: string = form.slice(0, MIN_CUT_CHARS);
    let out: string = s;
    let from: number = 0;
    for (;;) {
        const at: number = out.indexOf(head, from);
        if (at < 0) {
            return out;
        }
        let end: number = at + MIN_CUT_CHARS;
        while (end < out.length && end - at < form.length && out[end] === form[end - at]) {
            end++;
        }
        // A span that is exactly another secret's whole value is that secret, not this one cut
        // short (a user name a password starts with): its own whole pass labels it.
        const cut: boolean = end - at < form.length && (end === out.length || CUT_MARKS.some((m: string): boolean => out.startsWith(m, end)));
        if (!cut) {
            from = at + 1;
        } else if (wholeForms.has(out.slice(at, end))) {
            // Left whole for its own pass; not searched again inside, or a value that repeats its
            // own start would be split under this name.
            from = end;
        } else {
            const marker: string = `[secret:${name}]`;
            out = `${out.slice(0, at)}${marker}${out.slice(end)}`;
            from = at + marker.length;
        }
    }
}

/** Replaces each form (a secret or an encoding of one) with `[secret:name]`. */
function maskForms<T>(value: T, forms: Array<[string, string]>): T {
    // The shapes a page read gives back: whitespace collapsed and trimmed (a multi-line value
    // in a field reads as one line).
    const shaped: Array<[string, string]> = forms.flatMap(([name, v]: [string, string]): Array<[string, string]> => {
        const collapsed: string = v.replace(/\s+/g, " ").trim();
        return collapsed === v ? [[name, v]] : [[name, v], [name, collapsed]];
    });
    // A plain value has one shape under every encoding: masked once, or the marker
    // itself is re-masked when the value is a part of it (`admin=admin`).
    const seen: Set<string> = new Set();
    const entries: Array<[string, string]> = shaped
        .filter(([name, v]: [string, string]): boolean => {
            const key: string = `${name}\u0000${v}`;
            if (v.length === 0 || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        })
        // Longest first, so a secret containing another is masked whole.
        .sort((a: [string, string], b: [string, string]): number => b[1].length - a[1].length);
    if (entries.length === 0) {
        return value;
    }
    const wholeForms: ReadonlySet<string> = new Set(entries.map(([, v]: [string, string]): string => v));
    const maskString: (s: string) => string = (s: string): string => {
        let out: string = s;
        // Per form, longest first: the whole value, then what is left of it cut short — before a
        // shorter value's whole match can split a longer one's head (a password that starts with
        // the user name).
        for (const [name, secret] of entries) {
            out = maskCut(out.split(secret).join(`[secret:${name}]`), name, secret, wholeForms);
        }
        return out;
    };
    const walk: (v: unknown) => unknown = (v: unknown): unknown => {
        if (typeof v === "string") {
            return maskString(v);
        }
        if (Array.isArray(v)) {
            return v.map(walk);
        }
        if (v && typeof v === "object") {
            return Object.fromEntries(
                Object.entries(v).map(([k, x]: [string, unknown]): [string, unknown] => [k, walk(x)])
            );
        }
        return v;
    };
    return walk(value) as T;
}

/** What history, logs and the UI may show for a typed value: secrets by name only. */
export function visibleText(choice: TextChoice, text: string): string {
    return choice.source === TextSource.SECRET ? `<secret ${choice.name ?? choice.key}>` : text;
}

/** How a recording refers to a typed value: secrets by name only. */
export function textRefOf(choice: TextChoice, text: string): TextRef {
    const name: string | undefined =
        choice.source === TextSource.VALUE || choice.source === TextSource.SECRET ? choice.name : undefined;
    return {
        source: choice.source,
        ...(name !== undefined ? { name } : {}),
        ...(choice.source === TextSource.SECRET ? {} : { text }),
    };
}

/** The same choices without their text — what a decision engine is given. */
export function withoutText(choices: TextChoice[]): TextChoice[] {
    return choices.map(({ text: _text, ...rest }: TextChoice): TextChoice => rest);
}
