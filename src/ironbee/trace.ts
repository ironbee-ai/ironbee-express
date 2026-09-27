/**
 * Reads a run's trace back from the IronBee platform through the DevTools
 * daemon's read tools (`o11y_get-trace`, `o11y_get-trace-logs`): which
 * services took part, every span and every log record — the evidence the
 * engine's review reads beyond the page, and what the UI charts.
 *
 * Spans and logs are ingested asynchronously, so the first read waits (bounded)
 * for the trace to appear.
 */

import { DevtoolsClient } from "../devtools/client";
import { sleep } from "../util/time";

export interface TraceLogFinding {
    service?: string;
    severity?: string;
    severityNumber?: number;
    body: string;
    /** OTEL `timeUnixNano`, exact digits. */
    timeNs?: string;
    /** The span the record was emitted under, when there was one. */
    spanId?: string;
}

/** One span for the trace chart: timing, parentage and what it did. */
export interface TraceSpan {
    spanId: string;
    parentSpanId?: string;
    name: string;
    service?: string;
    kind?: string;
    /** OTEL status code (`OK`, `ERROR`, `UNSET`), when set. */
    status?: string;
    statusMessage?: string;
    /** OTEL `startTimeUnixNano`, exact digits. */
    startNs: string;
    durationMs: number;
    attributes?: Record<string, unknown>;
}

export interface TraceReport {
    traceId: string;
    /** Spans in the trace as read (all pages, up to `MAX_SPANS`). 0 = nothing ingested for this trace (yet). */
    spanCount: number;
    services: Array<{ name: string; spanCount: number; errorCount: number }>;
    /** Every log record read (up to `MAX_LOGS`), in time order. */
    logs: TraceLogFinding[];
    /** Every span read (up to `MAX_SPANS`), in start order: the trace chart. */
    spans: TraceSpan[];
}


const PAGE: number = 1_000;
const MAX_SPANS: number = 3_000;
const MAX_LOGS: number = 2_000;
const MAX_BODY_CHARS: number = 2_000;
const MAX_ATTRIBUTE_CHARS: number = 500;

interface RawSpan {
    spanId: string;
    parentSpanId?: string;
    name: string;
    serviceName?: string;
    kind?: string;
    status?: string;
    statusMessage?: string;
    startTimeUnixNano?: string;
    durationMs?: number;
    attributes?: Record<string, unknown>;
}

interface SpanPage {
    count?: number;
    services?: Array<{ name: string; spanCount: number; errorCount: number }>;
    spans?: RawSpan[];
    hasMore?: boolean;
    nextOffset?: number;
}

interface LogRecord {
    body?: string;
    serviceName?: string;
    severityText?: string;
    severityNumber?: number;
    timeUnixNano?: string;
    spanId?: string;
}

interface LogPage {
    logs?: LogRecord[];
    hasMore?: boolean;
    nextOffset?: number;
}

export interface ReadTraceOptions {
    /** Bounded wait for the first spans. */
    waitMs?: number;
    /**
     * Re-read logs until their count holds across two reads (bounded): a log
     * check must not pass on records the platform has not ingested yet.
     */
    settleLogsMs?: number;
    /** The same for spans: a span check must not pass on a half-ingested trace. */
    settleSpansMs?: number;
}

const LOG_SETTLE_POLL_MS: number = 2_000;

async function readLogs(client: DevtoolsClient, traceId: string, settleMs: number): Promise<LogPage> {
    const read: () => Promise<LogPage> = (): Promise<LogPage> =>
        client.call<LogPage>("o11y_get-trace-logs", { traceId, limit: PAGE });
    let page: LogPage = await read();
    const deadline: number = Date.now() + settleMs;
    while (settleMs > 0 && Date.now() < deadline) {
        await sleep(LOG_SETTLE_POLL_MS);
        const next: LogPage = await read();
        const settled: boolean = (next.logs ?? []).length === (page.logs ?? []).length && (page.logs ?? []).length > 0;
        page = next;
        if (settled) {
            break;
        }
    }
    return page;
}

export async function readTrace(
    client: DevtoolsClient,
    traceId: string,
    options: ReadTraceOptions = {}
): Promise<TraceReport> {
    const waitMs: number = options.waitMs ?? 15_000;
    let all: SpanPage = await client.call<SpanPage>("o11y_get-trace", { traceId, limit: PAGE, waitMs });
    const spanDeadline: number = Date.now() + (options.settleSpansMs ?? 0);
    while ((options.settleSpansMs ?? 0) > 0 && Date.now() < spanDeadline) {
        await sleep(LOG_SETTLE_POLL_MS);
        const next: SpanPage = await client.call<SpanPage>("o11y_get-trace", { traceId, limit: PAGE });
        const settled: boolean = (next.count ?? 0) === (all.count ?? 0) && (all.count ?? 0) > 0;
        all = next;
        if (settled) {
            break;
        }
    }
    const spans: TraceSpan[] = await readAllSpans(client, traceId);
    let logs: LogPage = { logs: [] };
    try {
        logs = await readLogs(client, traceId, options.settleLogsMs ?? 0);
        logs = {
            logs: await readAllPages<LogPage, LogRecord>(
                logs,
                (p: LogPage): LogRecord[] => p.logs ?? [],
                MAX_LOGS,
                (offset: number): Promise<LogPage> => client.call<LogPage>("o11y_get-trace-logs", { traceId, limit: PAGE, offset })
            ),
        };
    } catch {
        // Logs are optional evidence; spans are the core of the report.
    }
    const records: TraceLogFinding[] = (logs.logs ?? [])
        .map(
            (l: LogRecord): TraceLogFinding => ({
                service: l.serviceName,
                severity: l.severityText,
                severityNumber: l.severityNumber,
                body: (l.body ?? "").slice(0, MAX_BODY_CHARS),
                ...(l.timeUnixNano ? { timeNs: l.timeUnixNano } : {}),
                ...(l.spanId ? { spanId: l.spanId } : {}),
            })
        )
        .sort((a: TraceLogFinding, b: TraceLogFinding): number => compareNs(a.timeNs, b.timeNs));
    return {
        traceId,
        spanCount: Math.max(all.count ?? 0, spans.length),
        services: all.services ?? [],
        logs: records,
        spans,
    };
}

function compareNs(a: string | undefined, b: string | undefined): number {
    const x: bigint = BigInt(a || "0");
    const y: bigint = BigInt(b || "0");
    return x < y ? -1 : x > y ? 1 : 0;
}

interface Paging {
    hasMore?: boolean;
    nextOffset?: number;
}

/** Follows `nextOffset` until the pages end or `max` items are read. */
async function readAllPages<P extends Paging, T>(
    first: P,
    itemsOf: (page: P) => T[],
    max: number,
    next: (offset: number) => Promise<P>
): Promise<T[]> {
    const items: T[] = [...itemsOf(first)];
    let current: P = first;
    while (current.hasMore && current.nextOffset !== undefined && items.length < max) {
        const more: P = await next(current.nextOffset);
        const batch: T[] = itemsOf(more);
        if (batch.length === 0) {
            break;
        }
        items.push(...batch);
        current = more;
    }
    return items.slice(0, max);
}

function clipAttributes(attributes: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!attributes) {
        return undefined;
    }
    return Object.fromEntries(
        Object.entries(attributes).map(([k, v]: [string, unknown]): [string, unknown] => {
            const text: string = typeof v === "string" ? v : JSON.stringify(v) ?? "";
            return [k, text.length > MAX_ATTRIBUTE_CHARS ? `${text.slice(0, MAX_ATTRIBUTE_CHARS)}…` : v];
        })
    );
}

/** Every span of the trace with its attributes, for the chart. */
async function readAllSpans(client: DevtoolsClient, traceId: string): Promise<TraceSpan[]> {
    const read: (offset: number) => Promise<SpanPage> = (offset: number): Promise<SpanPage> =>
        client.call<SpanPage>("o11y_get-trace", {
            traceId,
            detail: "attributes",
            limit: PAGE,
            offset,
        });
    const first: SpanPage = await read(0);
    const raw: RawSpan[] = await readAllPages<SpanPage, RawSpan>(
        first,
        (p: SpanPage): RawSpan[] => p.spans ?? [],
        MAX_SPANS,
        read
    );
    return raw
        .map(
            (s: RawSpan): TraceSpan => ({
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                ...(s.serviceName ? { service: s.serviceName } : {}),
                ...(s.kind ? { kind: s.kind } : {}),
                ...(s.status ? { status: s.status } : {}),
                ...(s.statusMessage ? { statusMessage: s.statusMessage } : {}),
                startNs: s.startTimeUnixNano ?? "0",
                durationMs: s.durationMs ?? 0,
                ...(s.attributes ? { attributes: clipAttributes(s.attributes) } : {}),
            })
        )
        .sort((a: TraceSpan, b: TraceSpan): number => compareNs(a.startNs, b.startNs));
}

