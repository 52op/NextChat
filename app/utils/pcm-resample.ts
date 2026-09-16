/**
 * Resample mono float32 audio to 16kHz mono 16bit PCM.
 * Used by the voice input (iflytek real-time ASR).
 */
export const PCM_TARGET_RATE = 16000;

export function resampleTo16kPcm(
  samples: Float32Array,
  srcRate: number,
): Uint8Array {
  if (samples.length === 0) return new Uint8Array(0);

  const outLen = Math.ceil((samples.length * PCM_TARGET_RATE) / srcRate);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const j = (i * srcRate) / PCM_TARGET_RATE;
    const i0 = Math.floor(j);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = j - i0;
    const s = Math.max(
      -1,
      Math.min(1, samples[i0] * (1 - frac) + samples[i1] * frac),
    );
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}
