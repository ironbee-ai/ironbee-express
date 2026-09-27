/**
 * Frame routing is the snapshot's own map, never derived from an id's value.
 */

import {
    ControlTarget,
    controlTarget,
    FRAME_ID_BASE,
    FRAME_ID_STRIDE,
    frameControlId,
    FrameControlRoute,
} from "../../../src/devtools-plugin/frames";

describe("control-frames routing", (): void => {
    const page: never = { name: "page" } as never;
    const frame: never = { isDetached: (): boolean => false } as never;
    const gone: never = { isDetached: (): boolean => true } as never;

    it("routes any id not in the map to the page, however large", (): void => {
        for (const id of [1, 150_000, FRAME_ID_BASE + 5]) {
            expect(controlTarget(page, undefined, id)).toEqual({ runner: page, local: id });
            expect(controlTarget(page, new Map(), id)).toEqual({ runner: page, local: id });
        }
    });

    it("routes a mapped id to its frame and its runtime id there, and not to a frame that is gone", (): void => {
        const id: number = frameControlId(2, 7)!;
        expect(id).toBe(FRAME_ID_BASE + 2 * FRAME_ID_STRIDE + 7);
        const routes: Map<number, FrameControlRoute> = new Map([
            [id, { route: { slot: 2, frame, host: "pay.test", label: "pay.test" }, local: 7 }],
        ]);
        const target: ControlTarget | undefined = controlTarget(page, routes, id);
        expect(target?.runner).toBe(frame);
        expect(target?.local).toBe(7);
        routes.set(id, { route: { slot: 2, frame: gone, host: "pay.test", label: "pay.test" }, local: 7 });
        expect(controlTarget(page, routes, id)).toBeUndefined();
        expect(frameControlId(1, FRAME_ID_STRIDE)).toBeUndefined();
    });
});
