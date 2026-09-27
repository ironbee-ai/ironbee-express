/**
 * Saved browser profiles: a run either starts FRESH (no cookies, no storage —
 * the default) or in a named profile whose cookies, storage and logins stay
 * between runs, so a sign-in done once (e.g. a social login the user did at an
 * ASK_USER pause) holds for the next run. A profile is a Chromium user-data
 * directory DevTools opens as a persistent context.
 *
 * Profiles hold live sessions: the directory gets a `.gitignore` of its own,
 * so it is never committed along with the scenarios next to it.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const NAME: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class ProfileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProfileError";
    }
}

export interface ProfileSummary {
    name: string;
    /** When a run last opened it (the directory's modification time). */
    lastUsedAt: string;
}

export function validateProfileName(name: string): string {
    const trimmed: string = name.trim();
    if (!NAME.test(trimmed)) {
        throw new ProfileError(
            `Invalid profile name ${JSON.stringify(name)}: letters, digits, "-" and "_", up to 64, starting with a letter or digit`
        );
    }
    return trimmed;
}

/** The DevTools daemon environment that opens `dir` as the browser's profile. */
export function profileEnv(dir: string): Record<string, string> {
    return { BROWSER_PERSISTENT_ENABLE: "true", BROWSER_PERSISTENT_USER_DATA_DIR: dir };
}

export class ProfileStore {
    constructor(readonly dir: string) {}

    /** The profile's directory, created (with the store's .gitignore) when missing. */
    ensure(name: string): string {
        const path: string = join(this.dir, validateProfileName(name));
        if (!existsSync(this.dir)) {
            mkdirSync(this.dir, { recursive: true });
        }
        const ignore: string = join(this.dir, ".gitignore");
        if (!existsSync(ignore)) {
            writeFileSync(ignore, "# Browser profiles hold live sessions (cookies, storage): never commit them.\n*\n");
        }
        mkdirSync(path, { recursive: true });
        return path;
    }

    exists(name: string): boolean {
        return existsSync(join(this.dir, validateProfileName(name)));
    }

    list(): ProfileSummary[] {
        if (!existsSync(this.dir)) {
            return [];
        }
        return readdirSync(this.dir, { withFileTypes: true })
            .filter((e: { isDirectory(): boolean; name: string }): boolean => e.isDirectory() && NAME.test(e.name))
            .map((e: { name: string }): ProfileSummary => ({
                name: e.name,
                lastUsedAt: statSync(join(this.dir, e.name)).mtime.toISOString(),
            }))
            .sort((a: ProfileSummary, b: ProfileSummary): number => a.name.localeCompare(b.name));
    }

    /** Forgets the profile: every cookie, storage entry and login in it. */
    delete(name: string): void {
        const path: string = join(this.dir, validateProfileName(name));
        if (!existsSync(path)) {
            throw new ProfileError(`No profile named ${name}`);
        }
        rmSync(path, { recursive: true, force: true });
    }
}
