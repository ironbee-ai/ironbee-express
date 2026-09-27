// IronBee Express — the run's trace as a waterfall chart and its logs as a
// filterable log viewer. Plain browser JS, served as-is; used by app.js.
"use strict";

const TraceView = (() => {
    const PALETTE = ["#58a6ff", "#bc8cff", "#3fb950", "#d29922", "#39c5cf", "#ff7b72", "#ff5fb3", "#a5d6ff", "#7ee787", "#f0883e"];
    const WARN = 13;
    const ERROR = 17;

    /** What the viewer keeps across re-renders of the same run. */
    const view = {
        runId: null,
        tab: "trace",
        selected: null,
        collapsed: new Set(),
        severity: "all",
        service: "",
        query: "",
        relatedOnly: false,
        expandedLogs: new Set(),
        requestQuery: "",
        openRequests: new Set(),
        focusCheck: null,
        focusTrace: null,
        run: null,
        rerender: null,
    };

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) {
            node.className = cls;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function fmtDuration(ms) {
        if (ms < 1) {
            return `${ms.toFixed(2)} ms`;
        }
        if (ms < 1000) {
            return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
        }
        return `${(ms / 1000).toFixed(2)} s`;
    }

    function fmtClock(ns) {
        if (!ns) {
            return "";
        }
        const d = new Date(Number(BigInt(ns) / 1000000n));
        return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    }

    function severityClass(n) {
        return (n ?? 0) >= ERROR ? "error" : (n ?? 0) >= WARN ? "warn" : "info";
    }

    function isError(span) {
        return (span.status ?? "").toUpperCase().includes("ERROR");
    }

    // ---------- checks from what the run did ----------

    /** The body's leaf fields as `a.b[0].c` → value (bounded). */
    function leaves(value, max = 80) {
        const out = [];
        const walk = (v, path, depth) => {
            if (out.length >= max) {
                return;
            }
            if (v !== null && typeof v === "object" && depth < 6) {
                if (Array.isArray(v)) {
                    v.slice(0, 5).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
                } else {
                    for (const [k, x] of Object.entries(v).slice(0, 40)) {
                        if (/^[\w-]+$/.test(k)) {
                            walk(x, path ? `${path}.${k}` : k, depth + 1);
                        }
                    }
                }
                return;
            }
            if (path && typeof v !== "object") {
                out.push([path, String(v)]);
            } else if (path && v === null) {
                out.push([path, "null"]);
            }
        };
        walk(value, "", 0);
        return out;
    }

    /** `kind|id` → the findings that rest on that span / log record. */
    function traceJudgedBy(run) {
        const map = new Map();
        (run.analysis?.findings ?? []).forEach((f, index) => {
            for (const t of f.trace ?? []) {
                const key = `${t.kind}|${t.id}`;
                if (!map.has(key)) {
                    map.set(key, []);
                }
                map.get(key).push({ index, finding: f });
            }
        });
        return map;
    }

    function findingChip(index, finding) {
        const chip = el("span", `rq-chip sev-${finding.severity}`, `F${index + 1}`);
        chip.title = `${finding.severity}: ${finding.title}`;
        return chip;
    }

    function chipsFor(judged, key) {
        const chips = el("span", "rq-chips");
        for (const j of judged.get(key) ?? []) {
            chips.appendChild(findingChip(j.index, j.finding));
        }
        return chips;
    }

    function focusBanner(run, index, onClear) {
        const focus = el("div", "rq-focus");
        const f = run.analysis?.findings?.[index];
        focus.append(el("span", "", `Showing the evidence of F${index + 1}`), el("code", "", f?.title ?? ""));
        const clear = el("button", "ghost small", "show all");
        clear.type = "button";
        clear.addEventListener("click", onClear);
        focus.appendChild(clear);
        return focus;
    }

    function logKey(l) {
        return `${l.timeNs ?? ""}|${l.service ?? ""}|${l.body}`;
    }

    /** Timing relative to the trace's first instant, the span tree and the logs per span. */
    function model(trace) {
        const spans = trace.spans ?? [];
        const logs = trace.logs ?? [];
        const instants = [
            ...spans.map((s) => BigInt(s.startNs || "0")),
            ...logs.map((l) => BigInt(l.timeNs || "0")),
        ].filter((n) => n > 0n);
        const t0 = instants.length ? instants.reduce((a, b) => (a < b ? a : b)) : 0n;
        const offsetMs = (ns) => (ns && BigInt(ns) > 0n ? Number(BigInt(ns) - t0) / 1e6 : 0);
        const nodes = spans.map((s) => ({ ...s, startMs: offsetMs(s.startNs), endMs: offsetMs(s.startNs) + s.durationMs }));
        const byId = new Map(nodes.map((n) => [n.spanId, n]));
        const children = new Map();
        const roots = [];
        for (const n of nodes) {
            if (n.parentSpanId && byId.has(n.parentSpanId)) {
                if (!children.has(n.parentSpanId)) {
                    children.set(n.parentSpanId, []);
                }
                children.get(n.parentSpanId).push(n);
            } else {
                roots.push(n);
            }
        }
        const byStart = (a, b) => a.startMs - b.startMs;
        roots.sort(byStart);
        children.forEach((list) => list.sort(byStart));
        const logsBySpan = new Map();
        const timedLogs = logs.map((l) => ({ ...l, atMs: offsetMs(l.timeNs) }));
        for (const l of timedLogs) {
            if (l.spanId && byId.has(l.spanId)) {
                if (!logsBySpan.has(l.spanId)) {
                    logsBySpan.set(l.spanId, []);
                }
                logsBySpan.get(l.spanId).push(l);
            }
        }
        const total = Math.max(1, ...nodes.map((n) => n.endMs), ...timedLogs.map((l) => l.atMs));
        const serviceNames = [...new Set([...(trace.services ?? []).map((s) => s.name), ...nodes.map((n) => n.service), ...logs.map((l) => l.service)].filter(Boolean))].sort();
        const colors = new Map(serviceNames.map((name, i) => [name, PALETTE[i % PALETTE.length]]));
        return { nodes, byId, children, roots, logs: timedLogs, logsBySpan, total, colors, serviceNames };
    }

    function colorOf(m, service) {
        return m.colors.get(service) ?? "var(--muted)";
    }

    /** Depth-first rows, skipping collapsed subtrees. */
    function rows(m) {
        const out = [];
        const walk = (node, depth) => {
            const kids = m.children.get(node.spanId) ?? [];
            out.push({ node, depth, hasChildren: kids.length > 0 });
            if (!view.collapsed.has(node.spanId)) {
                kids.forEach((k) => walk(k, depth + 1));
            }
        };
        m.roots.forEach((r) => walk(r, 0));
        return out;
    }

    function pct(ms, m) {
        return `${Math.max(0, Math.min(100, (ms / m.total) * 100))}%`;
    }

    // ---------- trace chart ----------

    function axis(m) {
        const head = el("div", "wf-row wf-head");
        head.appendChild(el("div", "wf-name", "Span"));
        const scale = el("div", "wf-track");
        for (const f of [0, 0.25, 0.5, 0.75, 1]) {
            const tick = el("span", "wf-tick", fmtDuration(m.total * f));
            tick.style.left = `${f * 100}%`;
            if (f === 1) {
                tick.classList.add("end");
            }
            scale.appendChild(tick);
        }
        head.appendChild(scale);
        return head;
    }

    function spanRow(m, { node, depth, hasChildren }, rerender) {
        const judgedHere = m.judged?.get(`span|${node.spanId}`) ?? [];
        const focused = view.focusTrace !== null && judgedHere.some((j) => j.index === view.focusTrace);
        const row = el("div", `wf-row${isError(node) ? " failed" : ""}${view.selected === node.spanId ? " selected" : ""}${focused ? " focused" : ""}`);
        row.dataset.spanId = node.spanId;
        const name = el("div", "wf-name");
        name.style.paddingLeft = `${4 + depth * 14}px`;
        const caret = el("button", "wf-caret", hasChildren ? (view.collapsed.has(node.spanId) ? "▸" : "▾") : "");
        caret.type = "button";
        caret.disabled = !hasChildren;
        caret.addEventListener("click", (event) => {
            event.stopPropagation();
            view.collapsed.has(node.spanId) ? view.collapsed.delete(node.spanId) : view.collapsed.add(node.spanId);
            rerender();
        });
        const dot = el("span", "wf-dot");
        dot.style.background = colorOf(m, node.service);
        const svc = el("span", "wf-svc", node.service ?? "");
        const label = el("span", "wf-label", node.name);
        label.title = `${node.service ?? ""} ${node.name}`;
        name.append(caret, dot, svc, label);
        if (judgedHere.length) {
            name.appendChild(chipsFor(m.judged, `span|${node.spanId}`));
        }
        const track = el("div", "wf-track");
        const bar = el("div", "wf-bar");
        bar.style.left = pct(node.startMs, m);
        bar.style.width = `max(2px, ${pct(node.durationMs, m)})`;
        bar.style.background = colorOf(m, node.service);
        track.appendChild(bar);
        for (const l of m.logsBySpan.get(node.spanId) ?? []) {
            const mark = el("span", `wf-log ${severityClass(l.severityNumber)}`);
            mark.style.left = pct(l.atMs, m);
            mark.title = `${l.severity ?? "LOG"} ${l.body}`;
            track.appendChild(mark);
        }
        const dur = el("span", "wf-dur", fmtDuration(node.durationMs));
        const endPct = ((node.startMs + node.durationMs) / m.total) * 100;
        if (endPct > 82) {
            dur.style.right = `${100 - (node.startMs / m.total) * 100}%`;
            dur.classList.add("before");
        } else {
            dur.style.left = `${endPct}%`;
        }
        track.appendChild(dur);
        row.append(name, track);
        row.addEventListener("click", () => {
            view.selected = view.selected === node.spanId ? null : node.spanId;
            rerender();
        });
        return row;
    }

    function kv(grid, key, value) {
        if (value === undefined || value === null || value === "") {
            return;
        }
        grid.append(el("dt", "", key), el("dd", "", typeof value === "string" ? value : JSON.stringify(value)));
    }

    function spanDetail(m, node, related) {
        const box = el("div", "span-detail");
        const title = el("div", "sd-title");
        const dot = el("span", "wf-dot");
        dot.style.background = colorOf(m, node.service);
        title.append(dot, el("b", "", node.name), el("span", "muted", ` · ${node.service ?? "unknown service"}`));
        box.appendChild(title);
        const grid = el("dl", "kv");
        kv(grid, "status", `${node.status ?? "UNSET"}${node.statusMessage ? ` — ${node.statusMessage}` : ""}`);
        kv(grid, "kind", node.kind);
        kv(grid, "start", `+${fmtDuration(node.startMs)}`);
        kv(grid, "duration", fmtDuration(node.durationMs));
        kv(grid, "span id", node.spanId);
        const parent = node.parentSpanId ? m.byId.get(node.parentSpanId) : undefined;
        kv(grid, "parent", parent ? `${parent.service ?? ""} ${parent.name}` : node.parentSpanId);
        box.appendChild(grid);
        const attrs = Object.entries(node.attributes ?? {});
        if (attrs.length) {
            box.appendChild(el("h5", "", `Attributes (${attrs.length})`));
            const attrGrid = el("dl", "kv attrs");
            attrs.sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => kv(attrGrid, k, v));
            box.appendChild(attrGrid);
        }
        const logs = m.logsBySpan.get(node.spanId) ?? [];
        if (logs.length) {
            box.appendChild(el("h5", "", `Logs in this span (${logs.length})`));
            const table = el("div", "log-table");
            logs.forEach((l) => table.appendChild(logRow(m, l, related, null)));
            box.appendChild(table);
        }
        return box;
    }

    function traceTab(m, related, rerender) {
        const pane = el("div", "wf-pane");
        if (!m.nodes.length) {
            pane.appendChild(el("div", "hint", "No spans were ingested for this trace."));
            return pane;
        }
        if (view.focusTrace !== null) {
            pane.appendChild(
                focusBanner(view.run, view.focusTrace, () => {
                    view.focusTrace = null;
                    view.rerender();
                })
            );
        }
        const chart = el("div", "wf");
        chart.appendChild(axis(m));
        for (const r of rows(m)) {
            chart.appendChild(spanRow(m, r, rerender));
        }
        pane.appendChild(chart);
        const selected = view.selected ? m.byId.get(view.selected) : undefined;
        if (selected) {
            pane.appendChild(spanDetail(m, selected, related));
        } else {
            pane.appendChild(el("div", "hint", "Click a span for its attributes and logs. ▸ collapses a subtree; ticks on a bar are its logs."));
        }
        return pane;
    }

    // ---------- logs ----------

    function logRow(m, l, related, openSpan) {
        const row = el("div", `log-row sev-${severityClass(l.severityNumber)}${related.has(logKey(l)) ? " related" : ""}`);
        row.appendChild(el("span", "lr-off", `+${fmtDuration(l.atMs ?? 0)}`));
        const time = el("span", "lr-time", fmtClock(l.timeNs));
        row.appendChild(time);
        row.appendChild(el("span", "lr-sev", (l.severity || "LOG").toUpperCase()));
        const svc = el("span", "lr-svc", l.service ?? "");
        svc.style.color = colorOf(m, l.service);
        row.appendChild(svc);
        const body = el("span", "lr-body");
        let json;
        try {
            json = /^\s*[{[]/.test(l.body) ? JSON.parse(l.body) : undefined;
        } catch {
            json = undefined;
        }
        const key = logKey(l);
        if (json !== undefined && view.expandedLogs.has(key)) {
            body.appendChild(el("pre", "lr-json", JSON.stringify(json, null, 2)));
        } else {
            body.textContent = l.body;
        }
        if (json !== undefined) {
            body.classList.add("expandable");
            body.title = "Click to expand / collapse the JSON";
            body.addEventListener("click", () => {
                view.expandedLogs.has(key) ? view.expandedLogs.delete(key) : view.expandedLogs.add(key);
                const fresh = logRow(m, l, related, openSpan);
                row.replaceWith(fresh);
            });
        }
        row.appendChild(body);
        const link = el("span", "lr-span");
        if (m.judged?.has(`log|${logKey(l)}`)) {
            link.appendChild(chipsFor(m.judged, `log|${logKey(l)}`));
        }
        if (openSpan && l.spanId && m.byId.has(l.spanId)) {
            const button = el("button", "ghost small", "span ↗");
            button.type = "button";
            button.title = "Show the span in Traces";
            button.addEventListener("click", () => openSpan(l.spanId));
            link.appendChild(button);
        }
        row.appendChild(link);
        return row;
    }

    function logsTab(m, related, openSpan) {
        const pane = el("div", "logs-pane");
        const bar = el("div", "log-toolbar");
        const severity = el("select");
        for (const [value, label] of [["all", "all levels"], ["warn", "WARN and above"], ["error", "ERROR and above"]]) {
            const o = el("option", "", label);
            o.value = value;
            severity.appendChild(o);
        }
        severity.value = view.severity;
        const service = el("select");
        const any = el("option", "", "all services");
        any.value = "";
        service.appendChild(any);
        for (const name of [...new Set(m.logs.map((l) => l.service).filter(Boolean))].sort()) {
            const o = el("option", "", name);
            o.value = name;
            service.appendChild(o);
        }
        service.value = view.service;
        const search = el("input");
        search.type = "search";
        search.placeholder = "Search log text…";
        search.value = view.query;
        const onlyRelated = el("label", "choice");
        const relatedBox = el("input");
        relatedBox.type = "checkbox";
        relatedBox.checked = view.relatedOnly;
        onlyRelated.append(relatedBox, el("span", "", " flagged by Jev"));
        const count = el("span", "hint");
        bar.append(severity, service, search);
        if (related.size) {
            bar.appendChild(onlyRelated);
        }
        bar.appendChild(count);
        pane.appendChild(bar);
        const table = el("div", "log-table");
        if (view.focusTrace !== null) {
            pane.appendChild(
                focusBanner(view.run, view.focusTrace, () => {
                    view.focusTrace = null;
                    view.rerender();
                })
            );
        }
        pane.appendChild(table);
        const fill = () => {
            const min = view.severity === "error" ? ERROR : view.severity === "warn" ? WARN : 0;
            const q = view.query.trim().toLowerCase();
            const shown = m.logs.filter(
                (l) =>
                    (l.severityNumber ?? 0) >= min &&
                    (!view.service || l.service === view.service) &&
                    (!q || l.body.toLowerCase().includes(q) || (l.service ?? "").toLowerCase().includes(q)) &&
                    (!view.relatedOnly || related.has(logKey(l))) &&
                    (view.focusTrace === null || (m.judged?.get(`log|${logKey(l)}`) ?? []).some((j) => j.index === view.focusTrace))
            );
            table.innerHTML = "";
            shown.forEach((l) => table.appendChild(logRow(m, l, related, openSpan)));
            if (!shown.length) {
                table.appendChild(el("div", "hint", m.logs.length ? "No log matches the filters." : "No logs were ingested for this trace."));
            }
            count.textContent = `${shown.length} / ${m.logs.length}`;
        };
        severity.addEventListener("change", () => {
            view.severity = severity.value;
            fill();
        });
        service.addEventListener("change", () => {
            view.service = service.value;
            fill();
        });
        search.addEventListener("input", () => {
            view.query = search.value;
            fill();
        });
        relatedBox.addEventListener("change", () => {
            view.relatedOnly = relatedBox.checked;
            fill();
        });
        fill();
        return pane;
    }

    // ---------- requests ----------

    function statusClass(r) {
        if (r.failure || !r.status) {
            return "bad";
        }
        return r.status >= 400 ? "bad" : r.status >= 300 ? "info" : "ok";
    }

    function parseBody(body) {
        if (!body) {
            return undefined;
        }
        try {
            return JSON.parse(body);
        } catch {
            return undefined;
        }
    }

    /** A block of fields: path → value. */
    function fieldBlock(title, fields) {
        const block = el("div", "rq-block");
        block.appendChild(el("h5", "", title));
        const table = el("div", "rq-fields");
        for (const [path, value] of fields) {
            const row = el("div", "rq-field");
            row.append(el("code", "rq-path", path), el("span", "rq-value", value));
            table.appendChild(row);
        }
        block.appendChild(table);
        return block;
    }

    function parseRequestBody(body) {
        const json = parseBody(body);
        if (json !== undefined) {
            return json;
        }
        if (body && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)) {
            return Object.fromEntries(new URLSearchParams(body));
        }
        return undefined;
    }

    function requestDetail(r, run) {
        const box = el("div", "rq-detail");
        box.appendChild(el("div", "rq-url", r.url));
        const response = parseBody(r.body);
        if (response !== undefined) {
            const fields = leaves(response);
            if (fields.length) {
                box.appendChild(fieldBlock("Response body", fields));
            }
        } else if (r.body) {
            const block = el("div", "rq-block");
            block.append(el("h5", "", "Response body (not JSON)"), el("pre", "lr-json", r.body.slice(0, 4000)));
            box.appendChild(block);
        } else {
            box.appendChild(el("div", "hint", r.failure ? `Failed: ${r.failure}` : "No response body captured."));
        }
        const sent = parseRequestBody(r.requestBody);
        if (sent !== undefined && typeof sent === "object") {
            const fields = leaves(sent);
            if (fields.length) {
                box.appendChild(fieldBlock("Request body (sent)", fields));
            }
        } else if (r.requestBody) {
            const block = el("div", "rq-block");
            block.append(el("h5", "", "Request body (sent)"), el("pre", "lr-json", r.requestBody.slice(0, 4000)));
            box.appendChild(block);
        }
        const headers = el("details", "rq-headers");
        headers.appendChild(el("summary", "", "Headers"));
        const responseHeaders = Object.entries(r.responseHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b));
        const requestHeaders = Object.entries(r.requestHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b));
        if (responseHeaders.length) {
            headers.appendChild(fieldBlock("Response headers", responseHeaders));
        }
        if (requestHeaders.length) {
            headers.appendChild(fieldBlock("Request headers", requestHeaders));
        }
        if (responseHeaders.length || requestHeaders.length) {
            box.appendChild(headers);
        }
        if (response !== undefined) {
            const raw = el("details", "rq-headers");
            raw.appendChild(el("summary", "", "Raw response body"));
            raw.appendChild(el("pre", "lr-json", JSON.stringify(response, null, 2)));
            box.appendChild(raw);
        }
        return box;
    }

    function requestKey(r) {
        return `${r.method} ${r.url} ${r.timestamp}`;
    }

    /** Request key → the findings that rest on it. */
    function judgedBy(run) {
        const map = new Map();
        (run.analysis?.findings ?? []).forEach((f, index) => {
            for (const r of f.requests ?? []) {
                const key = requestKey(r);
                if (!map.has(key)) {
                    map.set(key, []);
                }
                map.get(key).push({ index, finding: f });
            }
        });
        return map;
    }

    function requestsTab(run) {
        const pane = el("div", "rq-pane");
        const requests = run.requests ?? [];
        const bar = el("div", "log-toolbar");
        const search = el("input");
        search.type = "search";
        search.placeholder = "Filter by method, URL or status…";
        search.value = view.requestQuery;
        const count = el("span", "hint");
        bar.append(search, count);
        pane.appendChild(bar);
        pane.appendChild(
            el("div", "hint", "The app's fetch/xhr requests during the run; F-chips mark the ones a problem rests on. Open one for its bodies and headers.")
        );
        const table = el("div", "log-table rq-table");
        pane.appendChild(table);
        const t0 = requests.length ? requests[0].timestamp : 0;
        const judged = judgedBy(run);
        if (view.focusCheck !== null) {
            const focus = el("div", "rq-focus");
            const f = run.analysis?.findings?.[view.focusCheck];
            focus.append(el("span", "", `Showing the evidence of F${view.focusCheck + 1}`), el("code", "", f?.title ?? ""));
            const clear = el("button", "ghost small", "show all");
            clear.type = "button";
            clear.addEventListener("click", () => {
                view.focusCheck = null;
                view.rerender();
            });
            focus.appendChild(clear);
            pane.insertBefore(focus, table);
        }
        const fill = () => {
            const q = view.requestQuery.trim().toLowerCase();
            const shown = requests
                .map((r, i) => [r, i])
                .filter(([r]) => !q || `${r.method} ${r.url} ${r.status ?? r.failure ?? ""}`.toLowerCase().includes(q))
                .filter(([r]) => view.focusCheck === null || (judged.get(requestKey(r)) ?? []).some((j) => j.index === view.focusCheck));
            table.innerHTML = "";
            for (const [r, i] of shown) {
                const key = `${i}`;
                const row = el("div", `rq-row${view.openRequests.has(key) ? " open" : ""}`);
                const line = el("div", "rq-line");
                line.appendChild(el("span", "lr-off", `+${fmtDuration(r.timestamp - t0)}`));
                line.appendChild(el("span", "rq-method", r.method));
                let shownUrl = r.url;
                try {
                    const u = new URL(r.url);
                    shownUrl = new URL(run.url).host === u.host ? u.pathname + u.search : r.url;
                } catch {
                    shownUrl = r.url;
                }
                const url = el("span", "rq-path", shownUrl);
                url.title = r.url;
                line.appendChild(url);
                line.appendChild(el("span", `rq-status ${statusClass(r)}`, r.status ? String(r.status) : r.failure ?? "—"));
                const chips = el("span", "rq-chips");
                for (const j of judged.get(requestKey(r)) ?? []) {
                    chips.appendChild(findingChip(j.index, j.finding));
                }
                line.appendChild(chips);
                line.addEventListener("click", () => {
                    view.openRequests.has(key) ? view.openRequests.delete(key) : view.openRequests.add(key);
                    fill();
                });
                row.appendChild(line);
                if (view.openRequests.has(key)) {
                    row.appendChild(requestDetail(r, run));
                }
                table.appendChild(row);
            }
            if (!shown.length) {
                table.appendChild(el("div", "hint", requests.length ? "No request matches the filter." : "The run made no fetch/xhr request."));
            }
            count.textContent = `${shown.length} / ${requests.length}`;
        };
        search.addEventListener("input", () => {
            view.requestQuery = search.value;
            fill();
        });
        fill();
        return pane;
    }

    // ---------- section ----------

    function legend(m, trace) {
        const box = el("div", "svc-legend");
        const stats = new Map((trace.services ?? []).map((s) => [s.name, s]));
        for (const name of m.serviceNames) {
            const s = stats.get(name);
            const spans = s?.spanCount ?? m.nodes.filter((n) => n.service === name).length;
            const failed = s?.errorCount ?? m.nodes.filter((n) => n.service === name && isError(n)).length;
            const chip = el("span", `svc-chip${failed ? " bad" : ""}`);
            const dot = el("span", "wf-dot");
            dot.style.background = colorOf(m, name);
            chip.append(dot, el("span", "", name), el("small", "", ` ${spans} span${spans === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`));
            box.appendChild(chip);
        }
        return box;
    }

    function traceBody(run, tab, head) {
        const pane = el("div");
        if (run.reviewing && !run.trace) {
            pane.appendChild(el("div", "hint", "Reading the trace from IronBee — spans and logs arrive for a few seconds after the run…"));
            return pane;
        }
        if (run.traceError || !run.trace) {
            pane.appendChild(el("div", "hint", `The trace is not available${run.traceError ? `: ${run.traceError}` : "."}`));
            return pane;
        }
        const trace = run.trace;
        const m = model(trace);
        m.judged = traceJudgedBy(run);
        const failedSpans = m.nodes.filter(isError).length;
        head.textContent = `Trace — ${fmtDuration(m.total)}, ${m.nodes.length} spans${failedSpans ? ` (${failedSpans} failed)` : ""}, ${m.serviceNames.length} services, ${m.logs.length} logs`;
        // Log records a problem rests on: marked, and a filter of their own.
        const related = new Set(
            (run.analysis?.findings ?? []).flatMap((f) => (f.trace ?? []).filter((t) => t.kind === "log").map((t) => t.id))
        );
        const rerender = () => view.rerender?.();
        const openSpan = (spanId) => {
            view.selected = spanId;
            // Unfold the path to the span.
            let node = m.byId.get(spanId);
            while (node?.parentSpanId) {
                view.collapsed.delete(node.parentSpanId);
                node = m.byId.get(node.parentSpanId);
            }
            selectTab("trace");
            document.querySelector(`.wf-row[data-span-id="${CSS.escape(spanId)}"]`)?.scrollIntoView({ block: "center" });
        };
        pane.appendChild(legend(m, trace));
        pane.appendChild(tab === "logs" ? logsTab(m, related, openSpan) : traceTab(m, related, rerender));
        pane.appendChild(el("div", "hint", `trace ${trace.traceId}`));
        return pane;
    }

    /** The evidence tabs this run has: [id, label]. The page's own tab bar shows them. */
    function tabsFor(run) {
        const tabs = [];
        if (run?.requests) {
            tabs.push(["requests", `Requests (${run.requests.length})`]);
        }
        if (run?.platform) {
            const spans = run.trace?.spans?.length;
            const logs = run.trace?.logs?.length;
            tabs.push(["trace", `Traces${spans === undefined ? "" : ` (${spans})`}`]);
            tabs.push(["logs", `Logs${logs === undefined ? "" : ` (${logs})`}`]);
        }
        return tabs;
    }

    /** Switches tab: through the page (which owns the tab bar) when it listens, else in place. */
    function selectTab(id) {
        view.tab = id;
        if (view.onTab) {
            view.onTab(id);
        } else {
            view.rerender?.();
        }
    }

    function build(run) {
        const section = el("div", "trace");
        view.run = run;
        view.rerender = () => section.replaceWith(build(run));
        if (view.tab === "requests") {
            section.appendChild(requestsTab(run));
        } else {
            const summary = el("div", "trace-summary");
            section.appendChild(summary);
            section.appendChild(traceBody(run, view.tab, summary));
        }
        return section;
    }

    /** Renders one evidence tab (`requests` / `trace` / `logs`) of the run into `box`. */
    function render(box, run, tab) {
        if (!run.platform && !run.requests) {
            return;
        }
        if (view.runId !== run.id) {
            Object.assign(view, {
                runId: run.id,
                tab: run.platform ? "trace" : "requests",
                requestQuery: "",
                openRequests: new Set(),
                focusCheck: null,
                focusTrace: null,
                selected: null,
                collapsed: new Set(),
                severity: "all",
                service: "",
                query: "",
                relatedOnly: false,
                expandedLogs: new Set(),
            });
        }
        if (tab) {
            view.tab = tab;
        }
        box.appendChild(build(run));
    }

    /** The page's tab switcher, called when the evidence itself opens a tab (a finding's link, a log's span). */
    function onTab(listener) {
        view.onTab = listener;
    }

    /** Opens the Requests tab on what check `index` looked at. */
    function showRequestsOf(index) {
        view.focusCheck = index;
        view.requestQuery = "";
        selectTab("requests");
        document.querySelector(".rq-pane")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    /** Opens Traces or Logs on the spans / log records check `index` looked at; `kind` picks one when it has both. */
    function showTraceOf(index, kind) {
        const judged = view.run?.analysis?.findings?.[index]?.trace ?? [];
        const logs = kind ? kind === "log" : judged.some((j) => j.kind === "log");
        view.focusTrace = index;
        view.query = "";
        view.severity = "all";
        view.service = "";
        view.relatedOnly = false;
        const firstSpan = judged.find((j) => j.kind === "span");
        if (firstSpan) {
            view.selected = firstSpan.id;
            view.collapsed = new Set();
        }
        selectTab(logs ? "logs" : "trace");
        const target = firstSpan ? document.querySelector(`.wf-row[data-span-id="${CSS.escape(firstSpan.id)}"]`) : document.querySelector(".logs-pane");
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    return { render, tabsFor, onTab, showRequestsOf, showTraceOf };
})();
