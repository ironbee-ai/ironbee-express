// IronBee Express — web UI. Plain browser JS, served as-is.
"use strict";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "ibexpress.form.v1";
/** The form saved before the project was renamed (read once, when nothing newer is saved). */
const OLD_STORE_KEY = "ibfast.form.v1";
const OPS_WITH_TEXT = new Set(["TYPE_TEXT"]);

const state = {
    scenario: null,
    config: null,
    run: null,
    runStartedAt: 0,
    /** The user's turns so far (ms), and the start of the current one. */
    pausedTotal: 0,
    pauseStart: 0,
    clockMs: 0,
    /** The run tab shown: steps | result | requests | trace | logs. */
    tab: "steps",
    clockTimer: 0,
    /** The run's final time once its clock stopped (the result is still being put together). */
    clockStoppedAt: undefined,
    frameSize: null,
};

// ---------- form ----------

function addRow(containerId, templateId, values) {
    const node = $(templateId).content.firstElementChild.cloneNode(true);
    node.querySelector(".remove").addEventListener("click", () => {
        node.remove();
        saveForm();
    });
    if (values) {
        for (const [cls, v] of Object.entries(values)) {
            const el = node.querySelector(`.${cls}`);
            if (!el) {
                continue;
            }
            if (el.type === "checkbox") {
                el.checked = Boolean(v);
            } else {
                el.value = v;
            }
        }
    }
    node.addEventListener("input", saveForm);
    // A secret is masked in the form too; the eye shows it on request, to check what was typed.
    const secret = node.querySelector(".is-secret");
    if (secret) {
        const reveal = node.querySelector(".reveal");
        const passwordFlag = node.querySelector(".password-flag");
        const sync = () => {
            const shown = reveal.getAttribute("aria-pressed") === "true";
            // Only a secret can be a login password.
            passwordFlag.hidden = !secret.checked;
            node.querySelector(".value").type = secret.checked && !shown ? "password" : "text";
            reveal.hidden = !secret.checked;
            reveal.title = shown ? "Hide the value" : "Show the value";
            reveal.setAttribute("aria-label", reveal.title);
        };
        reveal.addEventListener("click", () => {
            reveal.setAttribute("aria-pressed", String(reveal.getAttribute("aria-pressed") !== "true"));
            sync();
        });
        secret.addEventListener("change", () => {
            // Marking a value secret masks it again.
            reveal.setAttribute("aria-pressed", "false");
            sync();
        });
        sync();
    }
    $(containerId).appendChild(node);
    return node;
}

function readValues() {
    return [...$("values").querySelectorAll(".row")].map((row) => ({
        name: row.querySelector(".name").value.trim(),
        value: row.querySelector(".value").value,
        secret: row.querySelector(".is-secret").checked,
        password: row.querySelector(".is-secret").checked && row.querySelector(".is-password").checked,
        description: row.querySelector(".description").value.trim(),
    })).filter((v) => v.name);
}

function selectedCandidates() {
    return [...document.querySelectorAll("input[name=candidate]:checked")].map((el) => el.value);
}

// ---------- browser profiles ----------

const NEW_PROFILE = "__new__";

/** The chosen profile: "" = a fresh browser. */
function selectedProfile() {
    const value = $("profile").value;
    return value === NEW_PROFILE ? "" : value;
}

/** Fills the profile picker, keeping `want` selected when it exists. */
async function loadProfiles(want) {
    const { profiles } = await (await fetch("/api/profiles")).json();
    state.profiles = profiles;
    const select = $("profile");
    select.innerHTML = "";
    const add = (value, label) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    };
    add("", "Fresh — a clean browser every run");
    for (const p of profiles) {
        add(p.name, `${p.name} — saved profile`);
    }
    add(NEW_PROFILE, "+ New profile…");
    select.value = want && profiles.some((p) => p.name === want) ? want : "";
    renderProfileHint();
}

function renderProfileHint() {
    const value = $("profile").value;
    $("profile-new").hidden = value !== NEW_PROFILE;
    $("profile-delete").hidden = !value || value === NEW_PROFILE;
    const profile = state.profiles?.find((p) => p.name === value);
    $("profile-hint").textContent =
        value === NEW_PROFILE
            ? "A profile keeps its cookies, storage and logins between runs."
            : profile
              ? `Cookies, storage and logins stay between runs (last used ${new Date(profile.lastUsedAt).toLocaleString()}). Sign in once — Jev hands you the browser when it needs you.`
              : "Every run starts with no cookies, storage or logins.";
    if (value === NEW_PROFILE) {
        $("profile-name").focus();
    }
}

async function createProfile() {
    const response = await fetch("/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: $("profile-name").value }),
    });
    const data = await response.json();
    if (!response.ok) {
        $("profile-hint").textContent = data.error;
        return;
    }
    $("profile-name").value = "";
    await loadProfiles(data.profile);
    saveForm();
}

async function deleteProfile() {
    const name = $("profile").value;
    const response = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) {
        $("profile-hint").textContent = data.error;
        return;
    }
    await loadProfiles("");
    saveForm();
}

/** Persists the form for the next visit — secret VALUES are never stored. */
function saveForm() {
    const data = {
        url: $("url").value,
        goal: $("goal").value,
        values: readValues().map((v) => ({ ...v, value: v.secret ? "" : v.value })),
        textModel: selectedTextModel(),
        candidates: selectedCandidates(),
        profile: selectedProfile(),
    };
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
        // storage unavailable — the form just is not remembered
    }
}

function loadForm() {
    try {
        return JSON.parse(localStorage.getItem(STORE_KEY) || localStorage.getItem(OLD_STORE_KEY) || "null");
    } catch {
        return null;
    }
}

// ---------- IronBee connection ----------

/**
 * The IronBee pill: connected (with sign-out when the login is the saved one), or a
 * "Connect IronBee" button when the UI may connect it (not when the environment sets it).
 */
function renderIronBeeStatus(ironbee) {
    const pills = $("engine-status");
    const old = $("ironbee-status");
    const node = document.createElement("span");
    node.id = "ironbee-status";
    node.className = "ib-status";
    if (ironbee.ok) {
        const pill = h("span", "pill ok", "IronBee");
        pill.title = `${ironbee.domain} · project ${ironbee.project}${ironbee.source === "file" ? " · signed in (shared with the IronBee CLI)" : " · from the environment"}`;
        node.appendChild(pill);
        if (ironbee.source === "file") {
            const out = h("button", "ib-signout", "sign out");
            out.type = "button";
            out.title = "Remove the saved IronBee login (the IronBee CLI uses the same one)";
            out.addEventListener("click", disconnectIronBee);
            node.appendChild(out);
        }
    } else if (ironbee.canConnect) {
        const button = h("button", "ib-connect", state.ironbeeWaiting ? "Waiting for IronBee…" : "Connect IronBee");
        button.type = "button";
        button.title = "Sign in or sign up to add backend traces and logs to every review and keep each run's report";
        button.addEventListener("click", () => connectIronBee(false));
        node.appendChild(button);
    } else {
        const pill = h("span", "pill down", "IronBee");
        pill.title = ironbee.detail ?? "";
        node.appendChild(pill);
    }
    if (old) {
        old.replaceWith(node);
    } else {
        pills.appendChild(node);
    }
}

/**
 * Opens the IronBee console to sign in (or sign up first), then waits for the console to
 * hand the login back to this server. The tab is opened at once, inside the click, so no
 * popup blocker stops it; it closes itself when the login lands.
 */
async function connectIronBee(signup) {
    const tab = window.open("about:blank", "_blank");
    try {
        const response = await fetch("/api/ironbee/connect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        // Sign-up starts on the same page: its "Create an account" comes back to it.
        const url = data.url;
        if (tab) {
            tab.location.href = url;
        } else {
            window.open(url, "_blank");
        }
        state.ironbeeSignup = signup;
        waitForIronBee();
    } catch (err) {
        tab?.close();
        showIronBeeNotice(`Could not start the IronBee sign-in: ${err.message ?? err}`, "bad");
    }
}

/** Polls until the login lands (or 10 minutes pass). */
async function waitForIronBee() {
    if (state.ironbeeWaiting) {
        return;
    }
    state.ironbeeWaiting = true;
    renderIronBeeStatus(state.config.ironbee);
    showIronBeeNotice(
        state.ironbeeSignup
            ? 'In the tab that opened, choose Google or GitHub, or "Create an account" for email; this page updates when you are back.'
            : "Sign in to IronBee in the tab that opened; this page updates when you are back.",
        "info"
    );
    const until = Date.now() + 10 * 60_000;
    try {
        while (Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const config = await (await fetch("/api/config")).json();
            if (config.ironbee.ok) {
                state.config = config;
                showIronBeeNotice(`Connected to IronBee (${config.ironbee.domain}): the next run is reported, with its backend trace in the review.`, "ok");
                return;
            }
        }
        showIronBeeNotice("The IronBee sign-in timed out. Press Connect IronBee to try again.", "warn");
    } finally {
        state.ironbeeWaiting = false;
        state.ironbeeSignup = false;
        renderIronBeeStatus(state.config.ironbee);
        refreshIronBeeInvite();
    }
}

async function disconnectIronBee() {
    await fetch("/api/ironbee/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    state.config = await (await fetch("/api/config")).json();
    renderIronBeeStatus(state.config.ironbee);
    showIronBeeNotice(
        `Signed out of IronBee. The token still exists on the platform until it expires; delete it under Settings → Access tokens in the console if you like.`,
        "info",
        `${state.config.ironbee.consoleUrl}/settings/access-tokens`
    );
    refreshIronBeeInvite();
}

/** A one-line notice under the top bar about the IronBee connection. */
function showIronBeeNotice(text, tone, link) {
    const box = $("ironbee-notice");
    box.hidden = false;
    box.className = `ib-notice ${tone}`;
    box.innerHTML = "";
    box.appendChild(h("span", "", text));
    if (link) {
        const a = h("a", "", "Open access tokens ↗");
        a.href = link;
        a.target = "_blank";
        a.rel = "noopener";
        box.appendChild(a);
    }
    const close = h("button", "ib-notice-close", "×");
    close.type = "button";
    close.addEventListener("click", () => (box.hidden = true));
    box.appendChild(close);
}

/**
 * Under a run that was not reported: what IronBee adds, with sign-up / sign-in. Shown only
 * when the UI may connect (not when the environment decides, or reporting is switched off).
 */
function ironbeeInvite() {
    const box = h("div", "ib-invite");
    box.id = "ironbee-invite";
    const text = h("div", "ib-invite-text");
    text.append(
        h("b", "", "Get more out of every run with IronBee"),
        h("span", "", "Backend traces and logs of the services your app calls go into the review, and each run is kept as a report you can share. Free to start.")
    );
    const actions = h("div", "ib-invite-actions");
    const signup = h("button", "primary small", "Sign up free");
    signup.type = "button";
    signup.addEventListener("click", () => connectIronBee(true));
    const signin = h("button", "ghost small", "Sign in");
    signin.type = "button";
    signin.addEventListener("click", () => connectIronBee(false));
    actions.append(signup, signin);
    box.append(text, actions);
    return box;
}

function refreshIronBeeInvite() {
    const invite = $("ironbee-invite");
    if (invite && state.config?.ironbee?.ok) {
        invite.remove();
    }
}

function renderConfig(config, saved) {
    const pills = $("engine-status");
    pills.innerHTML = "";
    const pill = (name, ok, detail) => {
        const node = document.createElement("span");
        node.className = `pill ${ok ? "ok" : "down"}`;
        node.textContent = name;
        node.title = detail;
        pills.appendChild(node);
    };
    pill("Jev", config.engine.ok, config.engine.detail);
    renderIronBeeStatus(config.ironbee);
    pill("Live view", config.liveView, config.liveView ? "the page streams here while a run records" : "off: an external daemon is used");

    const candidates = $("candidates");
    candidates.innerHTML = "";
    const wantCandidates = new Set(saved?.candidates ?? config.defaultCandidates);
    const describe = { supplied: "your values", quoted: "quoted in the goal" };
    for (const kind of config.candidates) {
        const label = document.createElement("label");
        label.className = "choice";
        label.innerHTML = `<input type="checkbox" name="candidate" value="${kind}"><span></span>`;
        label.querySelector("span").textContent = describe[kind] ?? kind;
        const input = label.querySelector("input");
        input.checked = kind === "supplied" || wantCandidates.has(kind);
        input.disabled = kind === "supplied";
        input.addEventListener("change", saveForm);
        candidates.appendChild(label);
    }

    const provider = $("text-provider");
    provider.innerHTML = "";
    const none = document.createElement("option");
    none.value = "none";
    none.textContent = "No model";
    provider.appendChild(none);
    for (const p of config.textProviders) {
        const option = document.createElement("option");
        option.value = p.provider;
        option.textContent = p.ok ? p.label : `${p.label} — ${p.detail}`;
        option.disabled = !p.ok;
        provider.appendChild(option);
    }
    provider.addEventListener("change", () => {
        loadTextModels(provider.value).then(saveForm);
    });
    $("text-model").addEventListener("change", saveForm);
    setTextModel(saved?.textModel ?? config.defaultTextModel);
}

/** `provider/model`, or "none". */
function selectedTextModel() {
    const provider = $("text-provider").value;
    const model = $("text-model").value;
    return provider === "none" || !model ? "none" : `${provider}/${model}`;
}

/** Bumped per load: a slower, older response must not fill the list again. */
let textModelsLoad = 0;

/** A model's label: its name, plus its id when the name does not already say it. */
function modelLabel(m) {
    return m.name && m.name.toLowerCase() !== m.id.toLowerCase() ? `${m.name} (${m.id})` : (m.name ?? m.id);
}

/** Fills the model list of a provider; keeps `want` selected when it is listed. */
async function loadTextModels(provider, want) {
    const load = ++textModelsLoad;
    const select = $("text-model");
    const detail = $("text-model-detail");
    select.innerHTML = "";
    select.disabled = true;
    select.hidden = provider === "none";
    if (provider === "none") {
        detail.textContent = "Only your values (and quoted text) are typed.";
        return;
    }
    detail.textContent = "Loading models…";
    try {
        const response = await fetch(`/api/text-models?provider=${encodeURIComponent(provider)}`);
        const data = await response.json();
        if (load !== textModelsLoad) {
            return;
        }
        if (!response.ok) {
            throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        for (const m of data.models) {
            const option = document.createElement("option");
            option.value = m.id;
            option.textContent = modelLabel(m);
            select.appendChild(option);
        }
        if (want && data.models.some((m) => m.id === want)) {
            select.value = want;
        } else {
            const preferred = data.models.find((m) => m.default);
            if (preferred) {
                select.value = preferred.id;
            }
        }
        select.disabled = data.models.length === 0;
        detail.textContent =
            `${data.models.length} text model${data.models.length === 1 ? "" : "s"}` +
            (provider === "claude-code" ? " — each the latest of its family" : "");
    } catch (err) {
        if (load !== textModelsLoad) {
            return;
        }
        detail.textContent = `Could not list the models: ${err.message ?? err}`;
    }
}

/** Selects `provider/model` (or "none") in the two pickers. */
async function setTextModel(value) {
    const slash = (value ?? "none").indexOf("/");
    const provider = slash > 0 ? value.slice(0, slash) : "none";
    const option = [...$("text-provider").options].find((o) => o.value === provider && !o.disabled);
    $("text-provider").value = option ? provider : "none";
    await loadTextModels($("text-provider").value, slash > 0 ? value.slice(slash + 1) : undefined);
}

// ---------- live view ----------

const canvas = $("screen");
const ctx = canvas.getContext("2d");

async function drawFrame(buffer) {
    const view = new DataView(buffer);
    if (view.getUint8(0) !== 0x01) {
        return;
    }
    const headerLength = view.getUint32(1);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 5, headerLength)));
    const jpeg = new Blob([new Uint8Array(buffer, 5 + headerLength)], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(jpeg);
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    state.frameSize = { width: header.viewportWidth, height: header.viewportHeight };
    $("screen-empty").hidden = true;
}

// ---------- the user's turn (ASK_USER) ----------

/**
 * Shows (request) or hides (undefined) the run's request for the user; the live view takes input
 * meanwhile. `since`: when the turn began, for a viewer that joins during it.
 */
function showUserAction(request, since) {
    // The stopwatch holds while it is the user's turn: that time is theirs, not the run's.
    if (request && !state.pauseStart) {
        state.pauseStart = since ?? Date.now();
        setStopwatch("paused", "your turn");
    } else if (!request && state.pauseStart) {
        state.pausedTotal += Date.now() - state.pauseStart;
        state.pauseStart = 0;
        if (state.runStartedAt) {
            setStopwatch("running", "running");
        }
    }
    state.userAction = request;
    if (request) {
        setBrowserUrl(request.url);
    }
    setBrowserActivity(request ? "waiting" : state.runStartedAt ? "loading" : "");
    $("user-action").hidden = !request;
    $("ua-prompt").textContent = request ? withoutControlNumbers(request.prompt) : "";
    canvas.classList.toggle("driving", Boolean(request));
    canvas.tabIndex = request ? 0 : -1;
    if (request) {
        canvas.focus();
    }
}

function sendInput(input) {
    if (state.userAction && state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: "input", ...input }));
    }
}

/** A mouse event's position in the page's viewport coordinates. */
function viewportPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const size = state.frameSize ?? { width: canvas.width, height: canvas.height };
    return {
        x: Math.round(((event.clientX - rect.left) / rect.width) * size.width),
        y: Math.round(((event.clientY - rect.top) / rect.height) * size.height),
    };
}

const BUTTONS = ["left", "middle", "right"];
let lastMove = 0;
canvas.addEventListener("mousemove", (event) => {
    if (state.userAction && Date.now() - lastMove > 30) {
        lastMove = Date.now();
        sendInput({ kind: "mouse-move", ...viewportPoint(event) });
    }
});
canvas.addEventListener("mousedown", (event) => {
    if (state.userAction) {
        canvas.focus();
        sendInput({ kind: "mouse-down", button: BUTTONS[event.button] ?? "left", ...viewportPoint(event) });
    }
});
canvas.addEventListener("mouseup", (event) => {
    sendInput({ kind: "mouse-up", button: BUTTONS[event.button] ?? "left", ...viewportPoint(event) });
});
canvas.addEventListener("contextmenu", (event) => {
    if (state.userAction) {
        event.preventDefault();
    }
});
canvas.addEventListener(
    "wheel",
    (event) => {
        if (state.userAction) {
            event.preventDefault();
            sendInput({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY });
        }
    },
    { passive: false }
);
/** Ctrl/Cmd+V: left to this browser, so it raises `paste` with YOUR clipboard (the page's browser has its own). */
function isPasteShortcut(event) {
    return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
}
for (const [type, kind] of [["keydown", "key-down"], ["keyup", "key-up"]]) {
    canvas.addEventListener(type, (event) => {
        if (!state.userAction || event.isComposing || isPasteShortcut(event)) {
            return;
        }
        event.preventDefault();
        sendInput({ kind, key: event.key });
    });
}
// On the document: a canvas is not editable, so the paste event is dispatched to the document instead.
document.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text");
    if (state.userAction && document.activeElement === canvas && text) {
        event.preventDefault();
        sendInput({ kind: "text", text });
    }
});

// ---------- the browser frame around the live view ----------

/** The address bar: the page the run is on (host bright, the rest muted), a lock for https. */
function setBrowserUrl(url) {
    const box = $("bf-url");
    box.innerHTML = "";
    let parsed;
    try {
        parsed = url ? new URL(url) : undefined;
    } catch {
        parsed = undefined;
    }
    const secure = parsed?.protocol === "https:";
    $("bf-lock").style.display = secure ? "" : "none";
    $("bf-insecure").hidden = !parsed || secure || parsed.protocol !== "http:";
    if (!parsed) {
        box.appendChild(h("span", "bf-host", url || "about:blank"));
    } else {
        box.append(h("span", "bf-host", parsed.host), `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`);
    }
    box.parentElement.title = url ?? "";
}

/** loading while the run acts, waiting while it is the user's turn. */
function setBrowserActivity(mode) {
    const frame = $("browser-frame");
    frame.classList.toggle("loading", mode === "loading");
    frame.classList.toggle("waiting", mode === "waiting");
}

// ---------- run rendering ----------

function fmtMs(ms) {
    return `${(ms / 1000).toFixed(2)}s`;
}

/** Done or not, and whether the page changed: a grey tick is done with the page as it was (a click that did nothing). */
function markFor(step) {
    if (!step.executed) {
        return ["bad", "✗", "not done"];
    }
    return step.pageChanged
        ? ["ok", "✓", "done · the page changed"]
        : ["same", "✓", "done · the page stayed as it was (as for a click that did nothing)"];
}

/** The target as a person reads it: role and name. The snapshot's control number is only in the tooltip. */
function targetView(step) {
    const d = step.targetDescriptor;
    const raw = step.target ?? "";
    const parsed = raw.match(/^\[(\d+)\] (\S+) "(.*)"(?: \((.*)\))?$/);
    const role = d?.role ?? parsed?.[2];
    const name = d?.name ?? parsed?.[3];
    if (!role) {
        return undefined;
    }
    const box = h("span", "tgt");
    box.append(h("span", "tgt-role", role), h("span", "tgt-name", name ? `"${name}"` : ""));
    const context = d?.context ?? parsed?.[4];
    if (context) {
        box.appendChild(h("span", "tgt-context", context));
    }
    box.title = `${role} "${name ?? ""}"${context ? ` (${context})` : ""}${parsed ? ` — control ${parsed[1]} on the page` : ""}`;
    return box;
}

/** The origin in a word or two, for the step's row (the full words are its tooltip). */
function textOriginShort(step) {
    const name = step.textRef?.name;
    switch (step.textSource) {
        case "value":
            return name ? `value "${name}"` : "value";
        case "secret":
            return name ? `secret "${name}"` : "secret";
        case "goal-literal":
        case "goal-span":
            return "from goal";
        case "generate":
            return "text model";
        case "takeover":
            return "text model (at the controls)";
        case "user":
            return "you typed";
        case "combined":
            return "joined";
        default:
            return undefined;
    }
}

/** A text the run shows a person, without the snapshot's control numbers ("[2] searchbox …"). */
function withoutControlNumbers(text) {
    return (text ?? "").replace(/\[\d+\] /g, "");
}

/** Where a typed text came from, in words; a text-model one names the model and its time. */
function textOrigin(step) {
    const name = step.textRef?.name;
    switch (step.textSource) {
        case "value":
            return name ? `your value "${name}"` : "your value";
        case "secret":
            return name ? `secret "${name}"` : "a secret";
        case "goal-literal":
        case "goal-span":
            return "quoted in the goal";
        case "generate":
            return step.textReused
                ? `written by ${state.run?.generator ?? "the text model"} for the refused attempt before; typed now without a new call`
                : `written by ${state.run?.generator ?? "the text model"}${step.textMs !== undefined ? ` · ${fmtMs(step.textMs)}` : ""}`;
        case "takeover":
            return `written by ${state.run?.generator ?? "the text model"} while it had the controls`;
        case "user":
            return "typed by you";
        case "combined":
            return "the text the field held, joined with the new one";
        default:
            return undefined;
    }
}

function bars(title, entries, chosen) {
    const box = document.createElement("div");
    const h = document.createElement("h4");
    h.textContent = title;
    box.appendChild(h);
    for (const [label, p] of entries) {
        const row = document.createElement("div");
        row.className = `bar${label === chosen ? " chosen" : ""}`;
        row.innerHTML = `<span class="label"></span><span class="track"><span class="fill"></span></span><span class="p"></span>`;
        row.querySelector(".label").textContent = label.replace(/^\[\d+\] /, "");
        row.querySelector(".label").title = label;
        row.querySelector(".fill").style.width = `${Math.round(p * 100)}%`;
        row.querySelector(".p").textContent = p.toFixed(2);
        box.appendChild(row);
    }
    return box;
}

/** Who did what in a step: Jev's decisions, where the text came from, whether the text model ran. */
function decidedBy(step) {
    const box = h("div", "decided");
    box.appendChild(h("h4", "", "How this step was decided"));
    const list = h("ul", "");
    const item = (label, text) => {
        const li = h("li", "");
        li.append(h("span", "decided-label", label), h("span", "", text));
        list.appendChild(li);
    };
    if (step.mode === "replay" && step.reidentified) {
        item(
            "Action",
            `replayed from the scenario's recording; the page had changed around the recorded ${step.reidentified.from}, ` +
                `and Jev found it again (p=${step.reidentified.probability.toFixed(2)}, ${fmtMs(step.decisionMs)}) — the recording is updated when the run passes`
        );
    } else if (step.mode === "replay") {
        item("Action", "replayed from the scenario's recording — no engine, no text model");
    } else if (step.mode === "rescue" && step.rescue) {
        item(
            "Action",
            `Jev was stuck (${step.rescue.stuck}); the text model ${step.rescue.model} had the controls and chose ${step.operation} in ${fmtMs(step.decisionMs)}` +
                (step.rescue.why ? ` — "${step.rescue.why}"` : "") +
                ". It hands back to Jev once the run is unstuck."
        );
    } else {
        item("Action", `Jev chose ${step.operation}${step.target ? " and its target" : ""} in ${step.decisionMs} ms`);
    }
    if (OPS_WITH_TEXT.has(step.operation)) {
        const origin = textOrigin(step);
        if (step.textSource === "generate") {
            item("Text", `${origin}${step.mode === "replay" ? " when recorded; replayed as it was" : ""} — Jev chose to have it written rather than use a value the run was given.`);
        } else if (step.textSource === "takeover") {
            item("Text", `${origin}${step.mode === "replay" ? " when recorded; replayed as it was" : ""}.`);
        } else if (step.textSource === "user") {
            item("Text", "typed by you, when the run asked.");
        } else if (origin) {
            item("Text", `${origin}${step.mode === "replay" ? "" : " — Jev picked it among the values the run was given"}.`);
        }
    }
    const modelUsed = `used (${state.run?.generator ?? "configured model"}${step.textMs !== undefined ? `, ${fmtMs(step.textMs)}` : ""})`;
    item(
        "Text model",
        step.textSource === "generate" && step.mode !== "replay"
            ? step.textReused
                ? "not called: the text written for the refused attempt before was reused"
                : modelUsed
            : step.textSource === "takeover" && step.mode !== "replay"
              ? modelUsed
              : "not used in this step"
    );
    box.appendChild(list);
    return box;
}

function renderStep(step) {
    const li = document.createElement("li");
    li.className = "step";
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const [cls, mark, markTitle] = markFor(step);
    summary.innerHTML = `<span class="num"></span><span class="time"></span><b class="${cls}"></b><span class="op ${step.operation}"></span><span class="what"></span><span class="ms"></span>`;
    summary.querySelector("b").textContent = mark;
    summary.querySelector("b").title = markTitle;
    summary.querySelector(".num").textContent = `#${step.step}`;
    summary.querySelector(".time").textContent = `+${fmtMs(step.elapsedMs)}`;
    summary.querySelector(".op").textContent = step.operation;
    const mode = document.createElement("span");
    mode.className = `mode ${step.mode ?? "engine"}`;
    mode.textContent = step.mode === "rescue" ? "LLM" : step.mode ?? "engine";
    if (step.mode === "rescue" && step.rescue) {
        mode.title = `Chosen by ${step.rescue.model}: Jev was stuck (${step.rescue.stuck})`;
    } else if (step.reidentified) {
        mode.title = `The page had changed around the recorded ${step.reidentified.from}; Jev found it again`;
    }
    summary.querySelector(".op").appendChild(mode);
    const what = summary.querySelector(".what");
    const target = targetView(step);
    if (step.userAction) {
        what.textContent = withoutControlNumbers(step.userAction.prompt);
    } else if (step.key) {
        what.append(h("span", "key", step.key));
        if (target) {
            what.append(" in ", target);
        }
    } else if (step.tab !== undefined) {
        what.textContent = `tab ${step.tab}`;
    } else if (target) {
        what.appendChild(target);
    } else {
        what.textContent = step.target ?? (step.reason && !step.executed ? step.reason : "");
    }
    if (step.text !== undefined && OPS_WITH_TEXT.has(step.operation)) {
        what.appendChild(h("span", "typed", ` ← ${JSON.stringify(step.text)}`));
        const short = textOriginShort(step);
        if (short) {
            const chip = h("span", `origin src-${step.textSource}`, short);
            chip.title = textOrigin(step);
            what.appendChild(chip);
        }
    }
    what.title = what.textContent;
    summary.querySelector(".ms").textContent =
        (step.mode === "replay"
            ? step.reidentified
                ? `replayed · Jev ${step.decisionMs}ms`
                : "replayed"
            : step.mode === "rescue" && step.rescue
              ? `${step.rescue.model} ${fmtMs(step.decisionMs)}`
              : `Jev ${step.decisionMs}ms`) +
        (step.textMs !== undefined && step.mode !== "replay" ? ` · text model ${fmtMs(step.textMs)}` : "") +
        (step.actMs !== undefined ? ` · act ${step.actMs}ms` : "") +
        (step.userAction ? ` · you took ${fmtMs(step.userAction.waitMs)}` : "");
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "detail-body";
    const ops = Object.entries(step.operationProbabilities).sort((a, b) => b[1] - a[1]);
    if (ops.length) {
        body.appendChild(bars(`Operation (confidence ${step.confidence.toFixed(2)})`, ops, step.operation));
    } else if (step.mode === "replay") {
        const note = document.createElement("div");
        note.className = "hint";
        note.textContent = step.reidentified
            ? "Replayed from the scenario's recording; Jev found the recorded control again, the page having changed around it."
            : "Replayed from the scenario's recording — no engine decision.";
        body.appendChild(note);
    }
    if (step.targetTop) {
        body.appendChild(bars("Target", step.targetTop.map((t) => [t.label, t.probability]), step.target));
    }
    body.appendChild(decidedBy(step));
    if (step.goal) {
        body.appendChild(goalLine(step.goal, { engine: "Jev", sources: "the page and the API responses" }, true));
    }
    if (step.reason) {
        const reason = document.createElement("div");
        reason.className = "reason";
        reason.textContent = step.reason;
        body.appendChild(reason);
    }
    details.appendChild(body);
    li.appendChild(details);
    return li;
}

function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) {
        node.className = cls;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

const CONFIRM_ICONS = {
    clear: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    delete: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
};

/**
 * Asks the user to confirm an action in the page's own dialog (not the browser's). Resolves true on
 * the confirm button, false on Cancel, Escape or a click outside. `name` is shown as its own line.
 */
function confirmDialog({ kind, title, name, detail, action }) {
    return new Promise((resolve) => {
        const dialog = h("dialog", `confirm confirm-${kind}`);
        dialog.setAttribute("aria-labelledby", "confirm-title");
        const body = h("div", "confirm-body");
        const icon = h("div", "confirm-icon");
        icon.innerHTML = CONFIRM_ICONS[kind];
        const text = h("div", "confirm-text");
        const heading = h("h3", undefined, title);
        heading.id = "confirm-title";
        text.append(heading, h("div", "confirm-name", name), h("p", undefined, detail));
        body.append(icon, text);
        const actions = h("div", "confirm-actions");
        const cancel = h("button", undefined, "Cancel");
        cancel.type = "button";
        const ok = h("button", kind === "delete" ? "danger-solid" : "primary", action);
        ok.type = "button";
        actions.append(cancel, ok);
        dialog.append(body, actions);
        let answer = false;
        const close = (value) => {
            answer = value;
            dialog.close();
        };
        cancel.addEventListener("click", () => close(false));
        ok.addEventListener("click", () => close(true));
        // A click on the backdrop lands on the dialog element itself, outside its box.
        dialog.addEventListener("click", (event) => {
            const box = dialog.getBoundingClientRect();
            const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
            if (event.target === dialog && !inside) {
                close(false);
            }
        });
        dialog.addEventListener("close", () => {
            dialog.remove();
            resolve(answer);
        });
        document.body.appendChild(dialog);
        dialog.showModal();
        // The safe choice has the focus: Enter never deletes by accident.
        cancel.focus();
    });
}

function copyButton(value) {
    const button = h("button", "ghost small", "copy");
    button.type = "button";
    button.title = "Copy";
    button.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(value);
            button.textContent = "copied";
            setTimeout(() => (button.textContent = "copy"), 1200);
        } catch {
            button.textContent = "—";
        }
    });
    return button;
}

const SOURCE_LABELS = { network: "network", console: "console", trace: "trace", log: "log" };

const GOAL_LABELS = { done: "Goal done", "not-yet": "Goal not done yet", failed: "Goal failed" };
const GOAL_ICONS = { done: "✓", "not-yet": "…", failed: "✗" };

/** A 0–1 probability as "82%" beside a small bar, with what it means on hover. */
function confidence(p, meaning, cls = "") {
    const box = h("span", `conf ${cls}`);
    box.title = meaning;
    const bar = h("span", "conf-bar");
    const fill = h("span");
    fill.style.width = `${Math.round(p * 100)}%`;
    bar.appendChild(fill);
    box.append(bar, h("span", "conf-num", `${Math.round(p * 100)}%`));
    return box;
}

/**
 * Where the goal stands (done / not yet / failed) and how sure the engine is. The failure signals
 * are listed only when there is no problem list to show them (they are the problems' titles).
 */
function goalLine(goal, by, showSignals) {
    const tone = goal.state === "done" ? "ok" : goal.state === "failed" ? "bad" : "warn";
    const box = h("div", `goal-card ${tone}`);
    const row = h("div", "goal-row");
    if (goal.confirmedBy) {
        // Jev could not see it; the text model that had the controls confirmed it.
        row.append(
            h("span", "goal-icon", GOAL_ICONS[goal.state] ?? "?"),
            h("b", "", GOAL_LABELS[goal.state] ?? goal.state),
            h("span", "muted goal-by", `confirmed by ${goal.confirmedBy.model} (Jev could not see it)`)
        );
        box.append(row, h("div", "goal-confirmed", goal.confirmedBy.why));
        return box;
    }
    row.append(
        h("span", "goal-icon", GOAL_ICONS[goal.state] ?? "?"),
        h("b", "", GOAL_LABELS[goal.state] ?? goal.state),
        confidence(goal.stateProbability, `How sure ${by.engine} is that this is where the goal stands`, tone),
        h("span", "muted goal-by", `judged from ${by.sources}`)
    );
    box.appendChild(row);
    if (showSignals && goal.signals?.length && goal.state !== "done") {
        const list = h("ul", "goal-signals");
        for (const signal of goal.signals) {
            list.appendChild(h("li", "", signal));
        }
        box.appendChild(list);
    }
    return box;
}

/** Long text shown on up to two lines; a click shows it all. */
function clamped(tag, cls, text) {
    const el = h(tag, `${cls} clamp`, text);
    el.title = text;
    el.addEventListener("click", () => el.classList.toggle("open"));
    return el;
}

/** Each place a problem was seen: source, where, what, how often — one row per place. */
function occurrenceTable(occurrences) {
    const table = h("div", "occ");
    for (const o of occurrences) {
        const row = h("div", "occ-row");
        row.append(
            h("span", `source-badge src-${o.source}`, SOURCE_LABELS[o.source] ?? o.source),
            h("span", "occ-where mono", o.where),
            clamped("span", "occ-what mono", o.what),
            h("span", "occ-count", o.count > 1 ? `×${o.count}` : "")
        );
        table.appendChild(row);
        if (o.excerpt) {
            table.appendChild(clamped("div", "occ-excerpt mono", o.excerpt));
        }
    }
    return table;
}

/** One problem the engine found: how bad, what it is, where it was seen, and the evidence it rests on. */
function findingCard(finding, index) {
    const card = h("div", `ck ck-${finding.severity}`);
    const occurrences = finding.occurrences ?? [];
    const head = h("div", "fd-head");
    head.append(h("span", "ck-num", `F${index + 1}`), h("span", `sev sev-${finding.severity}`, finding.severity.toUpperCase()));
    if (!occurrences.length) {
        head.append(h("span", `source-badge src-${finding.source}`, SOURCE_LABELS[finding.source] ?? finding.source));
    }
    head.append(confidence(finding.probability, `How sure Jev is that this is ${finding.severity}`));
    card.appendChild(head);
    if (occurrences.length) {
        // The title is where + what joined: the table says it field by field.
        card.appendChild(occurrenceTable(occurrences));
    } else {
        // A run from before places were kept apart.
        card.appendChild(clamped("div", "fd-title", finding.title));
        if (finding.detail) {
            card.appendChild(clamped("div", "fd-detail", finding.detail));
        }
    }
    const links = h("div", "ck-links");
    if (finding.requests?.length) {
        const link = h("button", "ghost small", `show ${finding.requests.length === 1 ? "the request" : `${finding.requests.length} requests`}`);
        link.type = "button";
        link.addEventListener("click", () => TraceView.showRequestsOf(index));
        links.appendChild(link);
    }
    if (finding.trace?.length) {
        const logs = finding.trace.filter((t) => t.kind === "log").length;
        const spans = finding.trace.length - logs;
        for (const [n, one, many, kind] of [[logs, "the log", "logs", "log"], [spans, "the span", "spans", "span"]]) {
            if (!n) {
                continue;
            }
            const link = h("button", "ghost small", `show ${n === 1 ? one : `${n} ${many}`}`);
            link.type = "button";
            link.addEventListener("click", () => TraceView.showTraceOf(index, kind));
            links.appendChild(link);
        }
    }
    if (links.childNodes.length) {
        card.appendChild(links);
    }
    return card;
}

function fact(grid, label, value, cls) {
    if (!value) {
        return;
    }
    grid.appendChild(h("dt", "", label));
    const dd = h("dd", cls);
    if (value instanceof Node) {
        dd.appendChild(value);
    } else {
        dd.textContent = value;
    }
    grid.appendChild(dd);
}

function setPhase(label, cls) {
    const phase = $("phase");
    phase.textContent = label;
    phase.className = `badge ${cls ?? label}`;
}

// ---------- the stopwatch ----------

/** `mm:ss` and `.cc` of a duration. */
function setClock(ms) {
    const total = Math.max(0, Math.floor(ms / 10));
    const cs = total % 100;
    const seconds = Math.floor(total / 100);
    $("sw-main").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    $("sw-frac").textContent = `.${String(cs).padStart(2, "0")}`;
    state.clockMs = ms;
    renderPace();
}

/**
 * The engine is stuck and a text model is asked for the next step: shown while it thinks (with a
 * spinner, and under the stopwatch), then what it chose — or that it could not help.
 */
function showRescue(event) {
    const box = $("rescue-notice");
    if (!event) {
        box.hidden = true;
        return;
    }
    box.innerHTML = "";
    const text = h("div", "");
    const working = event.state === "asking" || event.state === "looking";
    if (event.state === "asking") {
        text.append(h("b", "", `Jev is stuck — ${event.model} has the controls`), ` (${event.stuck}). It works to get the run unstuck, then hands back to Jev.`);
    } else if (event.state === "looking") {
        text.append(h("b", "", `${event.model} has the controls`), ` — looking: ${event.action}`);
        if (event.why) {
            text.append(h("div", "why", event.why));
        }
    } else if (event.state === "answered") {
        text.append(
            h("b", "", event.end === "done" ? `${event.model} confirmed the goal done` : `${event.model} handed the controls back to Jev`),
            ` after ${fmtMs(event.ms ?? 0)}.`
        );
        if (event.why) {
            text.append(h("div", "why", event.why));
        }
    } else {
        text.append(h("b", "", `${event.model} could not get past it`), ` (${event.error ?? "no reason"}); the run ends as it would have.`);
    }
    if (!state.pauseStart) {
        setStopwatch("running", working ? `${event.model.split("/")[0]} at the controls` : "running");
    }
    box.className = `rescue-notice${working ? "" : " done"}`;
    box.append(h("span", "spinner"), text);
    box.hidden = false;
}

/** idle | running | paused | done | failed — the look — and the words under the digits. */
function setStopwatch(mode, label) {
    $("stopwatch").className = `stopwatch ${mode}`;
    $("sw-label").textContent = label;
}

/** The run's own time: the user's turns are not counted (as on the server). */
function runClockMs() {
    const paused = state.pausedTotal + (state.pauseStart ? Date.now() - state.pauseStart : 0);
    return Date.now() - state.runStartedAt - paused;
}

function tickClock() {
    if (state.runStartedAt && state.clockStoppedAt === undefined) {
        setClock(runClockMs());
    }
}

function renderPace() {
    const steps = state.run?.steps?.length ?? 0;
    $("hud-pace").textContent = steps && state.clockMs ? `${(state.clockMs / steps / 1000).toFixed(2)}s` : "–";
}

/** What did not go as configured while the run went on; kept above the steps, whatever tab shows them. */
function renderWarnings(run) {
    const list = $("warnings");
    list.innerHTML = "";
    for (const message of run?.warnings ?? []) {
        list.appendChild(h("li", "", message));
    }
    list.hidden = list.childElementCount === 0;
}

function renderRun(run) {
    state.run = run;
    const steps = $("steps");
    steps.innerHTML = "";
    for (const step of run?.steps ?? []) {
        steps.appendChild(renderStep(step));
    }
    renderWarnings(run);
    renderCounts();
    // Reviewing: the run itself is over and its result shows; only the review is pending.
    const running = run && run.phase !== "finished" && !run.result;
    if (run && state.tabRunId !== run.id) {
        state.tabRunId = run.id;
        state.tab = "steps";
    }
    if (run && (run.result || run.error) && state.resultShownFor !== run.id) {
        // The run just ended: its result is what to look at.
        state.resultShownFor = run.id;
        state.tab = "result";
    }
    $("run").disabled = Boolean(run && run.phase !== "finished");
    $("stop").disabled = !running;
    if (!run) {
        setPhase("idle");
        renderTabs();
        return;
    }
    if (running) {
        setPhase(run.phase);
        // The run's own clock, as the result counts it: from after the first page load.
        state.runStartedAt = state.runStartedAt || run.clockStartedAt || 0;
        state.clockStoppedAt = run.clockElapsedMs;
        // Reopened while the text model is asked: say so.
        showRescue(run.rescue?.state === "asking" || run.rescue?.state === "looking" ? run.rescue : undefined);
        if (run.clockElapsedMs !== undefined) {
            setClock(run.clockElapsedMs);
        }
        clearInterval(state.clockTimer);
        state.clockTimer = setInterval(tickClock, 47);
        if (!state.pauseStart) {
            setStopwatch("running", run.phase === "preparing" ? "preparing" : "running");
            setBrowserActivity("loading");
        }
        const last = run.steps?.[run.steps.length - 1];
        setBrowserUrl(run.userAction?.url ?? last?.url ?? run.url);
    } else {
        clearInterval(state.clockTimer);
        state.runStartedAt = 0;
        state.pauseStart = 0;
        setBrowserActivity("");
        setBrowserUrl(run.result?.finalUrl ?? run.steps?.[run.steps.length - 1]?.url ?? run.url);
        renderResult(run);
    }
    renderTabs();
}

// ---------- the run's tabs: steps, result, evidence ----------

const EVIDENCE_TABS = new Set(["requests", "trace", "logs"]);

function resultTabLabel(run) {
    if (run.error) {
        return ["Result", "bad"];
    }
    if (run.analysis) {
        return [`Result · ${run.analysis.verdict}`, run.analysis.verdict === "passed" ? "ok" : "bad"];
    }
    if (run.reviewing) {
        return ["Result · reviewing…", "info"];
    }
    return [`Result · ${run.result.status}`, run.result.status === "done" ? "ok" : "bad"];
}

/** One tab bar under the live view; only the chosen tab's content is on the page. */
function renderTabs() {
    const run = state.run;
    const tabs = [["steps", `Steps${run?.steps?.length ? ` (${run.steps.length})` : ""}`, ""]];
    if (run && (run.result || run.error)) {
        tabs.push(["result", ...resultTabLabel(run)]);
    }
    for (const [id, label] of TraceView.tabsFor(run)) {
        tabs.push([id, label, ""]);
    }
    if (!tabs.some(([id]) => id === state.tab)) {
        state.tab = "steps";
    }
    const bar = $("run-tabs");
    bar.innerHTML = "";
    for (const [id, label, tone] of tabs) {
        const tab = h("button", `run-tab${id === state.tab ? " active" : ""}${tone ? ` tone-${tone}` : ""}`, label);
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.addEventListener("click", () => {
            state.tab = id;
            renderTabs();
        });
        bar.appendChild(tab);
    }
    $("tab-steps").hidden = state.tab !== "steps";
    $("result").hidden = state.tab !== "result";
    const evidence = $("evidence");
    evidence.hidden = !EVIDENCE_TABS.has(state.tab);
    if (!evidence.hidden) {
        evidence.innerHTML = "";
        TraceView.render(evidence, run, state.tab);
    }
}

// A finding's "requests" / "trace" link opens that tab here.
TraceView.onTab((id) => {
    state.tab = id;
    renderTabs();
});

function renderCounts() {
    const steps = state.run?.steps ?? [];
    const actions = steps.filter((s) => s.executed && !["DONE", "BLOCKED", "ASK_USER"].includes(s.operation)).length;
    const decisions = steps.filter((s) => s.mode !== "replay").length;
    const replayed = steps.length - decisions;
    $("counts").textContent = steps.length
        ? `${decisions} decisions · ${actions} actions${replayed ? ` · ${replayed} replayed` : ""}`
        : "";
    $("hud-steps").textContent = String(steps.length);
    $("hud-actions").textContent = String(actions);
    renderPace();
    const last = steps[steps.length - 1];
    $("now").textContent = last ? `${last.operation} ${last.target ?? ""}` : "";
}

/** Text as a sentence: capital first letter. */
function sentence(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const RUN_ENDINGS = { done: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled" };

/** How the run itself ended, before the review: its status, and why when it did not finish. */
function runEnding(r) {
    const status = RUN_ENDINGS[r.status] ?? r.status;
    if (r.status === "done") {
        return "done — the agent reached the goal";
    }
    if (r.goal?.state === "failed") {
        // The evidence it saw is the goal's signals, shown with the problems.
        return `${status} — the goal failed during the run`;
    }
    return r.reason ? `${status} — ${r.reason}` : status;
}

function renderResult(run) {
    const box = $("result");
    box.innerHTML = "";
    if (run.error) {
        setPhase("error");
        setStopwatch("failed", "error");
        const head = h("div", "rs-head");
        head.append(h("span", "rs-status error", "ERROR"), h("h3", "", "The run could not complete"));
        box.append(head, h("div", "rs-reason bad", run.error));
        return;
    }
    const r = run.result;
    if (!r) {
        setPhase("finished", "cancelled");
        setStopwatch("idle", "stopped");
        return;
    }
    setPhase(r.status);
    setClock(r.elapsedMs);
    const verdict = run.analysis?.verdict;
    if (verdict) {
        setStopwatch(verdict === "passed" ? "done" : "failed", verdict);
    } else if (run.reviewing) {
        setStopwatch(r.status === "done" ? "done" : "failed", `${r.status} · reviewing`);
    } else {
        setStopwatch(r.status === "done" ? "done" : "failed", r.status);
    }
    if (run.recordingSaved) {
        loadScenarios();
    }
    const a = run.analysis;
    // One headline: the verdict and why. How the run itself ended is a fact below, not a second banner.
    const head = h("div", "rs-head");
    const status = a ? a.verdict : run.reviewing ? "reviewing" : r.status;
    head.appendChild(h("span", `rs-status ${a ? (a.verdict === "passed" ? "done" : "failed") : run.reviewing ? "reviewing" : r.status}`, status.toUpperCase()));
    const headline = a
        ? a.summary
        : run.reviewing
          ? "Jev is reviewing the run"
          : run.analysisError
            ? "Not reviewed"
            : r.status === "done"
              ? "The run reached its goal"
              : `The run ${r.status}`;
    head.appendChild(h("h3", `rs-headline ${a ? (a.verdict === "passed" ? "ok" : "bad") : ""}`, sentence(headline)));
    const stats = h("div", "rs-stats");
    for (const [value, label] of [[fmtMs(r.elapsedMs), "time"], [r.actions, "actions"], [r.decisions, "decisions"]]) {
        const s = h("span", "rs-stat");
        s.append(h("b", "", String(value)), h("small", "", label));
        stats.appendChild(s);
    }
    head.appendChild(stats);
    box.appendChild(head);
    if (run.reviewing) {
        box.appendChild(h("div", "rs-reason info", "Reading the final page, the requests, the console and — when IronBee is on — the trace, once it has settled."));
    } else if (!a && run.analysisError) {
        box.appendChild(h("div", "rs-reason warn", run.analysisError));
    }
    if (run.divergence) {
        box.appendChild(h("div", "rs-reason warn", `Replay diverged: ${run.divergence}`));
    }
    // A failed run's why, in words, by the text model: after the verdict, which it does not change.
    if (a?.explanation) {
        const why = h("div", "rs-explanation");
        why.append(h("div", "rs-explanation-head", `Why it failed — explained by ${a.explanation.model} (${fmtMs(a.explanation.ms)})`), h("p", "", a.explanation.text));
        box.appendChild(why);
    } else if (run.explaining) {
        const why = h("div", "rs-explanation pending");
        why.append(h("span", "spinner"), h("span", "", `Asking ${run.generator ?? "the text model"} to explain why it failed…`));
        box.appendChild(why);
    } else if (a?.explanationError) {
        box.appendChild(h("div", "rs-reason warn", `No explanation: ${a.explanationError}`));
    }

    const facts = h("dl", "rs-facts");
    fact(facts, "Run ended", runEnding(r));
    fact(facts, "Mode", run.mode);
    fact(facts, "Browser", run.profile ? `profile ${run.profile}` : "fresh");
    fact(facts, "Text model", run.generator);
    fact(facts, "Scenario", run.scenario ? `${run.scenario}${run.recordingSaved ? " · recording cached" : ""}` : "");
    const page = h("a", "", r.finalUrl);
    page.href = r.finalUrl;
    page.target = "_blank";
    page.rel = "noopener";
    fact(facts, "Final page", page, "mono");
    box.appendChild(facts);
    // What did not go as configured on the way; the verdict above stands regardless.
    for (const message of run.warnings ?? []) {
        box.appendChild(h("div", "rs-reason warn", message));
    }

    if (a) {
        const section = h("div", "rs-section");
        const sources = run.platform ? "the page, the requests and the trace" : "the page and the requests";
        section.appendChild(goalLine(a.goal, { engine: "Jev", sources }, a.findings.length === 0));
        const title = h("div", "rs-title");
        title.append(
            h("h4", "", "Problems"),
            h("span", `rs-count ${a.findings.length ? "bad" : "ok"}`, a.findings.length ? String(a.findings.length) : "none"),
            h("span", "muted", `out of ${a.candidates} anomal${a.candidates === 1 ? "y" : "ies"} reviewed`)
        );
        section.appendChild(title);
        if (a.findings.length) {
            const cards = h("div", "ck-list");
            a.findings.forEach((f, i) => cards.appendChild(findingCard(f, i)));
            section.appendChild(cards);
        }
        box.appendChild(section);
    }

    if (!run.platform && !run.reviewing && state.config?.ironbee?.canConnect && !state.config.ironbee.ok) {
        box.appendChild(ironbeeInvite());
    }
    const foot = h("div", "rs-foot");
    if (run.platform) {
        const ib = h("div", "rs-ib");
        ib.appendChild(h("span", `rs-pill ${run.platform.reportError ? "bad" : "ok"}`, `IronBee · ${run.platform.domain} · ${run.platform.reportError ? "not reported" : "reported"}`));
        for (const [label, id] of [["session", run.platform.sessionId], ["trace", run.platform.traceId]]) {
            const item = h("span", "rs-id");
            item.append(h("small", "", label), h("code", "", id), copyButton(id));
            ib.appendChild(item);
        }
        if (run.platform.reportError) {
            ib.appendChild(h("span", "bad", run.platform.reportError));
        }
        foot.appendChild(ib);
    }
    if (run.hasVideo) {
        // One video per tab the run was on.
        const parts = Math.max(1, run.videoPartCount ?? 1);
        for (let i = 0; i < parts; i++) {
            const a = h("a", "button-link", parts > 1 ? `⬇ Recording ${i + 1}/${parts}` : "⬇ Recording");
            a.href = `/api/runs/${run.id}/video${i > 0 ? `?part=${i}` : ""}`;
            a.target = "_blank";
            foot.appendChild(a);
        }
    }
    if (foot.childNodes.length) {
        box.appendChild(foot);
    }
}

// ---------- scenarios ----------

async function loadScenarios() {
    const list = $("scenario-list");
    const { scenarios } = await (await fetch("/api/scenarios")).json();
    state.scenarioNames = new Set(scenarios.map((s) => s.name));
    list.innerHTML = "";
    if (!scenarios.length) {
        list.innerHTML = '<li class="empty">None yet. Fill the form, name it and press Save.</li>';
        return;
    }
    for (const s of scenarios) {
        const li = document.createElement("li");
        li.innerHTML = '<div class="head"><b></b><span><button type="button" class="load">Load</button> <button type="button" class="clear">Clear cache</button> <button type="button" class="del">Delete</button></span></div><div class="goal"></div><div class="meta"></div>';
        li.querySelector("b").textContent = s.name;
        li.querySelector(".goal").textContent = s.description ?? s.goal;
        li.querySelector(".goal").title = s.goal;
        const cached = s.cached?.entries ?? 0;
        li.querySelector(".meta").textContent = cached
            ? `${cached} recording${cached === 1 ? "" : "s"} cached`
            : "nothing cached: a run explores";
        li.querySelector(".load").addEventListener("click", () => useScenario(s.name));
        const clear = li.querySelector(".clear");
        if (!cached) {
            clear.remove();
        } else {
            clear.title = "Drop this scenario's cached recordings: its next run explores with the engine";
            clear.addEventListener("click", async () => {
                const confirmed = await confirmDialog({
                    kind: "clear",
                    title: "Clear cached recordings?",
                    name: s.name,
                    detail: `${cached} recording${cached === 1 ? "" : "s"} will be removed. The scenario stays, and its next run explores with the engine and records again.`,
                    action: "Clear cache",
                });
                if (!confirmed) {
                    return;
                }
                await fetch(`/api/scenarios/${encodeURIComponent(s.name)}/cache`, { method: "DELETE" });
                if (state.scenario?.name === s.name) {
                    showScenarioChip(state.scenario);
                }
                loadScenarios();
            });
        }
        li.querySelector(".del").title = "Delete the scenario and its cached recordings";
        li.querySelector(".del").addEventListener("click", async () => {
            const confirmed = await confirmDialog({
                kind: "delete",
                title: "Delete this scenario?",
                name: s.name,
                detail: cached
                    ? `The scenario and its ${cached} cached recording${cached === 1 ? "" : "s"} will be deleted. This cannot be undone.`
                    : "The scenario will be deleted. This cannot be undone.",
                action: "Delete",
            });
            if (!confirmed) {
                return;
            }
            await fetch(`/api/scenarios/${encodeURIComponent(s.name)}`, { method: "DELETE" });
            if (state.scenario?.name === s.name) {
                clearScenario();
            }
            loadScenarios();
        });
        list.appendChild(li);
    }
}

/** Fills the form from a scenario. Secret values are never stored: the user types them. */
async function useScenario(name) {
    const { scenario, recording } = await (await fetch(`/api/scenarios/${encodeURIComponent(name)}`)).json();
    state.scenario = scenario;
    $("url").value = scenario.url ?? "";
    $("goal").value = scenario.goal;
    $("values").innerHTML = "";
    const descriptions = scenario.descriptions ?? {};
    for (const [k, v] of Object.entries(scenario.values ?? {})) {
        addRow("values", "value-row", { name: k, value: v, "is-secret": false, description: descriptions[k] ?? "" });
    }
    for (const k of scenario.secretNames ?? []) {
        addRow("values", "value-row", {
            name: k,
            value: "",
            "is-secret": true,
            "is-password": (scenario.passwordSecrets ?? []).includes(k),
            description: descriptions[k] ?? "",
        });
    }
    // The scenario's own text setup (healing may need it).
    if (scenario.textCandidates) {
        for (const box of document.querySelectorAll("input[name=candidate]")) {
            box.checked = box.value === "supplied" || scenario.textCandidates.includes(box.value);
        }
    }
    if (scenario.textModel) {
        setTextModel(scenario.textModel);
    }
    // The scenario's profile is the run's: one not saved here yet (a fresh checkout, a
    // teammate's scenario) is created, as the CLI does, instead of silently running fresh.
    let profileNote = "";
    if (scenario.profile && !state.profiles?.some((p) => p.name === scenario.profile)) {
        const response = await fetch("/api/profiles", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: scenario.profile }),
        });
        if (response.ok) {
            await loadProfiles(scenario.profile);
            profileNote = ` · profile "${scenario.profile}" created (empty until a run signs in)`;
        } else {
            profileNote = ` · profile "${scenario.profile}" could not be created: ${(await response.json()).error}`;
        }
    }
    $("profile").value = scenario.profile && state.profiles?.some((p) => p.name === scenario.profile) ? scenario.profile : "";
    renderProfileHint();
    hideOverwrite();
    $("save-as").value = scenario.name;
    $("save-status").textContent = "";
    $("explore").checked = false;
    await showScenarioChip(scenario, recording ?? null);
    $("scenario-meta").textContent += profileNote;
}

/** The loaded scenario's name and whether its prompt, as saved, has a cached recording. */
async function showScenarioChip(scenario, recording) {
    if (recording === undefined) {
        recording = (await (await fetch(`/api/scenarios/${encodeURIComponent(scenario.name)}`)).json()).recording ?? null;
    }
    $("scenario-name").textContent = scenario.name;
    $("scenario-meta").textContent = recording
        ? `· ${recording.steps} steps cached: replays without the engine (an edited goal or URL explores)`
        : "· nothing cached for this goal: the engine explores";
    $("scenario-chip").hidden = false;
}

/** Unloads the scenario and empties what it filled in (the start URL stays). */
function clearScenario() {
    state.scenario = null;
    $("scenario-chip").hidden = true;
    $("goal").value = "";
    $("values").innerHTML = "";
    addRow("values", "value-row");
    hideOverwrite();
    $("save-as").value = "";
    $("save-status").textContent = "";
    $("explore").checked = false;
    $("profile").value = "";
    renderProfileHint();
    saveForm();
}

/** Clears the form and, when no run is going, the last run's result, steps and screen. */
function clearAll() {
    clearScenario();
    // The whole form: the start URL too (the chip's own clear keeps it — the site stays the same).
    $("url").value = "";
    saveForm();
    $("form-error").hidden = true;
    const running = state.run && state.run.phase !== "finished";
    if (running) {
        return;
    }
    state.run = null;
    renderWarnings(null);
    showRescue(undefined);
    $("result").innerHTML = "";
    $("steps").innerHTML = "";
    $("counts").textContent = "";
    $("now").textContent = "";
    setClock(0);
    setStopwatch("idle", "ready");
    setBrowserUrl("");
    setBrowserActivity("");
    renderCounts();
    renderTabs();
    setPhase("idle");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $("screen-empty").hidden = false;
}

// ---------- wiring ----------

function connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
            drawFrame(event.data).catch(() => {});
            return;
        }
        const message = JSON.parse(event.data);
        if (message.type === "hello" || message.type === "run") {
            if (message.type === "run" && message.run?.phase !== "finished" && state.run?.id !== message.run?.id) {
                state.runStartedAt = 0;
                state.clockStoppedAt = undefined;
                setClock(0);
                showRescue(undefined);
                state.pausedTotal = 0;
                state.pauseStart = 0;
                $("screen-empty").hidden = false;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            if (message.type === "hello" && message.run && message.run.phase !== "finished") {
                // Joined (or reloaded) during a run: the user's turns so far are not run time.
                state.pausedTotal = (message.run.steps ?? []).reduce((sum, s) => sum + (s.userAction?.waitMs ?? 0), 0);
                state.pauseStart = 0;
            }
            renderRun(message.run);
            showUserAction(
                message.run && message.run.phase !== "finished" ? message.run.userAction : undefined,
                message.run?.userActionSince
            );
        } else if (message.type === "user-action" && state.run?.id === message.id) {
            showUserAction(message.request);
        } else if (message.type === "user-action-done" && state.run?.id === message.id) {
            showUserAction(undefined);
        } else if (message.type === "phase" && state.run?.id === message.id) {
            state.run.phase = message.phase;
            if (message.phase === "running") {
                setStopwatch("running", "running");
                setBrowserActivity("loading");
            }
            setPhase(message.phase);
        } else if (message.type === "warning" && state.run?.id === message.id) {
            state.run.warnings = [...(state.run.warnings ?? []), message.message];
            renderWarnings(state.run);
        } else if (message.type === "clock" && state.run?.id === message.id) {
            // Navigation and the first page load are over: the run's clock starts, as the result counts it.
            state.runStartedAt = Date.now();
            state.pausedTotal = 0;
        } else if (message.type === "rescue" && state.run?.id === message.id) {
            state.run.rescue = message.event;
            showRescue(message.event);
        } else if (message.type === "clock-stop" && state.run?.id === message.id) {
            // The run is over: its time is final while the video and the evidence are read.
            state.clockStoppedAt = message.elapsedMs;
            setClock(message.elapsedMs);
        } else if (message.type === "step" && state.run?.id === message.id) {
            // The text model's step is in; its notice stays while it has the controls.
            state.run.steps.push(message.step);
            $("steps").appendChild(renderStep(message.step));
            setBrowserUrl(message.step.url);
            renderCounts();
            renderTabs();
        }
    };
    ws.onclose = () => setTimeout(connect, 1000);
}

async function submit(event, confirmed = false) {
    event?.preventDefault();
    hideOverwrite();
    $("form-error").hidden = true;
    saveForm();
    // An empty secret would be typed as nothing (secrets are never saved: a loaded scenario asks again).
    const unset = [...$("values").querySelectorAll(".row")].find(
        (row) => row.querySelector(".is-secret").checked && row.querySelector(".name").value.trim() && !row.querySelector(".value").value
    );
    if (unset) {
        $("form-error").textContent = `Enter the value of the secret "${unset.querySelector(".name").value.trim()}" (secrets are never saved, so a loaded scenario asks for them again).`;
        $("form-error").hidden = false;
        unset.querySelector(".value").focus();
        return;
    }
    // A run never saves the scenario (only Save does); a passing run of a loaded scenario is cached.
    const body = {
        url: $("url").value,
        goal: $("goal").value,
        values: readValues(),
        textModel: selectedTextModel(),
        textCandidates: selectedCandidates(),
        profile: selectedProfile(),
        scenario: state.scenario?.name,
        explore: $("explore").checked,
    };
    $("run").disabled = true;
    const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        $("form-error").textContent = error.error ?? `HTTP ${response.status}`;
        $("form-error").hidden = false;
        $("run").disabled = false;
    }
}

/** Saves the form as a scenario now (secret values stay out; only their names are kept). */
// ---------- asking before a scenario is replaced ----------

/** Shows the question with Overwrite / Cancel; `onYes` runs on Overwrite. */
function confirmOverwrite(text, yesLabel, onYes) {
    $("save-confirm-text").textContent = text;
    $("save-confirm-yes").textContent = yesLabel;
    $("save-confirm").hidden = false;
    state.onOverwrite = onYes;
    $("save-confirm-yes").focus();
}

function hideOverwrite() {
    $("save-confirm").hidden = true;
    state.onOverwrite = null;
}

/** The question for replacing scenario `name` (the loaded one is an update). */
function overwriteQuestion(name) {
    return state.scenario?.name === name
        ? `Update the scenario "${name}" with the form? Its recording is kept, unless the goal or the start URL changed.`
        : `A scenario named "${name}" already exists. Overwrite it with the form?`;
}

async function saveScenario(overwrite = false) {
    hideOverwrite();
    const name = $("save-as").value.trim();
    const status = $("save-status");
    status.className = "hint";
    if (!name) {
        status.className = "hint bad";
        status.textContent = "Enter a name to save the form as a scenario.";
        $("save-as").focus();
        return;
    }
    const response = await fetch(`/api/scenarios/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            url: $("url").value,
            goal: $("goal").value,
            values: readValues(),
            textModel: selectedTextModel(),
            textCandidates: selectedCandidates(),
            profile: selectedProfile(),
            overwrite,
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.exists) {
        status.textContent = "";
        confirmOverwrite(overwriteQuestion(data.exists), state.scenario?.name === data.exists ? "Update" : "Overwrite", () =>
            saveScenario(true).catch((err) => {
                status.className = "hint bad";
                status.textContent = String(err);
            })
        );
        return;
    }
    if (!response.ok) {
        status.className = "hint bad";
        status.textContent = data.error ?? `HTTP ${response.status}`;
        return;
    }
    state.scenario = data.scenario;
    showScenarioChip(data.scenario);
    status.className = "hint ok";
    status.textContent = `Saved "${data.scenario.name}". A passing run caches how it is done.`;
    loadScenarios();
}

async function init() {
    setBrowserUrl("");
    const saved = loadForm();
    state.config = await (await fetch("/api/config")).json();
    renderConfig(state.config, saved);
    $("url").value = saved?.url ?? "";
    $("goal").value = saved?.goal ?? "";
    for (const v of saved?.values ?? [{ name: "email", value: "", secret: false }]) {
        addRow("values", "value-row", { name: v.name, value: v.value, "is-secret": v.secret, "is-password": Boolean(v.password), description: v.description ?? "" });
    }
    $("add-value").addEventListener("click", () => addRow("values", "value-row"));
    await loadProfiles(saved?.profile);
    $("profile").addEventListener("change", () => {
        renderProfileHint();
        saveForm();
    });
    $("profile-create").addEventListener("click", () => createProfile().catch(() => {}));
    $("profile-name").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            createProfile().catch(() => {});
        }
    });
    $("profile-delete").addEventListener("click", () => deleteProfile().catch(() => {}));
    $("scenario-clear").addEventListener("click", clearScenario);
    $("clear").addEventListener("click", clearAll);
    $("save-confirm-yes").addEventListener("click", () => state.onOverwrite?.());
    $("save-confirm-no").addEventListener("click", hideOverwrite);
    // Another name: the question was about the old one.
    $("save-as").addEventListener("input", hideOverwrite);
    $("save-scenario").addEventListener("click", () => saveScenario().catch((err) => {
        $("save-status").className = "hint bad";
        $("save-status").textContent = String(err);
    }));
    loadScenarios().catch(() => {});
    $("url").addEventListener("input", saveForm);
    $("goal").addEventListener("input", saveForm);
    $("run-form").addEventListener("submit", submit);
    const post = (path) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    $("stop").addEventListener("click", () => post("/api/runs/stop"));
    $("ua-continue").addEventListener("click", () => post("/api/runs/continue"));
    $("ua-stop").addEventListener("click", () => post("/api/runs/stop"));
    connect();
}

init().catch((err) => {
    $("form-error").textContent = String(err);
    $("form-error").hidden = false;
});
