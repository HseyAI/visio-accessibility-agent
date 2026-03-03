class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 24000 * 60;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.playing = false;

    this.port.onmessage = (event) => {
      if (event.data.command === "stop") {
        this.readIndex = this.writeIndex;
        this.playing = false;
        return;
      }
      const int16 = new Int16Array(event.data);
      for (let i = 0; i < int16.length; i++) {
        this.buffer[this.writeIndex] = int16[i] / 32768;
        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
      }
      this.playing = true;
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      if (this.readIndex !== this.writeIndex) {
        output[0][i] = this.buffer[this.readIndex];
        if (output.length > 1) output[1][i] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.bufferSize;
      } else {
        output[0][i] = 0;
        if (output.length > 1) output[1][i] = 0;
        if (this.playing) {
          this.playing = false;
          this.port.postMessage({ type: "ended" });
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-player-processor", PCMPlayerProcessor);
