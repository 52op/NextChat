import {
  isPcmSilent,
  normalizeGain,
  pcmDiagnostics,
  resampleTo16kPcm,
  voiceActivity,
} from "../app/utils/pcm-resample";

function pcmFromInt16(values: number[]): Uint8Array {
  const buf = new Int16Array(values);
  return new Uint8Array(buf.buffer);
}

describe("isPcmSilent", () => {
  test("empty buffer is silent", () => {
    expect(isPcmSilent(new Uint8Array(0))).toBe(true);
  });

  test("all zero samples is silent", () => {
    const pcm = pcmFromInt16(new Array(1000).fill(0));
    expect(isPcmSilent(pcm)).toBe(true);
  });

  test("small noise below threshold is silent", () => {
    const pcm = pcmFromInt16(new Array(1000).fill(50));
    expect(isPcmSilent(pcm)).toBe(true);
  });

  test("voice-like amplitude is not silent", () => {
    const values = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0 ? 12000 : -12000,
    );
    expect(isPcmSilent(pcmFromInt16(values))).toBe(false);
  });
});

describe("resampleTo16kPcm", () => {
  test("resamples 48000 to 16000 samples", () => {
    const samples = new Float32Array(48000).fill(0.5);
    const pcm = resampleTo16kPcm(samples, 48000);
    expect(pcm.length / 2).toBe(16000);
  });

  test("output is not silent for a sine input", () => {
    const samples = new Float32Array(48000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const pcm = resampleTo16kPcm(samples, 48000);
    expect(isPcmSilent(pcm)).toBe(false);
  });
});

describe("pcmDiagnostics", () => {
  test("reports peak/rms/duration", () => {
    const values = Array.from({ length: 16000 }, (_, i) =>
      i % 2 === 0 ? -8000 : 8000,
    );
    const d = pcmDiagnostics(pcmFromInt16(values));
    expect(d.frameCount).toBe(16000);
    expect(d.durationSec).toBeCloseTo(1);
    expect(d.peak).toBe(8000);
    expect(d.rms).toBeCloseTo(8000);
    expect(d.loudFrames).toBe(16000);
  });
});

describe("normalizeGain", () => {
  test("lifts a quiet buffer to the target peak, never attenuates", () => {
    const values = Array.from({ length: 1600 }, (_, i) =>
      i % 2 === 0 ? -200 : 200,
    );
    const pcm = pcmFromInt16(values);
    const out = normalizeGain(pcm, 30000);
    const peak = pcmDiagnostics(out).peak;
    expect(peak).toBeGreaterThan(200);
    expect(peak).toBeLessThanOrEqual(30000);
    // monotonic: normalized keeps sign for every sample
    const inV = new Int16Array(pcm.buffer);
    const outV = new Int16Array(out.buffer);
    for (let i = 0; i < inV.length; i++) {
      expect(Math.sign(outV[i])).toBe(Math.sign(inV[i]));
    }
  });

  test("already-loud buffer is left untouched", () => {
    const values = Array.from({ length: 1600 }, (_, i) =>
      i % 2 === 0 ? -29500 : 29500,
    );
    const pcm = pcmFromInt16(values);
    expect(normalizeGain(pcm, 30000)).toBe(pcm);
  });

  test("clamps at 20x max gain", () => {
    const values = Array.from({ length: 1600 }, (_, i) =>
      i % 2 === 0 ? -1 : 1,
    );
    const out = normalizeGain(pcmFromInt16(values), 30000);
    const peak = pcmDiagnostics(out).peak;
    expect(peak).toBe(20); // 1 * 20
  });

  test("all-zero stays all-zero", () => {
    const pcm = pcmFromInt16(new Array(1600).fill(0));
    expect(normalizeGain(pcm, 30000)).toBe(pcm);
  });
});

describe("voiceActivity", () => {
  test("finds a speech island in the middle of padding", () => {
    // 2s of silence, 1s of loud voice, 2s of silence at 16k
    const buf = new Int16Array(16000 * 5);
    const start = 16000 * 2;
    for (let i = 0; i < 16000; i++) {
      buf[start + i] = i % 2 === 0 ? 12000 : -12000;
    }
    const act = voiceActivity(new Uint8Array(buf.buffer));
    expect(act.activeFrames).toBe(16000);
    expect(act.percent).toBe(20);
    expect(act.firstSec).toBeCloseTo(2);
    expect(act.lastSec).toBeCloseTo(3);
  });

  test("all-silent reports no activity", () => {
    const act = voiceActivity(pcmFromInt16(new Array(16000).fill(10)));
    expect(act.percent).toBe(0);
    expect(act.firstSec).toBe(0);
  });
});