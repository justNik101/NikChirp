import React, { useState, useRef, useEffect, ChangeEvent } from "react";
import { 
  Radio, 
  Mic, 
  MicOff, 
  Download, 
  Upload, 
  Play,
  Square,
  Activity,
  Terminal,
  Volume2,
  Info
} from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Label } from "@/src/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/src/components/ui/tabs";
import { Badge } from "@/src/components/ui/badge";
import { Toaster } from "@/src/components/ui/sonner";
import { toast } from "sonner";
import { motion, AnimatePresence } from "motion/react";
import { 
  encodeTextToAudio,
  decodeAudioToText,
  audioBufferToWav,
  MODEM_CONFIG
} from "@/src/lib/audioModem";

export default function App() {
  const [inputText, setInputText] = useState("");
  const [decodedText, setDecodedText] = useState("");
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<'prompt' | 'granted' | 'denied' | 'unknown'>('unknown');
  const [isPlaying, setIsPlaying] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const listenerNodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const sampleBufRef = useRef<Float32Array>(new Float32Array(0));
  const decodePendingRef = useRef(false);
  const decodeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Check permission status if API is available
    if (navigator.permissions && (navigator.permissions as any).query) {
      navigator.permissions.query({ name: 'microphone' as any })
        .then((result) => {
          setPermissionStatus(result.state as any);
          result.onchange = () => {
            setPermissionStatus(result.state as any);
          };
        })
        .catch(() => setPermissionStatus('unknown'));
    }

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (decodeIntervalRef.current) clearInterval(decodeIntervalRef.current);
      listenerNodeRef.current?.disconnect();
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (audioContextRef.current) audioContextRef.current.close();
    };
  }, []);

  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 2048;
    }
  };

  const handleGenerate = async () => {
    if (!inputText) {
      toast.error("Please enter some text to encode.");
      return;
    }

    initAudio();
    const ctx = audioContextRef.current!;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    
    try {
      setIsTransmitting(true);
      const buffer = await encodeTextToAudio(inputText, ctx);
      setAudioBuffer(buffer);
      toast.success("Audio generated successfully!");
    } catch (error) {
      console.error(error);
      toast.error("Failed to generate audio.");
    } finally {
      setIsTransmitting(false);
    }
  };

  const handlePlay = async () => {
    if (!audioBuffer) return;
    initAudio();
    const ctx = audioContextRef.current!;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch (e) {}
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.loop = true;
    source.connect(analyserRef.current!);
    analyserRef.current!.connect(ctx.destination);

    source.onended = () => setIsPlaying(false);

    setIsPlaying(true);
    source.start();
    sourceRef.current = source;
    startVisualizer();
  };

  const handleStop = () => {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch (e) {}
    }
    setIsPlaying(false);
  };

  const handleDownload = () => {
    if (!audioBuffer) return;
    const wavBlob = audioBufferToWav(audioBuffer);
    const url = URL.createObjectURL(wavBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sonic-message-${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Download started.");
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    initAudio();
    const ctx = audioContextRef.current!;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = await ctx.decodeAudioData(arrayBuffer);
      const text = await decodeAudioToText(buffer);
      setDecodedText(text);
      toast.success("File decoded successfully!");
    } catch (error) {
      console.error(error);
      toast.error("Failed to decode file. Make sure it's a valid sonic message.");
    }
  };

  const toggleListen = async () => {
    if (isListening) {
      setIsListening(false);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (decodeIntervalRef.current) clearInterval(decodeIntervalRef.current);
      listenerNodeRef.current?.disconnect();
      listenerNodeRef.current = null;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      sampleBufRef.current = new Float32Array(0);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast.error("Your browser does not support microphone access.");
      return;
    }

    try {
      initAudio();
      const ctx = audioContextRef.current!;
      if (ctx.state === 'suspended') await ctx.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const micSource = ctx.createMediaStreamSource(stream);
      micSource.connect(analyserRef.current!);

      sampleBufRef.current = new Float32Array(0);
      decodePendingRef.current = false;

      // Accumulate raw PCM into a rolling 8-second buffer
      const onSamples = (chunk: Float32Array) => {
        const prev = sampleBufRef.current;
        const merged = new Float32Array(prev.length + chunk.length);
        merged.set(prev);
        merged.set(chunk, prev.length);
        const maxSamples = ctx.sampleRate * 8;
        sampleBufRef.current = merged.length > maxSamples
          ? merged.slice(merged.length - maxSamples)
          : merged;
      };

      // Attempt a decode every 500 ms against accumulated PCM
      decodeIntervalRef.current = setInterval(async () => {
        if (decodePendingRef.current) return;
        const samples = sampleBufRef.current;
        if (samples.length < ctx.sampleRate * 1) return;
        decodePendingRef.current = true;
        try {
          const audioBuf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
          audioBuf.copyToChannel(samples, 0);
          const text = await decodeAudioToText(audioBuf);
          if (text) {
            setDecodedText(text);
            toast.success('Message received!');
            sampleBufRef.current = new Float32Array(0);
          }
        } catch (_) {
          // ignore decode errors
        } finally {
          decodePendingRef.current = false;
        }
      }, 500);

      // Try AudioWorklet; fall back to ScriptProcessorNode for older browsers
      try {
        await ctx.audioWorklet.addModule('/chirp-processor.js');
        const workletNode = new AudioWorkletNode(ctx, 'chirp-stream-processor');
        workletNode.port.onmessage = (e: MessageEvent) => {
          if (e.data instanceof Float32Array) onSamples(e.data);
        };
        micSource.connect(workletNode);
        listenerNodeRef.current = workletNode;
      } catch (_workletErr) {
        console.warn('AudioWorklet unavailable, using ScriptProcessorNode fallback');
        const spn = ctx.createScriptProcessor(4096, 1, 1);
        spn.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0).slice());
        micSource.connect(spn);
        spn.connect(ctx.destination);
        listenerNodeRef.current = spn;
      }

      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
      setIsListening(true);
      startVisualizer();
      toast.info("Listening — will decode as soon as a message is detected.");
    } catch (error: any) {
      console.error("Mic Error:", error);
      let message = "Microphone access denied.";
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        message = "Permission denied. Click the mic icon in the address bar and allow access.";
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        message = "No microphone found on your device.";
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        message = "Microphone is already in use by another application.";
      }
      toast.error(message, { duration: 6000 });
    }
  };

  const startVisualizer = () => {
    if (!canvasRef.current || !analyserRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d")!;
    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.fillStyle = "rgb(10, 10, 10)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2;

        const freq = (i * audioContextRef.current!.sampleRate) / analyser.fftSize;
        const isModemFreq = freq >= MODEM_CONFIG.BASE_FREQ - 500 && freq <= MODEM_CONFIG.END_FREQ + 500;

        if (isModemFreq) {
          ctx.fillStyle = `rgb(0, 255, 100)`;
          ctx.shadowBlur = 10;
          ctx.shadowColor = "rgba(0, 255, 100, 0.5)";
        } else {
          ctx.fillStyle = `rgb(50, 50, 50)`;
          ctx.shadowBlur = 0;
        }

        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    };

    draw();
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-mono selection:bg-green-500 selection:text-black p-4 md:p-8">
      <Toaster position="top-center" theme="dark" />
      
      <div className="max-w-5xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/10 pb-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="outline" className="text-green-500 border-green-500/50 animate-pulse">
                SYSTEM ACTIVE
              </Badge>
              <Badge variant="outline" className="text-white/50 border-white/20">
                v1.0.4-STABLE
              </Badge>
            </div>
            <h1 className="text-4xl md:text-6xl font-bold tracking-tighter">
              SONIC<span className="text-green-500">MODEM</span>
            </h1>
            <p className="text-white/50 mt-2 max-w-md">
              Acoustic data transmission protocol.
              Encode text into audible sound waves and decode them back.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-white/30">
            <div className="flex flex-col items-end">
              <span>BASE FREQ</span>
              <span className="text-white font-bold">{MODEM_CONFIG.BASE_FREQ} Hz</span>
            </div>
            <div className="h-8 w-px bg-white/10" />
            <div className="flex flex-col items-end">
              <span>BIT RATE</span>
              <span className="text-white font-bold">{Math.round(1 / MODEM_CONFIG.BIT_DURATION)} bps</span>
            </div>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-7 space-y-6">
            <Card className="bg-black/40 border-white/10 backdrop-blur-xl overflow-hidden">
              <CardHeader className="border-b border-white/5 bg-white/5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-green-500" />
                    <CardTitle className="text-sm uppercase tracking-widest">Spectral Analysis</CardTitle>
                  </div>
                  <div className="flex gap-1">
                    {[1, 2, 3].map(i => (
                      <div key={`status-dot-${i}`} className="w-1.5 h-1.5 rounded-full bg-white/20" />
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="relative aspect-video bg-black">
                  <canvas 
                    ref={canvasRef} 
                    width={800} 
                    height={400} 
                    className="w-full h-full"
                  />
                  <div className="absolute top-4 right-4 flex flex-col gap-2 items-end">
                    <div className="flex items-center gap-2 text-[10px] text-white/40">
                      <div className="w-2 h-2 bg-green-500 rounded-full" />
                      MODEM BAND (1.8-2.6kHz)
                    </div>
                    {isListening && (
                      <div className="flex items-center gap-2 bg-red-500/20 border border-red-500/40 rounded px-2 py-1">
                        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-red-400 font-mono text-[11px] font-bold">
                          REC {String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:{String(recordSeconds % 60).padStart(2, '0')}
                        </span>
                      </div>
                    )}
                  </div>
                  
                  {!isListening && !isTransmitting && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                      <div className="text-center space-y-4">
                        <div className="flex justify-center">
                          <Volume2 className="w-12 h-12 text-white/20" />
                        </div>
                        <p className="text-sm text-white/40">ANALYSER STANDBY</p>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="border-white/20 hover:bg-white/10"
                          onClick={toggleListen}
                        >
                          {isListening ? "STOP LISTENING" : "START ANALYSER"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
              <CardFooter className="bg-white/5 border-t border-white/5 p-4 flex justify-between text-[10px] text-white/40">
                <div className="flex gap-4">
                  <span>FFT_SIZE: 2048</span>
                  <span>WINDOW: HANNING</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-white/20'}`} />
                  {isListening ? 'LIVE FEED' : 'IDLE'}
                </div>
              </CardFooter>
            </Card>

            <div className="grid grid-cols-2 gap-4">
              <Card className="bg-black/40 border-white/10">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-xs uppercase text-white/40">System Log</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <div className="h-32 overflow-y-auto text-[10px] space-y-1 font-mono text-green-500/70">
                    <div>[09:42:01] Initializing AudioContext...</div>
                    <div>[09:42:02] Sample rate: 44100Hz</div>
                    <div>[09:42:02] FFT ready.</div>
                    {isTransmitting && <div>[09:45:12] TRANSMITTING DATA...</div>}
                    {isListening && <div>[09:46:05] LISTENING ON CHANNEL 0...</div>}
                    {decodedText && <div>[09:47:22] DECODE COMPLETE.</div>}
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-black/40 border-white/10">
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-xs uppercase text-white/40">Protocol Info</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0 space-y-2">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-white/40">ENCODING</span>
                    <span>FSK-2</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-white/40">MODULATION</span>
                    <span>BINARY</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-white/40">ERROR_CORR</span>
                    <span>NONE</span>
                  </div>
                  <div className="pt-2">
                    <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-green-500"
                        initial={{ width: 0 }}
                        animate={{ width: (isTransmitting || isPlaying) ? "100%" : "0%" }}
                        transition={{ duration: isPlaying ? 1 : (audioBuffer?.duration || 0), repeat: isPlaying ? Infinity : 0 }}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="lg:col-span-5 space-y-6">
            <Tabs defaultValue="transmit" className="w-full">
              <TabsList className="w-full bg-white/5 border border-white/10 p-1">
                <TabsTrigger value="transmit" className="flex-1 gap-2 data-[state=active]:bg-white/10">
                  <Radio className="w-4 h-4" /> TRANSMIT
                </TabsTrigger>
                <TabsTrigger value="receive" className="flex-1 gap-2 data-[state=active]:bg-white/10">
                  <Download className="w-4 h-4" /> RECEIVE
                </TabsTrigger>
              </TabsList>

              <AnimatePresence mode="wait">
                <TabsContent key="transmit" value="transmit" className="mt-6 space-y-6">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="message" className="text-xs uppercase tracking-widest text-white/40">Message Payload</Label>
                      <div className="relative">
                        <Terminal className="absolute left-3 top-3 w-4 h-4 text-white/20" />
                        <textarea
                          id="message"
                          placeholder="Enter text to transmit..."
                          className="w-full h-32 bg-black border border-white/10 rounded-lg p-3 pl-10 text-sm focus:outline-none focus:border-green-500/50 transition-colors resize-none"
                          value={inputText}
                          onChange={(e) => setInputText(e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <Button
                        onClick={handleGenerate}
                        disabled={isTransmitting || isPlaying || !inputText}
                        className="bg-white text-black hover:bg-white/90 font-bold"
                      >
                        {isTransmitting ? "ENCODING..." : "ENCODE"}
                      </Button>
                      {isPlaying ? (
                        <Button
                          variant="outline"
                          onClick={handleStop}
                          className="border-red-500/50 hover:bg-red-500/5 gap-2 text-red-400"
                        >
                          <Square className="w-4 h-4" /> STOP
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          onClick={handlePlay}
                          disabled={!audioBuffer || isTransmitting}
                          className="border-white/10 hover:bg-white/5 gap-2"
                        >
                          <Play className="w-4 h-4" /> PLAY LOOP
                        </Button>
                      )}
                    </div>

                    {audioBuffer && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center">
                            <Volume2 className="w-5 h-5 text-green-500" />
                          </div>
                          <div>
                            <p className="text-xs font-bold text-green-500">READY TO TRANSMIT</p>
                            <p className="text-[10px] text-green-500/60">{audioBuffer.duration.toFixed(2)}s • {audioBuffer.length} samples</p>
                          </div>
                        </div>
                        <Button size="icon" variant="ghost" className="text-green-500 hover:bg-green-500/20" onClick={handleDownload}>
                          <Download className="w-4 h-4" />
                        </Button>
                      </motion.div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent key="receive" value="receive" className="mt-6 space-y-6">
                  <div className="space-y-4">
                    <div className="p-8 border-2 border-dashed border-white/10 rounded-xl flex flex-col items-center justify-center text-center space-y-4 hover:border-white/20 transition-colors relative group">
                      <input 
                        type="file" 
                        accept="audio/*" 
                        className="absolute inset-0 opacity-0 cursor-pointer" 
                        onChange={handleFileUpload}
                      />
                      <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-white/10 transition-colors">
                        <Upload className="w-6 h-6 text-white/40" />
                      </div>
                      <div>
                        <p className="text-sm font-bold">Upload Audio File</p>
                        <p className="text-xs text-white/40 mt-1">WAV or MP3 containing sonic data</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="h-px flex-1 bg-white/10" />
                      <span className="text-[10px] text-white/20 uppercase tracking-widest">OR</span>
                      <div className="h-px flex-1 bg-white/10" />
                    </div>

                    <Button
                      variant="outline"
                      className={`w-full h-16 border-white/10 hover:bg-white/5 gap-3 ${isListening ? 'border-red-500/50 bg-red-500/5' : ''}`}
                      onClick={toggleListen}
                    >
                      {isListening ? (
                        <>
                          <MicOff className="w-5 h-5 text-red-500" />
                          <div className="text-left flex-1">
                            <div className="text-sm font-bold text-red-500">STOP LISTENING</div>
                            <div className="text-[10px] text-red-500/60 uppercase">Decoding continuously</div>
                          </div>
                          <div className="flex items-center gap-1.5 ml-auto">
                            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-red-400 font-mono text-xs font-bold">
                              {String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:{String(recordSeconds % 60).padStart(2, '0')}
                            </span>
                          </div>
                        </>
                      ) : (
                        <>
                          <Mic className={`w-5 h-5 ${permissionStatus === 'granted' ? 'text-green-500' : 'text-white/40'}`} />
                          <div className="text-left">
                            <div className="text-sm font-bold">START LIVE DECODER</div>
                            <div className="text-[10px] text-white/40 uppercase">
                              Status: {permissionStatus}
                            </div>
                          </div>
                        </>
                      )}
                    </Button>

                    {permissionStatus === 'denied' && (
                      <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                        <p className="text-[10px] text-red-500 leading-tight">
                          <span className="font-bold">PERMISSION BLOCKED:</span> Microphone access is restricted. 
                          Please click the "Open in New Tab" icon in the top-right of this preview to use the live decoder.
                        </p>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label className="text-xs uppercase tracking-widest text-white/40">Decoded Output</Label>
                      <div className="w-full min-h-32 bg-black border border-white/10 rounded-lg p-4 font-mono text-sm text-green-500">
                        {decodedText ? (
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                          >
                            {decodedText}
                          </motion.div>
                        ) : (
                          <span className="text-white/10 italic">{isListening ? "Listening for signal…" : "Waiting for signal..."}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </AnimatePresence>
            </Tabs>

            <Card className="bg-white/5 border-white/10">
              <CardHeader className="p-4 pb-2">
                <div className="flex items-center gap-2">
                  <Info className="w-4 h-4 text-white/40" />
                  <CardTitle className="text-xs uppercase text-white/40">Technical Specs & Help</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-4 pt-0 space-y-4">
                <p className="text-[10px] text-white/40 leading-relaxed">
                  This modem uses <span className="text-white">Frequency Shift Keying</span>.
                  Data is encoded into two distinct frequencies (1800Hz and 2200Hz).
                  A 4-bit preamble synchronizes the receiver.
                  Audible frequencies ensure compatibility across all speakers and microphones.
                </p>
                <div className="pt-2 border-t border-white/5">
                  <p className="text-[10px] font-bold text-green-500/70 mb-1 uppercase tracking-tighter">Permission Troubleshooting:</p>
                  <ul className="text-[9px] text-white/30 space-y-1 list-disc pl-3">
                    <li>Ensure you are using <span className="text-white/50">HTTPS</span>.</li>
                    <li>Check the <span className="text-white/50">Address Bar</span> for a blocked mic icon.</li>
                    <li>If on mobile, ensure the browser has system-level mic permissions.</li>
                    <li>Try opening the app in a <span className="text-white/50">New Tab</span> if the iframe blocks access.</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          </div>
        </main>

        <footer className="border-t border-white/10 pt-8 pb-12 flex flex-col md:flex-row justify-between items-center gap-4 text-[10px] text-white/30 uppercase tracking-widest">
          <div className="flex items-center gap-4">
            <span>© 2026 SONIC-LABS</span>
            <div className="w-1 h-1 rounded-full bg-white/20" />
            <span>ENCRYPTED_LINK_ESTABLISHED</span>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span>TX_READY</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span>RX_READY</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
