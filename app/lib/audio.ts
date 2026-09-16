export class AudioHandler {
  private context: AudioContext;
  private mergeNode: ChannelMergerNode;
  private analyserData: Uint8Array;
  public analyser: AnalyserNode;
  private workletNode: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recordBuffer: Int16Array[] = [];
  private readonly sampleRate: number;

  private nextPlayTime: number = 0;
  private isPlaying: boolean = false;
  private playbackQueue: AudioBufferSourceNode[] = [];
  private playBuffer: Int16Array[] = [];

  constructor(sampleRate: number = 24000) {
    // note: the actual context sample rate may differ from the requested one,
    // browsers resample automatically. we rely on this.context.sampleRate.
    this.sampleRate = sampleRate;
    this.context = new AudioContext({ sampleRate: this.sampleRate });
    // using ChannelMergerNode to get merged audio data, and then get analyser data.
    this.mergeNode = new ChannelMergerNode(this.context, { numberOfInputs: 2 });
    this.analyser = new AnalyserNode(this.context, { fftSize: 256 });
    this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
    this.mergeNode.connect(this.analyser);
  }

  getByteFrequencyData() {
    this.analyser.getByteFrequencyData(this.analyserData);
    return this.analyserData;
  }

  async initialize() {
    await this.context.audioWorklet.addModule("/audio-processor.js");
  }

  async startRecording(onChunk: (chunk: Uint8Array) => void) {
    try {
      if (!this.workletNode) {
        await this.initialize();
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: this.sampleRate,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(
        this.context,
        "audio-recorder-processor",
      );

      this.workletNode.port.onmessage = (event) => {
        if (event.data.eventType === "audio") {
          const float32Data = event.data.audioData;
          const int16Data = new Int16Array(float32Data.length);

          for (let i = 0; i < float32Data.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Data[i]));
            int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }

          const uint8Data = new Uint8Array(int16Data.buffer);
          onChunk(uint8Data);
          // save recordBuffer
          // @ts-ignore
          this.recordBuffer.push.apply(this.recordBuffer, int16Data);
        }
      };

      this.source.connect(this.workletNode);
      this.source.connect(this.mergeNode, 0, 0);
      this.workletNode.connect(this.context.destination);

      this.workletNode.port.postMessage({ command: "START_RECORDING" });
    } catch (error) {
      console.error("Error starting recording:", error);
      throw error;
    }
  }

  stopRecording() {
    if (!this.workletNode || !this.source || !this.stream) {
      throw new Error("Recording not started");
    }

    this.workletNode.port.postMessage({ command: "STOP_RECORDING" });

    this.workletNode.disconnect();
    this.source.disconnect();
    this.stream.getTracks().forEach((track) => track.stop());
  }
  startStreamingPlayback() {
    this.isPlaying = true;
    this.nextPlayTime = this.context.currentTime;
  }

  stopStreamingPlayback() {
    this.isPlaying = false;
    this.playbackQueue.forEach((source) => source.stop());
    this.playbackQueue = [];
    this.playBuffer = [];
  }

  playChunk(chunk: Uint8Array) {
    if (!this.isPlaying) return;

    const int16Data = new Int16Array(chunk.buffer);
    // @ts-ignore
    this.playBuffer.push.apply(this.playBuffer, int16Data); // save playBuffer

    const float32Data = new Float32Array(int16Data.length);
    for (let i = 0; i < int16Data.length; i++) {
      float32Data[i] = int16Data[i] / (int16Data[i] < 0 ? 0x8000 : 0x7fff);
    }

    const audioBuffer = this.context.createBuffer(
      1,
      float32Data.length,
      this.sampleRate,
    );
    audioBuffer.getChannelData(0).set(float32Data);

    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.context.destination);
    source.connect(this.mergeNode, 0, 1);

    const chunkDuration = audioBuffer.length / this.sampleRate;

    source.start(this.nextPlayTime);

    this.playbackQueue.push(source);
    source.onended = () => {
      const index = this.playbackQueue.indexOf(source);
      if (index > -1) {
        this.playbackQueue.splice(index, 1);
      }
    };

    this.nextPlayTime += chunkDuration;

    if (this.nextPlayTime < this.context.currentTime) {
      this.nextPlayTime = this.context.currentTime;
    }
  }
  _saveData(data: Int16Array, bytesPerSample = 16): Blob {
    const headerLength = 44;
    const numberOfChannels = 1;
    const byteLength = data.buffer.byteLength;
    const header = new Uint8Array(headerLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 1380533830, false); // RIFF identifier 'RIFF'
    view.setUint32(4, 36 + byteLength, true); // file length minus RIFF identifier length and file description length
    view.setUint32(8, 1463899717, false); // RIFF type 'WAVE'
    view.setUint32(12, 1718449184, false); // format chunk identifier 'fmt '
    view.setUint32(16, 16, true); // format chunk length
    view.setUint16(20, 1, true); // sample format (raw)
    view.setUint16(22, numberOfChannels, true); // channel count
    view.setUint32(24, this.context.sampleRate, true); // sample rate
    view.setUint32(28, this.context.sampleRate * 4, true); // byte rate (sample rate * block align)
    view.setUint16(32, numberOfChannels * 2, true); // block align (channel count * bytes per sample)
    view.setUint16(34, bytesPerSample, true); // bits per sample
    view.setUint32(36, 1684108385, false); // data chunk identifier 'data'
    view.setUint32(40, byteLength, true); // data chunk length

    // using data.buffer, so no need to setUint16 to view.
    return new Blob([view, data.buffer], { type: "audio/mpeg" });
  }
  savePlayFile() {
    // @ts-ignore
    return this._saveData(new Int16Array(this.playBuffer));
  }
  saveRecordFile(
    audioStartMillis: number | undefined,
    audioEndMillis: number | undefined,
  ) {
    const startIndex = audioStartMillis
      ? Math.floor((audioStartMillis * this.context.sampleRate) / 1000)
      : 0;
    const endIndex = audioEndMillis
      ? Math.floor((audioEndMillis * this.context.sampleRate) / 1000)
      : this.recordBuffer.length;
    return this._saveData(
      // @ts-ignore
      new Int16Array(this.recordBuffer.slice(startIndex, endIndex)),
    );
  }

  /**
   * Concatenate the recorded samples and resample to the target rate.
   * Returns raw mono s16le PCM ready to be uploaded to the ASR endpoint.
   */
  getRecordedPcm(targetRate: number = 16000): Uint8Array {
    if (this.recordBuffer.length === 0) return new Uint8Array(0);
    // @ts-ignore
    const length = this.recordBuffer.reduce((sum, v) => sum + v.length, 0);
    const all = new Int16Array(length);
    let offset = 0;
    for (const chunk of this.recordBuffer) {
      all.set(chunk, offset);
      offset += chunk.length;
    }

    const srcRate = this.context.sampleRate;
    const out = new Int16Array(Math.ceil((all.length * targetRate) / srcRate));
    for (let i = 0; i < out.length; i++) {
      const j = (i * srcRate) / targetRate;
      const i0 = Math.floor(j);
      const i1 = Math.min(i0 + 1, all.length - 1);
      const frac = j - i0;
      out[i] = all[i0] * (1 - frac) + all[i1] * frac;
    }
    return new Uint8Array(out.buffer);
  }
  async close() {
    this.recordBuffer = [];
    this.workletNode?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context.close();
  }
}
