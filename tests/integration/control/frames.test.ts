/**
 * BROWSER_CONTROL_SNAPSHOT_FRAMES=true (read by the plugin from the daemon's
 * env), through a live DevTools daemon of its own: controls inside the page's
 * iframes — here a cross-origin one (a 127.0.0.1 page, a frame from a second
 * site on localhost) — are offered with the frame they are in, and acted on
 * through the page at the frame's position.
 *
 *   IBEXPRESS_E2E_DAEMON_SCRIPT=../ironbee-devtools/dist/daemon-server.js npx jest tests/integration/control
 */

import { DaemonHandle } from "../../../src/devtools/daemon";
import { ActResult, Control, ControlSnapshot, SecretType } from "../../../src/devtools/types";
import { ControlSession, describeLive, find, FixtureSite, sleep, startLiveDaemon } from "../../helpers/control-live";

jest.setTimeout(120_000);

describeLive("controls in iframes (BROWSER_CONTROL_SNAPSHOT_FRAMES=true, live daemon)", (): void => {
    let site: FixtureSite;
    let frameSite: FixtureSite;
    /** `localhost:<port>`: another origin than the page's 127.0.0.1. */
    let frameHost: string;
    let daemon: DaemonHandle;
    let session: ControlSession;

    beforeAll(async (): Promise<void> => {
        site = await FixtureSite.start();
        frameSite = await FixtureSite.start();
        frameHost = `localhost:${frameSite.port}`;
        daemon = await startLiveDaemon({ BROWSER_CONTROL_SNAPSHOT_FRAMES: "true" });
    });
    afterAll(async (): Promise<void> => {
        await daemon?.stop();
        await site?.close();
        await frameSite?.close();
    });
    beforeEach((): void => {
        session = new ControlSession(daemon);
    });
    afterEach(async (): Promise<void> => {
        await session.close();
    });

    function loginFrame(style: string = ""): string {
        return `<iframe title="Login" src="http://${frameHost}/mpa/login" width="600" height="320" style="${style}"></iframe>`;
    }

    /** Opens `html` and, once the login frame's form is in, snapshots it. */
    async function page(html: string): Promise<ControlSnapshot> {
        await session.go(site.page(html));
        await session.waitInFrame(frameHost, "input[name=email]");
        return session.snapshot();
    }

    function checkout(cover: boolean = false): Promise<ControlSnapshot> {
        return page(`
            <h1>Checkout</h1>
            <button onclick="this.textContent = 'Placed'">Place order</button>
            <iframe title="Secure card payment" src="http://${frameHost}/mpa/login" width="600" height="320"></iframe>
            ${cover ? "<div style=\"position:fixed; inset:0; background:rgba(0,0,0,.4)\">Loading…</div>" : ""}
        `);
    }

    it("offers the frame's controls with their frame, next to the page's own", async (): Promise<void> => {
        const snap: ControlSnapshot = await checkout();
        const place: Control = find(snap, "Place order");
        expect(place.frame).toBeUndefined();
        expect(place.id).toBeLessThan(100_000);
        for (const name of ["Email", "Password", "Sign in"]) {
            const c: Control = find(snap, name);
            expect(c.frame).toBe(frameHost);
            expect(c.id).toBeGreaterThanOrEqual(100_000);
        }
        expect(snap.text).toContain("Checkout");
        expect(snap.text).toMatch(/\[frame: .*localhost/);
    });

    it("types into and clicks in the cross-origin frame, and sees what it did", async (): Promise<void> => {
        let snap: ControlSnapshot = await checkout();
        let out: ActResult = await session.fill(snap, "Email", "ada@example.test");
        expect(out.executed).toBe(true);
        expect(await session.inputValue("input[name=email]", frameHost)).toBe("ada@example.test");
        expect(find(out.snapshot!, "Email").value).toBe("ada@example.test");

        snap = out.snapshot!;
        out = await session.click(snap, "Sign in");
        expect(out.executed).toBe(true);
        await sleep(300);
        snap = await session.snapshot();
        expect(find(snap, "Search").frame).toBe(frameHost);

        // The page's own controls still work as before.
        out = await session.click(snap, "Place order");
        expect(out.snapshot!.text).toContain("Placed");
    });

    it("puts a list in the frame back when the page refuses the click after it scrolled there", async (): Promise<void> => {
        await session.go(
            site.page(`
            <iframe title="Picker" src="http://${frameHost}/mpa/login" width="600" height="320" style="border: 0; display: block; margin: 0"></iframe>
            <div style="position: fixed; left: 0; top: 0; width: 100%; height: 150px; background: rgba(0,0,0,.3)">Banner</div>`)
        );
        await session.waitInFrame(frameHost, "input[name=email]");
        await session.page(
            `const frame = page.frames().find((f) => f.url().includes(args.frameHost));
            await frame.evaluate(() => {
                document.body.style.margin = "0";
                document.body.innerHTML =
                    '<ul id="list" style="height: 120px; overflow: auto; margin: 0; padding: 0; list-style: none">' +
                    Array.from({ length: 30 }, (_, i) => "<li><button>Item " + (i + 1) + "</button></li>").join("") +
                    "</ul>";
            });`,
            { frameHost }
        );
        const snap: ControlSnapshot = await session.snapshot();
        // Past the list's visible part, below the banner; scrolled into the list's middle it would be under the banner.
        const out: ActResult = await session.click(snap, "Item 12");
        expect(out.executed).toBe(false);
        expect(out.reason).toMatch(/covered/);
        expect(
            await session.page<number>(
                `const frame = page.frames().find((f) => f.url().includes(args.frameHost));
                return frame.evaluate(() => document.getElementById("list").scrollTop);`,
                { frameHost }
            )
        ).toBe(0);
    });

    it("refuses a frame control the page covers", async (): Promise<void> => {
        const snap: ControlSnapshot = await checkout(true);
        const out: ActResult = await session.click(snap, "Sign in");
        expect(out.executed).toBe(false);
        expect(out.reason).toMatch(/covered/);
    });

    it("types a secret into the frame only when it is bound to the frame's own host", async (): Promise<void> => {
        await session.client.seedSecrets({
            secrets: [
                { name: "card", type: SecretType.LOGIN_CREDENTIALS, fields: { password: "pw-S3CRET" }, boundOrigins: [frameHost] },
                { name: "page", type: SecretType.LOGIN_CREDENTIALS, fields: { password: "nope-S3CRET" }, boundOrigins: [site.host] },
            ],
        });
        try {
            let snap: ControlSnapshot = await checkout();
            await expect(session.fill(snap, "Password", "{{secret:page.password}}")).rejects.toThrow(/not bound/);
            snap = await session.snapshot();
            const out: ActResult = await session.fill(snap, "Password", "{{secret:card.password}}");
            expect(out.executed).toBe(true);
            // Read back masked: the value typed was the card secret's.
            expect(await session.inputValue("input[name=password]", frameHost)).toBe("[secret:card.password]");
        } finally {
            await session.client.clearSecrets();
        }
    });

    it("finds the visible frame behind many hidden ones", async (): Promise<void> => {
        const pixels: string = Array.from(
            { length: 9 },
            (_: unknown, i: number): string => `<iframe src="about:blank#${i}" width="1" height="1" style="border:0"></iframe>`
        ).join("");
        const snap: ControlSnapshot = await page(`${pixels}${loginFrame()}`);
        expect(find(snap, "Email").frame).toBe(frameHost);
    });

    it("acts at the right point through padding, a border and a scaling transform", async (): Promise<void> => {
        const snap: ControlSnapshot = await page(
            `<div style="margin: 40px; transform: scale(0.8); transform-origin: 0 0">${loginFrame("padding: 24px; border: 6px solid #333")}</div>`
        );
        const out: ActResult = await session.fill(snap, "Email", "scaled@example.test");
        expect(out.executed).toBe(true);
        expect(await session.inputValue("input[name=email]", frameHost)).toBe("scaled@example.test");
    });

    it("acts on a frame inside a shadow root", async (): Promise<void> => {
        await session.go(site.page("<div id=\"host\"></div>"));
        await session.page(
            `await page.evaluate((html) => { document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = html; }, args.html);`,
            { html: loginFrame() }
        );
        await session.waitInFrame(frameHost, "input[name=email]");
        const snap: ControlSnapshot = await session.snapshot();
        const out: ActResult = await session.fill(snap, "Email", "shadow@example.test");
        expect(out.executed).toBe(true);
        expect(await session.inputValue("input[name=email]", frameHost)).toBe("shadow@example.test");
    });

    it("does not wait on a frame that is slow to load", async (): Promise<void> => {
        await session.go(site.page(`<button>Here</button><iframe src="${site.url}/api/slow?ms=6000" width="400" height="200"></iframe>`), {
            waitUntil: "domcontentloaded",
        });
        const started: number = Date.now();
        const snap: ControlSnapshot = await session.snapshot();
        expect(Date.now() - started).toBeLessThan(2_500);
        expect(find(snap, "Here")).toBeDefined();
    });

    it("counts the controls of a frame's part below the fold as offscreen", async (): Promise<void> => {
        await session.go(site.page("<p>blank</p>"));
        const height: number = await session.page<number>("return page.evaluate(() => innerHeight);");
        const snap: ControlSnapshot = await page(`<div style="height:${height - 40}px">Top</div>${loginFrame("border:0")}`);
        expect(snap.controls.find((c: Control): boolean => c.name === "Email")).toBeUndefined();
        expect(snap.offscreenControls).toBeGreaterThan(0);
    });

    it("clicks a custom checkbox (a hidden input behind its label) inside a frame", async (): Promise<void> => {
        await session.go(
            site.page(
                `<iframe title="Consent" width="500" height="200" style="padding:10px" srcdoc="<label><input id='c' type='checkbox' style='display:none'> <span>Accept the terms</span></label>"></iframe>`
            )
        );
        await session.waitInFrame("about:srcdoc", "label");
        const snap: ControlSnapshot = await session.snapshot();
        const box: Control | undefined = snap.controls.find((c: Control): boolean => c.frame !== undefined && c.role === "checkbox");
        expect(box).toBeDefined();
        const out: ActResult = await session.act({ action: "click", snapshotId: snap.snapshotId, controlId: box!.id });
        expect(out.executed).toBe(true);
        expect(
            await session.page<boolean>(`return page.frames().find((f) => f.url() === "about:srcdoc").isChecked("#c");`)
        ).toBe(true);
    });
});
