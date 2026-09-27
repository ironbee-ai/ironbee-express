/**
 * `control_act`'s network wait, hover, press-key and history actions through
 * a live DevTools daemon with the control-tools plugin: each returns the next
 * snapshot in the same call, like the others. The daemon runs with DevTools'
 * own defaults (dialogs dismissed, new tabs not followed).
 *
 *   IBEXPRESS_E2E_DAEMON_SCRIPT=../ironbee-devtools/dist/daemon-server.js npx jest tests/integration/control
 */

import { DaemonHandle } from "../../../src/devtools/daemon";
import { ActResult, Control, ControlSnapshot } from "../../../src/devtools/types";
import { ControlSession, describeLive, find, FixtureSite, named, sleep, startLiveDaemon } from "../../helpers/control-live";

const PAGE: string = `
<style>
  .menu .items { display: none; }
  .menu:hover .items { display: block; }
</style>
<p id="status">idle</p>
<div class="menu">
  <button>Account</button>
  <div class="items"><a href="#settings">Settings</a></div>
</div>
<div id="dialog" role="dialog">Cookie notice <button>Accept</button></div>
<label>City <input id="city" onkeydown="if (event.key === 'ArrowDown') document.getElementById('status').textContent = 'down in ' + this.id"></label>
<script>
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.getElementById('dialog').remove();
  });
</script>
`;

const SHOW_LIST: string = "document.getElementById('list').innerHTML = '<button>Add to cart</button>'";

jest.setTimeout(120_000);

describeLive("control_act: network wait, hover, press-key, go-back / go-forward (live daemon)", (): void => {
    let site: FixtureSite;
    let daemon: DaemonHandle;
    let session: ControlSession;

    beforeAll(async (): Promise<void> => {
        site = await FixtureSite.start();
        daemon = await startLiveDaemon({ BROWSER_DIALOG_MODE: "dismiss", BROWSER_FOLLOW_NEW_TABS: "false" });
    });
    afterAll(async (): Promise<void> => {
        await daemon?.stop();
        await site?.close();
    });
    beforeEach((): void => {
        session = new ControlSession(daemon);
    });
    afterEach(async (): Promise<void> => {
        await session.close();
    });

    async function clickAndWait(
        snap: ControlSnapshot,
        name: string,
        waitForNetworkMs: number
    ): Promise<{ out: ActResult; ms: number }> {
        const started: number = Date.now();
        const out: ActResult = await session.click(snap, name, { waitForNetworkMs });
        return { out, ms: Date.now() - started };
    }

    it("waits for the requests a click started when asked, so the loaded list is observed", async (): Promise<void> => {
        const LIST: string = `
<button onclick="fetch('/api/slow?ms=400').then(() => { ${SHOW_LIST}; })">Products</button>
<div id="list"></div>`;

        let snap: ControlSnapshot = await session.load(site, LIST);
        let out: ActResult = await session.click(snap, "Products");
        expect(out.networkIdle).toBeUndefined();
        expect(named(out.snapshot!, "Add to cart")).toBeUndefined();

        snap = await session.load(site, LIST);
        out = await session.click(snap, "Products", { waitForNetworkMs: 3_000 });
        expect(out.networkIdle).toBe(true);
        expect(named(out.snapshot!, "Add to cart")).toBeDefined();

        snap = await session.load(site, LIST);
        out = await session.click(snap, "Products", { waitForNetworkMs: 100 });
        expect(out.networkIdle).toBe(false);
    });

    it("keeps waiting through a pushState made while the list loads", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<button onclick="fetch('/api/slow?ms=400').then(() => { ${SHOW_LIST}; }); history.pushState({}, '', '?page=products')">Products</button>
<div id="list"></div>`
        );
        const { out } = await clickAndWait(snap, "Products", 3_000);
        expect(out.networkIdle).toBe(true);
        expect(named(out.snapshot!, "Add to cart")).toBeDefined();
    });

    it("waits for a request that follows another", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<button onclick="fetch('/api/slow?ms=200').then(() => new Promise((r) => setTimeout(r, 80))).then(() => fetch('/api/slow?ms=200')).then(() => { ${SHOW_LIST}; })">Products</button>
<div id="list"></div>`
        );
        const { out } = await clickAndWait(snap, "Products", 3_000);
        expect(out.networkIdle).toBe(true);
        expect(named(out.snapshot!, "Add to cart")).toBeDefined();
    });

    it("is not held by a request opened before the action", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<script>fetch('/api/slow?ms=5000');</script>
<button onclick="document.getElementById('status').textContent = 'clicked'">Ping</button>
<p id="status"></p>`
        );
        const { out, ms } = await clickAndWait(snap, "Ping", 3_000);
        expect(out.networkIdle).toBe(true);
        expect(ms).toBeLessThan(1_500);
    });

    it("waits, on a wait action, for what is already loading", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<button onclick="fetch('/api/slow?ms=500').then(() => { ${SHOW_LIST}; })">Products</button>
<div id="list"></div>`
        );
        let out: ActResult = await session.click(snap, "Products");
        expect(named(out.snapshot!, "Add to cart")).toBeUndefined();
        out = await session.act({ action: "wait", waitMs: 0, waitForNetworkMs: 3_000 });
        expect(out.networkIdle).toBe(true);
        expect(named(out.snapshot!, "Add to cart")).toBeDefined();
    });

    it("does not wait, on a wait action, for the requests of a document navigated away from or an iframe removed", async (): Promise<void> => {
        // Navigated away from: the old document's slow request is not waited for.
        await session.load(site, "<script>fetch('/api/slow?ms=5000');</script><p>busy</p>");
        // While it is on the page, the wait does see it.
        let out: ActResult = await session.act({ action: "wait", waitMs: 0, waitForNetworkMs: 300 });
        expect(out.networkIdle).toBe(false);
        await session.go(`${site.url}/mpa/login`);
        let started: number = Date.now();
        out = await session.act({ action: "wait", waitMs: 0, waitForNetworkMs: 3_000 });
        expect(out.networkIdle).toBe(true);
        expect(Date.now() - started).toBeLessThan(1_500);

        // An iframe removed by a script: its request goes with it.
        await session.load(site, `<iframe srcdoc="<script>fetch('/api/slow?ms=6000')</script>"></iframe>`);
        await sleep(200);
        out = await session.act({ action: "wait", waitMs: 0, waitForNetworkMs: 300 });
        expect(out.networkIdle).toBe(false);
        await session.page(`await page.evaluate(() => document.querySelector("iframe").remove()); await sleep(100);`);
        started = Date.now();
        out = await session.act({ action: "wait", waitMs: 0, waitForNetworkMs: 3_000 });
        expect(out.networkIdle).toBe(true);
        expect(Date.now() - started).toBeLessThan(1_500);
    });

    it("hovers a control, and the next snapshot shows what opened", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(site, PAGE);
        expect(named(snap, "Settings")).toBeUndefined();
        const out: ActResult = await session.act({ action: "hover", snapshotId: snap.snapshotId, controlId: find(snap, "Account").id });
        expect(out.executed).toBe(true);
        expect(named(out.snapshot!, "Settings")).toBeDefined();
    });

    it("fills a date input, which takes no typed text", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            "<label>When <input type=\"date\" oninput=\"document.getElementById('got').textContent = this.value\"></label><p id=\"got\">none</p>"
        );
        const out: ActResult = await session.act({ action: "fill", value: "2024-01-15", snapshotId: snap.snapshotId, controlId: find(snap, "When").id });
        expect(out.executed).toBe(true);
        expect(out.snapshot!.text).toContain("2024-01-15");
    });

    it("presses a key where focus is, or in a control focused first; refuses what is not a key", async (): Promise<void> => {
        await session.load(site, PAGE);
        let out: ActResult = await session.act({ action: "press-key", value: "Escape" });
        expect(out.executed).toBe(true);
        expect(named(out.snapshot!, "Accept")).toBeUndefined();

        const snap: ControlSnapshot = out.snapshot!;
        out = await session.act({ action: "press-key", value: "ArrowDown", snapshotId: snap.snapshotId, controlId: find(snap, "City").id });
        expect(out.snapshot!.text).toContain("down in city");

        await expect(session.act({ action: "press-key", value: "hello world" })).rejects.toThrow(/key name/);
        await expect(session.act({ action: "press-key", value: "{{secret:api.value}}" })).rejects.toThrow();
    });

    it("goes back and forward in the history, and refuses when there is nowhere to go", async (): Promise<void> => {
        await session.go(`${site.url}/mpa/login`);
        await session.go(`${site.url}/mpa/home`);
        let out: ActResult = await session.act({ action: "go-back" });
        expect(out.executed).toBe(true);
        expect(new URL(out.snapshot!.url).pathname).toBe("/mpa/login");

        out = await session.act({ action: "go-forward" });
        expect(out.executed).toBe(true);
        expect(new URL(out.snapshot!.url).pathname).toBe("/mpa/home");

        out = await session.act({ action: "go-forward" });
        expect(out.executed).toBe(false);
        expect(out.reason).toMatch(/no page to go forward/);
    });

    it("leaves a native dialog to the dismiss mode: dismissed, no dialog snapshot", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `<p id="s">idle</p><button onclick="document.getElementById('s').textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>`
        );
        const out: ActResult = await session.click(snap, "Ask");
        expect(out.snapshot!.dialog).toBeUndefined();
        expect(out.snapshot!.text).toContain("no");
    });

    it("stays on its page when a link opens a new tab (BROWSER_FOLLOW_NEW_TABS off)", async (): Promise<void> => {
        const url: string = site.page(`<a href="${site.url}/mpa/home" target="_blank">Open home</a>`);
        await session.go(url);
        const snap: ControlSnapshot = await session.snapshot();
        const out: ActResult = await session.click(snap, "Open home");
        expect(out.executed).toBe(true);
        expect(out.snapshot!.url).toBe(url);
        expect(out.snapshot!.tabs).toBeUndefined();
        await session.closeOtherTabs();
    });

    it("observes after a panel the action slid in has come to rest, so the next action on it is not refused", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<style>
  #panel { position: fixed; top: 40px; left: 0; width: 300px; transform: translateX(-400px); transition: transform 400ms linear; }
  #panel.open { transform: translateX(300px); }
</style>
<button onclick="document.getElementById('panel').classList.add('open')">Dates</button>
<div id="panel" role="dialog"><p id="month">June</p><button onclick="document.getElementById('month').textContent = 'July'">Next month</button></div>`
        );
        const opened: ActResult = await session.click(snap, "Dates");
        expect(opened.executed).toBe(true);
        const next: ActResult = await session.click(opened.snapshot!, "Next month");
        expect(next.reason).toBeUndefined();
        expect(next.executed).toBe(true);
        expect(next.snapshot!.text).toContain("July");
    });

    it("still acts when the page changes around the control, and not when the control itself changed", async (): Promise<void> => {
        const CHANGING: string = `
<p id="status">idle</p>
<label>Name <input id="name"></label>
<ul><li>Sunday <a href="#sunday" onclick="document.getElementById('status').textContent = 'sunday'">Open</a></li>
<li>Monday <a href="#monday" onclick="document.getElementById('status').textContent = 'monday'">Open</a></li></ul>`;
        const open: (change: string) => Promise<ActResult> = async (change: string): Promise<ActResult> => {
            const snap: ControlSnapshot = await session.load(site, CHANGING);
            await session.page(`await page.evaluate(() => { ${change} });`);
            const sunday: Control = find(snap, "Open", "Sunday");
            return session.act({ action: "click", snapshotId: snap.snapshotId, controlId: sunday.id });
        };
        // Around it: a late widget's fields, another field typed into, the address changed in place, a scroll.
        for (const change of [
            `const form = document.createElement("form"); form.innerHTML = '<input type="range" value="25"><input value="1">'; document.body.appendChild(form);`,
            `document.getElementById("name").value = "Ada";`,
            `history.replaceState(null, "", "#view=2");`,
            `document.body.style.height = "3000px"; scrollTo(0, 10);`,
        ]) {
            const out: ActResult = await open(change);
            expect(out.reason).toBeUndefined();
            expect(out.snapshot!.text).toContain("sunday");
        }
        // The control itself: its link target, or the context that told it apart from the other "Open".
        for (const change of [
            `document.querySelector("a").setAttribute("href", "#elsewhere");`,
            `document.querySelector("li").firstChild.textContent = "Tuesday ";`,
        ]) {
            const out: ActResult = await open(change);
            expect(out.executed).toBe(false);
            expect(out.reason).toMatch(/stale/);
        }
    });

    it("fills the field it was asked to when the click moves focus to another field the page showed", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<label>From <input id="from" onclick="if (!this.dataset.once) { this.dataset.once = '1'; document.getElementById('to').focus(); }"></label>
<label>To <input id="to"></label>`
        );
        const out: ActResult = await session.fill(snap, "From", "Paris");
        expect(out.executed).toBe(true);
        expect(await session.inputValue("#from")).toBe("Paris");
        expect(await session.inputValue("#to")).toBe("");
    });

    it("does not wait for an endless animation", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<style>
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { width: 20px; height: 20px; border: 2px solid; animation: spin 800ms linear infinite; }
</style>
<div class="spinner"></div>
<p id="status">idle</p>
<button onclick="document.getElementById('status').textContent = 'saved'">Save</button>`
        );
        const startedMs: number = Date.now();
        const out: ActResult = await session.click(snap, "Save");
        expect(out.executed).toBe(true);
        expect(out.snapshot!.text).toContain("saved");
        // The original in-process bound was 700 ms; the daemon round trip is on top.
        expect(Date.now() - startedMs).toBeLessThan(1_000);
    });
});
