/** Validate the formats accepted by the ASR endpoint; never send WAV headers as PCM. */
export function readAsrPcm(buffer: Buffer): Buffer {
  let pcm = buffer;
  if (buffer.toString("ascii", 0, 4) === "RIFF") {
    if (buffer.length < 12 || buffer.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("无效的 WAV 文件");
    }
    const limit = buffer.readUInt32LE(4) + 8;
    if (limit > buffer.length || limit < 12) throw new Error("WAV 文件不完整");
    let validFormat = false;
    let data: Buffer | undefined;
    for (let off = 12; off < limit; ) {
      if (off + 8 > limit) throw new Error("WAV 文件不完整");
      const id = buffer.toString("ascii", off, off + 4);
      const size = buffer.readUInt32LE(off + 4);
      const start = off + 8;
      if (start + size > limit) throw new Error("WAV 文件不完整");
      if (id === "fmt ") {
        validFormat =
          size >= 16 &&
          buffer.readUInt16LE(start) === 1 &&
          buffer.readUInt16LE(start + 2) === 1 &&
          buffer.readUInt32LE(start + 4) === 16000 &&
          buffer.readUInt16LE(start + 12) === 2 &&
          buffer.readUInt16LE(start + 14) === 16;
      } else if (id === "data") {
        data = buffer.subarray(start, start + size);
      }
      off = start + size + (size % 2);
    }
    if (!validFormat || !data) {
      throw new Error("WAV 必须为 16kHz、单声道、16bit PCM");
    }
    pcm = data;
  }
  if (!pcm.length || pcm.length % 2 !== 0) {
    throw new Error("音频必须为非空的 16bit PCM");
  }
  if (pcm.length > 16000 * 2 * 40) {
    throw new Error("录音最长为 40 秒，请缩短后重试");
  }
  return pcm;
}
