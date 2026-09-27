/** URL readings shared across layers: the path a page is on, for words and for matching. */

/** The URL's path; the URL itself when it does not parse. */
export function pathOf(url: string): string {
    try {
        return new URL(url).pathname;
    } catch {
        return url;
    }
}

/** The URL's path and query; the URL itself when it does not parse. */
export function pathAndQuery(url: string): string {
    try {
        const u: URL = new URL(url);
        return `${u.pathname}${u.search}`;
    } catch {
        return url;
    }
}
