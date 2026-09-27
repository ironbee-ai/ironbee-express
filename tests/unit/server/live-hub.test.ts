import { EventEmitter } from "events";
import { WebSocket } from "ws";
import { LiveHub } from "../../../src/server/live-hub";

/** Just enough of a socket for the hub: sends are recorded, messages are emitted. */
class FakeSocket extends EventEmitter {
    readonly readyState: number = WebSocket.OPEN;
    readonly bufferedAmount: number = 0;
    readonly sent: string[] = [];
    terminated: boolean = false;

    send(data: unknown): void {
        if (typeof data === "string") {
            this.sent.push(data);
        }
    }

    terminate(): void {
        this.terminated = true;
    }
}

function hub(): { hub: LiveHub; producer: FakeSocket; viewer: FakeSocket } {
    const live: LiveHub = new LiveHub();
    const producer: FakeSocket = new FakeSocket();
    const viewer: FakeSocket = new FakeSocket();
    live.addProducer(producer as unknown as WebSocket);
    live.addViewer(viewer as unknown as WebSocket);
    return { hub: live, producer, viewer };
}

function inputs(socket: FakeSocket): Array<Record<string, unknown>> {
    return socket.sent.map((s: string): Record<string, unknown> => JSON.parse(s)).filter((m: Record<string, unknown>): boolean => m.type === "input");
}

describe("LiveHub human control", (): void => {
    it("relays a viewer's input only while control is granted, with known fields only", (): void => {
        const { hub: live, producer, viewer } = hub();
        const click: string = JSON.stringify({ type: "input", kind: "mouse-down", x: 10, y: 20, button: "left", extra: "dropped" });
        viewer.emit("message", Buffer.from(click), false);
        expect(inputs(producer)).toEqual([]);

        live.setHumanControl(true);
        expect(JSON.parse(producer.sent.at(-1)!)).toMatchObject({ type: "state", humanControl: true });
        viewer.emit("message", Buffer.from(click), false);
        viewer.emit("message", Buffer.from(JSON.stringify({ type: "input", kind: "eval", text: "x" })), false);
        viewer.emit("message", Buffer.from("not json"), false);
        expect(inputs(producer)).toEqual([{ type: "input", kind: "mouse-down", x: 10, y: 20, button: "left" }]);

        live.setHumanControl(false);
        expect(JSON.parse(producer.sent.at(-1)!)).toMatchObject({ type: "state", humanControl: false });
        viewer.emit("message", Buffer.from(click), false);
        expect(inputs(producer)).toHaveLength(1);
    });
});

describe("LiveHub socket errors", (): void => {
    it("ends the failing socket only: a viewer's or producer's error never throws", (): void => {
        const { hub: live, producer, viewer } = hub();
        // An EventEmitter with no `error` listener throws on emit — as `ws` does for a malformed frame.
        expect((): boolean => viewer.emit("error", new Error("invalid UTF-8"))).not.toThrow();
        expect(viewer.terminated).toBe(true);
        expect(live.viewerCount).toBe(0);
        expect(live.producerConnected).toBe(true);

        expect((): boolean => producer.emit("error", new Error("RSV bits set"))).not.toThrow();
        expect(producer.terminated).toBe(true);
        expect(live.producerConnected).toBe(false);
    });
});
