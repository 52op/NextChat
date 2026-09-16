"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./voice-input.module.scss";
import VoiceIcon from "../icons/voice.svg";
import LoadingIcon from "../icons/loading.svg";
import { useAccessStore } from "../store/access";
import { getHeaders } from "../client/api";
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

/**
 * Minimal PCM recorder for the voice input.
 * Uses ScriptProcessorNode because it is supported on every browser
 * including iOS Safari; AudioWorklet + custom sample rates are unreliable
 * on iOS. Records at the context rate and resamples to 16k later.
 */
class PcmRecorder {
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];

  async start(): Promise<void> {
    // don't force a sample rate: iOS only supports 44100/48000 and would
    // silently fail. we record at the context rate and resample later.
    this.context = new AudioContext();
    // CRITICAL on iOS: resume() must be called inside the user gesture stack.
    // awaiting getUserMedia first leaves the gesture context and the resume
    // gets rejected, leaving the context suspended and onaudioprocess silent.
    // resume is the first await so it runs synchronously within touchstart.
    try {
      await this.context.resume();
    } catch (e) {
      console.warn("[VoiceInput] audio context resume failed", e);
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    // some browsers suspend again after the mic prompt; try once more
    if (this.context.state !== "running") {
      try {
        await this.context.resume();
      } catch {
        /* ignore */
      }
    }

    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      // copy, the underlying buffer is reused
      this.chunks.push(new Float32Array(data));
    };
    this.source.connect(this.processor);
    // must be connected to destination or the callback stops firing on some
    // browsers (webkit), a zero gain keeps it silent
    const gain = this.context.createGain();
    gain.gain.value = 0;
    this.processor.connect(gain);
    gain.connect(this.context.destination);
  }

  get isRecording(): boolean {
    return !!this.processor && this.chunks.length > 0;
  }

  stop(): Uint8Array {
    this.teardown();
    return this.toPcm16k();
  }

  async cancel(): Promise<void> {
    this.chunks = [];
    this.teardown();
    const ctx = this.context;
    this.context = null;
    if (ctx) {
      try {
        await ctx.close();
      } catch (e) {
        // already closed or suspended on iOS, ignore
        console.warn("[VoiceInput] audio context close failed", e);
      }
    }
  }

  private teardown() {
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
    } catch {
      /* noop */
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor = null;
    this.source = null;
    this.stream = null;
  }

  private toPcm16k(): Uint8Array {
    const srcRate = this.context?.sampleRate || 48000;
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    if (total === 0) return new Uint8Array(0);

    const all = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    return resampleTo16kPcm(all, srcRate);
  }
}

interface VoiceInputBarProps {
  // called when transcription completes, text is filled into the input
  onResult: (text: string) => void;
  // current mode
  voiceMode: boolean;
  // called when the user toggles the mode (mic <-> keyboard button)
  onToggleMode: () => void;
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
  onToggleMode,
  onRecordingChange,
}: VoiceInputBarProps) {
  const engine = useVoiceEngine();
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [starting, setStarting] = useState(false);

  const recorderRef = useRef<PcmRecorder | null>(null);
  const recognitionRef = useRef<any>(null);
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
    return () => {
      recorderRef.current?.cancel();
      recognitionRef.current?.abort?.();
    };
  }, []);

  // cleanup when switching back to text mode
  useEffect(() => {
    if (!voiceMode && (recording || starting || processing)) {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      recognitionRef.current?.abort?.();
      pressedRef.current = false;
      armedRef.current = false;
      setRecording(false);
      setStarting(false);
      setProcessing(false);
      updateRecording(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode]);

  const startIflytek = useCallback(async () => {
    setStarting(true);
    const recorder = new PcmRecorder();
    recorderRef.current = recorder;
    armedRef.current = false;
    try {
      await recorder.start();
      // the user may have released the surface while the mic was arming
      if (!pressedRef.current) {
        recorder.cancel().catch(() => {});
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
    // cancelled itself, nothing to transcribe
    if (!armedRef.current) {
      armedRef.current = false;
      return;
    }
    armedRef.current = false;

    setProcessing(true);
    try {
      const pcm = recorder.stop();
      // 3200 bytes = 100ms at 16k mono 16bit
      if (pcm.length < 3200) {
        showToast(Locale.VoiceInput.TooShort);
        return;
      }
      // if the audio graph was interrupted (e.g. iOS resume failure), the
      // buffer has length but no voice; tell the user instead of transcribing
      if (isPcmSilent(pcm)) {
        console.warn("[VoiceInput] recorded audio is silent");
        showToast(Locale.VoiceInput.Silent);
        return;
      }

      const res = await fetch("/api/iflytek/asr", {
        method: "POST",
        headers: {
          ...getHeaders(),
          "Content-Type": "application/octet-stream",
        },
        body: pcm,
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        showToast(json.msg || Locale.VoiceInput.TranscribeError);
        return;
      }
      const text = (json.text ?? "").trim();
      if (text) {
        onResult(text);
      } else {
        showToast(Locale.VoiceInput.NoResult);
      }
    } catch (e) {
      console.error("[VoiceInput] iflytek failed", e);
      showToast(Locale.VoiceInput.TranscribeError);
    } finally {
      // cancel can throw on iOS; never block the state reset
      recorder.cancel().catch(() => {});
      setProcessing(false);
      updateRecording(false);
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
          onClick={onToggleMode}
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
            {processing || starting ? <LoadingIcon /> : <VoiceIcon />}
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
      onClick={onToggleMode}
    >
      <VoiceIcon />
    </span>
  );
}
