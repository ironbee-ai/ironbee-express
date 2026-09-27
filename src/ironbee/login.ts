/**
 * "Connect IronBee": the IronBee CLI's browser login (`ironbee login`), run
 * from the UI. The console's `/cli-auth` page signs the user in (or up: its
 * "Create an account" returns there), mints a personal access token for their active
 * account and redirects to a localhost callback with it — here, this app's own
 * `/api/ironbee/callback`. The token is saved where the CLI keeps it
 * (`service.oauthToken` in `~/.ironbee/config.json`), so the CLI, the editor
 * extension and this app share one login.
 *
 * The callback is accepted only with a `state` this process issued moments
 * before: the request that issues one is same-origin only, so no other page
 * can connect this app to an account of its choosing.
 */

import { randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { hostname } from "os";
import { dirname } from "path";

/** How the console's sign-in page names this app (it shows names starting with "IronBee"). */
export const CLIENT_NAME: string = "IronBee Express";

/** How long a started login may take (the console keeps its pending request 5 minutes). */
export const LOGIN_TIMEOUT_MS: number = 10 * 60_000;

/** What the console hands back, as the callback's query parameters. */
export interface CallbackParams {
    state?: string | null;
    access_token?: string | null;
    api_key?: string | null;
    error?: string | null;
}

export interface LoginCredential {
    oauthToken?: string;
    apiKey?: string;
}

export class LoginError extends Error {
    constructor(
        message: string,
        /** The console's error code, when it sent one. */
        readonly code?: string
    ) {
        super(message);
        this.name = "LoginError";
    }
}

/** User-facing words for the console's `?error=` codes. */
const CONSOLE_ERRORS: Record<string, string> = {
    token_limit_exceeded:
        "Your IronBee account already has the maximum number of access tokens. Delete an old one under Settings → Access tokens in the IronBee console, then connect again.",
};

export class IronBeeLogin {
    private readonly pending: Map<string, number> = new Map();

    constructor(private readonly now: () => number = Date.now) {}

    /** Starts a login: the console URL to open, carrying a fresh one-time state. */
    start(consoleUrl: string, callbackUrl: string, tokenName: string = defaultTokenName()): string {
        this.expire();
        const state: string = randomBytes(24).toString("hex");
        this.pending.set(state, this.now() + LOGIN_TIMEOUT_MS);
        return (
            `${consoleUrl}/cli-auth?callback=${encodeURIComponent(callbackUrl)}` +
            `&state=${state}&name=${encodeURIComponent(tokenName)}&client=${encodeURIComponent(CLIENT_NAME)}`
        );
    }

    /** Checks the console's callback; the credential it carries, or why there is none. The state is spent either way. */
    complete(params: CallbackParams): LoginCredential {
        this.expire();
        const state: string | undefined = params.state ?? undefined;
        if (!state || !this.pending.has(state)) {
            throw new LoginError("This sign-in link is not one this app started, or it expired. Start again from IronBee Express.");
        }
        this.pending.delete(state);
        if (params.error) {
            throw new LoginError(CONSOLE_ERRORS[params.error] ?? `The IronBee console reported an error (${params.error}).`, params.error);
        }
        if (params.access_token) {
            return { oauthToken: params.access_token };
        }
        if (params.api_key) {
            return { apiKey: params.api_key };
        }
        throw new LoginError("The IronBee console did not return an access token.");
    }

    private expire(): void {
        const now: number = this.now();
        for (const [state, until] of this.pending) {
            if (until < now) {
                this.pending.delete(state);
            }
        }
    }
}

/** The token's label on the console's access-token page. */
export function defaultTokenName(): string {
    const host: string = hostname().trim();
    return `ironbee-express${host ? `:${host}` : ""}`;
}

function objectSection(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/**
 * The shared config as it is, to be written back: `{}` when there is none, and a
 * refusal when the file is there but not readable — a file this app cannot read
 * is not this app's to replace (the CLI's other settings would go with it).
 */
function readConfigForWriting(file: string): Record<string, unknown> {
    if (!existsSync(file)) {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch (err: unknown) {
        throw new LoginError(`${file} is not valid JSON (${err instanceof Error ? err.message : err}); fix or move it, then connect again.`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new LoginError(`${file} does not hold a JSON object; fix or move it, then connect again.`);
    }
    return { ...(parsed as Record<string, unknown>) };
}

/** Writes the file readable by its owner only, atomically: a crash never leaves half a config. */
function writeConfig(file: string, config: Record<string, unknown>): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp: string = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
}

/**
 * Saves the credential the way `ironbee login` does: under `service` with the
 * stage's `domain`, the other kind of credential and any legacy `collector.*`
 * one removed so nothing stale shadows it. Everything else in the file stays.
 */
export function saveCredential(file: string, domain: string, credential: LoginCredential): void {
    const config: Record<string, unknown> = readConfigForWriting(file);
    const service: Record<string, unknown> = objectSection(config.service);
    if (credential.oauthToken) {
        service.oauthToken = credential.oauthToken;
        delete service.apiKey;
    } else if (credential.apiKey) {
        service.apiKey = credential.apiKey;
        delete service.oauthToken;
    } else {
        throw new LoginError("No credential to save.");
    }
    service.domain = domain;
    config.service = service;
    const collector: Record<string, unknown> = objectSection(config.collector);
    delete collector.oauthToken;
    delete collector.apiKey;
    if (Object.keys(collector).length) {
        config.collector = collector;
    } else {
        delete config.collector;
    }
    writeConfig(file, config);
}

/** Signs out: removes the saved credential (the IronBee CLI's too — it is the same login). */
export function clearCredential(file: string): void {
    const config: Record<string, unknown> = readConfigForWriting(file);
    const service: Record<string, unknown> = objectSection(config.service);
    const collector: Record<string, unknown> = objectSection(config.collector);
    const had: boolean = [service.oauthToken, service.apiKey, collector.oauthToken, collector.apiKey].some(Boolean);
    if (!had) {
        return;
    }
    delete service.oauthToken;
    delete service.apiKey;
    delete collector.oauthToken;
    delete collector.apiKey;
    config.service = service;
    if (Object.keys(collector).length) {
        config.collector = collector;
    } else {
        delete config.collector;
    }
    writeConfig(file, config);
}
