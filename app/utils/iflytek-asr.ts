import crypto from "crypto";
import WebSocket from "ws";

// https://www.xfyun.cn/doc/spark/asr_llm/rtasr_llm.html
export const ASR_WS_URL =
  "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1";
// send 1280 bytes per 40ms (16k/16bit/mono)
export const ASR_CHUNK_BYTES = 1280;
export const ASR_CHUNK_INTERVAL_MS = 40;
export const ASR_SAMPLE_RATE = 16000;
// after the end marker the server normally answers with the tail results and
// closes the socket; if it stays open we stop waiting after this grace period
export const ASR_FLUSH_TIMEOUT_MS = 4000;

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

/**
 * Transcribe raw pcm (16k/16bit/mono) via the iflytek real-time ASR
 * websocket. Returns the concatenated final segments.
 */
export async function transcribePcm(
  config: IflytekAsrConfig,
  pcm: Uint8Array,
  timeoutMs: number = 50 * 1000,
): Promise<{ text: string; wsStat: Record<string, any> }> {
  const url = buildAsrWsUrl(config);

  return new Promise<{ text: string; wsStat: Record<string, any> }>(
    (resolve, reject) => {
      const ws = new WebSocket(url, { origin: "https://chat.it0731.cn" });

      let sentEnd = false;
      let pcmOffset = 0;
      // aggregate only final segments (type=0), keyed by seg_id
      const finalSegments = new Map<number, string>();
      // the end marker carries a sessionId; the handshake may not provide one, so
      // keep a client generated uuid as a fallback (community implementations
      // send a self generated session id)
      let sessionId = crypto.randomUUID();
      let finished = false;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      // what the server actually told us, for diagnosing silent empty results
      let resultCount = 0;
      const typeCounts: Record<string, number> = {};
      let acceptedChars = 0;
      let lsFlags = 0;
      let lastRawSample = "";
      // handshake tracing: whether the server ever confirmed the session
      let gotStarted = false;
      let sawError = false;
      let actionCount = 0;
      let nonAsrMsgCount = 0;

      const failTimer = setTimeout(() => {
        if (finished) return;
        // hard timeout: never drop text that was already recognized, only report
        // an error when nothing usable arrived
        if (finalSegments.size > 0) {
          finish();
          return;
        }
        finished = true;
        clearInterval(sendTimer);
        try {
          ws.close();
        } catch {
          /* noop */
        }
        reject(new Error("ASR timeout"));
      }, timeoutMs);

      const finish = (err?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(failTimer);
        if (flushTimer) clearTimeout(flushTimer);
        clearInterval(sendTimer);
        try {
          ws.close();
        } catch {
          /* noop */
        }
        const wsStat = {
          resultCount,
          types: typeCounts,
          final: finalSegments.size,
          chars: acceptedChars,
          ls: lsFlags,
          last: lastRawSample.slice(0, 300),
          started: gotStarted,
          error: sawError,
          actions: actionCount,
          other: nonAsrMsgCount,
        };
        console.log("[Iflytek ASR] ws " + JSON.stringify(wsStat));
        if (err) reject(err);
        else
          resolve({
            text: [...finalSegments.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, v]) => v)
              .join(""),
            wsStat,
          });
      };

      const sendTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (sentEnd) return;
        if (pcmOffset >= pcm.length) {
          ws.send(JSON.stringify({ end: true, sessionId }));
          sentEnd = true;
          // the server may keep the socket open after the end marker: give it a
          // short grace period and then return what we already have
          flushTimer = setTimeout(() => {
            if (finalSegments.size > 0) finish();
          }, ASR_FLUSH_TIMEOUT_MS);
          return;
        }
        const end = Math.min(pcmOffset + ASR_CHUNK_BYTES, pcm.length);
        ws.send(pcm.subarray(pcmOffset, end));
        pcmOffset = end;
      }, ASR_CHUNK_INTERVAL_MS);

      ws.on("open", () => {
        /* sending handled by timer */
      });

      ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (msg.msg_type === "action") {
          actionCount++;
          const d = msg.data || {};
          if (d.action === "started") {
            gotStarted = true;
            // prefer the server provided session id, fall back to the client one
            sessionId = d.sessionId || sessionId;
          } else if (d.action === "error") {
            sawError = true;
            clearInterval(sendTimer);
            const code = String(d.code ?? "");
            finish(
              new Error(
                iflytekAsrErrorMessage(code) ||
                  `讯飞返回错误: ${d.code} ${d.desc}`,
              ),
            );
          }
          return;
        }

        if (msg.msg_type === "result") {
          if (msg.res_type === "asr") {
            const d = msg.data || {};
            const segId = d.seg_id ?? 0;
            const type = String(d.cn?.st?.type ?? "0");
            const wsList = d.cn?.st?.rt || [];
            const segText = wsList
              .flatMap((rt: any) => rt.ws || [])
              .flatMap((ws: any) => ws.cw || [])
              .map((cw: any) => cw.w ?? "")
              .join("");

            resultCount++;
            typeCounts[type] = (typeCounts[type] || 0) + 1;
            acceptedChars += segText.length;
            if (d.ls === true) lsFlags++;
            if (resultCount <= 2)
              lastRawSample = JSON.stringify(msg).slice(0, 300);

            // only final (type=0) results are stable
            if (type === "0" && segText) {
              finalSegments.set(segId, segText);
            }

            if (d.ls === true) {
              clearInterval(sendTimer);
              finish();
            }
          } else {
            // result of a different type (frc, etc.)
            nonAsrMsgCount++;
          }
          return;
        }

        // any other message shape
        nonAsrMsgCount++;
      });

      ws.on("error", (err) => {
        clearInterval(sendTimer);
        finish(new Error(`连接讯飞失败: ${err.message}`));
      });

      ws.on("close", () => {
        clearInterval(sendTimer);
        if (!finished) {
          // server closed after sending all results
          finish();
        }
      });
    },
  );
}
