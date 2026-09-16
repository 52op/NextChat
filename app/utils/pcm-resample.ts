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
  /** zero crossings per second (speech ~ 750-3500, hum/beep far lower or higher) */
  zeroCrossRate: number;
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
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < view.length; i++) {
    const v = Math.abs(view[i]);
    if (v > peak) peak = v;
    sumSq += v * v;
    if (v > 500) loudFrames++;
    const s = view[i];
    if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
    prev = s;
  }
  const n = view.length;
  return {
    frameCount: n,
    durationSec: n / 16000,
    peak,
    rms: n === 0 ? 0 : Math.sqrt(sumSq / n),
    loudFrames,
    zeroCrossRate: n === 0 ? 0 : crossings / (n / 16000),
  };
}

export interface VoiceActivity {
  activeFrames: number;
  percent: number;
  firstSec: number;
  lastSec: number;
}

/**
 * Divide the buffer into `bins` equal windows and return each window's RMS.
 * A 40-bin RMS envelope of a real 3-4s sentence shows the word-by-word energy
 * pattern (bursts with quiet gaps); a uniform block of hum/tone or padding
 * shows flat. Cheap waveform-shape fingerprint for remote debugging.
 */
export function pcmEnvelope(pcm: Uint8Array, bins = 40): number[] {
  const view = new Int16Array(pcm.buffer);
  const n = view.length;
  if (n === 0) return new Array(bins).fill(0);
  const out: number[] = [];
  const perBin = n / bins;
  for (let b = 0; b < bins; b++) {
    const start = Math.floor(b * perBin);
    const end = Math.min(n, Math.floor((b + 1) * perBin));
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = view[i];
      sumSq += v * v;
    }
    out.push(end > start ? Math.round(Math.sqrt(sumSq / (end - start))) : 0);
  }
  return out;
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

/** Wrap 16k mono s16 PCM into a WAV file for local inspection/playback. */
export function pcmToWav16k(pcm: Uint8Array): Uint8Array {
  const hdr = new Uint8Array(44);
  const dv = new DataView(hdr.buffer);
  dv.setUint32(0, 0x52494646, false); // "RIFF"
  dv.setUint32(4, 36 + pcm.length, true);
  dv.setUint32(8, 0x57415645, false); // "WAVE"
  dv.setUint32(12, 0x666d7420, false); // "fmt "
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, 16000, true);
  dv.setUint32(28, 16000 * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits
  dv.setUint32(36, 0x64617461, false); // "data"
  dv.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(hdr, 0);
  out.set(pcm, 44);
  return out;
}
