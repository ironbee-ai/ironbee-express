/**
 * New tabs under BROWSER_FOLLOW_NEW_TABS=true and BROWSER_DIALOG_MODE=hold
 * (ensureDaemon's defaults), through a live DevTools daemon with the
 * control-tools plugin: a snapshot lists the tabs once there are several,
 * `control_act` switches and closes them, and a decision made on a tab the
 * session has left is refused.
 *
 *   IBEXPRESS_E2E_DAEMON_SCRIPT=../ironbee-devtools/dist/daemon-server.js npx jest tests/integration/control
 */

import { DaemonHandle } from "../../../src/devtools/daemon";
import { ActResult, ControlSnapshot, TabInfo } from "../../../src/devtools/types";
import { ControlSession, describeLive, find, FixtureSite, sleep, startLiveDaemon } from "../../helpers/control-live";

jest.setTimeout(120_000);

describeLive("new tabs (BROWSER_FOLLOW_NEW_TABS=true, live daemon)", (): void => {
    let site: FixtureSite;
    let daemon: DaemonHandle;
    let session: ControlSession;

    beforeAll(async (): Promise<void> => {
        site = await FixtureSite.start();
        daemon = await startLiveDaemon();
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

    function home(): Promise<ControlSnapshot> {
        return session.load(
            site,
            `<a href="${site.url}/mpa/home" target="_blank">Open home</a>
            <button onclick="window.open('${site.url}/mpa/home')">Pop up</button>`
        );
    }

    function active(tabs: TabInfo[] | undefined): boolean[] {
        return (tabs ?? []).map((t: TabInfo): boolean => t.active);
    }

    it("follows a target=_blank link and a window.open to the new tab, lists the tabs, and closes back to the opener", async (): Promise<void> => {
        for (const opener of ["Open home", "Pop up"]) {
            const snap: ControlSnapshot = await home();
            expect(snap.tabs).toBeUndefined();
            const out: ActResult = await session.click(snap, opener);
            expect(out.executed).toBe(true);
            expect(new URL(out.snapshot!.url).pathname).toBe("/mpa/home");
            expect(out.snapshot!.tabs).toHaveLength(2);
            expect(out.snapshot!.tabs!.find((t: TabInfo): boolean => t.active)!.url).toContain("/mpa/home");

            // Close it: the opener comes back.
            const back: ActResult = await session.act({ action: "close-tab" });
            expect(back.executed).toBe(true);
            expect(back.snapshot!.tabs).toBeUndefined();
            expect(find(back.snapshot!, opener)).toBeDefined();
        }
    });

    it("switches between tabs by index, and refuses one that does not exist", async (): Promise<void> => {
        const snap: ControlSnapshot = await home();
        let out: ActResult = await session.click(snap, "Pop up");
        expect(active(out.snapshot!.tabs)).toEqual([false, true]);
        out = await session.act({ action: "switch-tab", value: "0" });
        expect(out.executed).toBe(true);
        expect(active(out.snapshot!.tabs)).toEqual([true, false]);
        expect(find(out.snapshot!, "Pop up")).toBeDefined();
        out = await session.act({ action: "switch-tab", value: "7" });
        expect(out.executed).toBe(false);
        expect(out.reason).toMatch(/no tab 7/);
    });

    it("refuses a decision on the tab it left, follows a popup of a popup, and closes a background tab by index", async (): Promise<void> => {
        const snap: ControlSnapshot = await home();
        // A tab opens without the session's doing (a click from outside the control tools).
        await session.page(`const popup = page.waitForEvent("popup"); await page.click("text=Pop up"); await popup; await sleep(200);`);
        const refused: ActResult = await session.click(snap, "Open home");
        expect(refused.executed).toBe(false);
        expect(refused.reason).toMatch(/another tab became active/);
        expect(new URL(refused.snapshot!.url).pathname).toBe("/mpa/home");

        // A popup of the popup is followed too.
        await session.go(site.page(`<button onclick="window.open('${site.url}/mpa/register')">Third</button>`));
        await session.page(`const popup = page.waitForEvent("popup"); await page.click("text=Third"); await popup; await sleep(200);`);
        const third: ControlSnapshot = await session.snapshot();
        expect(new URL(third.url).pathname).toBe("/mpa/register");
        expect(third.tabs).toHaveLength(3);

        // Close the middle (background) tab: the active one stays.
        const closed: ActResult = await session.act({ action: "close-tab", value: "1" });
        expect(closed.executed).toBe(true);
        expect(new URL(closed.snapshot!.url).pathname).toBe("/mpa/register");
        expect(closed.snapshot!.tabs).toHaveLength(2);
        const last: ActResult = await session.act({ action: "close-tab", value: "9" });
        expect(last.executed).toBe(false);
        expect(last.reason).toMatch(/there is no tab 9/);
    });

    it("shows a background tab's dialog as the snapshot, and answers it there through its controls", async (): Promise<void> => {
        const snap: ControlSnapshot = await home();
        let out: ActResult = await session.click(snap, "Pop up");
        expect(new URL(out.snapshot!.url).pathname).toBe("/mpa/home");
        // The opener, now in the background, asks something.
        await session.page(
            `await page.context().pages()[0].evaluate(() => {
                setTimeout(() => { document.title = confirm("Leave?") ? "left" : "stayed"; }, 20);
            });`
        );
        await sleep(300);
        const dialog: ControlSnapshot = await session.snapshot();
        expect(dialog.dialog).toEqual({ type: "confirm", message: "Leave?" });
        out = await session.click(dialog, "OK");
        expect(out.snapshot!.dialog).toBeUndefined();
        expect(out.snapshot!.title).toBe("left");
    });
});
