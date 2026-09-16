"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import styles from "./voice-input.module.scss";
import VoiceIcon from "../icons/voice.svg";
import LoadingIcon from "../icons/loading.svg";
import { useAccessStore } from "../store/access";
import { getHeaders } from "../client/api";
import { showToast } from "./ui-lib";
import Locale from "../locales";
import clsx from "clsx";
import { resampleTo16kPcm } from "../utils/pcm-resample";

// Web Speech API types are not in the default TS lib
declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
  }
}

interface VoiceInputProps {
  onResult: (text: string) => void;
}

type Engine = "iflytek" | "web-speech" | "none";

function detectEngine(): Engine {
  // server managed iflytek ASR has priority
  if (useAccessStore.getState().enableIflytekAsr) return "iflytek";
  // fallback to the browser Web Speech API
  if (typeof window !== "undefined") {
    const sr = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (sr) return "web-speech";
  }
  return "none";
}

const TARGET_SAMPLE_RATE = 16000;

/**
 * Minimal PCM recorder for the voice input.
 * Uses ScriptProcessorNode instead of AudioWorklet because it is supported
 * on every browser including iOS Safari, where AudioWorklet + custom sample
 * rates are unreliable. Output is resampled to 16k mono 16bit PCM.
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
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    await this.context.resume();

    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      // copy, the underlying buffer is reused
      this.chunks.push(new Float32Array(data));
    };
    this.source.connect(this.processor);
    // must be connected to destination or the callback stops firing on some
    // browsers (webkit), use a zero gain to keep it silent
    const gain = this.context.createGain();
    gain.gain.value = 0;
    this.processor.connect(gain);
    gain.connect(this.context.destination);
  }

  stop(): Uint8Array {
    this.teardown();
    return this.toPcm16k();
  }

  async cancel(): Promise<void> {
    this.chunks = [];
    this.teardown();
    await this.context?.close();
    this.context = null;
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

    // concatenate all recorded samples
    const all = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    return resampleTo16kPcm(all, srcRate);
  }
}

export function VoiceInput({ onResult }: VoiceInputProps) {
  const [engine] = useState<Engine>(detectEngine);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);

  const recorderRef = useRef<PcmRecorder | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      recorderRef.current?.cancel();
      recognitionRef.current?.abort?.();
    };
  }, []);

  const startIflytek = useCallback(async () => {
    try {
      const recorder = new PcmRecorder();
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
    } catch (e) {
      console.error("[VoiceInput] mic start failed", e);
      recorderRef.current = null;
      showToast(Locale.VoiceInput.MicError);
    }
  }, []);

  const stopIflytek = useCallback(async () => {
    const recorder = recorderRef.current;
    setRecording(false);
    recorderRef.current = null;
    if (!recorder) return;

    setProcessing(true);
    try {
      const pcm = recorder.stop();
      // 3200 bytes = 100ms at 16k mono 16bit
      if (pcm.length < 3200) {
        showToast(Locale.VoiceInput.TooShort);
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
      await recorder.cancel();
      setProcessing(false);
    }
  }, [onResult]);

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
      setRecording(false);
    };

    setRecording(true);
    try {
      recognition.start();
    } catch {
      setRecording(false);
      showToast(Locale.VoiceInput.MicError);
    }
  }, [onResult]);

  const stopWebSpeech = useCallback(() => {
    recognitionRef.current?.stop?.();
    setRecording(false);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (processing) return;
      // keep receiving pointer events even if the finger slides a bit
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      if (engine === "iflytek") {
        startIflytek();
      } else if (engine === "web-speech") {
        startWebSpeech();
      }
    },
    [engine, processing, startIflytek, startWebSpeech],
  );

  const handlePointerUp = useCallback(() => {
    if (engine === "iflytek") {
      stopIflytek();
    } else if (engine === "web-speech") {
      stopWebSpeech();
    }
  }, [engine, stopIflytek, stopWebSpeech]);

  const handleCancel = useCallback(() => {
    if (engine === "iflytek") {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      setRecording(false);
    } else if (engine === "web-speech") {
      recognitionRef.current?.abort?.();
      setRecording(false);
    }
  }, [engine]);

  if (engine === "none") return null;

  return (
    <span
      className={clsx(styles["voice-input"], recording && styles["recording"])}
      title={Locale.VoiceInput.Title}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={recording ? handleCancel : undefined}
      data-engine={engine}
    >
      {processing || recording ? <LoadingIcon /> : <VoiceIcon />}
    </span>
  );
}
