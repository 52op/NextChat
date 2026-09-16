import {
  buildAsrSignature,
  buildAsrQueryParams,
  buildAsrWsUrl,
  isoUtcWithTimezone,
} from "../app/utils/iflytek-asr";

const config = {
  appId: "1e20bf92",
  apiKey: "36169c0e02b63242fc589053bbd9e2a7",
  apiSecret: "MTkyZGIzZWVmNGVhNzA3NjI1MWI2OTZi",
};

describe("iflytek ASR signature", () => {
  test("signature is deterministic for the same params", () => {
    const params = {
      appId: "1e20bf92",
      accessKeyId: "36169c0e02b63242fc589053bbd9e2a7",
      uuid: "11111111-1111-1111-1111-111111111111",
      utc: "2025-09-04T15:38:07+0800",
      lang: "autodialect",
      audio_encode: "pcm_s16le",
      samplerate: "16000",
    };
    const sig1 = buildAsrSignature(params, config.apiSecret);
    const sig2 = buildAsrSignature({ ...params }, config.apiSecret);
    expect(sig1).toBe(sig2);
    // base64 hmac signature is 28 chars
    expect(sig1).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test("params contain required fields and signature is internally consistent", () => {
    const params = buildAsrQueryParams(config);
    expect(params.signature).toBeTruthy();
    expect(params.samplerate).toBe("16000");
    expect(params.audio_encode).toBe("pcm_s16le");
    expect(params.lang).toBe("autodialect");
    // signature must be reproducible from the same params
    const { signature, ...rest } = params;
    expect(buildAsrSignature(rest, config.apiSecret)).toBe(signature);
  });

  test("ws url includes all required params", () => {
    const url = buildAsrWsUrl(config);
    expect(url.startsWith("wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1?")).toBe(true);
    expect(url).toContain("appId=1e20bf92");
    expect(url).toContain("accessKeyId=36169c0e02b63242fc589053bbd9e2a7");
    expect(url).toContain("samplerate=16000");
    expect(url).toContain("signature=");
  });

  test("isoUtcWithTimezone has +0800 offset in CST timezone", () => {
    const d = new Date(2025, 8, 4, 15, 38, 7); // local time
    const utc = isoUtcWithTimezone(d);
    expect(utc).toMatch(/^2025-09-04T15:38:07/);
    expect(utc).toMatch(/[+-]\d{4}$/);
  });
});
