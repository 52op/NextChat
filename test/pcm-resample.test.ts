import {
  resampleTo16kPcm,
} from "../app/utils/pcm-resample";

describe("pcm resample to 16k mono 16bit", () => {
  test("48khz 1s sine converts to 16000 samples", () => {
    const srcRate = 48000;
    const total = 48000;
    const all = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      all[i] = Math.sin((2 * Math.PI * 440 * i) / srcRate) * 0.5;
    }
    const pcm = resampleTo16kPcm(all, srcRate);
    expect(pcm.length / 2).toBe(16000); // bytes / 2 = samples
    expect(pcm.length).toBe(32000);
  });

  test("empty input returns empty", () => {
    const pcm = resampleTo16kPcm(new Float32Array(0), 48000);
    expect(pcm.length).toBe(0);
  });

  test("16k in equals 16k out", () => {
    const srcRate = 16000;
    const all = new Float32Array(16000).fill(0.25);
    const pcm = resampleTo16kPcm(all, srcRate);
    expect(pcm.length).toBe(32000);
  });

  test("resampled amplitude is clamped to int16 range", () => {
    const srcRate = 48000;
    const all = new Float32Array(48000).fill(2); // out of range
    const pcm = resampleTo16kPcm(all, srcRate);
    const view = new Int16Array(pcm.buffer);
    expect(Math.max(...view)).toBe(32767);
  });
});