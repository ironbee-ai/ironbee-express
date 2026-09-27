/**
 * The run's anomalies, found mechanically: everything that MIGHT be a problem —
 * an HTTP error or a request with no response, a console error, a failed or
 * slow span, a log record at WARN or above.
 * Whether it is one — a 401 before logging in is expected — is the engine's
 * call (analyzer.ts). So is what a response body or a log line says: no text is
 * matched here, the engine reads them in the evidence (describe.ts).
 *
 * Similar anomalies are grouped (the same request pattern and status, the
 * same log line with its ids stripped) and the list is capped, most likely
 * problems first, so one engine request can judge them all.
 */

import {
    ERROR_SEVERITY,
    isFailedSpan,
    logKey,
    urlPattern,
    WARN_SEVERITY,
} from "./describe";
import {
    Candidate,
    CapturedRequest,
    ConsoleEntry,
    FindingSource,
    PageEvidence,
    RequestRef,
    TraceItemKind,
    TraceLogRecord,
    TraceSpanRecord,
} from "./types";

export const MAX_CANDIDATES: number = 24;
/** A span slower than this is worth asking about. */
export const SLOW_SPAN_MS: number = 3_000;
const MAX_REFS: number = 10;
const MAX_WHAT_CHARS: number = 300;


interface Scored extends Candidate {
    /** Higher = more likely a problem; orders the capped list. */
    score: number;
}

function requestRef(r: CapturedRequest): RequestRef {
    return { method: r.method, url: r.url, timestamp: r.timestamp };
}

/** A log line with its ids and numbers stripped, for grouping. */
function logShape(body: string): string {
    return body
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
        .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
        .replace(/\d+/g, "<n>")
        .replace(/\s+/g, " ")
        .trim();
}

interface NetworkGroup {
    requests: CapturedRequest[];
    title: string;
    score: number;
    excerpt: string;
    /** The request pattern, and what was wrong with it: `→ 500`, `→ failed (net::ERR_ABORTED)`. */
    where: string;
    what: string;
}

function networkCandidates(requests: CapturedRequest[]): Scored[] {
    const groups: Map<string, NetworkGroup> = new Map();
    const add: (key: string, title: string, score: number, r: CapturedRequest, excerpt: string, where: string, what: string) => void = (
        key: string,
        title: string,
        score: number,
        r: CapturedRequest,
        excerpt: string,
        where: string,
        what: string
    ): void => {
        const group: NetworkGroup = groups.get(key) ?? {
            requests: [],
            title,
            score,
            excerpt,
            where,
            what,
        };
        if (!group.requests.includes(r)) {
            group.requests.push(r);
        }
        groups.set(key, group);
    };
    for (const r of requests) {
        const target: string = `${r.method} ${urlPattern(r.url)}`;
        if (r.failure !== undefined || (r.status ?? 0) >= 400) {
            const status: string = r.failure ? `failed (${r.failure})` : String(r.status);
            add(
                `http|${target}|${status}`,
                `${target} → ${status}`,
                r.failure || (r.status ?? 0) >= 500 ? 90 : 60,
                r,
                (r.body ?? "").replace(/\s+/g, " ").slice(0, 200),
                target,
                `→ ${status}`
            );
        }
    }
    return [...groups.values()].map(
        (g: NetworkGroup): Scored => ({
            source: FindingSource.NETWORK,
            title: g.title,
            detail: `${g.requests.length} request${g.requests.length === 1 ? "" : "s"}${g.excerpt ? `; ${g.excerpt}` : ""}`,
            occurrences: [
                {
                    source: FindingSource.NETWORK,
                    where: g.where,
                    what: g.what,
                    count: g.requests.length,
                    // An error response's body says why.
                    ...(g.excerpt ? { excerpt: g.excerpt } : {}),
                },
            ],
            requests: g.requests.slice(-MAX_REFS).map(requestRef),
            score: g.score,
        })
    );
}

function consoleCandidates(errors: ConsoleEntry[]): Scored[] {
    const groups: Map<string, ConsoleEntry[]> = new Map();
    for (const e of errors) {
        const key: string = logShape(e.text).slice(0, 160);
        groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return [...groups.values()].map(
        (list: ConsoleEntry[]): Scored => ({
            source: FindingSource.CONSOLE,
            title: `console: ${list[0].text.replace(/\s+/g, " ").slice(0, 140)}`,
            detail: `${list.length} time${list.length === 1 ? "" : "s"} (${list[0].type})`,
            occurrences: [
                {
                    source: FindingSource.CONSOLE,
                    where: `console ${list[0].type}`,
                    what: list[0].text.replace(/\s+/g, " ").slice(0, MAX_WHAT_CHARS),
                    count: list.length,
                },
            ],
            score: 70,
        })
    );
}

interface SpanGroup {
    spans: TraceSpanRecord[];
    title: string;
    detail: string;
    score: number;
    /** `service: span name`. */
    where: string;
}

function spanCandidates(spans: TraceSpanRecord[]): Scored[] {
    const groups: Map<string, SpanGroup> = new Map();
    for (const s of spans) {
        const name: string = `${s.service ?? "?"}: ${s.name}`;
        if (isFailedSpan(s)) {
            const key: string = `failed|${name}`;
            const g: SpanGroup = groups.get(key) ?? {
                spans: [],
                title: `failed span ${name}`,
                detail: s.statusMessage ?? "status ERROR",
                score: 85,
                where: name,
            };
            g.spans.push(s);
            groups.set(key, g);
        } else if (s.durationMs >= SLOW_SPAN_MS) {
            const key: string = `slow|${name}`;
            const g: SpanGroup = groups.get(key) ?? {
                spans: [],
                title: `slow span ${name}`,
                detail: "",
                score: 40,
                where: name,
            };
            g.spans.push(s);
            g.detail = `took up to ${Math.round(Math.max(...g.spans.map((x: TraceSpanRecord): number => x.durationMs)))} ms`;
            groups.set(key, g);
        }
    }
    return [...groups.values()].map(
        (g: SpanGroup): Scored => ({
            source: FindingSource.TRACE,
            title: g.title,
            detail: `${g.spans.length} span${g.spans.length === 1 ? "" : "s"}; ${g.detail}`,
            occurrences: [{ source: FindingSource.TRACE, where: g.where, what: g.detail, count: g.spans.length }],
            trace: g.spans.slice(0, MAX_REFS).map((s: TraceSpanRecord): { kind: TraceItemKind; id: string } => ({ kind: TraceItemKind.SPAN, id: s.spanId })),
            score: g.score,
        })
    );
}

function logCandidates(logs: TraceLogRecord[]): Scored[] {
    const groups: Map<string, { logs: TraceLogRecord[]; score: number }> = new Map();
    for (const l of logs) {
        const level: number = l.severityNumber ?? 0;
        if (level < WARN_SEVERITY) {
            continue;
        }
        const key: string = `${l.service ?? "?"}|${logShape(l.body).slice(0, 160)}`;
        const g: { logs: TraceLogRecord[]; score: number } = groups.get(key) ?? {
            logs: [],
            score: level >= ERROR_SEVERITY ? 75 : 55,
        };
        g.logs.push(l);
        // A group ranks by its worst record, not its first: WARN retries then an ERROR of the same shape.
        g.score = Math.max(g.score, level >= ERROR_SEVERITY ? 75 : 55);
        groups.set(key, g);
    }
    return [...groups.values()].map(
        (g: { logs: TraceLogRecord[]; score: number }): Scored => ({
            source: FindingSource.LOG,
            title: `${g.logs[0].service ?? "?"}: ${g.logs[0].body.replace(/\s+/g, " ").slice(0, 140)}`,
            detail: `${g.logs.length} record${g.logs.length === 1 ? "" : "s"}`,
            occurrences: [
                {
                    source: FindingSource.LOG,
                    where: g.logs[0].service ?? "?",
                    what: g.logs[0].body.replace(/\s+/g, " ").slice(0, MAX_WHAT_CHARS),
                    count: g.logs.length,
                },
            ],
            trace: g.logs.slice(0, MAX_REFS).map((l: TraceLogRecord): { kind: TraceItemKind; id: string } => ({ kind: TraceItemKind.LOG, id: logKey(l) })),
            score: g.score,
        })
    );
}

/** Every anomaly in the evidence, grouped, most likely problems first, capped. */
export function collectCandidates(evidence: PageEvidence, max: number = MAX_CANDIDATES): Candidate[] {
    const all: Scored[] = [
        ...networkCandidates(evidence.requests ?? []),
        ...consoleCandidates(evidence.consoleErrors ?? []),
        ...spanCandidates(evidence.trace?.spans ?? []),
        ...logCandidates(evidence.trace?.logs ?? []),
    ];
    return all
        .sort((a: Scored, b: Scored): number => b.score - a.score)
        .slice(0, max)
        .map(({ score: _score, ...candidate }: Scored): Candidate => candidate);
}
