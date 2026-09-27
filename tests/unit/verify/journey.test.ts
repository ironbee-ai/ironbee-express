import { describeEvidence } from "../../../src/verify/describe";
import { describeJourney, Journey, JourneyRecorder } from "../../../src/verify/journey";

describe("JourneyRecorder", (): void => {
    it("keeps the steps with the page each led to, and each page's latest text, bounded", (): void => {
        const journey: JourneyRecorder = new JourneyRecorder();
        journey.see({ url: "https://s.test/", title: "Home", text: "Welcome   home" });
        journey.see({ url: "https://s.test/orders", title: "Orders", text: "#1 total 5" });
        journey.step({ step: 1, operation: "CLICK", target: '[3] link "Orders"', executed: true });
        journey.step({ step: 2, operation: "CLICK", target: '[4] button "Pay"', executed: false, reason: "covered" });
        journey.step({ step: 3, operation: "PRESS_KEY", key: "Escape", executed: true });
        journey.see({ url: "https://s.test/", title: "Home", text: "Welcome back" });
        const got: Journey = journey.get();
        expect(got.steps.map((s): string => `${s.operation}@${s.url}${s.refused ? "!" : ""}${s.text ? ` ${s.text}` : ""}`)).toEqual([
            "CLICK@https://s.test/orders",
            "CLICK@https://s.test/orders!",
            "PRESS_KEY@https://s.test/orders Escape",
        ]);
        // Seen longest ago first; the home page, seen again, moves last with its latest text.
        expect(got.pages).toEqual([
            { url: "https://s.test/orders", title: "Orders", excerpt: "#1 total 5" },
            { url: "https://s.test/", title: "Home", excerpt: "Welcome back" },
        ]);

        for (let i: number = 0; i < 40; i++) {
            journey.see({ url: `https://s.test/p${i}`, title: `P${i}`, text: "x".repeat(2000) });
            journey.step({ step: 10 + i, operation: "CLICK", executed: true });
        }
        const bounded: Journey = journey.get();
        expect(bounded.steps).toHaveLength(30);
        expect(bounded.pages).toHaveLength(8);
        expect(bounded.pages[0].excerpt.length).toBe(500);
    });

    it("drops the page seen longest ago, not the first visited: a page returned to stays", (): void => {
        const journey: JourneyRecorder = new JourneyRecorder();
        const see = (name: string): void => journey.see({ url: `https://s.test/${name}`, title: name, text: name });
        for (const name of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
            see(name);
        }
        see("B");
        see("I");
        see("J");
        const urls: string[] = journey.get().pages.map((p): string => p.url.replace("https://s.test/", ""));
        expect(urls).toContain("B");
        expect(urls).not.toContain("A");
        expect(urls).not.toContain("C");
        expect(urls).toHaveLength(8);
    });

    it("keeps a page returned to across a hand-over (a replay's journey, healed by the engine)", (): void => {
        const replay: JourneyRecorder = new JourneyRecorder();
        const seeOn = (recorder: JourneyRecorder, name: string): void => recorder.see({ url: `https://s.test/${name}`, title: name, text: name });
        for (const name of ["cart", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "cart", "p8"]) {
            seeOn(replay, name);
        }
        const healing: JourneyRecorder = new JourneyRecorder(replay.get());
        seeOn(healing, "p8");
        seeOn(healing, "p9");
        const urls: string[] = healing.get().pages.map((p): string => p.url.replace("https://s.test/", ""));
        expect(urls).toContain("cart");
        expect(urls).not.toContain("p2");
        expect(urls).toHaveLength(8);
    });

    it("keeps the page seen most recently when the description is cut", (): void => {
        const journey: JourneyRecorder = new JourneyRecorder();
        const page = (name: string): void => journey.see({ url: `https://s.test/${name}`, title: name, text: `${name} ${"x".repeat(480)}` });
        for (const name of ["cart", "p1", "p2", "p3", "p4", "p5", "cart", "final"]) {
            page(name);
        }
        for (let i: number = 1; i <= 30; i++) {
            journey.step({ step: i, operation: "CLICK", target: `[${i}] button "Next page of results"`, executed: true });
        }
        const text: string = describeJourney(journey.get(), "https://s.test/final", 3_600);
        expect(text.length).toBeLessThanOrEqual(3_600);
        expect(text).toContain("- cart /cart:");
        expect(text).not.toContain("- p1 /p1:");
    });

    it("reads as steps then earlier pages, before the final page in the evidence", (): void => {
        const journey: Journey = {
            steps: [{ step: 1, operation: "GO_BACK", url: "https://s.test/" }],
            pages: [
                { url: "https://s.test/orders", title: "Orders", excerpt: "#1 total 5" },
                { url: "https://s.test/", title: "Home", excerpt: "Welcome" },
            ],
        };
        expect(describeJourney(journey, "https://s.test/")).toBe(
            "Steps taken, oldest first:\n1. GO_BACK → /\n\nEarlier pages (as last seen):\n- Orders /orders: #1 total 5"
        );
        const text: string = describeEvidence({ url: "https://s.test/", title: "Home", text: "Welcome", journey }, 1000);
        expect(text.indexOf("The run so far")).toBeLessThan(text.indexOf("Final page"));
    });

    it("does not take a dialog over a page for the page", (): void => {
        const journey: JourneyRecorder = new JourneyRecorder();
        journey.see({ url: "https://s.test/orders", title: "Orders", text: "#1 total 5" });
        journey.see({ url: "https://s.test/orders", title: "Orders", text: "A confirm dialog is open: Sure?", dialog: { type: "confirm", message: "Sure?" } });
        expect(journey.get().pages).toEqual([{ url: "https://s.test/orders", title: "Orders", excerpt: "#1 total 5" }]);
    });
});
