/**
 * Native dialogs under BROWSER_DIALOG_MODE=hold (ensureDaemon's default),
 * through a live DevTools daemon with the control-tools plugin: an action
 * that opens one counts as executed, the next snapshot IS the dialog, and its
 * OK / Cancel / field answer it.
 *
 *   IBEXPRESS_E2E_DAEMON_SCRIPT=../ironbee-devtools/dist/daemon-server.js npx jest tests/integration/control
 */

import { SECRET_DENIED } from "../../../src/devtools/client";
import { DaemonHandle } from "../../../src/devtools/daemon";
import { ActResult, ControlSnapshot, SecretType } from "../../../src/devtools/types";
import { ControlSession, describeLive, find, FixtureSite, names, sleep, startLiveDaemon } from "../../helpers/control-live";

const PAGE: string = `
<p id="status">idle</p>
<button onclick="document.getElementById('status').textContent = confirm('Delete item 3?') ? 'deleted' : 'kept'">Delete</button>
<button onclick="const n = prompt('Your name?', 'guest'); document.getElementById('status').textContent = 'hello ' + n">Name</button>
<button onclick="alert('Saved!'); document.getElementById('status').textContent = 'after alert'">Save</button>
<button onclick="setTimeout(() => alert('Later'), 50)">Later</button>
<label>Nick <input id="nick" onclick="if (!window.warned) { window.warned = true; alert('Pick carefully'); }"></label>
`;

jest.setTimeout(120_000);

describeLive("native dialogs (BROWSER_DIALOG_MODE=hold, live daemon)", (): void => {
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

    function load(): Promise<ControlSnapshot> {
        return session.load(site, PAGE);
    }

    it("does not wait for the network behind a held dialog", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(site, `<button onclick="fetch('/api/slow?ms=3000'); alert('Saved!')">Save</button>`);
        const started: number = Date.now();
        const out: ActResult = await session.click(snap, "Save", { waitForNetworkMs: 5_000 });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(out.executed).toBe(true);
        expect(out.networkIdle).toBeUndefined();
        expect(out.snapshot!.dialog).toEqual({ type: "alert", message: "Saved!" });
        await session.click(out.snapshot!, "OK");
    });

    it("ends the network wait when a dialog opens while it waits", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(
            site,
            `<button onclick="fetch('/api/slow?ms=300').then(() => { fetch('/api/slow?ms=3000'); alert('Loaded'); })">Load</button>`
        );
        const started: number = Date.now();
        const out: ActResult = await session.click(snap, "Load", { waitForNetworkMs: 5_000 });
        // The dialog froze the page with a request still in flight: the wait ends there, without a verdict.
        expect(Date.now() - started).toBeLessThan(2_500);
        expect(out.networkIdle).toBeUndefined();
        expect(out.snapshot!.dialog).toEqual({ type: "alert", message: "Loaded" });
        await session.click(out.snapshot!, "OK");
    });

    it("shows a confirm as the snapshot, and OK / Cancel answer it", async (): Promise<void> => {
        let out: ActResult = await session.click(await load(), "Delete");
        expect(out.executed).toBe(true);
        expect(out.snapshot!.dialog).toEqual({ type: "confirm", message: "Delete item 3?" });
        expect(names(out.snapshot!)).toEqual(["OK", "Cancel"]);
        expect(out.snapshot!.text).toContain("Delete item 3?");

        out = await session.click(out.snapshot!, "OK");
        expect(out.executed).toBe(true);
        expect(out.snapshot!.dialog).toBeUndefined();
        expect(out.snapshot!.text).toContain("deleted");

        out = await session.click(out.snapshot!, "Delete");
        out = await session.click(out.snapshot!, "Cancel");
        expect(out.snapshot!.text).toContain("kept");
    });

    it("types into a prompt, answers it, and refuses a secret there", async (): Promise<void> => {
        let out: ActResult = await session.click(await load(), "Name");
        expect(out.snapshot!.dialog?.type).toBe("prompt");
        expect(find(out.snapshot!, "Dialog input").value).toBe("guest");
        // A secret bound to this very page: still not typed into a dialog's field.
        await session.client.seedSecrets({
            secrets: [{ name: "api", type: SecretType.GENERIC, fields: { value: "api-S3CRET" }, boundOrigins: [site.host] }],
        });
        try {
            // Refused with DevTools' SECRET_DENIED code — the run's client reads it as a refused action, not a failure.
            await expect(session.fill(out.snapshot!, "Dialog input", "{{secret:api.value}}")).rejects.toMatchObject({
                code: SECRET_DENIED,
                message: expect.stringMatching(/cannot be typed into a native dialog/),
            });
        } finally {
            await session.client.clearSecrets();
        }
        out = await session.fill(out.snapshot!, "Dialog input", "Ada");
        expect(find(out.snapshot!, "Dialog input").value).toBe("Ada");
        out = await session.click(out.snapshot!, "OK");
        expect(out.snapshot!.text).toContain("hello Ada");
    });

    it("offers an alert only OK; Escape dismisses; a dialog answered elsewhere leaves its snapshot stale", async (): Promise<void> => {
        let out: ActResult = await session.click(await load(), "Save");
        expect(names(out.snapshot!)).toEqual(["OK"]);
        out = await session.act({ action: "press-key", value: "Escape" });
        expect(out.snapshot!.text).toContain("after alert");

        out = await session.click(out.snapshot!, "Delete");
        // Answered outside the control tools (DevTools' own dialog tool).
        const answered: { type: string; message: string; accepted: boolean } = await session.client.call("interaction_handle-dialog", {
            action: "accept",
        });
        expect(answered).toEqual({ type: "confirm", message: "Delete item 3?", accepted: true });
        // The dialog snapshot it was decided on is stale now.
        const stale: ActResult = await session.click(out.snapshot!, "OK");
        expect(stale.executed).toBe(false);
        expect(stale.reason).toMatch(/no longer open/);
        expect(stale.snapshot!.text).toContain("deleted");
    });

    it("refuses to act on the page behind a dialog that opened since the snapshot", async (): Promise<void> => {
        let out: ActResult = await session.click(await load(), "Later");
        const before: ControlSnapshot = out.snapshot!;
        await sleep(300);
        out = await session.click(before, "Delete");
        expect(out.executed).toBe(false);
        expect(out.reason).toMatch(/alert dialog opened/);
        expect(out.snapshot!.dialog).toEqual({ type: "alert", message: "Later" });
        out = await session.click(out.snapshot!, "OK");
        expect(out.snapshot!.dialog).toBeUndefined();
    });

    it("never types later into a field whose click opened a dialog", async (): Promise<void> => {
        const snap: ControlSnapshot = await load();
        let out: ActResult = await session.fill(snap, "Nick", "typed-later");
        // The click reached the page (it opened the alert): executed, and the rest abandoned.
        expect(out.executed).toBe(true);
        expect(out.snapshot!.dialog).toEqual({ type: "alert", message: "Pick carefully" });
        out = await session.click(out.snapshot!, "OK");
        await sleep(200);
        expect(await session.inputValue("#nick")).toBe("");
    });
});
