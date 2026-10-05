import { actionAnimation, followsNewTabs, snapshotFrames } from "../../../src/devtools-plugin/settings";

describe("the DevTools settings the control tools follow", () => {
    const names: string[] = ["BROWSER_FOLLOW_NEW_TABS", "BROWSER_ACTION_ANIMATION", "BROWSER_CONTROL_SNAPSHOT_FRAMES"];
    const saved: Record<string, string | undefined> = {};

    beforeEach((): void => {
        for (const name of names) {
            saved[name] = process.env[name];
            delete process.env[name];
        }
    });

    afterEach((): void => {
        for (const name of names) {
            if (saved[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = saved[name];
            }
        }
    });

    it("reads a flag as DevTools does: true, 1, yes or on, in any case", (): void => {
        for (const value of ["true", "1", "yes", "on", "TRUE", " On "]) {
            process.env.BROWSER_FOLLOW_NEW_TABS = value;
            expect([value, followsNewTabs()]).toEqual([value, true]);
        }
        for (const value of ["false", "0", "no", "off", "maybe"]) {
            process.env.BROWSER_FOLLOW_NEW_TABS = value;
            expect([value, followsNewTabs()]).toEqual([value, false]);
        }
    });

    it("leaves a flag that is not set to its default", (): void => {
        expect(followsNewTabs()).toBe(false);
        expect(snapshotFrames()).toBe(false);
        expect(actionAnimation()).toBeUndefined();
        process.env.BROWSER_ACTION_ANIMATION = "0";
        expect(actionAnimation()).toBe(false);
    });
});
