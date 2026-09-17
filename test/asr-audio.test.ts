import { Buffer } from "buffer";
import { readAsrPcm } from "../app/utils/asr-audio";
import { pcmToWav16k } from "../app/utils/pcm-resample";

const pcm = Buffer.from([0, 1, 2, 3]);
const wav = () => Buffer.from(pcmToWav16k(pcm));

test("accepts PCM without changing the signal", () => {
  expect(readAsrPcm(pcm)).toBe(pcm);
});

test("extracts just WAV audio including from a larger buffer", () => {
  const file = wav();
  const backing = Buffer.concat([Buffer.alloc(5), file, Buffer.alloc(9)]);
  expect(readAsrPcm(backing.subarray(5, 5 + file.length))).toEqual(pcm);
});

test("skips odd-sized metadata chunks and their padding", () => {
  const file = wav();
  const metadata = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 99, 0]);
  const input = Buffer.concat([
    file.subarray(0, 36),
    metadata,
    file.subarray(36),
  ]);
  input.writeUInt32LE(input.length - 8, 4);
  expect(readAsrPcm(input)).toEqual(pcm);
});

test.each([0, 1, 32000 * 40 + 2])("rejects invalid PCM length %i", (length) => {
  expect(() => readAsrPcm(Buffer.alloc(length))).toThrow();
});

test.each([
  "truncated",
  "wrong-rate",
  "stereo",
  "float",
  "no-data",
  "bad-chunk",
])("rejects %s WAV instead of sending it as raw audio", (kind) => {
  let file = wav();
  if (kind === "truncated") file = file.subarray(0, file.length - 2);
  if (kind === "wrong-rate") file.writeUInt32LE(48000, 24);
  if (kind === "stereo") file.writeUInt16LE(2, 22);
  if (kind === "float") file.writeUInt16LE(3, 20);
  if (kind === "no-data") file.write("JUNK", 36);
  if (kind === "bad-chunk") file.writeUInt32LE(0xffffffff, 40);
  expect(() => readAsrPcm(file)).toThrow();
});
