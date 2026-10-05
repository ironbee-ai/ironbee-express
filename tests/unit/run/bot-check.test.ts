import { DocumentResponse } from "../../../src/devtools/client";
import { BotCheck, botCheckWarning, botVendorOf, BotVendor, lastPageBotCheck } from "../../../src/run/bot-check";

function doc(status: number, headers: Record<string, string>, url: string = "https://shop.example/"): DocumentResponse {
    return { url, status, headers };
}

describe("botVendorOf", (): void => {
    it("recognises each vendor's documented challenge or block response", (): void => {
        expect(botVendorOf(doc(403, { "cf-mitigated": "challenge", server: "cloudflare" }))).toBe(BotVendor.CLOUDFLARE);
        expect(botVendorOf(doc(429, { "X-Kpsdk-Ct": "abc" }))).toBe(BotVendor.KASADA);
        expect(botVendorOf(doc(403, { "x-dd-b": "1" }))).toBe(BotVendor.DATADOME);
        expect(botVendorOf(doc(403, { "x-datadome": "protected" }))).toBe(BotVendor.DATADOME);
        expect(botVendorOf(doc(403, { server: "AkamaiGHost" }))).toBe(BotVendor.AKAMAI);
        expect(botVendorOf(doc(202, { "x-amzn-waf-action": "challenge" }))).toBe(BotVendor.AWS_WAF);
        expect(botVendorOf(doc(403, { "x-iinfo": "8-123" }))).toBe(BotVendor.IMPERVA);
        expect(botVendorOf(doc(429, { "x-vercel-mitigated": "challenge" }))).toBe(BotVendor.VERCEL);
    });

    it("does not count a vendor's header on a page it let through", (): void => {
        expect(botVendorOf(doc(200, { "x-datadome": "protected" }))).toBeUndefined();
        expect(botVendorOf(doc(200, { server: "AkamaiGHost" }))).toBeUndefined();
        expect(botVendorOf(doc(200, { "x-kpsdk-ct": "abc" }))).toBeUndefined();
        expect(botVendorOf(doc(200, { server: "cloudflare" }))).toBeUndefined();
        expect(botVendorOf(doc(403, { server: "nginx" }))).toBeUndefined();
    });
});

describe("lastPageBotCheck", (): void => {
    it("judges the latest response for the last page's address", (): void => {
        const documents: DocumentResponse[] = [
            doc(403, { "cf-mitigated": "challenge" }, "https://shop.example/cart?step=1"),
            doc(200, {}, "https://shop.example/cart?step=1"),
            doc(403, { "x-dd-b": "1" }, "https://ads.example/frame"),
        ];
        // The challenge passed (the page loaded after it); an ad frame's block is not the run's page.
        expect(lastPageBotCheck("https://shop.example/cart?step=1#total", documents)).toBeUndefined();
        const check: BotCheck | undefined = lastPageBotCheck("https://shop.example/cart?step=1", [
            ...documents,
            doc(429, { "x-kpsdk-r": "1" }, "https://shop.example/cart?step=1"),
        ]);
        expect(check).toEqual({ vendor: BotVendor.KASADA, status: 429, host: "shop.example" });
    });

    it("says nothing without a response for the page", (): void => {
        expect(lastPageBotCheck("https://shop.example/", [])).toBeUndefined();
        expect(lastPageBotCheck("not a url", [doc(403, { "cf-mitigated": "challenge" })])).toBeUndefined();
    });
});

describe("botCheckWarning", (): void => {
    const check: BotCheck = { vendor: BotVendor.KASADA, status: 429, host: "shop.example" };

    it("points a normal run at the stealth browser", (): void => {
        expect(botCheckWarning(check, false)).toMatch(/shop\.example .*Kasada's bot check \(HTTP 429\).*stealth browser/);
    });

    it("tells a stealth run what is left", (): void => {
        expect(botCheckWarning(check, true)).toMatch(/the stealth browser too .*allowlist/);
    });
});
