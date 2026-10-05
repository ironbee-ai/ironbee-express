import { DocumentResponse } from "../devtools/client";

/**
 * A bot-protection vendor's challenge or block on the run's last page, recognised from the response
 * that served it: its status and the headers the vendors document — never the page's words.
 */
export interface BotCheck {
    vendor: BotVendor;
    status: number;
    /** The page's host (a URL could carry what the run typed). */
    host: string;
}

export enum BotVendor {
    CLOUDFLARE = "Cloudflare",
    KASADA = "Kasada",
    DATADOME = "DataDome",
    AKAMAI = "Akamai",
    AWS_WAF = "AWS WAF",
    IMPERVA = "Imperva",
    VERCEL = "Vercel",
}

function header(response: DocumentResponse, name: string): string | undefined {
    for (const [key, value] of Object.entries(response.headers)) {
        if (key.toLowerCase() === name) {
            return value;
        }
    }
    return undefined;
}

function hasHeaderPrefix(response: DocumentResponse, prefix: string): boolean {
    return Object.keys(response.headers).some((key: string): boolean => key.toLowerCase().startsWith(prefix));
}

/**
 * The vendor whose challenge or block page this response is, or undefined. Each rule is one the
 * vendor documents for its challenge / block responses; a vendor's header on a page it let through
 * (DataDome's `x-datadome: protected`, Akamai's server on every page) does not count.
 */
export function botVendorOf(response: DocumentResponse): BotVendor | undefined {
    const status: number = response.status ?? 0;
    if (header(response, "cf-mitigated") === "challenge") {
        return BotVendor.CLOUDFLARE;
    }
    if (header(response, "x-vercel-mitigated") === "challenge") {
        return BotVendor.VERCEL;
    }
    if (header(response, "x-amzn-waf-action") !== undefined) {
        return BotVendor.AWS_WAF;
    }
    if (status === 429 && hasHeaderPrefix(response, "x-kpsdk-")) {
        return BotVendor.KASADA;
    }
    if (status === 403 && (header(response, "x-dd-b") !== undefined || header(response, "x-datadome") !== undefined)) {
        return BotVendor.DATADOME;
    }
    if (status === 403 && /akamaighost/i.test(header(response, "server") ?? "")) {
        return BotVendor.AKAMAI;
    }
    if (status === 403 && header(response, "x-iinfo") !== undefined) {
        return BotVendor.IMPERVA;
    }
    return undefined;
}

function sameDocument(a: string, b: string): boolean {
    try {
        const x: URL = new URL(a);
        const y: URL = new URL(b);
        return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
    } catch {
        return false;
    }
}

/**
 * The bot check on the run's last page: the latest document response for that page's address,
 * when a vendor's challenge or block served it.
 */
export function lastPageBotCheck(finalUrl: string, documents: DocumentResponse[]): BotCheck | undefined {
    const served: DocumentResponse | undefined = [...documents].reverse().find((d: DocumentResponse): boolean => sameDocument(d.url, finalUrl));
    if (served === undefined) {
        return undefined;
    }
    const vendor: BotVendor | undefined = botVendorOf(served);
    if (vendor === undefined) {
        return undefined;
    }
    return { vendor, status: served.status ?? 0, host: new URL(served.url).host };
}

/** What the run's warning says about it: the stealth browser when the run did not use it. */
export function botCheckWarning(check: BotCheck, stealth: boolean): string {
    const what: string = `${check.host} answered the run's last page with ${check.vendor}'s bot check (HTTP ${check.status}): the site refused the browser`;
    return stealth
        ? `${what}, the stealth browser too — an allowlist of the site's own, or another network, is needed`
        : `${what} — the stealth browser (--stealth, or "Stealth browser" in the UI) gets past more of these`;
}
