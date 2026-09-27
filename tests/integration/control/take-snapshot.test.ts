/**
 * `control_take-snapshot` + `control_act` through a live DevTools daemon with
 * the control-tools plugin: one-call observation of the visible controls, and
 * guarded execution by control id that refuses (without acting) when the
 * target or its surroundings changed.
 *
 *   IBEXPRESS_E2E_DAEMON_SCRIPT=../ironbee-devtools/dist/daemon-server.js npx jest tests/integration/control
 */

import { DaemonHandle } from "../../../src/devtools/daemon";
import { ActResult, Control, ControlSnapshot } from "../../../src/devtools/types";
import { ControlSession, describeLive, find, FixtureSite, names, startLiveDaemon } from "../../helpers/control-live";

const FORM_PAGE: string = `
<h1>Checkout</h1>
<p id="status">idle</p>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'submitted ' + document.getElementById('q').value">
  <label>Query <input id="q" value="old text"></label>
  <label>Password <input id="pw" type="password" value="s3cr3t-value"></label>
  <label>Country
    <select id="country"><option value="tr" selected>Turkey</option><option value="de">Germany</option><option value="x" disabled>Nowhere</option></select>
  </label>
  <label><input id="terms" type="checkbox"> Accept terms</label>
  <!-- Enter submits a form with several fields only when it has a submit button. -->
  <button type="submit">Submit</button>
</form>
<button id="inc" onclick="this.textContent = 'Clicked ' + (++window.n)">Count</button>
<button disabled>Disabled</button>
<button style="display:none">Hidden</button>
<input type="hidden" name="h" value="hidden">
<ul>
  <li>Red shirt <button onclick="document.getElementById('status').textContent='added red'">Add to cart</button></li>
  <li>Blue shirt <button onclick="document.getElementById('status').textContent='added blue'">Add to cart</button></li>
</ul>
<button><span class="material-icons">login</span> Sign in</button>
<div id="ticker">tick 0</div>
<script>window.n = 0;</script>
<div style="height: 3000px"></div>
<button>Far below</button>
`;

jest.setTimeout(120_000);

describeLive("control snapshot + control_act (live daemon)", (): void => {
    let site: FixtureSite;
    let daemon: DaemonHandle;
    let session: ControlSession;

    beforeAll(async (): Promise<void> => {
        site = await FixtureSite.start();
        // DevTools' defaults, as the tools had them: dialogs dismissed, new tabs not followed.
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

    function loadForm(): Promise<ControlSnapshot> {
        return session.load(site, FORM_PAGE);
    }

    it("lists visible, enabled controls with state — and never a password value", async (): Promise<void> => {
        const snap: ControlSnapshot = await loadForm();
        const listed: string[] = names(snap);

        expect(find(snap, "Query")).toMatchObject({ role: "textbox", value: "old text", ops: ["fill", "click"] });
        const pw: Control = find(snap, "Password");
        expect(pw).toMatchObject({ role: "textbox", password: true, filled: true });
        expect(pw.value).toBeUndefined();
        expect(JSON.stringify(snap)).not.toContain("s3cr3t-value");

        expect(find(snap, "Country")).toMatchObject({
            role: "combobox",
            value: "Turkey",
            ops: ["select"],
            options: [{ value: "de", label: "Germany" }],
        });
        expect(find(snap, "Accept terms")).toMatchObject({ role: "checkbox", checked: "false" });
        // Drawn text makes the name, an icon font's ligature too — as in an accessibility tree.
        expect(listed).toContain("login Sign in");
        // Disabled, hidden and off-screen controls are not offered.
        expect(listed).not.toContain("Disabled");
        expect(listed).not.toContain("Hidden");
        expect(listed).not.toContain("Far below");
        expect(snap.offscreenControls).toBeGreaterThanOrEqual(1);
        expect(snap.canScrollDown).toBe(true);
        // Identical controls carry the text that tells them apart.
        expect(find(snap, "Add to cart", "Red shirt").id).not.toBe(find(snap, "Add to cart", "Blue shirt").id);
    });

    it("clicks by id and returns the next snapshot in the same call", async (): Promise<void> => {
        const snap: ControlSnapshot = await loadForm();
        const out: ActResult = await session.click(snap, "Add to cart", {}, "Blue shirt");
        expect(out.executed).toBe(true);
        expect(out.snapshot!.text).toContain("added blue");
        expect(out.snapshot!.snapshotId).toBeGreaterThan(snap.snapshotId);
        expect(out.snapshot!.fingerprint).not.toBe(snap.fingerprint);
    });

    it("fill replaces the value; press-enter submits; select and check work", async (): Promise<void> => {
        let snap: ControlSnapshot = await loadForm();
        let out: ActResult = await session.fill(snap, "Query", "new text");
        snap = out.snapshot!;
        expect(find(snap, "Query").value).toBe("new text");

        out = await session.act({ action: "press-enter", snapshotId: snap.snapshotId, controlId: find(snap, "Query").id });
        snap = out.snapshot!;
        expect(snap.text).toContain("submitted new text");

        out = await session.act({ action: "select", snapshotId: snap.snapshotId, controlId: find(snap, "Country").id, value: "de" });
        snap = out.snapshot!;
        expect(find(snap, "Country").value).toBe("Germany");

        out = await session.click(snap, "Accept terms");
        expect(find(out.snapshot!, "Accept terms").checked).toBe("true");
    });

    it("marks the action in the page when asked (as during a recording)", async (): Promise<void> => {
        const snap: ControlSnapshot = await loadForm();
        await session.act({ action: "fill", snapshotId: snap.snapshotId, controlId: find(snap, "Query").id, value: "x", animate: true });
        const marks: number = await session.page<number>(
            `return page.evaluate(() => document.getElementById("__ironbee_devtools_overlay__")?.shadowRoot?.querySelectorAll(".ib-action-box").length ?? 0);`
        );
        expect(marks).toBe(1);
    });

    it("refuses without acting when the target changed since the snapshot", async (): Promise<void> => {
        const snap: ControlSnapshot = await loadForm();
        await session.page(`await page.evaluate(() => document.getElementById("q").setAttribute("aria-label", "Renamed"));`);
        const out: ActResult = await session.act({
            action: "fill",
            snapshotId: snap.snapshotId,
            controlId: find(snap, "Query").id,
            value: "should not be typed",
        });
        expect(out.executed).toBe(false);
        expect(out.reason).toMatch(/^stale/);
        expect(find(out.snapshot!, "Renamed").value).toBe("old text");
    });

    it("tolerates unrelated content changing elsewhere on the page", async (): Promise<void> => {
        const snap: ControlSnapshot = await loadForm();
        await session.page(`await page.evaluate(() => { document.getElementById("ticker").textContent = "tick 1"; });`);
        const out: ActResult = await session.click(snap, "Count");
        expect(out.executed).toBe(true);
        expect(names(out.snapshot!)).toContain("Clicked 1");
    });

    it("offers a control the site made invisible and draws itself, a hidden one through its label, and nothing hidden", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<style>
  .menu { position: relative; display: inline-block; }
  .menu input { position: absolute; inset: 0; opacity: 0; margin: 0; width: 100%; height: 100%; }
  .menu label { display: inline-block; padding: 8px 16px; border: 1px solid #888; }
  .todo { position: relative; height: 40px; }
  .todo .toggle { position: absolute; left: 0; top: 0; width: 40px; height: 40px; opacity: 0; margin: 0; }
  .styled input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .closed { opacity: 0; }
</style>
<!-- An invisible checkbox over a label hidden from assistive technology (a menu toggle): offered, clicked where it lies. -->
<div class="menu"><input type="checkbox" id="lang" role="button" aria-label="96 languages"><label for="lang" aria-hidden="true">96 languages</label></div>
<!-- An invisible checkbox over a sibling's drawing (a custom checkbox's circle): offered. -->
<div class="todo"><input class="toggle" type="checkbox" aria-label="Toggle buy milk"><label>buy milk</label></div>
<!-- An invisible checkbox with a label a person sees and clicks: offered through the label. -->
<label class="styled"><input type="checkbox" id="news"> Subscribe</label>
<!-- Not a tag but what it is to a reader: an ARIA switch made invisible over its drawing is offered too. -->
<div style="position: relative; width: 60px; height: 24px; background: #ccc"><span role="switch" tabindex="0" aria-checked="false" aria-label="Dark mode" style="position: absolute; inset: 0; opacity: 0" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')"></span></div>
<div class="closed"><button>Hidden menu item</button></div>
`
        );
        expect(names(snap)).toEqual(expect.arrayContaining(["96 languages", "Toggle buy milk", "Dark mode"]));
        expect(names(snap)).not.toContain("Hidden menu item");
        let out: ActResult = await session.click(snap, "Toggle buy milk");
        expect(out.executed).toBe(true);
        expect(find(out.snapshot!, "Toggle buy milk").checked).toBe("true");
        out = await session.click(out.snapshot!, "Dark mode");
        expect(out.executed).toBe(true);
        expect(find(out.snapshot!, "Dark mode").checked).toBe("true");
        out = await session.click(out.snapshot!, "Subscribe");
        expect(out.executed).toBe(true);
        expect(find(out.snapshot!, "Subscribe").checked).toBe("true");
    });

    it("offers nothing a person cannot see or reach", async (): Promise<void> => {
        let snap: ControlSnapshot = await session.load(
            site,
            `
<p>An article.</p>
<!-- Invisible: an ad link over the page, a menu item mid-animation, a spam trap. -->
<a href="#ad" style="position: fixed; inset: 0; opacity: 0">Sponsored</a>
<div role="menuitem" tabindex="0" style="opacity: 0; width: 80px; height: 20px">Delete account</div>
<input name="website" aria-label="Leave empty" style="opacity: 0; width: 120px; height: 24px">
<!-- Invisible itself, and invisible with its container. -->
<input type="checkbox" aria-label="Tiny" style="opacity: 0; width: 4px; height: 4px; margin: 0">
<div style="opacity: 0"><input type="checkbox" aria-label="In a hidden panel" style="opacity: 0; width: 20px; height: 20px"></div>
<!-- The page behind a modal: hidden from assistive technology. -->
<div aria-hidden="true"><input type="checkbox" id="news" style="position: absolute; opacity: 0; width: 1px; height: 1px"><label for="news">Subscribe to newsletter</label></div>
<!-- Its label is hidden itself, and inside a hidden region too. -->
<input type="checkbox" id="twice" style="position: absolute; opacity: 0; width: 1px; height: 1px"><div aria-hidden="true"><label for="twice" aria-hidden="true">Double hidden</label></div>
<!-- Its label is slotted into a custom element inside a hidden region. -->
<script>customElements.define('x-wrap', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>'; } });</script>
<input type="checkbox" id="slotted" style="position: absolute; opacity: 0; width: 1px; height: 1px"><div aria-hidden="true"><x-wrap><label for="slotted">Slotted in hidden region</label></x-wrap></div>`
        );
        for (const hidden of [
            "Sponsored",
            "Delete account",
            "Leave empty",
            "Tiny",
            "In a hidden panel",
            "Subscribe to newsletter",
            "Double hidden",
            "Slotted in hidden region",
        ]) {
            expect(names(snap)).not.toContain(hidden);
        }
        // A web component's own button under a hidden or inert region: `closest()`
        // stops at the shadow boundary, the reader's walk through the host does not.
        snap = await session.load(
            site,
            `<script>customElements.define('x-btn', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<button>' + this.getAttribute('label') + '</button>'; } });</script>
<div aria-hidden="true"><x-btn label="Shadow in hidden region"></x-btn></div>
<div inert><x-btn label="Shadow in inert region"></x-btn></div>
<x-btn label="Shadow button"></x-btn>`
        );
        expect(names(snap)).toContain("Shadow button");
        expect(names(snap)).not.toContain("Shadow in hidden region");
        expect(names(snap)).not.toContain("Shadow in inert region");
        // A visually hidden checkbox whose label — not the control — is hidden
        // from assistive technology: clicked through its label.
        snap = await session.load(
            site,
            `<input type="checkbox" id="terms" aria-label="Accept terms" style="position: absolute; opacity: 0; width: 1px; height: 1px"><label for="terms" aria-hidden="true">Accept terms</label>`
        );
        const out: ActResult = await session.click(snap, "Accept terms");
        expect(out.executed).toBe(true);
        expect(find(out.snapshot!, "Accept terms").checked).toBe("true");
    });

    it("offers the inner control when a click on the outer one lands on it, and the outer one when the inner one is hidden", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<table role="grid"><tr>
  <td role="gridcell" aria-label="3 June cell"><button>3 June</button></td>
  <td role="gridcell" aria-label="4 June cell"><button style="display: none">4 June</button>4</td>
</tr></table>`
        );
        expect(names(snap)).toContain("3 June");
        expect(names(snap)).not.toContain("3 June cell");
        expect(names(snap)).toContain("4 June cell");
    });

    it("does not offer a control another element lies over, but offers what covers it", async (): Promise<void> => {
        let snap: ControlSnapshot = await session.load(
            site,
            `
<p id="month">June</p>
<button style="position: absolute; top: 60px; left: 20px" onclick="document.getElementById('month').textContent = 'July'">Next month</button>
<div id="pop" role="dialog" aria-label="How prices vary" style="position: absolute; top: 40px; left: 0; width: 300px; height: 80px; background: #fff; border: 1px solid">
  Prices vary by date <button onclick="document.getElementById('pop').remove()">Close</button>
</div>
<!-- A floating label drawn over its field passes the click on: the field is not covered. -->
<div style="position: relative; margin-top: 160px; width: 200px">
  <label for="city" style="position: absolute; inset: 0; line-height: 30px">City</label>
  <input id="city" style="width: 200px; height: 30px">
</div>`
        );
        expect(names(snap)).not.toContain("Next month");
        expect(names(snap)).toEqual(expect.arrayContaining(["Close", "City"]));
        const out: ActResult = await session.click(snap, "Close");
        expect(out.executed).toBe(true);
        snap = out.snapshot!;
        const next: ActResult = await session.click(snap, "Next month");
        expect(next.executed).toBe(true);
        expect(next.snapshot!.text).toContain("July");
    });

    it("scrolls a list to an item past its visible part, then clicks it", async (): Promise<void> => {
        const items: string = Array.from(
            { length: 30 },
            (_: unknown, i: number): string =>
                `<li><button onclick="document.getElementById('picked').textContent = 'picked ' + this.textContent">Item ${i + 1}</button></li>`
        ).join("");
        const snap: ControlSnapshot = await session.load(
            site,
            `
<p id="picked">none</p>
<ul id="list" style="height: 120px; overflow: auto; margin: 0; padding: 0; list-style: none">${items}</ul>`
        );
        // Past the list's 120px, yet in the viewport: offered, and clipped.
        const out: ActResult = await session.click(snap, "Item 12");
        expect(out.executed).toBe(true);
        expect(out.snapshot!.text).toContain("picked Item 12");
    });

    it("scrolls only what a person can scroll, clear of a sticky header, and puts it back when the click cannot go ahead", async (): Promise<void> => {
        const items: (prefix: string) => string = (prefix: string): string =>
            Array.from(
                { length: 30 },
                (_: unknown, i: number): string =>
                    `<li><button onclick="document.getElementById('picked').textContent = 'picked ' + this.textContent">${prefix} ${i + 1}</button></li>`
            ).join("");
        const scrollTop: (id: string) => Promise<number> = (id: string): Promise<number> =>
            session.page<number>(`return page.evaluate((i) => document.getElementById(i).scrollTop, args.id);`, { id });
        let snap: ControlSnapshot = await session.load(
            site,
            `
<p id="picked">none</p>
<ul id="hidden" style="height: 60px; overflow: hidden; margin: 0; padding: 0; list-style: none">${items("Slide")}</ul>
<div id="sticky" style="height: 120px; overflow: auto; margin-top: 300px">
  <div style="position: sticky; top: 0; height: 40px; background: #fff">Header</div>
  <ul style="margin: 0; padding: 0; list-style: none">${items("Row")}</ul>
</div>`
        );
        // A clipped overflow is not a list to scroll: its hidden items stay hidden, and are not offered.
        expect(names(snap)).not.toContain("Slide 4");
        expect(await scrollTop("hidden")).toBe(0);
        // A scrolled list with a sticky header: an item above the visible part comes to the middle, not under the header.
        await session.page(`await page.evaluate(() => { document.getElementById("sticky").scrollTop = 300; });`);
        snap = await session.snapshot();
        let out: ActResult = await session.click(snap, "Row 8");
        expect(out.executed).toBe(true);
        expect(out.snapshot!.text).toContain("picked Row 8");
        // Covered once scrolled: refused, and the list is where it was.
        await session.page(`await page.evaluate(() => {
            document.getElementById("sticky").scrollTop = 0;
            const cover = document.createElement("div");
            cover.style.cssText = "position: fixed; inset: 0; background: rgba(0,0,0,.2)";
            document.getElementById("sticky").addEventListener("scroll", () => { document.body.appendChild(cover); }, { once: true });
        });`);
        snap = await session.snapshot();
        out = await session.click(snap, "Row 12");
        expect(out.executed).toBe(false);
        expect(await scrollTop("sticky")).toBe(0);
    });

    it("does not scroll a list the target is not in, and counts a control below the fold as offscreen", async (): Promise<void> => {
        // A menu drawn below a scrolled panel (positioned against an outer box): the panel's scroll would close it.
        let snap: ControlSnapshot = await session.load(
            site,
            `
<p id="picked">none</p>
<div style="position: relative">
  <div id="panel" style="height: 60px; overflow: auto" onscroll="document.getElementById('menu')?.remove()">
    <div style="height: 300px">Panel content</div>
    <div id="menu" style="position: absolute; top: 100px; left: 0"><button onclick="document.getElementById('picked').textContent = 'chosen'">Choose</button></div>
  </div>
</div>`
        );
        const out: ActResult = await session.click(snap, "Choose");
        expect(out.executed).toBe(true);
        expect(out.snapshot!.text).toContain("chosen");
        expect(await session.page<number>(`return page.evaluate(() => document.getElementById("panel").scrollTop);`)).toBe(0);

        snap = await session.load(
            site,
            `
<div style="height: 3000px"></div>
<input type="checkbox" aria-label="Invisible below" style="opacity: 0; width: 20px; height: 20px">
<button>Below the fold</button>`
        );
        // Both are reached by scrolling: the visible button, and the invisible checkbox laid over its page.
        expect(snap.offscreenControls).toBe(2);
    });

    it("tells identical controls with no text around them apart by the heading they sit under, and their order there", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `
<h2>Basic checkboxes</h2>
<div><span><input type="checkbox" aria-label="Checkbox demo" checked></span><span><input type="checkbox" aria-label="Checkbox demo"></span></div>
<h2>Label placement</h2>
<div><span><input type="checkbox" aria-label="Checkbox demo"></span></div>`
        );
        expect(
            snap.controls
                .filter((c: Control): boolean => c.name === "Checkbox demo")
                .map((c: Control): [string | undefined, string | undefined] => [c.context, c.checked])
        ).toEqual([
            ["Basic checkboxes · 1/2", "true"],
            ["Basic checkboxes · 2/2", "false"],
            ["Label placement", "false"],
        ]);
    });

    it("refuses a covered target", async (): Promise<void> => {
        const snap: ControlSnapshot = await loadForm();
        await session.page(`await page.evaluate(() => {
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.3)";
            document.documentElement.appendChild(overlay);
        });`);
        const out: ActResult = await session.click(snap, "Count");
        expect(out.executed).toBe(false);
        expect(out.reason).toMatch(/covered/);
    });

    it("rejects a decision made on an older snapshot, or an unsupported operation", async (): Promise<void> => {
        const first: ControlSnapshot = await loadForm();
        const second: ControlSnapshot = await session.snapshot();
        await expect(session.click(first, "Count")).rejects.toThrow(/not the latest/);
        await expect(
            session.act({ action: "fill", snapshotId: second.snapshotId, controlId: find(second, "Count").id, value: "x" })
        ).rejects.toThrow(/does not support fill/);
    });

    it("scrolls to reveal off-screen controls", async (): Promise<void> => {
        let snap: ControlSnapshot = await loadForm();
        for (let i: number = 0; i < 10 && !names(snap).includes("Far below"); i++) {
            const out: ActResult = await session.act({ action: "scroll-down" });
            snap = out.snapshot!;
        }
        expect(find(snap, "Far below")).toBeDefined();
        expect(snap.canScrollUp).toBe(true);
    });

    it("follows a navigation the action caused", async (): Promise<void> => {
        await session.go(`${site.url}/mpa/login`);
        let snap: ControlSnapshot = await session.snapshot();
        let out: ActResult = await session.fill(snap, "Password", "pw");
        snap = out.snapshot!;
        out = await session.click(snap, "Sign in");
        expect(out.executed).toBe(true);
        expect(new URL(out.snapshot!.url).pathname).toBe("/mpa/home");
        expect(out.snapshot!.text).toContain("Welcome");
    });
});
