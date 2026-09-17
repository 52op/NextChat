import { jest } from "@jest/globals";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

jest.unstable_mockModule("@/app/icons/voice.svg", () => ({
  default: () => null,
}));
jest.unstable_mockModule("@/app/icons/loading.svg", () => ({
  default: () => null,
}));
jest.unstable_mockModule("@/app/icons/keyboard.svg", () => ({
  default: () => null,
}));

const access = { enableIflytekAsr: true, accessCode: "test" };
const useAccessStore = Object.assign((selector: any) => selector(access), {
  getState: () => access,
});
jest.unstable_mockModule("@/app/store/access", () => ({ useAccessStore }));
jest.unstable_mockModule("@/app/client/api", () => ({
  getHeaders: () => ({}),
}));
jest.unstable_mockModule("@/app/components/ui-lib", () => ({
  showToast: jest.fn(),
}));
jest.unstable_mockModule("@/app/locales", () => ({
  default: {
    VoiceInput: {
      ToggleToVoice: "voice",
      ToggleToText: "text",
      HoldToTalk: "hold",
    },
  },
}));

let voice: typeof import("../app/components/voice-input");
const getUserMedia = jest.fn<() => Promise<MediaStream>>();
function stream() {
  const track = {
    readyState: "live",
    stop: jest.fn(() => {
      track.readyState = "ended";
    }),
  };
  return {
    track,
    value: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  voice = await import("../app/components/voice-input");
});
beforeEach(() => {
  getUserMedia.mockReset();
  access.enableIflytekAsr = true;
});
afterEach(() => {
  cleanup();
  voice.releaseVoiceRecorder();
  delete window.SpeechRecognition;
});

test("deduplicates pending microphone permission requests", async () => {
  const pending = deferred<MediaStream>();
  const mic = stream();
  getUserMedia.mockReturnValue(pending.promise);
  const first = voice.prepareVoiceRecorder();
  const second = voice.prepareVoiceRecorder();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  pending.resolve(mic.value);
  await Promise.all([first, second]);
  await voice.prepareVoiceRecorder();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

test("reacquires an ended microphone track", async () => {
  const oldMic = stream();
  const newMic = stream();
  getUserMedia
    .mockResolvedValueOnce(oldMic.value)
    .mockResolvedValueOnce(newMic.value);
  await voice.prepareVoiceRecorder();
  oldMic.track.readyState = "ended";
  await voice.prepareVoiceRecorder();
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  voice.releaseVoiceRecorder();
  expect(newMic.track.stop).toHaveBeenCalled();
});

test("releases a late permission result after cancellation", async () => {
  const pending = deferred<MediaStream>();
  const mic = stream();
  getUserMedia.mockReturnValue(pending.promise);
  const preparing = voice.prepareVoiceRecorder();
  const assertion = expect(preparing).rejects.toMatchObject({
    name: "AbortError",
  });
  voice.releaseVoiceRecorder();
  pending.resolve(mic.value);
  await assertion;
  expect(mic.track.stop).toHaveBeenCalledTimes(1);
});

test("releases the mic when returning to text mode while idle", async () => {
  const mic = stream();
  getUserMedia.mockResolvedValue(mic.value);
  await voice.prepareVoiceRecorder();
  const props = { onResult: jest.fn(), onModeChange: jest.fn() };
  const { rerender } = render(<voice.VoiceInputBar voiceMode {...props} />);
  rerender(<voice.VoiceInputBar voiceMode={false} {...props} />);
  expect(mic.track.stop).toHaveBeenCalledTimes(1);
});

test("a late permission result cannot switch mode after unmount", async () => {
  const pending = deferred<MediaStream>();
  const mic = stream();
  getUserMedia.mockReturnValue(pending.promise);
  const onModeChange = jest.fn();
  const { unmount } = render(
    <voice.VoiceInputBar
      voiceMode={false}
      onResult={jest.fn()}
      onModeChange={onModeChange}
    />,
  );
  fireEvent.click(screen.getByTitle("voice"));
  unmount();
  await act(async () => {
    pending.resolve(mic.value);
  });
  expect(onModeChange).not.toHaveBeenCalled();
  expect(mic.track.stop).toHaveBeenCalled();
});

test("Web Speech fallback does not reserve a separate microphone stream", async () => {
  access.enableIflytekAsr = false;
  window.SpeechRecognition = function () {};
  const onModeChange = jest.fn();
  render(
    <voice.VoiceInputBar
      voiceMode={false}
      onResult={jest.fn()}
      onModeChange={onModeChange}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByTitle("voice"));
  });
  expect(onModeChange).toHaveBeenCalledWith(true);
  expect(getUserMedia).not.toHaveBeenCalled();
});
