/**
 * A run's secrets as DevTools holds them. Seeded into the daemon's secret
 * registry, a secret is typed by REFERENCE (`{{secret:name.field}}`): DevTools
 * swaps the value in at the field — only on the run's own site, and a password
 * only into a password input — and masks it in everything it returns. The
 * value never travels in a tool call.
 */

import { ControlSnapshot, SecretBundle, SecretType, SeedSecret } from "./types";

/**
 * A mirror of DevTools' seed schema (`NAME_PATTERN` + `NAME_MAX` in its
 * `src/secrets/schema.ts`); it changes with that schema. A secret named
 * otherwise is not seeded and is typed by value, as before.
 */
const NAME_PATTERN: RegExp = /^[A-Za-z0-9._-]{1,255}$/;

/**
 * DevTools' value rules from the same schema (`VALUE_MAX`, no control
 * characters, not whitespace only): a value it would refuse fails the whole
 * bundle, so such a secret is not seeded either and is typed by value.
 */
const VALUE_MAX: number = 4096;
const CONTROL_CHARS: RegExp = /[\u0000-\u001f\u007f]/;

function seedable(value: string): boolean {
    return value.trim().length > 0 && value.length <= VALUE_MAX && !CONTROL_CHARS.test(value);
}

export interface SeededSecrets {
    bundle: SecretBundle;
    /** The reference typed in place of each seeded secret, by name. */
    refs: Record<string, string>;
}

/**
 * Hosts of the frames whose controls a snapshot offers that the secrets are
 * not bound to yet (IBEXPRESS_IFRAMES: a secret may be typed into a frame the
 * start page embeds — its payment form, its login widget).
 */
export function newFrameHosts(page: ControlSnapshot, bound: readonly string[]): string[] {
    const hosts: Set<string> = new Set();
    for (const control of page.controls) {
        if (control.frame && !bound.includes(control.frame)) {
            hosts.add(control.frame);
        }
    }
    return [...hosts];
}

/** `host[:port]` of the run's start URL — the one site its secrets are bound to. */
export function boundOriginOf(url: string | undefined): string | undefined {
    if (!url) {
        return undefined;
    }
    try {
        const parsed: URL = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The seed bundle for a run's secrets, bound to the start site `origin` —
 * and, for all but a password, to `frameHosts` too (IBEXPRESS_IFRAMES: frames
 * the start site embeds). A password never leaves the start site: a frame that
 * asks for it (an ad rendering "session expired") is exactly what to refuse.
 * `passwords` names the secrets that are login passwords, as the user marked
 * them: DevTools types those into password inputs only.
 */
export function secretBundle(
    secrets: Record<string, string>,
    descriptions: Record<string, string>,
    passwords: readonly string[],
    origin: string,
    frameHosts: readonly string[] = []
): SeededSecrets {
    const seeded: SeedSecret[] = [];
    const refs: Record<string, string> = {};
    for (const [name, value] of Object.entries(secrets)) {
        if (!NAME_PATTERN.test(name) || !seedable(value)) {
            continue;
        }
        const password: boolean = passwords.includes(name);
        const field: string = password ? "password" : "value";
        const description: string | undefined = descriptions[name]?.trim().replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500);
        seeded.push({
            name,
            ...(description ? { description } : {}),
            type: password ? SecretType.LOGIN_CREDENTIALS : SecretType.GENERIC,
            fields: { [field]: value },
            boundOrigins: password ? [origin] : [origin, ...frameHosts],
        });
        refs[name] = `{{secret:${name}.${field}}}`;
    }
    return { bundle: { secrets: seeded }, refs };
}
