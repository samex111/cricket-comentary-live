"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API } from "@/lib/api";

type Frame = { timestampMs: number; jpegBase64: string };
type AudioBlock = { timestampMs: number; samples: Float32Array };
type FeedEvent = { eventId: string; epoch: number; startMs: number; eventType: string; commentaryText: string; confidence: number };
type AudioMessage = { eventId: string; epoch: number; startMs: number; commentaryText: string; audio: ArrayBuffer | Uint8Array };
type VideoWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function wavBlob(samples: Float32Array, sampleRate: number) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true); offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
function resample(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}
const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};

export function LivePlayer({ videoId, title }: { videoId: string; title: string }) {
  const videoRef = useRef<VideoWithFrameCallbacks>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef("");
  const epochRef = useRef(0);
  const framesRef = useRef<Frame[]>([]);
  const audioBlocksRef = useRef<AudioBlock[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const queueRef = useRef<string[]>([]);
  const urlsRef = useRef<string[]>([]);
  const [status, setStatus] = useState("READY");
  const [positionMs, setPositionMs] = useState(0);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [message, setMessage] = useState("Create a playback session to begin");
  const [error, setError] = useState("");

  const clearSpeech = useCallback(() => {
    queueRef.current = [];
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.removeAttribute("src"); audioRef.current.load(); }
    urlsRef.current.forEach(URL.revokeObjectURL);
    urlsRef.current = [];
  }, []);

  const playQueuedSpeech = useCallback(() => {
    const player = audioRef.current;
    if (!player || !player.paused || !queueRef.current.length) return;
    player.src = queueRef.current.shift()!;
    void player.play().catch(() => setError("Tap Play once more to allow generated commentary audio."));
  }, []);

  const connectAudioCapture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || sourceRef.current) return;
    const context = new AudioContext();
    const source = context.createMediaElementSource(video);
    const processor = context.createScriptProcessor(4096, 1, 1);
    source.connect(context.destination);
    source.connect(processor);
    processor.connect(context.destination);
    processor.onaudioprocess = event => {
      if (video.paused || !sessionRef.current) return;
      audioBlocksRef.current.push({ timestampMs: Math.max(0, Math.round(video.currentTime * 1000)), samples: new Float32Array(event.inputBuffer.getChannelData(0)) });
      if (audioBlocksRef.current.length > 64) audioBlocksRef.current.splice(0, 16);
    };
    audioContextRef.current = context;
    sourceRef.current = source;
    await context.resume();
  }, []);

  const sendWindow = useCallback(() => {
    const video = videoRef.current;
    const socket = socketRef.current;
    if (!video || video.paused || status !== "PLAYING" || !socket?.connected || !sessionRef.current) return;
    const frames = framesRef.current.splice(0, 6);
    const audioBlocks = audioBlocksRef.current.splice(0);
    const firstFrame = frames[0];
    if (!firstFrame) return;
    const sampleCount = audioBlocks.reduce((sum, block) => sum + block.samples.length, 0);
    const joined = new Float32Array(sampleCount);
    let offset = 0;
    for (const block of audioBlocks) { joined.set(block.samples, offset); offset += block.samples.length; }
    const firstTimestamp = Math.min(firstFrame.timestampMs, audioBlocks[0]?.timestampMs ?? firstFrame.timestampMs);
    const endMs = Math.max(firstTimestamp + 1, Math.round(video.currentTime * 1000));
    const audioPromise = sampleCount
      ? wavBlob(resample(joined, audioContextRef.current?.sampleRate ?? 48000, 16000), 16000).arrayBuffer()
      : Promise.resolve(null);
    void audioPromise.then(wav => {
      if (video.paused || !socket.connected) return;
      let audioWavBase64: string | undefined;
      if (wav) {
        const bytes = new Uint8Array(wav);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        audioWavBase64 = btoa(binary);
      }
      socket.emit("media:window", {
        epoch: epochRef.current, startMs: firstTimestamp, endMs,
        frames: frames.filter(frame => frame.timestampMs >= firstTimestamp && frame.timestampMs <= endMs),
        ...(audioWavBase64 ? { audioWavBase64 } : {}),
      }, (ack: { accepted: boolean; reason?: string }) => {
        setMessage(ack?.accepted ? "Gemini analysing synchronized audio + video" : (ack?.reason ?? "Window skipped"));
      });
    });
  }, [status]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch(`${API}/videos/${videoId}/playback-sessions`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ positionMs: 0 }),
        });
        if (!response.ok) throw new Error((await response.json()).error ?? "Could not create playback session");
        const session = await response.json() as { id: string; epoch: number; status: string };
        if (disposed) return;
        sessionRef.current = session.id; epochRef.current = session.epoch;
        const socket = io(API.replace(/\/v1$/, ""), { auth: { sessionId: session.id }, transports: ["websocket"] });
        socketRef.current = socket;
        socket.on("playback:ready", (data: { epoch: number; status: string }) => { epochRef.current = data.epoch; setStatus(data.status); setMessage("Session connected"); });
        socket.on("playback:error", (data: { message: string }) => setError(data.message));
        socket.on("commentary:event", (event: FeedEvent) => {
          if (event.epoch === epochRef.current) setEvents(old => [event, ...old].slice(0, 40));
        });
        socket.on("commentary:audio", (event: AudioMessage) => {
          const video = videoRef.current;
          if (event.epoch !== epochRef.current || !video || event.startMs < video.currentTime * 1000 - 8000) return;
          const url = URL.createObjectURL(new Blob([event.audio as BlobPart], { type: "audio/wav" }));
          urlsRef.current.push(url); queueRef.current.push(url); playQueuedSpeech();
        });
        socket.on("playback:control", (control: { type: string; epoch: number }) => {
          epochRef.current = control.epoch;
          if (control.type === "SEEK" || control.type === "STOP") {
            clearSpeech(); framesRef.current = []; audioBlocksRef.current = [];
          }
        });
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Session initialization failed"); }
    })();
    return () => { disposed = true; socketRef.current?.disconnect(); socketRef.current = null; };
  }, [videoId, clearSpeech, playQueuedSpeech]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let handle = 0;
    let lastCaptureMs = -500;
    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      const timestampMs = Math.round(metadata.mediaTime * 1000);
      if (!video.paused && status === "PLAYING" && timestampMs - lastCaptureMs >= 500) {
        const canvas = canvasRef.current;
        if (canvas) {
          const width = Math.min(640, video.videoWidth || 640);
          const height = Math.max(1, Math.round(width * (video.videoHeight || 360) / (video.videoWidth || 640)));
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
          const jpegBase64 = canvas.toDataURL("image/jpeg", 0.65).split(",")[1];
          if (jpegBase64) framesRef.current.push({ timestampMs, jpegBase64 });
          if (framesRef.current.length > 8) framesRef.current.shift();
          lastCaptureMs = timestampMs;
        }
      }
      if (video.requestVideoFrameCallback) handle = video.requestVideoFrameCallback(onFrame);
    };
    if (video.requestVideoFrameCallback) handle = video.requestVideoFrameCallback(onFrame);
    const timer = setInterval(sendWindow, 2500);
    return () => { if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle); clearInterval(timer); };
  }, [sendWindow, status]);

  useEffect(() => () => {
    clearSpeech(); sourceRef.current?.disconnect(); void audioContextRef.current?.close();
    const id = sessionRef.current;
    if (id) void fetch(`${API}/playback-sessions/${id}/stop`, { method: "POST" }).catch(() => undefined);
  }, [clearSpeech]);

  const play = async () => {
    const video = videoRef.current;
    if (!video || !sessionRef.current) return;
    try {
      await connectAudioCapture();
      await audioContextRef.current?.resume();
      await fetch(`${API}/playback-sessions/${sessionRef.current}/resume`, { method: "POST" });
      setStatus("PLAYING");
      if (audioRef.current?.src) void audioRef.current.play().catch(() => undefined);
      await video.play();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start playback"); }
  };
  const pause = async () => {
    const video = videoRef.current;
    if (!video || !sessionRef.current) return;
    video.pause(); audioRef.current?.pause(); setStatus("PAUSED");
    await fetch(`${API}/playback-sessions/${sessionRef.current}/pause`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionMs: Math.round(video.currentTime * 1000) }),
    });
  };
  const seek = async () => {
    const video = videoRef.current;
    if (!video || !sessionRef.current) return;
    clearSpeech(); framesRef.current = []; audioBlocksRef.current = [];
    const response = await fetch(`${API}/playback-sessions/${sessionRef.current}/seek`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionMs: Math.round(video.currentTime * 1000) }),
    });
    if (response.ok) { const session = await response.json(); epochRef.current = session.epoch; }
  };
  const stop = async () => {
    videoRef.current?.pause(); clearSpeech(); setStatus("STOPPED");
    if (sessionRef.current) await fetch(`${API}/playback-sessions/${sessionRef.current}/stop`, { method: "POST" });
  };

  return <section className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{title}</h2><p className="text-xs text-neutral-500">Live multimodal commentary · original match audio + video frames</p></div>
      <span className="text-xs text-neutral-400">{status} · {clock(positionMs)}</span>
    </header>
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-black">
      <video ref={videoRef} crossOrigin="anonymous" playsInline src={`${API}/videos/${videoId}/stream`} className="aspect-video w-full" onTimeUpdate={event => setPositionMs(Math.round(event.currentTarget.currentTime * 1000))} onSeeking={() => void seek()} onEnded={() => void stop()} />
    </div>
    <div className="flex flex-wrap gap-2">
      <button onClick={() => void play()} disabled={status === "STOPPED"} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black">Play / Resume</button>
      <button onClick={() => void pause()} className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">Pause</button>
      <button onClick={() => void stop()} className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">Stop</button>
      <span className="self-center text-xs text-neutral-500">{message}</span>
    </div>
    {error && <p className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-200">{error}</p>}
    <div className="rounded-xl border border-neutral-800">
      <div className="border-b border-neutral-800 px-4 py-3 text-xs uppercase tracking-widest text-neutral-500">Live AI commentary</div>
      <div className="max-h-72 space-y-2 overflow-y-auto p-3">
        {events.map(event => <article key={event.eventId} className="rounded-lg bg-neutral-900 p-3">
          <div className="mb-1 flex justify-between text-[10px] text-neutral-500"><span>{clock(event.startMs)} · {event.eventType}</span><span>{Math.round(event.confidence * 100)}%</span></div>
          <p className="text-sm">{event.commentaryText}</p>
        </article>)}
        {!events.length && <p className="py-8 text-center text-xs text-neutral-600">Play the match to start multimodal commentary.</p>}
      </div>
    </div>
    <audio ref={audioRef} className="hidden" onEnded={playQueuedSpeech} />
    <canvas ref={canvasRef} className="hidden" />
  </section>;
}
