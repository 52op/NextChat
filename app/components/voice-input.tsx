"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import styles from "./voice-input.module.scss";
import VoiceIcon from "../icons/voice.svg";
import LoadingIcon from "../icons/loading.svg";
import { useAccessStore } from "../store/access";
import { getHeaders } from "../client/api";
import { AudioHandler } from "../lib/audio";
import { showToast } from "./ui-lib";
import Locale from "../locales";
import clsx from "clsx";

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

export function VoiceInput({ onResult }: VoiceInputProps) {
  const [engine] = useState<Engine>(detectEngine);
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);

  const audioHandlerRef = useRef<AudioHandler | null>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      audioHandlerRef.current?.close();
      recognitionRef.current?.abort?.();
    };
  }, []);

  const startIflytek = useCallback(async () => {
    try {
      const handler = new AudioHandler(16000);
      audioHandlerRef.current = handler;
      await handler.startRecording(() => {});
      setRecording(true);
    } catch (e) {
      console.error("[VoiceInput] mic start failed", e);
      showToast(Locale.VoiceInput.MicError);
    }
  }, []);

  const stopIflytek = useCallback(async () => {
    const handler = audioHandlerRef.current;
    setRecording(false);
    audioHandlerRef.current = null;
    if (!handler) return;

    try {
      handler.stopRecording();
    } catch {
      // ignore, pcm may still be available
    }

    setProcessing(true);
    try {
      const pcm = handler.getRecordedPcm(16000);
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
      handler.close();
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

  const handlePointerDown = useCallback(() => {
    if (processing) return;
    if (engine === "iflytek") {
      startIflytek();
    } else if (engine === "web-speech") {
      startWebSpeech();
    }
  }, [engine, processing, startIflytek, startWebSpeech]);

  const handlePointerUp = useCallback(() => {
    if (engine === "iflytek") {
      stopIflytek();
    } else if (engine === "web-speech") {
      stopWebSpeech();
    }
  }, [engine, stopIflytek, stopWebSpeech]);

  const handleCancel = useCallback(() => {
    if (engine === "iflytek") {
      audioHandlerRef.current?.close();
      audioHandlerRef.current = null;
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
      onPointerLeave={recording ? handleCancel : undefined}
      onPointerCancel={recording ? handleCancel : undefined}
      data-engine={engine}
    >
      {processing || recording ? <LoadingIcon /> : <VoiceIcon />}
    </span>
  );
}
