/**
 * Reads the evidence a run is judged on, fresh: the page (after the network
 * settles — DevTools logs a request only once its body is read) and its
 * controls' state, the run's
 * API requests and console errors, and — converted here — the trace the
 * platform recorded. Everything is secret-masked before an engine sees it —
 * in its encoded forms too (a form body carries the value url-encoded), since
 * this read comes after DevTools' secrets are cleared, or from a daemon that
 * never held them.
 */

import { DevtoolsClient } from "../devtools/client";
import { ControlSnapshot, SnapshotLimits } from "../devtools/types";
import { TraceLogFinding, TraceReport, TraceSpan } from "../ironbee/trace";
import { maskSecretsEncoded } from "../text/mask";
import { PageEvidence, TraceEvidence, TraceLogRecord, TraceSpanRecord } from "./types";

/** The moment as an engine reads it: weekday, date and local time with its offset — `Saturday 2026-09-26 15:04 (UTC+03:00)`. */
export function describeNow(at: Date): string {
    const pad: (n: number) => string = (n: number): string => String(n).padStart(2, "0");
    const offset: number = -at.getTimezoneOffset();
    const sign: string = offset >= 0 ? "+" : "-";
    const weekday: string = at.toLocaleDateString("en-US", { weekday: "long" });
    return (
        `${weekday} ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}` +
        ` (UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)})`
    );
}

/** Page text read for judging. */
export const EVIDENCE_MAX_CHARS: number = 20_000;

export interface ReadEvidence {
    evidence: PageEvidence;
    /** The fresh snapshot the evidence was read with; the caller's new current one. */
    snapshot: ControlSnapshot;
}

export interface EvidenceOptions {
    /** Also read console errors and uncaught exceptions. */
    console?: boolean;
}

export async function readEvidence(
    client: DevtoolsClient,
    sinceMs: number,
    limits: SnapshotLimits,
    secrets: Record<string, string>,
    options: EvidenceOptions = {}
): Promise<ReadEvidence> {
    await client.settleNetwork();
    const snapshot: ControlSnapshot = await client.snapshot(limits);
    const evidence: PageEvidence = maskSecretsEncoded(
        {
            url: snapshot.url,
            title: snapshot.title,
            text: await client.pageText(EVIDENCE_MAX_CHARS),
            visibleText: snapshot.text,
            now: describeNow(new Date()),
            controls: snapshot.controls,
            requests: await client.appRequests(sinceMs),
            ...(options.console ? { consoleErrors: await client.consoleErrors(sinceMs) } : {}),
        },
        secrets
    );
    return { evidence, snapshot };
}

/** The platform's trace report as evidence. */
export function traceEvidence(report: TraceReport): TraceEvidence {
    return {
        traceId: report.traceId,
        spanCount: report.spanCount,
        spans: report.spans.map(
            (sp: TraceSpan): TraceSpanRecord => ({
                spanId: sp.spanId,
                parentSpanId: sp.parentSpanId,
                name: sp.name,
                service: sp.service,
                kind: sp.kind,
                status: sp.status,
                statusMessage: sp.statusMessage,
                durationMs: sp.durationMs,
                attributes: sp.attributes,
            })
        ),
        logs: report.logs.map(
            (l: TraceLogFinding): TraceLogRecord => ({
                service: l.service,
                severityNumber: l.severityNumber,
                body: l.body,
                timeNs: l.timeNs,
                spanId: l.spanId,
            })
        ),
        services: report.services,
    };
}
