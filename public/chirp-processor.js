class ChirpStreamProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor('chirp-stream-processor', ChirpStreamProcessor);
