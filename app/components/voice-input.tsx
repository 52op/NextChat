"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./voice-input.module.scss";
import VoiceIcon from "../icons/voice.svg";
import LoadingIcon from "../icons/loading.svg";
import { useAccessStore } from "../store/access";
import { getHeaders } from "../client/api";
import { ACCESS_CODE_PREFIX } from "../constant";
import { showToast } from "./ui-lib";
import Locale from "../locales";
import clsx from "clsx";
import { resampleTo16kPcm, isPcmSilent } from "../utils/pcm-resample";
import KeyboardIcon from "../icons/keyboard.svg";

// Web Speech API types are not in the default TS lib
declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

export type VoiceEngine = "iflytek" | "web-speech" | "none";

export function detectVoiceEngine(): VoiceEngine {
  // server managed iflytek ASR has priority
  if (useAccessStore.getState().enableIflytekAsr) return "iflytek";
  // fallback to the browser Web Speech API
  if (typeof window !== "undefined") {
    const sr = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (sr) return "web-speech";
  }
  return "none";
}

/**
 * Reactive voice engine: re-evaluates when the server config (enableIflytekAsr)
 * arrives or when the page reloads.
 */
export function useVoiceEngine(): VoiceEngine {
  const enableIflytekAsr = useAccessStore((s) => s.enableIflytekAsr);
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, []);
  return detectVoiceEngine();
}

// Record using MediaRecorder, decode locally, then upload 16k mono PCM.
// Keep a microphone stream only while voice mode is active.
let sharedStream: MediaStream | null = null;
let decoderContext: AudioContext | null = null;
let preparingStream: Promise<void> | null = null;
let streamGeneration = 0;

function getDecoderContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!decoderContext || decoderContext.state === "closed") {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    decoderContext = new Ctor();
  }
  return decoderContext;
}

function releaseSharedStream() {
  streamGeneration++;
  preparingStream = null;
  if (sharedStream) {
    sharedStream.getTracks().forEach((track) => track.stop());
    sharedStream = null;
  }
}

/**
 * Ask for mic permission ahead of time (inside a user gesture) so that
 * holding to talk does not need to wait for / re-trigger the prompt.
 */
export async function prepareVoiceRecorder(): Promise<void> {
  if (
    sharedStream?.getAudioTracks().some((track) => track.readyState === "live")
  )
    return;
  if (preparingStream) return preparingStream;
  releaseSharedStream();
  const generation = streamGeneration;
  const pending = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== streamGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Recording cancelled", "AbortError");
    }
    sharedStream = stream;
  })();
  preparingStream = pending;
  try {
    await pending;
  } finally {
    if (preparingStream === pending) preparingStream = null;
  }
}

export function releaseVoiceRecorder(): void {
  releaseSharedStream();
  // keep the decoder context around for the session
}

/**
 * Whether the app runs as an installed PWA (standalone display mode).
 * iOS standalone has a known WebKit bug: the mic permission is revoked every
 * time the URL hash changes (NextChat uses a hash router), so we show a hint
 * when the mic cannot be prepared.
 */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as any).standalone === true
  );
}

class MediaRecorderRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private cancelled = false;

  async start(): Promise<void> {
    this.chunks = [];
    await prepareVoiceRecorder();
    if (this.cancelled) return;
    if (!sharedStream) throw new Error("Microphone is unavailable");
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is not supported");
    }
    this.stream = sharedStream;
    this.recorder = new MediaRecorder(sharedStream);
    this.recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });
    this.recorder.start();
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** stop and convert the recorded blob to 16k mono s16 PCM */
  async stop(): Promise<Uint8Array> {
    const recorder = this.recorder;
    this.recorder = null;
    this.stream = null;
    if (!recorder) return new Uint8Array(0);

    // if the recorder already finished on its own, the "stop" event cannot
    // fire again, so never wrap it in a promise that waits for that event
    let blob: Blob;
    if (recorder.state === "inactive") {
      blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/mp4" });
    } else {
      const blobPromise = new Promise<Blob>((resolve) => {
        recorder.addEventListener(
          "stop",
          () => {
            resolve(
              new Blob(this.chunks, {
                type: recorder.mimeType || "audio/mp4",
              }),
            );
          },
          { once: true },
        );
      });
      recorder.stop();
      blob = await blobPromise;
    }
    console.log(
      "[VoiceInput] chunks=" +
        this.chunks.length +
        " blobBytes=" +
        blob.size +
        " mime=" +
        blob.type,
    );
    this.chunks = [];

    const ctx = getDecoderContext();
    if (!ctx) return new Uint8Array(0);
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const srcRate = audioBuffer.sampleRate || 48000;
      const samples = audioBuffer.getChannelData(0);
      if (samples.length === 0) return new Uint8Array(0);
      const pcm = resampleTo16kPcm(samples, srcRate);
      // set localStorage voiceDownloadDebug=1 to download the 16k wav for
      // local spectrum / ASR replay debugging
      try {
        if (
          typeof localStorage !== "undefined" &&
          localStorage.getItem("voiceDownloadDebug")
        ) {
          const { pcmToWav16k } = await import("../utils/pcm-resample");
          const wav = pcmToWav16k(pcm);
          const url = URL.createObjectURL(
            new Blob([wav], { type: "audio/wav" }),
          );
          const a = document.createElement("a");
          a.href = url;
          a.download = `voice-${Date.now()}.wav`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          // don't revoke immediately: browsers can fail the download if the
          // object URL is freed before the fetch starts
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        }
      } catch {
        /* noop */
      }
      return pcm;
    } catch (e) {
      console.warn("[VoiceInput] decodeAudioData failed", e);
      throw new Error("failed to decode recorded audio");
    }
  }

  /** stop the recorder and drop the data */
  cancel(): void {
    this.cancelled = true;
    try {
      this.recorder?.stop();
    } catch {
      /* noop */
    }
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
  }
}

/** animated waveform bars shown next to the label while recording */
function Waveform() {
  return (
    <span className={styles["waveform"]} aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} />
      ))}
    </span>
  );
}

interface VoiceInputBarProps {
  // called when transcription completes, text is filled into the input
  onResult: (text: string) => void;
  // current mode
  voiceMode: boolean;
  // called when the user switches between text and voice mode.
  // Idempotent: it receives the target mode so rapid repeated clicks cannot
  // flip the state back and forth.
  onModeChange: (voiceMode: boolean) => void;
  // called when recording state changes (to style the container)
  onRecordingChange?: (recording: boolean) => void;
}

/**
 * Voice / text input toggle.
 * - text mode: renders a mic button; clicking switches to voice mode
 * - voice mode: renders a "hold to talk" surface; press and hold to record,
 *   release to transcribe into the input, then switches back to text mode
 */
export function VoiceInputBar({
  onResult,
  voiceMode,
  onModeChange,
  onRecordingChange,
}: VoiceInputBarProps) {
  const engine = useVoiceEngine();
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [starting, setStarting] = useState(false);

  const recorderRef = useRef<MediaRecorderRecorder | null>(null);
  const recognitionRef = useRef<any>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const enteringRef = useRef(false);
  // whether the user is currently pressing the hold-to-talk surface
  const pressedRef = useRef(false);
  // whether the recorder has finished arming (async on mobile)
  const armedRef = useRef(false);

  const updateRecording = useCallback(
    (v: boolean) => {
      setRecording(v);
      onRecordingChange?.(v);
    },
    [onRecordingChange],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pressedRef.current = false;
      requestRef.current?.abort();
      recorderRef.current?.cancel();
      recognitionRef.current?.abort?.();
      releaseVoiceRecorder();
    };
  }, []);

  // cleanup when switching back to text mode
  useEffect(() => {
    if (!voiceMode) {
      requestRef.current?.abort();
      recorderRef.current?.cancel();
      recorderRef.current = null;
      recognitionRef.current?.abort?.();
      pressedRef.current = false;
      armedRef.current = false;
      setRecording(false);
      setStarting(false);
      setProcessing(false);
      updateRecording(false);
      releaseVoiceRecorder();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode]);

  const handleEnterVoiceMode = useCallback(
    async (event: React.MouseEvent) => {
      // Prevent the enclosing label from focusing the hidden text input.
      event.preventDefault();
      if (enteringRef.current) return;
      enteringRef.current = true;
      try {
        if (engine === "iflytek") await prepareVoiceRecorder();
        if (mountedRef.current) onModeChange(true);
      } catch (error) {
        if (mountedRef.current && (error as Error).name !== "AbortError") {
          showToast(
            isStandalonePwa()
              ? Locale.VoiceInput.StandaloneMicError
              : Locale.VoiceInput.MicError,
          );
        }
      } finally {
        enteringRef.current = false;
      }
    },
    [engine, onModeChange],
  );

  const handleExitVoiceMode = useCallback(() => {
    pressedRef.current = false;
    requestRef.current?.abort();
    recorderRef.current?.cancel();
    releaseVoiceRecorder();
    onModeChange(false);
  }, [onModeChange]);

  const startIflytek = useCallback(async () => {
    setStarting(true);
    const recorder = new MediaRecorderRecorder();
    recorderRef.current = recorder;
    armedRef.current = false;
    try {
      await recorder.start();
      // the user may have released the surface while the mic was arming
      if (!pressedRef.current) {
        recorder.cancel();
        recorderRef.current = null;
        return;
      }
      armedRef.current = true;
      updateRecording(true);
    } catch (e) {
      console.error("[VoiceInput] mic start failed", e);
      recorderRef.current = null;
      armedRef.current = false;
      if (pressedRef.current) {
        showToast(Locale.VoiceInput.MicError);
      }
    } finally {
      setStarting(false);
    }
  }, [updateRecording]);

  const stopIflytek = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    updateRecording(false);
    if (!recorder) return;

    // released before the recorder was ready: the async start already
    // cancelled itself, nothing to transcribe. Tell the user instead of
    // failing silently (a quick tap used to look like "nothing happens").
    if (!armedRef.current) {
      armedRef.current = false;
      showToast(Locale.VoiceInput.TooShort);
      return;
    }
    armedRef.current = false;

    setProcessing(true);
    const controller = new AbortController();
    requestRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    try {
      const pcm = await recorder.stop();
      if (controller.signal.aborted) return;
      // 3200 bytes = 100ms at 16k mono 16bit
      if (pcm.length < 3200) {
        showToast(Locale.VoiceInput.TooShort);
        return;
      }
      // if the recorded audio turned out silent, tell the user instead of
      // transcribing noise
      if (isPcmSilent(pcm)) {
        console.warn("[VoiceInput] recorded audio is silent");
        showToast(Locale.VoiceInput.Silent);
        return;
      }
      try {
        const { pcmDiagnostics } = await import("../utils/pcm-resample");
        const d = pcmDiagnostics(pcm);
        console.log(
          "[VoiceInput] pcm peak=" +
            d.peak +
            " rms=" +
            Math.round(d.rms) +
            " frames=" +
            d.frameCount +
            " (" +
            d.durationSec.toFixed(1) +
            "s) loudFrames=" +
            d.loudFrames,
        );
      } catch {
        /* noop */
      }

      // /api/iflytek/asr only reads the Authorization header, while
      // getHeaders() may put the credential into a provider specific header
      // (api-key / x-api-key / x-goog-api-key) depending on the chat model the
      // user is currently on. Make sure Authorization is always present.
      const headers: Record<string, string> = {
        ...getHeaders(),
        "Content-Type": "application/octet-stream",
      };
      if (!headers["Authorization"]) {
        const accessCode = useAccessStore.getState().accessCode;
        if (accessCode) {
          headers["Authorization"] =
            "Bearer " + ACCESS_CODE_PREFIX + accessCode;
        }
      }

      const res = await fetch("/api/iflytek/asr", {
        method: "POST",
        headers,
        body: pcm,
        signal: controller.signal,
      });
      const json = await res.json();
      if (controller.signal.aborted) return;
      if (!res.ok || json.error) {
        console.log(
          "[VoiceInput] ASR failed",
          json.msg ?? "",
          json.debug ?? "",
        );
        showToast(json.msg || Locale.VoiceInput.TranscribeError);
        return;
      }
      const text = (json.text ?? "").trim();
      if (text) {
        onResult(text);
      } else {
        console.log("[VoiceInput] ASR empty result", json.debug ?? "");
        showToast(Locale.VoiceInput.NoResult);
      }
    } catch (e) {
      if (!controller.signal.aborted || timedOut) {
        console.error("[VoiceInput] iflytek failed", e);
        showToast(Locale.VoiceInput.TranscribeError);
      }
    } finally {
      clearTimeout(timeout);
      recorder.cancel();
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (mountedRef.current) {
          setProcessing(false);
          updateRecording(false);
        }
      }
    }
  }, [onResult, updateRecording]);

  const startWebSpeech = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      showToast(Locale.VoiceInput.Unsupported);
      return;
    }
    const recognition = new SR();
    recognitionRef.current = recognition;
    recognition.lang = "zh-CN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      const text = Array.from(event.results)
        .map((r: any) => r[0]?.transcript ?? "")
        .join("")
        .trim();
      if (text) {
        onResult(text);
      }
    };
    recognition.onerror = (e: any) => {
      console.error("[VoiceInput] web speech error", e);
      showToast(Locale.VoiceInput.TranscribeError);
    };
    recognition.onend = () => {
      updateRecording(false);
      setProcessing(false);
    };

    updateRecording(true);
    try {
      recognition.start();
    } catch {
      updateRecording(false);
      showToast(Locale.VoiceInput.MicError);
    }
  }, [onResult, updateRecording]);

  const stopWebSpeech = useCallback(() => {
    recognitionRef.current?.stop?.();
    updateRecording(false);
  }, [updateRecording]);

  // ---------- hold-to-talk handlers ----------
  // Use touch + mouse events directly (like WeChat) and preventDefault all
  // touch gestures: this stops iOS text selection / long-press callout from
  // hijacking the pointer stream. A timestamp suppresses the synthetic mouse
  // events that browsers fire right after touch.
  const lastTouchTimeRef = useRef(0);

  const startHold = useCallback(() => {
    if (processing || starting || recording) return;
    pressedRef.current = true;
    if (engine === "iflytek") {
      startIflytek();
    } else if (engine === "web-speech") {
      startWebSpeech();
    }
  }, [engine, processing, starting, recording, startIflytek, startWebSpeech]);

  const endHold = useCallback(() => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    if (engine === "iflytek") {
      stopIflytek();
    } else if (engine === "web-speech") {
      stopWebSpeech();
    }
  }, [engine, stopIflytek, stopWebSpeech]);

  const cancelHold = useCallback(() => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    armedRef.current = false;
    if (engine === "iflytek") {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setProcessing(false);
      updateRecording(false);
    } else if (engine === "web-speech") {
      recognitionRef.current?.abort?.();
      updateRecording(false);
      setProcessing(false);
    }
  }, [engine, updateRecording]);
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      lastTouchTimeRef.current = Date.now();
      startHold();
    },
    [startHold],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      endHold();
    },
    [endHold],
  );

  const handleTouchCancel = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      cancelHold();
    },
    [cancelHold],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // suppress the synthetic mouse events fired after a real touch
      if (Date.now() - lastTouchTimeRef.current < 700) return;
      e.preventDefault();
      startHold();
    },
    [startHold],
  );

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (Date.now() - lastTouchTimeRef.current < 700) return;
      e.preventDefault();
      endHold();
    },
    [endHold],
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent) => {
      if (Date.now() - lastTouchTimeRef.current < 700) return;
      if (pressedRef.current) {
        cancelHold();
      }
    },
    [cancelHold],
  );

  if (engine === "none") return null;

  // voice mode: the whole input area becomes a hold-to-talk surface,
  // with a keyboard toggle on the left to switch back to text mode
  if (voiceMode) {
    return (
      <div className={styles["voice-mode-wrap"]}>
        <span
          className={styles["voice-mode-toggle"]}
          title={Locale.VoiceInput.ToggleToText}
          onClick={handleExitVoiceMode}
        >
          <KeyboardIcon />
        </span>
        <div
          className={clsx(
            styles["hold-to-talk"],
            recording && styles["recording"],
            starting && styles["starting"],
            processing && styles["processing"],
          )}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        >
          <span className={styles["hold-to-talk-icon"]}>
            {recording ? (
              <Waveform />
            ) : processing || starting ? (
              <LoadingIcon />
            ) : (
              <VoiceIcon />
            )}
          </span>
          <span className={styles["hold-to-talk-text"]}>
            {processing
              ? Locale.VoiceInput.Processing
              : recording
              ? Locale.VoiceInput.Listening
              : Locale.VoiceInput.HoldToTalk}
          </span>
        </div>
      </div>
    );
  }

  // text mode: a mic toggle button on the left of the input box
  return (
    <span
      className={styles["voice-mode-toggle"]}
      title={Locale.VoiceInput.ToggleToVoice}
      data-testid="voice-toggle"
      // the toggle lives inside the <label htmlFor="chat-input"> wrapper: keep
      // the click from focusing the textarea / popping the mobile keyboard.
      // NOTE: only intercept mousedown here, preventDefault on touchstart can
      // suppress the synthesized click on mobile and break the toggle.
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleEnterVoiceMode}
    >
      <VoiceIcon />
    </span>
  );
}
