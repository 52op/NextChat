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

/**
 * Rough silence detection for a s16le PCM buffer.
 * Returns true when the peak amplitude is below the threshold, i.e. the
 * recording is probably silent (no voice picked up).
 */
export function isPcmSilent(pcm: Uint8Array, threshold = 300): boolean {
  if (pcm.length === 0) return true;
  const view = new Int16Array(pcm.buffer);
  let peak = 0;
  for (let i = 0; i < view.length; i += 100) {
    const v = Math.abs(view[i]);
    if (v > peak) peak = v;
  }
  return peak < threshold;
}

export interface PcmDiagnostics {
  /** samples (s16 at 16k) */
  frameCount: number;
  /** seconds of audio */
  durationSec: number;
  /** peak |sample| before normalization */
  peak: number;
  /** root mean square before normalization */
  rms: number;
  /** frames with |sample| > 500 (a plosive/carrier level) */
  loudFrames: number;
}

/**
 * Rough level stats for a s16 PCM buffer. Diagnostic aid: tells us whether a
 * real-phone recording is actually carrying decent audio level, or whether the
 * mic pipeline produced a whisper-quiet buffer that passes the silence check
 * but is too weak for the ASR server.
 */
export function pcmDiagnostics(pcm: Uint8Array): PcmDiagnostics {
  const view = new Int16Array(pcm.buffer);
  let peak = 0;
  let sumSq = 0;
  let loudFrames = 0;
  for (let i = 0; i < view.length; i++) {
    const v = Math.abs(view[i]);
    if (v > peak) peak = v;
    sumSq += v * v;
    if (v > 500) loudFrames++;
  }
  const n = view.length;
  return {
    frameCount: n,
    durationSec: n / 16000,
    peak,
    rms: n === 0 ? 0 : Math.sqrt(sumSq / n),
    loudFrames,
  };
}

export interface VoiceActivity {
  activeFrames: number;
  percent: number;
  firstSec: number;
  lastSec: number;
}

/**
 * Where the speech actually sits in the buffer. A MediaRecorder blob decoded
 * to a 5s buffer can contain only ~1s of real voice padded out with near-zero
 * samples; knowing how much of the window is active and where it starts/ends
 * tells us whether the recording is a sparse speech island (streaming ASR
 * hates that) or continuous audio.
 */
export function voiceActivity(
  pcm: Uint8Array,
  peakThreshold = 500,
): VoiceActivity {
  const view = new Int16Array(pcm.buffer);
  const n = view.length;
  let activeFrames = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(view[i]) > peakThreshold) {
      if (first < 0) first = i;
      last = i;
      activeFrames++;
    }
  }
  return {
    activeFrames,
    percent: n === 0 ? 0 : Math.round((activeFrames / n) * 100),
    firstSec: first < 0 ? 0 : first / 16000,
    lastSec: last < 0 ? 0 : last / 16000,
  };
}

/**
 * Normalize a s16 PCM buffer so its peak hits a healthy target for the ASR
 * server. Multiplied with a hard cap (never amplifies more than 20x, and never
 * attenuates) so dark "system gain" recordings get brought up without letting
 * noise explode. Driver for the peak target of 0 dBFS-ish audio.
 */
export function normalizeGain(pcm: Uint8Array, targetPeak = 30000): Uint8Array {
  const view = new Int16Array(pcm.buffer);
  if (view.length === 0 || view.byteLength !== pcm.byteLength) return pcm;
  let peak = 0;
  for (let i = 0; i < view.length; i++) {
    const a = Math.abs(view[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0) return pcm;
  const gain = Math.min(targetPeak / peak, 20);
  if (gain <= 1.02) return pcm;
  const out = new Int16Array(view.length);
  for (let i = 0; i < view.length; i++) {
    const v = Math.round(view[i] * gain);
    out[i] = Math.max(-0x8000, Math.min(0x7fff, v));
  }
  return new Uint8Array(out.buffer);
}
