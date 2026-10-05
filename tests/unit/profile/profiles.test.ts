import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { profileEnv, ProfileStore, validateProfileName } from "../../../src/profile/profiles";
import { effectiveProfile, effectiveStealth } from "../../../src/run/runner";
import { parseRunRequest } from "../../../src/server/ui-server";
import { Scenario } from "../../../src/scenario/types";

describe("ProfileStore", (): void => {
    let dir: string;
    beforeEach((): void => {
        dir = join(mkdtempSync(join(tmpdir(), "ibexpress-profiles-")), "profiles");
    });
    afterEach((): void => {
        rmSync(join(dir, ".."), { recursive: true, force: true });
    });

    it("creates a profile with a .gitignore that keeps every profile out of git, lists and deletes it", (): void => {
        const store: ProfileStore = new ProfileStore(dir);
        expect(store.list()).toEqual([]);
        const path: string = store.ensure("acme-admin");
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toMatch(/^\*$/m);
        expect(store.list().map((p): string => p.name)).toEqual(["acme-admin"]);
        expect(profileEnv(path)).toEqual({ BROWSER_PERSISTENT_ENABLE: "true", BROWSER_PERSISTENT_USER_DATA_DIR: path });
        store.delete("acme-admin");
        expect(store.list()).toEqual([]);
        expect((): void => store.delete("acme-admin")).toThrow(/No profile/);
    });

    it("refuses a name that is not a plain directory name", (): void => {
        expect((): string => validateProfileName("../etc")).toThrow(/Invalid profile name/);
        expect((): string => validateProfileName("a b")).toThrow(/Invalid profile name/);
        expect(validateProfileName(" ok_1 ")).toBe("ok_1");
    });
});

describe("which profile a run uses", (): void => {
    const scenario: Scenario = { profile: "acme" } as Scenario;

    it("takes the run's own choice, else the scenario's; an empty choice is a fresh browser", (): void => {
        expect(effectiveProfile({}, undefined)).toBeUndefined();
        expect(effectiveProfile({}, scenario)).toBe("acme");
        expect(effectiveProfile({ profile: "other" }, scenario)).toBe("other");
        expect(effectiveProfile({ profile: "" }, scenario)).toBeUndefined();
    });

    it("uses the stealth browser by the run's own choice, else the scenario's, else the configured default", (): void => {
        const stealthy: Scenario = { ...scenario, stealth: true };
        expect(effectiveStealth({}, undefined, false)).toBe(false);
        expect(effectiveStealth({}, undefined, true)).toBe(true);
        expect(effectiveStealth({}, stealthy, false)).toBe(true);
        expect(effectiveStealth({ stealth: false }, stealthy, true)).toBe(false);
        expect(effectiveStealth({ stealth: true }, scenario, false)).toBe(true);
    });

    it("reads the UI's stealth choice", (): void => {
        expect(parseRunRequest({ goal: "x", stealth: true }).stealth).toBe(true);
        expect(parseRunRequest({ goal: "x", stealth: false }).stealth).toBe(false);
        expect(parseRunRequest({ goal: "x" })).not.toHaveProperty("stealth");
        expect(parseRunRequest({ goal: "x", stealth: "yes" })).not.toHaveProperty("stealth");
    });

    it("reads the UI's choice", (): void => {
        expect(parseRunRequest({ goal: "x", profile: "acme" }).profile).toBe("acme");
        expect(parseRunRequest({ goal: "x", profile: "" }).profile).toBe("");
        expect(parseRunRequest({ goal: "x" })).not.toHaveProperty("profile");
        expect((): unknown => parseRunRequest({ goal: "x", profile: "../x" })).toThrow(/Invalid profile name/);
    });
});
