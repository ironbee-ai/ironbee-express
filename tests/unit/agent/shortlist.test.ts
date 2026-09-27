import { relevance, shortlistControls } from "../../../src/agent/shortlist";
import { Control, ControlOperation } from "../../../src/devtools/types";
import { control, productControls } from "../../helpers/fixtures";

describe("shortlistControls", (): void => {
    it("keeps everything under the limit, in page order", (): void => {
        const controls: Control[] = productControls(3);
        expect(shortlistControls(controls, "anything", 10)).toBe(controls);
    });

    it("keeps the goal-relevant controls and returns them in page order", (): void => {
        const all: Control[] = productControls(40);
        const kept: Control[] = shortlistControls(all, "Add the Sony headphones to the cart", 5);
        const ids: number[] = kept.map((c: Control): number => c.id);
        expect(ids).toContain(139);
        expect(ids).toContain(8);
        const positions: number[] = kept.map((c: Control): number => all.indexOf(c));
        expect(positions).toEqual([...positions].sort((a: number, b: number): number => a - b));
        expect(kept).toHaveLength(5);
    });

    it("scores a control by the goal's words and an empty field only — no word list for what a button is", (): void => {
        const query: Set<string> = new Set(["headphones"]);
        expect(relevance(control(1, "button", "Submit", [ControlOperation.CLICK]), query)).toBe(relevance(control(2, "button", "Zebra", [ControlOperation.CLICK]), query));
        expect(relevance(control(3, "button", "Search", [ControlOperation.CLICK]), query)).toBe(0);
        expect(relevance(control(4, "textbox", "Anything", [ControlOperation.FILL]), query)).toBe(0.5);
    });
});
