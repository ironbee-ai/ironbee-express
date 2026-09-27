/**
 * The evidence as text an engine can judge, and the small helpers that name
 * requests, log records and severities the same way everywhere.
 */

import { describeJourney } from "./journey";
import { headLines, linesSize, tailLines } from "./lines";
import { Control } from "../devtools/types";
import { pathAndQuery } from "../util/url";
import { CapturedRequest, PageEvidence, TraceEvidence, TraceLogRecord, TraceSpanRecord } from "./types";

/** API responses shown to the engine: the latest this many, bodies whole while they fit (bodyCap). */
const API_REQUESTS: number = 60;
/**
 * Shares of the evidence budget, so the whole text fits it: the final page's text and the API
 * responses; the journey, the controls' state and the console errors bounded too; the trace takes
 * what is left (about 12 % at the least, more when a share goes unused).
 */
const PAGE_SHARE: number = 0.3;
const API_SHARE: number = 0.35;
const JOURNEY_SHARE: number = 0.15;
const CONTROLS_SHARE: number = 0.05;
const CONSOLE_SHARE: number = 0.03;
/** The final page's address as its heading: a long query is cut. */
const HEADING_CHARS: number = 300;
/** Log records and spans shown to the engine. */
const TRACE_LOGS: number = 80;
const TRACE_SPANS: number = 60;
const LINE_CHARS: number = 220;
/** A request's address in the evidence: a long query (an app packing state into it) is cut. */
const URL_CHARS: number = 160;
/** Controls with a state listed for the final page. */
const CONTROL_LINES: number = 80;

/** OTLP severity numbers: each name starts its range. */
const SEVERITIES: Array<[string, number]> = [
    ["TRACE", 1],
    ["DEBUG", 5],
    ["INFO", 9],
    ["WARN", 13],
    ["ERROR", 17],
    ["FATAL", 21],
];
export const WARN_SEVERITY: number = 13;
export const ERROR_SEVERITY: number = 17;

export function severityName(n: number | undefined): string {
    let name: string = "UNSPECIFIED";
    for (const [label, start] of SEVERITIES) {
        if ((n ?? 0) >= start) {
            name = label;
        }
    }
    return name;
}

export function shortUrl(url: string): string {
    const short: string = pathAndQuery(url);
    return short.length > URL_CHARS ? `${short.slice(0, URL_CHARS)}…` : short;
}

/** `/api/items/65?x=1` → `/api/items/*`: ids become wildcards, the query goes. */
export function urlPattern(url: string): string {
    let path: string = url;
    try {
        path = new URL(url).pathname;
    } catch {
        path = url.split("?")[0];
    }
    return path
        .split("/")
        .map((seg: string): string => (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) ? "*" : seg))
        .join("/");
}

/** The key the UI identifies a log record by. */
export function logKey(log: { timeNs?: string; service?: string; body: string }): string {
    return `${log.timeNs ?? ""}|${log.service ?? ""}|${log.body}`;
}

export function isFailedSpan(span: { status?: string }): boolean {
    return (span.status ?? "").toUpperCase().includes("ERROR");
}

/** The items whose id the described text carries: the only ones an engine can be asked to point at. */
export function itemsIn(items: EvidenceItem[], text: string): EvidenceItem[] {
    // By the whole line start, not the bare `[r3]`: page text that happens to contain one does not
    // make an item the text does not carry offerable.
    const lines: string[] = text.split("\n");
    return items.filter((item: EvidenceItem): boolean => lines.some((line: string): boolean => line.startsWith(item.head)));
}

/**
 * The longest a body may be so that every body, cut to it, fits `budget`: short bodies stay whole
 * and only the longest are cut, all to the same length. Infinity when everything fits.
 */
export function bodyCap(lengths: number[], budget: number): number {
    const sorted: number[] = [...lengths].sort((a: number, b: number): number => a - b);
    let remaining: number = budget;
    for (let i: number = 0; i < sorted.length; i++) {
        const share: number = remaining / (sorted.length - i);
        if (sorted[i] > share) {
            return Math.max(0, Math.floor(share));
        }
        remaining -= sorted[i];
    }
    return Infinity;
}

/**
 * The final page's controls that have a state — checked, selected, expanded, a value, a filled
 * password field — as text: what a checkbox or a picker holds is not in the page's text.
 */
export function describeControls(controls: Control[]): string {
    return controls
        .map((c: Control): string => {
            const state: string[] = [];
            for (const key of ["checked", "selected", "expanded"] as const) {
                if (c[key] !== undefined) {
                    state.push(`${key}=${c[key]}`);
                }
            }
            if (c.password) {
                // Never its value: whether it holds one.
                if (c.filled !== undefined) {
                    state.push(`filled=${c.filled}`);
                }
            } else if (c.value !== undefined && c.value !== "") {
                state.push(`value=${JSON.stringify(c.value.slice(0, 120))}`);
            }
            return state.length ? `${c.role} "${c.name}"${c.context ? ` (${c.context.slice(0, 60)})` : ""}: ${state.join(" ")}` : "";
        })
        .filter(Boolean)
        .slice(0, CONTROL_LINES)
        .join("\n");
}

/** The kinds of evidence item an engine can point at, as their ids start: `[r3]`, `[l12]`, `[s5]`. */
export enum EvidenceKind {
    RESPONSE = "r",
    LOG = "l",
    SPAN = "s",
}

/** One piece of evidence, by the id it carries in the described evidence, and a short label for it. */
export interface EvidenceItem {
    id: string;
    label: string;
    /** How its line starts in the described evidence (`[r3] GET /api/x → 500`): what `itemsIn` looks for. */
    head: string;
}

function responseHead(r: CapturedRequest, i: number): string {
    return `[${EvidenceKind.RESPONSE}${i + 1}] ${r.method} ${shortUrl(r.url)} → ${r.status ?? r.failure ?? "no response"}`;
}

function logHead(l: TraceLogRecord, i: number): string {
    return `[${EvidenceKind.LOG}${i + 1}] ${describeLog(l)}`;
}

function spanHead(sp: TraceSpanRecord, i: number): string {
    return `[${EvidenceKind.SPAN}${i + 1}] ${sp.service ?? "?"}: ${sp.name} ${sp.status ?? "UNSET"} ${Math.round(sp.durationMs)}ms`;
}

/**
 * The API responses, log records and spans the described evidence lists, by the ids they carry there
 * — what an engine can be asked to point at (the goal's `failure_cause`).
 */
export function evidenceItems(evidence: PageEvidence): EvidenceItem[] {
    const items: EvidenceItem[] = [];
    (evidence.requests ?? []).slice(-API_REQUESTS).forEach((r: CapturedRequest, i: number): void => {
        items.push({ id: `${EvidenceKind.RESPONSE}${i + 1}`, label: `${r.method} ${shortUrl(r.url)} → ${r.status ?? r.failure ?? "no response"}`, head: responseHead(r, i) });
    });
    (evidence.trace?.logs ?? []).slice(-TRACE_LOGS).forEach((l: TraceLogRecord, i: number): void => {
        items.push({ id: `${EvidenceKind.LOG}${i + 1}`, label: `${l.service ?? "?"}: ${l.body.replace(/\s+/g, " ").slice(0, 140)}`, head: logHead(l, i) });
    });
    (evidence.trace?.spans ?? []).slice(0, TRACE_SPANS).forEach((sp: TraceSpanRecord, i: number): void => {
        items.push({ id: `${EvidenceKind.SPAN}${i + 1}`, label: `${sp.service ?? "?"}: ${sp.name} ${sp.status ?? "UNSET"}`, head: spanHead(sp, i) });
    });
    return items;
}

/**
 * The API traffic as text: method, path, status and the body per request, within `budgetChars` —
 * bodies cut first; when the lines alone do not fit, the oldest go.
 */
export function describeApiResponses(requests: CapturedRequest[], budgetChars: number): string {
    const recent: CapturedRequest[] = requests.slice(-API_REQUESTS);
    const heads: string[] = recent.map((r: CapturedRequest, i: number): string => responseHead(r, i));
    const bodies: string[] = recent.map((r: CapturedRequest): string => (r.body ?? "").replace(/\s+/g, " ").trim());
    // Per line beside its body: the space before it, a cut body's "…" and the newline.
    const fixed: number = heads.reduce((n: number, head: string): number => n + head.length + 3, 0);
    const cap: number = bodyCap(
        bodies.map((b: string): number => b.length),
        Math.max(0, budgetChars - fixed)
    );
    const lines: string[] = recent.map((_r: CapturedRequest, i: number): string => {
        const body: string = bodies[i].length > cap ? `${bodies[i].slice(0, cap)}…` : bodies[i];
        return `${heads[i]}${body ? ` ${body}` : ""}`;
    });
    return tailLines(lines, budgetChars).join("\n");
}

export function describeLog(log: TraceLogRecord): string {
    return `[${log.service ?? "?"} ${severityName(log.severityNumber)}] ${log.body.replace(/\s+/g, " ").slice(0, LINE_CHARS)}`;
}

/**
 * The run's trace as text: services, the log records (time order) and the spans (start order) —
 * what the backend did, which the page often does not show — within `budget` characters: the log
 * records keep at least half of it when the spans need more (the latest records are kept), the
 * spans the rest (the first ones).
 */
export function describeTrace(trace: TraceEvidence, budget: number = Infinity): string {
    const services: string = `Services: ${
        trace.services
            .map(
                (s: { name: string; spanCount: number; errorCount: number }): string =>
                    `${s.name} (${s.spanCount} spans${s.errorCount ? `, ${s.errorCount} failed` : ""})`
            )
            .join(", ") || "none"
    }`.slice(0, LINE_CHARS * 2);
    const logLines: string[] = trace.logs
        .slice(-TRACE_LOGS)
        .map((l: TraceLogRecord, i: number): string => logHead(l, i));
    const spanLines: string[] = trace.spans
        .slice(0, TRACE_SPANS)
        .map(
            (sp: TraceSpanRecord, i: number): string =>
                `${spanHead(sp, i)}${sp.statusMessage ? ` — ${sp.statusMessage.slice(0, LINE_CHARS)}` : ""}`
        );
    const LOGS_HEADING: string = "Log records, in time order:";
    const SPANS_HEADING: string = "Spans, in start order:";
    const room: number = budget - services.length - (logLines.length ? LOGS_HEADING.length + 2 : 0) - (spanLines.length ? SPANS_HEADING.length + 2 : 0);
    const logs: string[] = tailLines(logLines, Math.max(0, room - Math.min(linesSize(spanLines), room / 2)));
    const spans: string[] = headLines(spanLines, Math.max(0, room - linesSize(logs)));
    return [
        services,
        ...(logs.length ? [LOGS_HEADING, ...logs] : []),
        ...(spans.length ? [SPANS_HEADING, ...spans] : []),
    ].join("\n");
}

/**
 * Everything the engine judges a run on, as one text of at most `budget` characters: each part
 * within its share (the final page 30 %, the API responses 35 %, the journey 15 %, the controls'
 * state 5 %, the console errors 3 %) and the trace in what is left — so a long page does not push
 * the responses out, and nothing is cut after the fact. What an engine may point at is the items
 * this text carries (`itemsIn`).
 */
export function describeEvidence(evidence: PageEvidence, budget: number): string {
    const share: (part: number) => number = (part: number): number => Math.floor(budget * part);
    const lines: (text: string, part: number) => string = (text: string, part: number): string =>
        headLines(text.split("\n"), share(part)).join("\n");
    const pageChars: number = share(PAGE_SHARE);
    const api: string = evidence.requests?.length ? describeApiResponses(evidence.requests, share(API_SHARE)) : "";
    const consoleErrors: string = tailLines(
        (evidence.consoleErrors ?? []).slice(-10).map((e: { text: string }): string => e.text.slice(0, LINE_CHARS)),
        share(CONSOLE_SHARE)
    ).join("\n");
    // The journey first and bounded: the final page's text may fill the budget.
    const journey: string = evidence.journey ? describeJourney(evidence.journey, evidence.url, share(JOURNEY_SHARE)) : "";
    const controls: string = evidence.controls ? lines(describeControls(evidence.controls), CONTROLS_SHARE) : "";
    // What is on the screen first: on a long page, the part scrolled to is far from the text's start.
    const visible: string = evidence.visibleText ? evidence.visibleText.slice(0, pageChars) : "";
    const rest: number = Math.max(0, pageChars - visible.length);
    const parts: string[] = [
        evidence.now ? `Now: ${evidence.now}` : "",
        journey ? `The run so far:\n${journey}` : "",
        `Final page: ${evidence.title} ${evidence.url}`.slice(0, HEADING_CHARS),
        visible ? `On the screen now:\n${visible}` : "",
        rest > 0 ? `The whole page's text${visible ? " (from its start)" : ""}:\n${evidence.text.slice(0, rest)}` : "",
        controls ? `Its controls' state:\n${controls}` : "",
        api ? `API responses during the run:\n${api}` : "",
        consoleErrors ? `Console errors:\n${consoleErrors}` : "",
    ].filter(Boolean);
    const TRACE_HEADING: string = "The run's distributed trace (IronBee):\n";
    const used: number = parts.join("\n\n").length;
    const traceRoom: number = budget - used - 2 - TRACE_HEADING.length;
    if (evidence.trace && traceRoom > 0) {
        parts.push(`${TRACE_HEADING}${describeTrace(evidence.trace, traceRoom)}`);
    }
    // Only when the shares' labels alone outgrow a tiny budget: cut on a line, never mid-id.
    return headLines(parts.join("\n\n").split("\n"), budget).join("\n");
}
