class CricketLiveAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.captureEnabled = false;
    this.phase = 0;
    this.captureSum = 0;
    this.captureCount = 0;
    this.captureChunk = new Int16Array(640); // 40 ms at 16 kHz.
    this.captureOffset = 0;
    this.speechQueue = [];
    this.currentSpeech = null;
    this.speechOffset = 0;
    this.queuedSpeechSamples = 0;
    this.maxQueuedSpeechSamples = 24_000 * 3;
    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "start") this.captureEnabled = true;
      if (message.type === "pause") {
        this.captureEnabled = false;
        this.clearSpeech();
      }
      if (message.type === "clear") this.clearSpeech();
      if (message.type === "enqueue" && message.pcm) {
        const pcm = new Int16Array(message.pcm);
        if (!pcm.length) return;
        if (this.queuedSpeechSamples + pcm.length > this.maxQueuedSpeechSamples) {
          this.clearSpeech();
        }
        const samples = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
        this.speechQueue.push(samples);
        this.queuedSpeechSamples += samples.length;
      }
    };
  }

  clearSpeech() {
    this.speechQueue = [];
    this.currentSpeech = null;
    this.speechOffset = 0;
    this.queuedSpeechSamples = 0;
  }

  nextSpeechSample() {
    while (!this.currentSpeech || this.speechOffset >= this.currentSpeech.length) {
      if (this.currentSpeech) {
        this.queuedSpeechSamples = Math.max(0, this.queuedSpeechSamples - this.currentSpeech.length);
      }
      this.currentSpeech = this.speechQueue.shift() || null;
      this.speechOffset = 0;
      if (!this.currentSpeech) return 0;
    }

    const index = Math.floor(this.speechOffset);
    const nextIndex = Math.min(index + 1, this.currentSpeech.length - 1);
    const fraction = this.speechOffset - index;
    const sample = this.currentSpeech[index] * (1 - fraction) + this.currentSpeech[nextIndex] * fraction;
    this.speechOffset += 24_000 / sampleRate;
    return sample;
  }

  capture(input, frameCount) {
    if (!this.captureEnabled || !input) return;
    for (let i = 0; i < frameCount; i++) {
      let mono = 0;
      for (let channel = 0; channel < input.length; channel++) mono += input[channel][i] || 0;
      mono /= Math.max(1, input.length);
      this.captureSum += mono;
      this.captureCount++;
      this.phase += 16_000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const value = Math.max(-1, Math.min(1, this.captureSum / Math.max(1, this.captureCount)));
        this.captureChunk[this.captureOffset++] = value < 0 ? value * 32768 : value * 32767;
        this.captureSum = 0;
        this.captureCount = 0;
        if (this.captureOffset >= this.captureChunk.length) {
          const transferable = this.captureChunk.buffer.slice(0);
          this.port.postMessage({ type: "audio", pcm: transferable }, [transferable]);
          this.captureChunk = new Int16Array(640);
          this.captureOffset = 0;
        }
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const frameCount = output[0]?.length || 128;
    this.capture(input, frameCount);

    for (let i = 0; i < frameCount; i++) {
      const speechActive = Boolean(this.currentSpeech || this.speechQueue.length);
      const speech = this.nextSpeechSample();
      const sourceGain = speechActive ? 0.32 : 1;
      for (let channel = 0; channel < output.length; channel++) {
        const matchAudio = (input[channel] || input[0])?.[i] || 0;
        // Duck the source broadcast while AI speech is present, without muting it.
        output[channel][i] = Math.max(-1, Math.min(1, matchAudio * sourceGain + speech * 0.82));
      }
    }
    return true;
  }
}

registerProcessor("cricket-live-audio", CricketLiveAudioProcessor);
