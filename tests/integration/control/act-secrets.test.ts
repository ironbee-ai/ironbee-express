/**
 * `control_act` as a form-fill secret sink, through a live DevTools daemon
 * whose registry the test seeds over the internal surface: a `{{secret:…}}`
 * value is resolved against the CONTROL's own element — its frame's origin and
 * whether it is a real password input — and written through that element.
 * Anything else carrying a reference is refused.
 *
 * The field's value is read back through `execute`, whose output DevTools
 * masks: a typed secret reads `[secret:name.field]`, its length the real one.
 *
 *   IBEXPRESS_E2E_DAEMON_SCRIPT=../ironbee-devtools/dist/daemon-server.js npx jest tests/integration/control
 */

import { SECRET_DENIED } from "../../../src/devtools/client";
import { DaemonHandle } from "../../../src/devtools/daemon";
import { ActResult, ControlSnapshot, SecretType } from "../../../src/devtools/types";
import { ControlSession, describeLive, find, FixtureSite, startLiveDaemon } from "../../helpers/control-live";

const TYPED: string = "api-key-S3CRET-value";
const PASSWORD: string = "pw-S3CRET-value";

const FORM_PAGE: string = `
<form onsubmit="event.preventDefault()">
  <label>Api key <input id="key"></label>
  <label>Password <input id="pw" type="password"></label>
  <button type="button">Go</button>
</form>
`;

interface FieldValue {
    value: string;
    length: number;
}

jest.setTimeout(120_000);

describeLive("control_act: secret references (live daemon)", (): void => {
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
    beforeEach(async (): Promise<void> => {
        session = new ControlSession(daemon);
        await session.client.seedSecrets({
            secrets: [
                { name: "api", type: SecretType.GENERIC, fields: { value: TYPED }, boundOrigins: [site.host] },
                { name: "login", type: SecretType.LOGIN_CREDENTIALS, fields: { password: PASSWORD }, boundOrigins: [site.host] },
                { name: "elsewhere", type: SecretType.GENERIC, fields: { value: "never-typed" }, boundOrigins: ["other.example"] },
            ],
        });
    });
    afterEach(async (): Promise<void> => {
        await session.client.clearSecrets();
        await session.close();
    });

    function valueOf(id: string): Promise<FieldValue> {
        return session.page<FieldValue>(
            `return page.$eval("#" + args.id, (e) => ({ value: e.value, length: e.value.length }));`,
            { id }
        );
    }

    it("types a bound secret into the control, and a password only into a password input", async (): Promise<void> => {
        let snap: ControlSnapshot = await session.load(site, FORM_PAGE);
        const out: ActResult = await session.fill(snap, "Api key", "{{secret:api.value}}");
        expect(out.executed).toBe(true);
        expect(await valueOf("key")).toEqual({ value: "[secret:api.value]", length: TYPED.length });
        expect(JSON.stringify(out)).not.toContain(TYPED);

        snap = out.snapshot!;
        await session.fill(snap, "Password", "{{secret:login.password}}");
        expect(await valueOf("pw")).toEqual({ value: "[secret:login.password]", length: PASSWORD.length });

        snap = await session.load(site, FORM_PAGE);
        await expect(session.fill(snap, "Api key", "{{secret:login.password}}")).rejects.toThrow(
            /may only be typed into an <input type="password">/
        );
        expect(await valueOf("key")).toEqual({ value: "", length: 0 });
    });

    it("refuses a secret bound to another origin, and a reference outside a fill value", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(site, FORM_PAGE);
        await expect(session.fill(snap, "Api key", "{{secret:elsewhere.value}}")).rejects.toThrow(/not bound/);
        expect(await valueOf("key")).toEqual({ value: "", length: 0 });

        // The plugin's own misplacement refusal carries DevTools' SECRET_DENIED code, like the "not bound" one above.
        await expect(
            session.act({ action: "click", snapshotId: snap.snapshotId, controlId: find(snap, "Go").id, value: "{{secret:api.value}}" })
        ).rejects.toMatchObject({ code: SECRET_DENIED, message: expect.stringMatching(/may only be the value of a fill/) });
    });

    it("leaves an ordinary fill on its usual path", async (): Promise<void> => {
        const snap: ControlSnapshot = await session.load(site, FORM_PAGE);
        await session.fill(snap, "Api key", "plain text");
        expect(await valueOf("key")).toEqual({ value: "plain text", length: 10 });
    });
});
