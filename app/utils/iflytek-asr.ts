import crypto from "crypto";
import WebSocket from "ws";

// https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html
export const ASR_WS_URL =
  "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1";
// send 1280 bytes per 40ms (16k/16bit/mono)
export const ASR_CHUNK_BYTES = 1280;
export const ASR_CHUNK_INTERVAL_MS = 40;
export const ASR_SAMPLE_RATE = 16000;
// Maximum inactivity while waiting for the final result after uploading audio.
export const ASR_FLUSH_TIMEOUT_MS = 10_000;

export interface IflytekAsrConfig {
  appId: string;
  apiKey: string;
  apiSecret: string;
}

const urlEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

/**
 * iflytek signature: sort params (excluding signature) by key ascending,
 * url-encode key and value, join with &, then base64(HmacSHA1(baseString, apiSecret)).
 */
export function buildAsrSignature(
  params: Record<string, string>,
  apiSecret: string,
): string {
  const keys = Object.keys(params).sort();
  const baseString = keys
    .map((k) => urlEncode(k) + "=" + urlEncode(params[k]))
    .join("&");
  return crypto
    .createHmac("sha1", apiSecret)
    .update(baseString)
    .digest("base64");
}

export function buildAsrQueryParams(
  config: IflytekAsrConfig,
  extra?: Record<string, string>,
): Record<string, string> {
  const params: Record<string, string> = {
    appId: config.appId,
    accessKeyId: config.apiKey,
    uuid: crypto.randomUUID(),
    utc: isoUtcWithTimezone(),
    lang: "autodialect",
    audio_encode: "pcm_s16le",
    samplerate: String(ASR_SAMPLE_RATE),
    ...extra,
  };
  params.signature = buildAsrSignature(params, config.apiSecret);
  return params;
}

export function buildAsrWsUrl(
  config: IflytekAsrConfig,
  extra?: Record<string, string>,
): string {
  const params = buildAsrQueryParams(config, extra);
  const query = Object.entries(params)
    .map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`)
    .join("&");
  return `${ASR_WS_URL}?${query}`;
}

export function isoUtcWithTimezone(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const tzOffset = -date.getTimezoneOffset();
  const tzSign = tzOffset >= 0 ? "+" : "-";
  const tzAbs = Math.abs(tzOffset);
  const tz = `${tzSign}${pad(Math.floor(tzAbs / 60))}${pad(tzAbs % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}${tz}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  "35001": "账号鉴权失败",
  "35002": "转写用量不足",
  "35004": "appId 不存在",
  "35005": "appId 已禁用",
  "35006": "并发路数已满",
  "35010": "accessKeyId 不存在",
  "35014": "时间戳偏差过大",
  "35017": "accessKeyId 不匹配",
  "35020": "语种不支持",
  "35030": "签名已过期或重复",
  "35031": "账号已过期",
  "37002": "引擎没有空余路数",
  "37005": "长时间未传音频",
  "37007": "单次音频时长已达上限",
  "100001": "上传音频速度超出限制",
  "100002": "签名错误",
  "100019": "当前账号未开通当前语种转写能力",
};

export function iflytekAsrErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] || "";
}

export interface AsrWsStats {
  started: boolean;
  sentBytes: number;
  sentEnd: boolean;
  resultCount: number;
  final: number;
  other: number;
  closeCode?: number;
  failure?: string;
}

export class IflytekAsrError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly wsStat: AsrWsStats,
  ) {
    super(message);
    this.name = "IflytekAsrError";
  }
}

/** Send 16k mono s16le audio only after the service has accepted the session. */
export async function transcribePcm(
  config: IflytekAsrConfig,
  pcm: Uint8Array,
  timeoutMs = 55_000,
): Promise<{ text: string; wsStat: AsrWsStats }> {
  if (!pcm.length || pcm.length % 2 !== 0) {
    throw new Error("音频必须为非空的 16bit PCM");
  }
  const url = buildAsrWsUrl(config);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 8_000 });
    const stats: AsrWsStats = {
      started: false,
      sentBytes: 0,
      sentEnd: false,
      resultCount: 0,
      final: 0,
      other: 0,
    };
    const segments = new Map<number, string>();
    const pendingSegments = new Set<number>();
    let sessionId: string | undefined;
    let finished = false;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let resultTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (message?: string, code = "ASR_PROTOCOL_ERROR") => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(startTimer);
      clearTimeout(sendTimer);
      clearTimeout(resultTimer);
      stats.final = segments.size;
      if (message) stats.failure = code;
      // Log transport metadata only, never audio, signed URLs or transcripts.
      console.log("[Iflytek ASR] ws " + JSON.stringify(stats));
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.close();
      if (message) reject(new IflytekAsrError(message, code, { ...stats }));
      else
        resolve({
          text: [...segments.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, text]) => text)
            .join(""),
          wsStat: { ...stats },
        });
    };

    // A timeout is not successful completion: returning a prefix would silently
    // discard the end of the user's sentence.
    const deadline = setTimeout(
      () => finish("语音转写超时，请重试或缩短录音", "ASR_TIMEOUT"),
      timeoutMs,
    );
    const startTimer = setTimeout(
      () => finish("讯飞未确认转写会话，请稍后重试", "ASR_START_TIMEOUT"),
      8_000,
    );
    const waitForResults = () => {
      clearTimeout(resultTimer);
      resultTimer = setTimeout(
        () => finish("讯飞未返回完整转写结果，请重试", "ASR_RESULT_TIMEOUT"),
        ASR_FLUSH_TIMEOUT_MS,
      );
    };

    const sendNext = () => {
      if (finished || stats.sentEnd || ws.readyState !== WebSocket.OPEN) return;
      try {
        if (stats.sentBytes === pcm.length) {
          stats.sentEnd = true;
          // Follow the official demo: use the server ID if present, otherwise
          // omit it. A new random UUID does not identify this server session.
          ws.send(
            JSON.stringify({ end: true, ...(sessionId ? { sessionId } : {}) }),
          );
          waitForResults();
          return;
        }
        const end = Math.min(stats.sentBytes + ASR_CHUNK_BYTES, pcm.length);
        ws.send(pcm.subarray(stats.sentBytes, end), { binary: true });
        stats.sentBytes = end;
        sendTimer = setTimeout(sendNext, ASR_CHUNK_INTERVAL_MS);
      } catch {
        finish("向讯飞发送音频失败，请重试", "ASR_SEND_ERROR");
      }
    };

    ws.on("message", (raw) => {
      if (finished) return;
      try {
        const msg = JSON.parse(raw.toString());
        // The reference describes both an action/data/sid envelope and the
        // newer msg_type/data envelope. data can itself be a JSON string.
        const data =
          typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data ?? {};
        const action = msg.action ?? data.action;
        if (
          action === "error" ||
          (msg.res_type === "frc" && data.normal === false)
        ) {
          const code = String(data.code ?? msg.code ?? "ASR_ENGINE_ERROR");
          const desc =
            iflytekAsrErrorMessage(code) ||
            data.desc ||
            msg.desc ||
            "转写引擎异常";
          finish(`讯飞转写失败（${code}）：${desc}`, code);
          return;
        }
        if (action === "started") {
          if (stats.started) return;
          sessionId = data.sessionId || msg.sid || data.sid || undefined;
          stats.started = true;
          clearTimeout(startTimer);
          sendNext();
          return;
        }
        const isAsr =
          (msg.msg_type === "result" && msg.res_type === "asr") ||
          action === "result";
        if (!isAsr) {
          stats.other++;
          return;
        }
        stats.resultCount++;
        const segment = data.cn?.st;
        if (segment) {
          const segId = Number(data.seg_id ?? 0);
          const text = (segment.rt ?? [])
            .flatMap((rt: any) => rt.ws ?? [])
            .map((word: any) => word.cw?.[0]?.w ?? "")
            .join("");
          if (String(segment.type) === "0") {
            segments.set(segId, text);
            pendingSegments.delete(segId);
          } else {
            pendingSegments.add(segId);
          }
        }
        if (data.ls === true) {
          if (!stats.sentEnd || pendingSegments.size) {
            finish(
              "讯飞提前结束转写，未收到完整结果，请重试",
              "ASR_INCOMPLETE",
            );
          } else {
            finish();
          }
        } else if (stats.sentEnd) {
          waitForResults();
        }
      } catch {
        finish("讯飞返回了无法解析的转写消息", "ASR_INVALID_RESPONSE");
      }
    });

    ws.on("error", () => {
      // ws handshake errors may contain the signed request URL.
      finish("连接讯飞失败，请检查服务配置或稍后重试", "ASR_CONNECTION_ERROR");
    });
    ws.on("close", (code) => {
      stats.closeCode = code;
      if (finished) return;
      if (
        code === 1000 &&
        stats.started &&
        stats.sentEnd &&
        stats.resultCount > 0 &&
        pendingSegments.size === 0
      ) {
        finish();
      } else {
        finish(
          `讯飞连接提前关闭（${code}），未收到完整转写结果`,
          "ASR_CONNECTION_CLOSED",
        );
      }
    });
  });
}
