/**
 * IronBee platform access — optional. With a credential, every run is reported
 * as a session on the platform (the same event stream the IronBee CLI sends),
 * the DevTools daemon ships its tool calls, video and browser spans there, and
 * the run's trace can be read back for checks and root causes.
 *
 * Both endpoints hang off one domain: `collector.service.<domain>` (write) and
 * `api.service.<domain>` (read). `ironbee.ai` is production; a dev environment
 * sets its own (`ironbee.dev`).
 *
 * The credential comes from the environment, or else from the IronBee CLI's
 * shared config (`~/.ironbee/config.json`, `service.oauthToken` / `apiKey`):
 * the file `ironbee login`, the IronBee editor extension and this app's own
 * "Connect IronBee" write. A token in the file belongs to the file's
 * `service.domain`, so it is used only on that domain.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

export const DEFAULT_IRONBEE_DOMAIN: string = "ironbee.ai";

/** Where the credential in use came from. */
export enum CredentialSource {
    ENV = "env",
    /** The shared IronBee config file. */
    FILE = "file",
}

export interface IronBeeConfig {
    /** Shared account key (`X-API-Key`). */
    apiKey?: string;
    /** Personal token (`X-OAuth-Token`); wins over the key when both are set. */
    oauthToken?: string;
    /** Unset without a credential. */
    source?: CredentialSource;
    domain: string;
    collectorUrl: string;
    apiUrl: string;
    /** The web console: where a user signs up, signs in and manages tokens. */
    consoleUrl: string;
    /** The shared IronBee config file (read, and written by "Connect IronBee"). */
    configFile: string;
    /** The platform groups sessions by project. */
    projectName: string;
    userEmail?: string;
    /** `IBEXPRESS_IRONBEE_REPORT=off`: a credential is kept but nothing is reported. */
    reportingOff?: boolean;
    /** Reporting is on: a credential is present and it was not switched off. */
    enabled: boolean;
}

/**
 * The IronBee CLI's config file. `IBEXPRESS_IRONBEE_CONFIG` points elsewhere, read from the
 * given environment or the process's (so a test's hand-made environment never reaches a
 * developer's real login).
 */
export function sharedConfigPath(env: NodeJS.ProcessEnv): string {
    return env.IBEXPRESS_IRONBEE_CONFIG || process.env.IBEXPRESS_IRONBEE_CONFIG || join(homedir(), ".ironbee", "config.json");
}

function bareDomain(value: string): string {
    return value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function section(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nonEmpty(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The whole shared config, `{}` when missing or unreadable (a broken file is not this app's to fix). */
export function readSharedConfig(file: string): Record<string, unknown> {
    if (!existsSync(file)) {
        return {};
    }
    try {
        return section(JSON.parse(readFileSync(file, "utf-8")));
    } catch {
        return {};
    }
}

interface FileCredential {
    oauthToken?: string;
    apiKey?: string;
    domain: string;
}

/**
 * The credential in the shared config: `service.*` (current CLI) when it holds
 * one, else the legacy `collector.*` (older CLI, the editor extension) — the
 * section is chosen first, so a stale `collector` token never shadows a current
 * `service` key. Within a section a token wins over a key. Its domain is the
 * section's own: `service.domain`, or the one a standard
 * `collector.service.<d>` URL names.
 */
function fileCredential(config: Record<string, unknown>): FileCredential | undefined {
    const service: Record<string, unknown> = section(config.service);
    const collector: Record<string, unknown> = section(config.collector);
    const fromService: boolean = nonEmpty(service.oauthToken) !== undefined || nonEmpty(service.apiKey) !== undefined;
    const chosen: Record<string, unknown> = fromService ? service : collector;
    const oauthToken: string | undefined = nonEmpty(chosen.oauthToken);
    const apiKey: string | undefined = oauthToken ? undefined : nonEmpty(chosen.apiKey);
    if (!oauthToken && !apiKey) {
        return undefined;
    }
    const collectorHost: string | undefined = nonEmpty(collector.url)?.match(/collector\.service\.([^/:]+)/)?.[1];
    const domain: string = bareDomain((fromService ? nonEmpty(service.domain) : collectorHost) ?? DEFAULT_IRONBEE_DOMAIN);
    return { ...(oauthToken ? { oauthToken } : { apiKey }), domain };
}

export function resolveIronBeeConfig(env: NodeJS.ProcessEnv): IronBeeConfig {
    // An empty IRONBEE_* (a template's `IRONBEE_API_KEY=`) does not shadow a set SERVICE_* one.
    const envApiKey: string | undefined = nonEmpty(env.IRONBEE_API_KEY) ?? nonEmpty(env.SERVICE_API_KEY);
    const envOauthToken: string | undefined = nonEmpty(env.IRONBEE_OAUTH_TOKEN) ?? nonEmpty(env.SERVICE_OAUTH_TOKEN);
    const envDomain: string | undefined = nonEmpty(env.IRONBEE_DOMAIN) ?? nonEmpty(env.SERVICE_DOMAIN);
    const configFile: string = sharedConfigPath(env);
    let credential: { apiKey?: string; oauthToken?: string; source?: CredentialSource } = {};
    let domain: string = bareDomain(envDomain ?? DEFAULT_IRONBEE_DOMAIN);
    if (envApiKey || envOauthToken) {
        credential = { apiKey: envApiKey, oauthToken: envOauthToken, source: CredentialSource.ENV };
    } else {
        const stored: FileCredential | undefined = fileCredential(readSharedConfig(configFile));
        // A token of another stage would only be refused there.
        if (stored && (envDomain === undefined || bareDomain(envDomain) === stored.domain)) {
            credential = { apiKey: stored.apiKey, oauthToken: stored.oauthToken, source: CredentialSource.FILE };
            domain = stored.domain;
        }
    }
    const off: boolean = ["0", "false", "no", "off"].includes((env.IBEXPRESS_IRONBEE_REPORT ?? "").trim().toLowerCase());
    return {
        ...(credential.apiKey ? { apiKey: credential.apiKey } : {}),
        ...(credential.oauthToken ? { oauthToken: credential.oauthToken } : {}),
        ...(credential.source ? { source: credential.source } : {}),
        domain,
        collectorUrl: nonEmpty(env.IRONBEE_COLLECTOR_URL) ?? `https://collector.service.${domain}`,
        apiUrl: nonEmpty(env.IRONBEE_API_URL) ?? `https://api.service.${domain}`,
        consoleUrl: (nonEmpty(env.IRONBEE_CONSOLE_URL) ?? `https://console.${domain}`).replace(/\/$/, ""),
        configFile,
        projectName: nonEmpty(env.IBEXPRESS_PROJECT_NAME) ?? basename(process.cwd()),
        userEmail: nonEmpty(env.IRONBEE_USER_EMAIL),
        ...(off ? { reportingOff: true } : {}),
        enabled: Boolean(credential.apiKey || credential.oauthToken) && !off,
    };
}

/**
 * The same config with the shared file's credential read again (after a
 * connect or a sign-out). A credential from the environment stays: the
 * environment wins over the file.
 */
export function reloadStoredCredential(current: IronBeeConfig): IronBeeConfig {
    if (current.source === CredentialSource.ENV) {
        return current;
    }
    const { apiKey: _apiKey, oauthToken: _oauthToken, source: _source, ...rest } = current;
    const stored: FileCredential | undefined = fileCredential(readSharedConfig(current.configFile));
    if (!stored || stored.domain !== current.domain) {
        return { ...rest, enabled: false };
    }
    return {
        ...rest,
        ...(stored.oauthToken ? { oauthToken: stored.oauthToken } : { apiKey: stored.apiKey }),
        source: CredentialSource.FILE,
        enabled: !current.reportingOff,
    };
}

/** The platform auth header: the personal token wins over the shared key. */
export function authHeaders(config: IronBeeConfig): Record<string, string> {
    if (config.oauthToken) {
        return { "X-OAuth-Token": config.oauthToken };
    }
    return config.apiKey ? { "X-API-Key": config.apiKey } : {};
}

/**
 * Environment for a DevTools daemon that reports to the platform: tool-call
 * metadata accepted, browser OpenTelemetry exported to the collector, and the
 * service domain + credential for the trace/log read tools.
 */
export function daemonEnvFor(config: IronBeeConfig): Record<string, string> {
    if (!config.enabled) {
        return {};
    }
    const [header, value] = Object.entries(authHeaders(config))[0];
    return {
        TOOL_INPUT_METADATA_ENABLE: "true",
        SERVICE_DOMAIN: config.domain,
        ...(config.oauthToken ? { SERVICE_OAUTH_TOKEN: config.oauthToken } : { SERVICE_API_KEY: config.apiKey! }),
        OTEL_ENABLE: "true",
        OTEL_EXPORTER_TYPE: "otlp/http-protobuf",
        OTEL_EXPORTER_HTTP_URL: config.collectorUrl,
        OTEL_EXPORTER_HTTP_HEADERS: `${header}=${value}`,
        OTEL_INSTRUMENTATION_USER_INTERACTION_EVENTS: "change,input,click",
    };
}
