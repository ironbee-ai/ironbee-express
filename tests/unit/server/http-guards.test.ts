/**
 * The UI server's request guards and its video streaming, as pure pieces: which
 * `Host` / `Origin` a bind accepts, the address the daemon and the IronBee
 * console are given, and byte ranges over a recording.
 */

import { bindHost, connectRefusal, hostAllowed, loopbackHost, originAllowed, parseRange, reachableHost, serveVideo } from "../../../src/server/ui-server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";

describe("reachableHost", (): void => {
    it("is the bound address when concrete, loopback for a wildcard bind, bracketed for IPv6", (): void => {
        expect(reachableHost("127.0.0.1")).toBe("127.0.0.1");
        expect(reachableHost("192.168.1.5")).toBe("192.168.1.5");
        expect(reachableHost("::1")).toBe("[::1]");
        expect(reachableHost("0.0.0.0")).toBe("127.0.0.1");
        expect(reachableHost("::")).toBe("127.0.0.1");
        expect(reachableHost("")).toBe("127.0.0.1");
    });
});

describe("bindHost", (): void => {
    it("hands listen an IPv6 literal without the URL brackets", (): void => {
        expect(bindHost("[::1]")).toBe("::1");
        expect(bindHost("[::]")).toBe("::");
        expect(bindHost(" 127.0.0.1 ")).toBe("127.0.0.1");
        expect(bindHost("0.0.0.0")).toBe("0.0.0.0");
        expect(reachableHost(bindHost("[::]"))).toBe("127.0.0.1");
        expect(reachableHost(bindHost("[::1]"))).toBe("[::1]");
    });
});

describe("loopbackHost", (): void => {
    it("accepts localhost, 127.0.0.1 and [::1] on the port, nothing else", (): void => {
        const port: number = 15986;
        expect(loopbackHost("localhost:15986", port)).toBe(true);
        expect(loopbackHost("127.0.0.1:15986", port)).toBe(true);
        expect(loopbackHost("[::1]:15986", port)).toBe(true);
        expect(loopbackHost("192.168.1.5:15986", port)).toBe(false);
        expect(loopbackHost("localhost:80", port)).toBe(false);
        expect(loopbackHost(undefined, port)).toBe(false);
    });
});

describe("connectRefusal", (): void => {
    it("sends the user to loopback under a loopback or wildcard bind, to a restart under a concrete one", (): void => {
        for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "::", ""]) {
            expect(connectRefusal(host)).toMatch(/from this machine/);
        }
        // The console calls back to `localhost` / `127.0.0.1` only: a `[::1]` callback is refused there.
        expect(connectRefusal("::1")).toMatch(/does not call back to \[::1\]; restart with --host 127\.0\.0\.1 or 0\.0\.0\.0/);
        for (const host of ["192.168.1.5", "fe80::1", "10.0.0.2"]) {
            expect(connectRefusal(host)).toMatch(/restart with --host 127\.0\.0\.1 or 0\.0\.0\.0/);
        }
    });
});

describe("hostAllowed", (): void => {
    const port: number = 15986;

    it("accepts a bound name or IPv6 literal however it was capitalised", (): void => {
        expect(hostAllowed("Serkans-MacBook-Pro.local:15986", "Serkans-MacBook-Pro.local", port)).toBe(true);
        expect(hostAllowed("serkans-macbook-pro.local:15986", "Serkans-MacBook-Pro.local", port)).toBe(true);
        expect(hostAllowed("[2001:db8::1]:15986", "2001:DB8::1", port)).toBe(true);
        expect(hostAllowed("other.local:15986", "Serkans-MacBook-Pro.local", port)).toBe(false);
    });

    it("accepts the bound host, loopback and localhost on the UI's port, nothing else", (): void => {
        expect(hostAllowed("127.0.0.1:15986", "127.0.0.1", port)).toBe(true);
        expect(hostAllowed("localhost:15986", "127.0.0.1", port)).toBe(true);
        expect(hostAllowed("[::1]:15986", "127.0.0.1", port)).toBe(true);
        expect(hostAllowed("192.168.1.5:15986", "192.168.1.5", port)).toBe(true);
        expect(hostAllowed("192.168.1.5:15986", "127.0.0.1", port)).toBe(false);
        expect(hostAllowed("127.0.0.1:80", "127.0.0.1", port)).toBe(false);
        expect(hostAllowed("127.0.0.1", "127.0.0.1", port)).toBe(false);
        expect(hostAllowed("evil.test:15986", "127.0.0.1", port)).toBe(false);
        expect(hostAllowed(undefined, "127.0.0.1", port)).toBe(false);
        expect(hostAllowed("", "127.0.0.1", port)).toBe(false);
        expect(hostAllowed("127.0.0.1:15986/x", "127.0.0.1", port)).toBe(false);
    });

    it("on a wildcard bind accepts any IP literal on the port, still no DNS name", (): void => {
        expect(hostAllowed("192.168.1.5:15986", "0.0.0.0", port)).toBe(true);
        expect(hostAllowed("[fe80::1]:15986", "::", port)).toBe(true);
        expect(hostAllowed("192.168.1.5:80", "0.0.0.0", port)).toBe(false);
        expect(hostAllowed("evil.test:15986", "0.0.0.0", port)).toBe(false);
        expect(hostAllowed("localhost:15986", "0.0.0.0", port)).toBe(true);
    });

    it("an origin is allowed when it is http:// plus an allowed host", (): void => {
        expect(originAllowed("http://127.0.0.1:15986", "127.0.0.1", port)).toBe(true);
        expect(originAllowed("http://192.168.1.5:15986", "0.0.0.0", port)).toBe(true);
        expect(originAllowed("https://127.0.0.1:15986", "127.0.0.1", port)).toBe(false);
        expect(originAllowed("http://evil.test:15986", "0.0.0.0", port)).toBe(false);
        expect(originAllowed(undefined, "127.0.0.1", port)).toBe(false);
    });
});

describe("parseRange", (): void => {
    it("reads one bytes range, clamps the end, and refuses what cannot be satisfied", (): void => {
        expect(parseRange(undefined, 100)).toBeUndefined();
        expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
        expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
        expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange("bytes=100-", 100)).toBeNull();
        expect(parseRange("bytes=20-10", 100)).toBeNull();
        expect(parseRange("bytes=-", 100)).toBeNull();
        // Another unit, several ranges or a malformed one: no range to honor, the whole file goes.
        expect(parseRange("items=0-1", 100)).toBeUndefined();
        expect(parseRange("bytes=0-1,5-6", 100)).toBeUndefined();
        expect(parseRange("bytes=abc", 100)).toBeUndefined();
    });
});

describe("serveVideo", (): void => {
    let dir: string;
    let server: Server;
    let base: string;
    const bytes: Buffer = Buffer.from("0123456789abcdef");

    beforeAll(async (): Promise<void> => {
        dir = mkdtempSync(join(tmpdir(), "ibexpress-video-"));
        writeFileSync(join(dir, "run.webm"), bytes);
        server = createServer((req: IncomingMessage, res: ServerResponse): void => {
            const name: string = new URL(req.url ?? "/", "http://x").pathname.slice(1);
            serveVideo(res, join(dir, name), req.headers.range);
        });
        await new Promise<void>((resolve: () => void): void => {
            server.listen(0, "127.0.0.1", (): void => resolve());
        });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async (): Promise<void> => {
        await new Promise<void>((resolve: () => void): void => {
            server.close((): void => resolve());
        });
        rmSync(dir, { recursive: true, force: true });
    });

    it("streams the whole file with its type and length, and says ranges are accepted", async (): Promise<void> => {
        const res: Response = await fetch(`${base}/run.webm`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/webm");
        expect(res.headers.get("content-length")).toBe(String(bytes.length));
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    });

    it("answers a range with 206 and just those bytes, an impossible one with 416", async (): Promise<void> => {
        const part: Response = await fetch(`${base}/run.webm`, { headers: { range: "bytes=4-7" } });
        expect(part.status).toBe(206);
        expect(part.headers.get("content-range")).toBe(`bytes 4-7/${bytes.length}`);
        expect(part.headers.get("content-length")).toBe("4");
        expect(await part.text()).toBe("4567");

        const tail: Response = await fetch(`${base}/run.webm`, { headers: { range: "bytes=-3" } });
        expect(tail.status).toBe(206);
        expect(await tail.text()).toBe("def");

        const bad: Response = await fetch(`${base}/run.webm`, { headers: { range: "bytes=99-" } });
        expect(bad.status).toBe(416);
        expect(bad.headers.get("content-range")).toBe(`bytes */${bytes.length}`);
    });
});
