/**
 * Audio Modem Logic
 * Uses Frequency Shift Keying (FSK) to encode/decode text over high-frequency sound.
 */

export const MODEM_CONFIG = {
  BASE_FREQ: 1800,
  BIT_0_FREQ: 1800,
  BIT_1_FREQ: 2200,
  END_FREQ: 2600,
  BIT_DURATION: 0.1, // seconds
  SAMPLE_RATE: 44100,
  PREAMBLE: [1800, 2600, 1800, 2600],
};

/**
 * Encodes text into an AudioBuffer
 */
export async function encodeTextToAudio(text: string, audioContext: AudioContext): Promise<AudioBuffer> {
  const binary = new TextEncoder().encode(text);
  const bits: number[] = [];

  // Convert bytes to bits
  for (const byte of binary) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }

  const totalDuration = (MODEM_CONFIG.PREAMBLE.length + bits.length + 1) * MODEM_CONFIG.BIT_DURATION;
  const buffer = audioContext.createBuffer(1, totalDuration * MODEM_CONFIG.SAMPLE_RATE, MODEM_CONFIG.SAMPLE_RATE);
  const data = buffer.getChannelData(0);

  let offset = 0;

  // 1. Preamble
  for (const freq of MODEM_CONFIG.PREAMBLE) {
    writeTone(data, offset, freq, MODEM_CONFIG.BIT_DURATION, MODEM_CONFIG.SAMPLE_RATE);
    offset += Math.floor(MODEM_CONFIG.BIT_DURATION * MODEM_CONFIG.SAMPLE_RATE);
  }

  // 2. Data Bits
  for (const bit of bits) {
    const freq = bit === 0 ? MODEM_CONFIG.BIT_0_FREQ : MODEM_CONFIG.BIT_1_FREQ;
    writeTone(data, offset, freq, MODEM_CONFIG.BIT_DURATION, MODEM_CONFIG.SAMPLE_RATE);
    offset += Math.floor(MODEM_CONFIG.BIT_DURATION * MODEM_CONFIG.SAMPLE_RATE);
  }

  // 3. End Tone
  writeTone(data, offset, MODEM_CONFIG.END_FREQ, MODEM_CONFIG.BIT_DURATION, MODEM_CONFIG.SAMPLE_RATE);

  return buffer;
}

function writeTone(data: Float32Array, offset: number, freq: number, duration: number, sampleRate: number) {
  const samples = Math.floor(duration * sampleRate);
  for (let i = 0; i < samples; i++) {
    // Apply a small fade in/out to avoid clicks
    const fadeSize = Math.floor(samples * 0.1);
    let amplitude = 1.0;
    if (i < fadeSize) amplitude = i / fadeSize;
    if (i > samples - fadeSize) amplitude = (samples - i) / fadeSize;

    data[offset + i] = amplitude * Math.sin(2 * Math.PI * freq * (i / sampleRate));
  }
}

/**
 * Decodes an AudioBuffer into text
 */
export async function decodeAudioToText(buffer: AudioBuffer): Promise<string> {
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const fftSize = 2048;
  const stepSize = Math.floor(MODEM_CONFIG.BIT_DURATION * sampleRate);
  
  const bits: number[] = [];
  let inMessage = false;
  let bitIndex = 0;

  // This is a simplified decoding. In a real scenario, we'd use a sliding window
  // to find the preamble and synchronize.
  
  // For this implementation, we'll assume the audio starts with the preamble.
  // We'll skip the preamble (4 bits)
  let offset = 4 * stepSize;

  while (offset + fftSize < data.length) {
    const segment = data.slice(offset, offset + fftSize);
    const freq = detectDominantFreq(segment, sampleRate);

    if (Math.abs(freq - MODEM_CONFIG.BIT_0_FREQ) < 200) {
      bits.push(0);
    } else if (Math.abs(freq - MODEM_CONFIG.BIT_1_FREQ) < 200) {
      bits.push(1);
    } else if (Math.abs(freq - MODEM_CONFIG.END_FREQ) < 200) {
      break;
    }

    offset += stepSize;
  }

  // Convert bits to bytes
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    if (i + 8 > bits.length) break;
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    bytes.push(byte);
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function detectDominantFreq(data: Float32Array, sampleRate: number): number {
  // Simple FFT-like detection using Goertzel algorithm for specific frequencies
  // or just a simple zero-crossing/peak detection. 
  // For simplicity and reliability at high frequencies, let's use a basic DFT for our target frequencies.
  
  const targets = [
    MODEM_CONFIG.BIT_0_FREQ,
    MODEM_CONFIG.BIT_1_FREQ,
    MODEM_CONFIG.END_FREQ,
    ...MODEM_CONFIG.PREAMBLE
  ];

  let maxMag = -1;
  let bestFreq = 0;

  for (const freq of targets) {
    const mag = goertzel(data, freq, sampleRate);
    if (mag > maxMag) {
      maxMag = mag;
      bestFreq = freq;
    }
  }

  return bestFreq;
}

function goertzel(data: Float32Array, targetFreq: number, sampleRate: number): number {
  const n = data.length;
  const k = (n * targetFreq) / sampleRate;
  const omega = (2 * Math.PI * k) / n;
  const sine = Math.sin(omega);
  const cosine = Math.cos(omega);
  const coeff = 2 * cosine;

  let q0 = 0, q1 = 0, q2 = 0;

  for (let i = 0; i < n; i++) {
    q0 = coeff * q1 - q2 + data[i];
    q2 = q1;
    q1 = q0;
  }

  const real = q1 - q2 * cosine;
  const imag = q2 * sine;
  return Math.sqrt(real * real + imag * imag);
}

/**
 * Converts AudioBuffer to WAV Blob
 */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const outBuffer = new ArrayBuffer(length);
  const view = new DataView(outBuffer);
  const channels = [];
  let i, sample, offset = 0, pos = 0;

  // write WAVE header
  setUint32(0x46464952);                         // "RIFF"
  setUint32(length - 8);                         // file length - 8
  setUint32(0x45564157);                         // "WAVE"

  setUint32(0x20746d66);                         // "fmt " chunk
  setUint32(16);                                 // length = 16
  setUint16(1);                                  // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);  // avg. bytes/sec
  setUint16(numOfChan * 2);                      // block-align
  setUint16(16);                                 // 16-bit (hardcoded)

  setUint32(0x61746164);                         // "data" - chunk
  setUint32(length - pos - 4);                   // chunk length

  // write interleaved data
  for(i = 0; i < buffer.numberOfChannels; i++)
    channels.push(buffer.getChannelData(i));

  while(pos < length) {
    for(i = 0; i < numOfChan; i++) {             // interleave channels
      sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
      sample = (sample < 0 ? sample * 0x8000 : sample * 0x7FFF); // scale to 16-bit signed int
      view.setInt16(pos, sample, true);          // write 16-bit sample
      pos += 2;
    }
    offset++;                                     // next sample index
  }

  return new Blob([outBuffer], {type: "audio/wav"});

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}
