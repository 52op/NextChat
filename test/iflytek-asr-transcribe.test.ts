import { jest } from "@jest/globals";

jest.unstable_mockModule("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static instances: MockWebSocket[] = [];
    readyState = 0;
    sent: any[] = [];
    handlers: Record<string, ((...args: any[]) => void)[]> = {};
    constructor(public url: string) {
      MockWebSocket.instances.push(this);
    }
    on(event: string, cb: (...args: any[]) => void) {
      (this.handlers[event] ??= []).push(cb);
    }
    emit(event: string, ...args: any[]) {
      (this.handlers[event] ?? []).forEach((cb) => cb(...args));
    }
    send(data: any) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.emit("close", 1000);
    }
    terminate() {
      this.readyState = 3;
      this.emit("close", 1006);
    }
  }
  return { default: MockWebSocket };
});

let transcribePcm!: typeof import("../app/utils/iflytek-asr").transcribePcm;
let ASR_FLUSH_TIMEOUT_MS!: number;
let MockWebSocket: any;

beforeAll(async () => {
  const asr = await import("../app/utils/iflytek-asr");
  transcribePcm = asr.transcribePcm;
  ASR_FLUSH_TIMEOUT_MS = asr.ASR_FLUSH_TIMEOUT_MS;
  MockWebSocket = (await import("ws")).default;
});

const config = {
  appId: "test-app",
  apiKey: "test-key",
  apiSecret: "test-secret",
};
function message(ws: any, payload: unknown) {
  ws.emit("message", { toString: () => JSON.stringify(payload) });
}
function begin(sessionId: string | null = "srv-session", bytes = 1280) {
  const pcm = Uint8Array.from({ length: bytes }, (_, i) => i % 256);
  const promise = transcribePcm(config, pcm);
  const ws = MockWebSocket.instances[0];
  ws.readyState = MockWebSocket.OPEN;
  ws.emit("open");
  message(ws, { msg_type: "action", data: { action: "started", sessionId } });
  return { promise, ws, pcm };
}
function result(ws: any, text: string, segId = 0, type = "0", ls = false) {
  message(ws, {
    msg_type: "result",
    res_type: "asr",
    data: {
      seg_id: segId,
      ls,
      cn: { st: { type, rt: [{ ws: [{ cw: [{ w: text }] }] }] } },
    },
  });
}
function endMarker(ws: any) {
  return JSON.parse(ws.sent.find((data: any) => typeof data === "string"));
}

describe("transcribePcm protocol", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("waits for started, then sends every PCM byte in paced binary frames", async () => {
    const pcm = new Uint8Array(1280 * 3 + 2).fill(17);
    const promise = transcribePcm(config, pcm);
    const ws = MockWebSocket.instances[0];
    ws.readyState = MockWebSocket.OPEN;
    ws.emit("open");
    await jest.advanceTimersByTimeAsync(1500);
    expect(ws.sent).toHaveLength(0);
    message(ws, {
      msg_type: "action",
      data: { action: "started", sessionId: "actual-id" },
    });
    expect(ws.sent).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(160);
    expect(
      ws.sent
        .filter((x: any) => typeof x !== "string")
        .map((x: any) => x.length),
    ).toEqual([1280, 1280, 1280, 2]);
    expect(endMarker(ws)).toEqual({ end: true, sessionId: "actual-id" });
    result(ws, "你好", 0, "0", true);
    await expect(promise).resolves.toMatchObject({
      text: "你好",
      wsStat: { sentBytes: pcm.length },
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("does not invent a session ID when the server provides none", async () => {
    const { promise, ws } = begin(null);
    await jest.advanceTimersByTimeAsync(40);
    expect(endMarker(ws)).toEqual({ end: true });
    result(ws, "测试", 0, "0", true);
    await expect(promise).resolves.toMatchObject({ text: "测试" });
  });

  test("handles the documented action/data/sid envelope and JSON-encoded data", async () => {
    const promise = transcribePcm(config, new Uint8Array(1280));
    const ws = MockWebSocket.instances[0];
    ws.readyState = MockWebSocket.OPEN;
    message(ws, { action: "started", sid: "legacy-session" });
    await jest.advanceTimersByTimeAsync(40);
    expect(endMarker(ws).sessionId).toBe("legacy-session");
    message(ws, {
      action: "result",
      data: JSON.stringify({
        seg_id: 0,
        ls: true,
        cn: { st: { type: 0, rt: [{ ws: [{ cw: [{ w: "你好" }] }] }] } },
      }),
    });
    await expect(promise).resolves.toMatchObject({ text: "你好" });
  });

  test("surfaces the official frc functional error instead of returning empty text", async () => {
    const { promise, ws } = begin();
    const assertion = expect(promise).rejects.toMatchObject({
      code: "ASR_ENGINE_ERROR",
      message: expect.stringContaining("功能异常"),
    });
    message(ws, {
      msg_type: "result",
      res_type: "frc",
      data: {
        desc: "功能异常",
        detail: { domain: "ist_ed_test" },
        fnType: "ast",
        normal: false,
      },
    });
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(["nested", "top-level"])(
    "surfaces %s authentication errors",
    async (envelope) => {
      const { promise, ws } = begin();
      const assertion = expect(promise).rejects.toMatchObject({
        code: "35002",
        message: expect.stringContaining("转写用量不足"),
      });
      message(
        ws,
        envelope === "nested"
          ? { msg_type: "action", data: { action: "error", code: 35002 } }
          : { action: "error", code: "35002" },
      );
      await assertion;
    },
  );

  test("a close without any ASR response is a transport error, not silence", async () => {
    const { promise, ws } = begin();
    const assertion = expect(promise).rejects.toMatchObject({
      code: "ASR_CONNECTION_CLOSED",
    });
    await jest.advanceTimersByTimeAsync(40);
    ws.close();
    await assertion;
  });

  test("does not return a truncated prefix on abnormal close", async () => {
    const { promise, ws } = begin();
    const assertion = expect(promise).rejects.toMatchObject({
      code: "ASR_CONNECTION_CLOSED",
    });
    await jest.advanceTimersByTimeAsync(40);
    result(ws, "句子开头");
    ws.emit("close", 1006);
    await assertion;
  });

  test("returns all final segments in order, replacing partial hypotheses", async () => {
    const { promise, ws } = begin();
    await jest.advanceTimersByTimeAsync(40);
    result(ws, "世", 1, "1");
    result(ws, "世界", 1);
    result(ws, "你好", 0, "0", true);
    await expect(promise).resolves.toMatchObject({ text: "你好世界" });
  });

  test("an explicit empty final response is a valid no-speech result", async () => {
    const { promise, ws } = begin();
    await jest.advanceTimersByTimeAsync(40);
    message(ws, { msg_type: "result", res_type: "asr", data: { ls: true } });
    await expect(promise).resolves.toMatchObject({ text: "" });
  });

  test("supports normal server close after final segments without ls", async () => {
    const { promise, ws } = begin();
    await jest.advanceTimersByTimeAsync(40);
    result(ws, "完整句子");
    ws.close();
    await expect(promise).resolves.toMatchObject({ text: "完整句子" });
  });

  test("does not treat an unfinished hypothesis as complete on close", async () => {
    const { promise, ws } = begin();
    const assertion = expect(promise).rejects.toMatchObject({
      code: "ASR_CONNECTION_CLOSED",
    });
    await jest.advanceTimersByTimeAsync(40);
    result(ws, "尚未确认", 0, "1");
    ws.close();
    await assertion;
  });

  test("rejects when session startup never arrives and releases all timers", async () => {
    const promise = transcribePcm(config, new Uint8Array(1280));
    const assertion = expect(promise).rejects.toMatchObject({
      code: "ASR_START_TIMEOUT",
    });
    await jest.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });

  test("result inactivity is an error even if a prefix was recognized", async () => {
    const { promise, ws } = begin();
    const assertion = expect(promise).rejects.toMatchObject({
      code: "ASR_RESULT_TIMEOUT",
    });
    await jest.advanceTimersByTimeAsync(40);
    result(ws, "句子开头");
    await jest.advanceTimersByTimeAsync(ASR_FLUSH_TIMEOUT_MS);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });

  test("late results extend the idle deadline rather than being cut off", async () => {
    const { promise, ws } = begin();
    await jest.advanceTimersByTimeAsync(9000);
    result(ws, "开头");
    await jest.advanceTimersByTimeAsync(9000);
    result(ws, "结尾", 1, "0", true);
    await expect(promise).resolves.toMatchObject({ text: "开头结尾" });
  });

  test("hard deadline never reports incomplete text as success", async () => {
    const promise = transcribePcm(config, new Uint8Array(1280), 1000);
    const assertion = expect(promise).rejects.toMatchObject({
      code: "ASR_TIMEOUT",
    });
    const ws = MockWebSocket.instances[0];
    ws.readyState = MockWebSocket.OPEN;
    message(ws, { msg_type: "action", data: { action: "started" } });
    result(ws, "部分");
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });
});
