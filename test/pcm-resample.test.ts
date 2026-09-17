import {
  isPcmSilent,
  normalizeGain,
  pcmDiagnostics,
  pcmEnvelope,
  pcmToWav16k,
  resampleTo16kPcm,
  voiceActivity,
} from "../app/utils/pcm-resample";

function pcmFromInt16(values: number[]): Uint8Array {
  const buf = new Int16Array(values);
  return new Uint8Array(buf.buffer);
}

describe("isPcmSilent", () => {
  test("does not skip periodic speech whose sampled peaks fall between strides", () => {
    const samples = new Int16Array(16000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(
        12000 * Math.sin((2 * Math.PI * 160 * i) / 16000),
      );
    }
    expect(isPcmSilent(new Uint8Array(samples.buffer))).toBe(false);
  });

  test("ignores audio outside the supplied subarray", () => {
    const backing = pcmFromInt16([20000, 0, 0, 20000]);
    const pcm = backing.subarray(2, 6);
    expect(isPcmSilent(pcm)).toBe(true);
    expect(pcmDiagnostics(pcm).frameCount).toBe(2);
    expect(pcmDiagnostics(pcm).peak).toBe(0);
    expect(voiceActivity(pcm).activeFrames).toBe(0);
    expect(pcmEnvelope(pcm, 2)).toEqual([0, 0]);
  });

  test("normalizes only audio in an unaligned buffer view", () => {
    const backing = new Uint8Array(9).fill(255);
    const pcm = backing.subarray(3, 7);
    new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).setInt16(
      0,
      100,
      true,
    );
    new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).setInt16(
      2,
      -100,
      true,
    );
    const normalized = normalizeGain(pcm);
    expect(normalized.length).toBe(4);
    expect(pcmDiagnostics(normalized).peak).toBe(2000);
    expect(backing[0]).toBe(255);
  });
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
    // alternates every sample: 16000 zero crossings in 1s
    expect(d.zeroCrossRate).toBe(16000);
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

describe("pcmToWav16k", () => {
  test("builds a valid wav header and copies pcm", () => {
    const ascii = (u: Uint8Array, off: number, len: number) =>
      String.fromCharCode(...u.subarray(off, off + len));
    const pcm = pcmFromInt16([0, 1000, -1000, 32767, -32768]);
    const wav = pcmToWav16k(pcm);
    const dv = new DataView(wav.buffer);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(dv.getUint32(4, true)).toBe(36 + pcm.length);
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(24, true)).toBe(16000);
    expect(dv.getUint16(34, true)).toBe(16); // bits
    expect(wav.length).toBe(44 + pcm.length);
    // pcm payload preserved
    for (let i = 0; i < pcm.length; i++) {
      expect(wav[44 + i]).toBe(pcm[i]);
    }
  });
});

describe("pcmEnvelope", () => {
  test("loud window reports high rms, quiet window low", () => {
    const buf = new Int16Array(16000 * 2); // 2s
    for (let i = 0; i < 8000; i++) buf[i] = 20000; // first 0.5s loud
    const env = pcmEnvelope(new Uint8Array(buf.buffer), 40);
    expect(env[0]).toBeGreaterThan(10000);
    expect(env[30]).toBeLessThan(100); // silence long after the loud pass
    expect(env.length).toBe(40);
  });

  test("flat tone -> all bins similar", () => {
    const buf = new Int16Array(16000).fill(8000);
    const env = pcmEnvelope(new Uint8Array(buf.buffer), 4);
    for (const v of env) expect(v).toBeCloseTo(8000, 0);
  });
});
