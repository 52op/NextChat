import { jest } from "@jest/globals";

// The test suite runs as native ESM (see jest.config.ts + extensionsToTreatAsEsm),
// so jest.mock() is not hoisted: register the module mock explicitly and import
// the module under test afterwards (dynamic import inside beforeAll).
jest.unstable_mockModule("ws", () => {
  class MockWebSocket {
    static OPEN = 1;
    static instances: any[] = [];
    // null simulates a handshake that does not carry a session id
    static handshakeSessionId: string | null = "srv-session";

    readyState = 0;
    sent: any[] = [];
    handlers: Record<string, ((...args: any[]) => void)[]> = {};

    constructor(public url: string) {
      MockWebSocket.instances.push(this);
      setTimeout(() => {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open");
        this.emit("message", {
          toString: () =>
            JSON.stringify({
              msg_type: "action",
              data: {
                action: "started",
                ...(MockWebSocket.handshakeSessionId
                  ? { sessionId: MockWebSocket.handshakeSessionId }
                  : {}),
              },
            }),
        });
      }, 0);
    }

    on(event: string, cb: (...args: any[]) => void) {
      (this.handlers[event] = this.handlers[event] || []).push(cb);
    }

    emit(event: string, ...args: any[]) {
      (this.handlers[event] || []).forEach((cb) => cb(...args));
    }

    send(data: any) {
      this.sent.push(data);
    }

    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }

  return { __esModule: true, default: MockWebSocket };
});

let transcribePcm!: typeof import("../app/utils/iflytek-asr").transcribePcm;
let ASR_FLUSH_TIMEOUT_MS!: number;
let MockWebSocket!: any;

beforeAll(async () => {
  const asr = await import("../app/utils/iflytek-asr");
  transcribePcm = asr.transcribePcm;
  ASR_FLUSH_TIMEOUT_MS = asr.ASR_FLUSH_TIMEOUT_MS;
  MockWebSocket = (await import("ws")).default as any;
});

const config = {
  appId: "1e20bf92",
  apiKey: "36169c0e02b63242fc589053bbd9e2a7",
  apiSecret: "MTkyZGIzZWVmNGVhNzA3NjI1MWI2OTZi",
};

// the server sends JSON as text frames
function message(payload: unknown) {
  return { toString: () => JSON.stringify(payload) };
}

function finalResult(segId: number, text: string) {
  return message({
    msg_type: "result",
    res_type: "asr",
    data: {
      seg_id: segId,
      cn: { st: { type: "0", rt: [{ ws: [{ cw: [{ w: text }] }] }] } },
    },
  });
}

function endMarker(ws: any) {
  const raw = ws.sent.find((d: any) => typeof d === "string");
  return raw ? JSON.parse(raw) : null;
}

describe("transcribePcm", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    MockWebSocket.handshakeSessionId = "srv-session";
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("resolves after the flush grace period when the server keeps the socket open", async () => {
    const pcm = new Uint8Array(1280 * 3);
    const promise = transcribePcm(config, pcm, 30000);

    // open + handshake + first audio chunk
    await jest.advanceTimersByTimeAsync(120);
    const ws = MockWebSocket.instances[0];
    ws.emit("message", finalResult(0, "你好"));

    // remaining chunks + the end marker
    await jest.advanceTimersByTimeAsync(200);
    expect(endMarker(ws)).toEqual({ end: true, sessionId: "srv-session" });

    // no ls=true and no close from the server: the flush timer must resolve
    await jest.advanceTimersByTimeAsync(ASR_FLUSH_TIMEOUT_MS + 500);
    await expect(promise).resolves.toMatchObject({ text: "你好" });
  });

  test("falls back to a client session id when the handshake has none", async () => {
    MockWebSocket.handshakeSessionId = null;
    const pcm = new Uint8Array(1280);
    const promise = transcribePcm(config, pcm, 30000);

    await jest.advanceTimersByTimeAsync(200);
    const end = endMarker(MockWebSocket.instances[0]);
    expect(end.end).toBe(true);
    expect(typeof end.sessionId).toBe("string");
    expect(end.sessionId.length).toBeGreaterThan(0);

    MockWebSocket.instances[0].emit("message", finalResult(0, "测试"));
    await jest.advanceTimersByTimeAsync(ASR_FLUSH_TIMEOUT_MS + 500);
    await expect(promise).resolves.toMatchObject({ text: "测试" });
  });

  test("returns already recognized text on hard timeout instead of failing", async () => {
    const pcm = new Uint8Array(1280);
    const promise = transcribePcm(config, pcm, 1000);

    await jest.advanceTimersByTimeAsync(100);
    MockWebSocket.instances[0].emit("message", finalResult(0, "世界"));
    // the hard timeout (1s) is shorter than the flush grace period (4s)
    await jest.advanceTimersByTimeAsync(1100);

    await expect(promise).resolves.toMatchObject({ text: "世界" });
  });

  test("rejects on timeout when nothing was recognized", async () => {
    const pcm = new Uint8Array(1280);
    const promise = transcribePcm(config, pcm, 1000);
    const assertion = expect(promise).rejects.toThrow("ASR timeout");

    await jest.advanceTimersByTimeAsync(1100);
    await assertion;
  });
});
