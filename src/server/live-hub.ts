/**
 * The live-view hub. IronBee DevTools' live-view publisher (enabled by
 * LIVE_VIEW_WS_URL + LIVE_VIEW_TOKEN in the daemon's environment) connects
 * here as the PRODUCER while a recording runs and sends JPEG frames:
 *
 *   0x01 | u32BE headerLen | header JSON {seq, ts, viewportWidth, viewportHeight} | JPEG
 *
 * Frames are relayed unchanged to every VIEWER (browser tabs of the UI), which
 * also receive the run's JSON events. The hub tells the producer its target
 * frame rate, viewer count and whether a human has control: granted only
 * while a run waits for its user (ASK_USER). Then, and only then, a viewer's
 * input messages (mouse / wheel / keys / text in viewport coordinates) are
 * relayed to the producer, which applies them to the page.
 */

import { RawData, WebSocket } from "ws";

const TARGET_FPS: number = 10;
/** A viewer this far behind skips frames rather than queueing them. */
const VIEWER_BACKLOG_BYTES: number = 2 * 1024 * 1024;
/** Input kinds DevTools' live view applies; anything else is dropped here. */
const INPUT_KINDS: Set<string> = new Set(["mouse-move", "mouse-down", "mouse-up", "wheel", "key-down", "key-up", "text"]);
const MAX_INPUT_BYTES: number = 16 * 1024;

export class LiveHub {
    private readonly viewers: Set<WebSocket> = new Set();
    private readonly producers: Set<WebSocket> = new Set();
    private lastFrame: Buffer | undefined;
    private humanControl: boolean = false;

    /** Grants (or takes back) the browser to the viewers' human input. */
    setHumanControl(on: boolean): void {
        if (this.humanControl === on) {
            return;
        }
        this.humanControl = on;
        this.broadcastState();
    }

    get viewerCount(): number {
        return this.viewers.size;
    }

    get producerConnected(): boolean {
        return this.producers.size > 0;
    }

    addProducer(socket: WebSocket): void {
        this.producers.add(socket);
        this.guard(socket);
        this.sendState(socket);
        socket.on("message", (data: RawData, isBinary: boolean): void => {
            if (!isBinary) {
                // Spans / logs / tool calls: not shown by this UI.
                return;
            }
            const frame: Buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            this.lastFrame = frame;
            for (const viewer of this.viewers) {
                if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < VIEWER_BACKLOG_BYTES) {
                    viewer.send(frame, { binary: true });
                }
            }
        });
        socket.on("close", (): void => {
            this.producers.delete(socket);
        });
    }

    addViewer(socket: WebSocket): void {
        this.viewers.add(socket);
        this.guard(socket);
        if (this.lastFrame) {
            socket.send(this.lastFrame, { binary: true });
        }
        this.broadcastState();
        socket.on("message", (data: RawData, isBinary: boolean): void => {
            if (!isBinary && this.humanControl) {
                this.relayInput(data.toString());
            }
        });
        socket.on("close", (): void => {
            this.viewers.delete(socket);
            this.broadcastState();
        });
    }

    /** A JSON event to every viewer. */
    broadcast(message: unknown): void {
        const text: string = JSON.stringify(message);
        for (const viewer of this.viewers) {
            if (viewer.readyState === WebSocket.OPEN) {
                viewer.send(text);
            }
        }
    }

    /** Forgets the last frame, so a new run does not open on the previous page. */
    resetFrame(): void {
        this.lastFrame = undefined;
    }

    closeAll(): void {
        for (const socket of [...this.viewers, ...this.producers]) {
            socket.terminate();
        }
    }

    /**
     * A socket error (a malformed frame, a reset) is that socket's end, not the
     * process's: `ws` emits `error` whether or not anyone listens, and an
     * unlistened `error` event throws.
     */
    private guard(socket: WebSocket): void {
        socket.on("error", (): void => {
            this.viewers.delete(socket);
            this.producers.delete(socket);
            socket.terminate();
        });
    }

    /** A viewer's input, re-serialized from its known fields only, to every producer. */
    private relayInput(raw: string): void {
        if (raw.length > MAX_INPUT_BYTES) {
            return;
        }
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        if (message?.type !== "input" || typeof message.kind !== "string" || !INPUT_KINDS.has(message.kind)) {
            return;
        }
        const input: Record<string, unknown> = { type: "input", kind: message.kind };
        for (const key of ["x", "y", "deltaX", "deltaY"]) {
            if (typeof message[key] === "number" && Number.isFinite(message[key])) {
                input[key] = message[key];
            }
        }
        for (const key of ["button", "key", "text"]) {
            if (typeof message[key] === "string") {
                input[key] = message[key];
            }
        }
        const text: string = JSON.stringify(input);
        for (const producer of this.producers) {
            if (producer.readyState === WebSocket.OPEN) {
                producer.send(text);
            }
        }
    }

    private sendState(socket: WebSocket): void {
        socket.send(
            JSON.stringify({
                type: "state",
                v: 1,
                humanControl: this.humanControl,
                targetFps: TARGET_FPS,
                viewers: this.viewers.size,
            })
        );
    }

    private broadcastState(): void {
        for (const producer of this.producers) {
            if (producer.readyState === WebSocket.OPEN) {
                this.sendState(producer);
            }
        }
    }
}
