import {
  isPcmSilent,
  resampleTo16kPcm,
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