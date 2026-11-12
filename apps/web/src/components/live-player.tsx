"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API } from "@/lib/api";

type VideoWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};
type LiveEvent = {
  eventId: string;
  epoch: number;
  startMs: number;
  endMs: number;
  eventType: string;
  commentaryText: string;
  confidence: number;
};
type LiveAudioMessage = {
  epoch: number;
  sequence: number;
  sampleRate: number;
  matchPositionMs: number;
  generatedAtMs: number;
  audio: ArrayBuffer | Uint8Array | number[] | { type: "Buffer"; data: number[] };
};
type LiveStatus = "READY" | "PLAYING" | "PAUSED" | "STOPPED" | "CONNECTING" | "RECONNECTING" | "FAILED";
type WorkletMessage = { type: "audio"; pcm: ArrayBuffer };
type LiveMetrics = {
  epoch: number;
  uptimeMs: number;
  audioChunksIn: number;
  audioBytesIn: number;
  geminiVideoFramesIn: number;
  visionFramesIn: number;
  visionCandidates: number;
  visionInferenceMsLast: number;
  audioChunksOut: number;
  reconnects: number;
};

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};

function audioArrayBuffer(value: LiveAudioMessage["audio"]): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(value)) return new Uint8Array(value).buffer;
  if (value && typeof value === "object" && "data" in value && Array.isArray(value.data)) {
    return new Uint8Array(value.data).buffer;
  }
  return null;
}

async function waitForSocket(socket: Socket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Realtime socket connection timed out"));
    }, 8_000);
    const connected = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("Realtime socket connection failed")); };
    const cleanup = () => {
      window.clearTimeout(timeout);
      socket.off("connect", connected);
      socket.off("connect_error", failed);
    };
    socket.on("connect", connected);
    socket.on("connect_error", failed);
    socket.connect();
  });
}

export function LivePlayer({ videoId, title }: { videoId: string; title: string }) {
  const videoRef = useRef<VideoWithFrameCallbacks>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef("");
  const epochRef = useRef(0);
  const statusRef = useRef<LiveStatus>("READY");
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const [status, setStatus] = useState<LiveStatus>("READY");
  const [positionMs, setPositionMs] = useState(0);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [transcript, setTranscript] = useState("");
  const [message, setMessage] = useState("Create a live commentary session to begin");
  const [error, setError] = useState("");
  const [visionStatus, setVisionStatus] = useState("Checking local vision detector");
  const [audioLatencyMs, setAudioLatencyMs] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null);

  const setLiveStatus = useCallback((next: LiveStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const clearCommentaryAudio = useCallback(() => {
    workletRef.current?.port.postMessage({ type: "clear" });
  }, []);

  const connectAudioGraph = useCallback(async () => {
    const video = videoRef.current;
    if (!video) throw new Error("Video player is not ready");
    if (audioContextRef.current && workletRef.current) {
      await audioContextRef.current.resume();
      workletRef.current.port.postMessage({ type: "start" });
      return;
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    await context.audioWorklet.addModule("/cricket-live-audio.js");
    const source = context.createMediaElementSource(video);
    const worklet = new AudioWorkletNode(context, "cricket-live-audio", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    source.connect(worklet);
    worklet.connect(context.destination);
    worklet.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      if (event.data?.type !== "audio" || statusRef.current !== "PLAYING") return;
      const socket = socketRef.current;
      if (socket?.connected) socket.emit("live:audio", event.data.pcm);
    };
    audioContextRef.current = context;
    mediaSourceRef.current = source;
    workletRef.current = worklet;
    await context.resume();
    worklet.port.postMessage({ type: "start" });
  }, []);

  const startLiveSession = useCallback(async () => {
    const socket = socketRef.current;
    const sessionId = sessionRef.current;
    if (!socket || !sessionId) throw new Error("Playback session is not connected");
    await waitForSocket(socket);
    const response = await fetch(`${API}/playback-sessions/${sessionId}/live/start`, { method: "POST" });
    const payload = await response.json().catch(() => ({})) as { error?: string; connected?: boolean; model?: string };
    if (!response.ok) throw new Error(payload.error ?? "Could not connect Gemini Live");
    setMessage(payload.connected ? `Gemini Live connected · ${payload.model ?? "Live model"}` : "Connecting Gemini Live...");
  }, []);

  useEffect(() => {
    let disposed = false;
    let socket: Socket | null = null;
    void (async () => {
      try {
        const response = await fetch(`${API}/videos/${videoId}/playback-sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ positionMs: 0 }),
        });
        if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "Could not create playback session");
        const session = await response.json() as { id: string; epoch: number; status: string };
        if (disposed) return;
        sessionRef.current = session.id;
        epochRef.current = session.epoch;
        socket = io(API.replace(/\/v1$/, ""), {
          auth: { sessionId: session.id },
          transports: ["websocket"],
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 400,
          reconnectionDelayMax: 4_000,
        });
        socketRef.current = socket;
        socket.on("connect", () => {
          setError("");
          setMessage("Realtime transport connected");
          if (statusRef.current === "PLAYING") void startLiveSession().catch((cause) => {
            setError(cause instanceof Error ? cause.message : "Could not restore Gemini Live");
          });
        });
        socket.on("playback:ready", (data: { epoch: number; status: string; currentPositionMs: number }) => {
          epochRef.current = data.epoch;
          setPositionMs(data.currentPositionMs ?? 0);
          if (data.status === "PAUSED") setLiveStatus("PAUSED");
          setMessage("Playback session connected");
        });
        socket.on("live:status", (data: { state?: string; model?: string; reason?: string }) => {
          if (data.state === "connected") {
            setLiveStatus("PLAYING");
            setMessage(`Live session connected · ${data.model ?? "Gemini Live"}`);
          } else if (data.state === "reconnecting") {
            setLiveStatus("RECONNECTING");
            setMessage("Reconnecting Gemini Live session...");
          } else if (data.state === "client-disconnected") {
            setMessage("Browser reconnected; preserving match session");
          } else if (data.state === "idle") {
            setMessage("Ready to start Gemini Live");
          }
        });
        socket.on("live:metrics", (event: LiveMetrics) => {
          if (event.epoch === epochRef.current) setMetrics(event);
        });
        socket.on("live:audio", (event: LiveAudioMessage) => {
          if (event.epoch !== epochRef.current || statusRef.current !== "PLAYING") return;
          const ageMs = Date.now() - event.generatedAtMs;
          if (Number.isFinite(ageMs) && ageMs > 4_000) return;
          const pcm = audioArrayBuffer(event.audio);
          if (!pcm || !workletRef.current) return;
          workletRef.current.port.postMessage({ type: "enqueue", pcm }, [pcm]);
          if (Number.isFinite(ageMs) && ageMs >= 0) setAudioLatencyMs(Math.round(ageMs));
        });
        socket.on("live:transcript", (event: { epoch: number; fullText: string; matchPositionMs: number }) => {
          if (event.epoch === epochRef.current) setTranscript(event.fullText ?? "");
        });
        socket.on("live:turn-complete", () => setTranscript(""));
        socket.on("live:interrupt", () => clearCommentaryAudio());
        socket.on("commentary:event", (event: LiveEvent) => {
          if (event.epoch === epochRef.current) {
            setEvents((current) => [event, ...current.filter((item) => item.eventId !== event.eventId)]
              .sort((a, b) => b.startMs - a.startMs)
              .slice(0, 50));
          }
        });
        socket.on("live:vision", (event: { candidateEvents: Array<{ type: string }>; inferenceMs: number }) => {
          const candidates = event.candidateEvents.map((item) => item.type).join(", ");
          setVisionStatus(`Vision active · ${event.inferenceMs} ms${candidates ? ` · ${candidates}` : ""}`);
        });
        socket.on("live:vision-status", (event: { available: boolean; message?: string }) => {
          setVisionStatus(event.available ? "Vision detector online" : "Vision unavailable · audio + Gemini video continue");
          if (!event.available && event.message) setMessage(event.message);
        });
        socket.on("live:error", (event: { message: string }) => setError(event.message));
        socket.on("disconnect", () => {
          if (statusRef.current === "PLAYING") setMessage("Realtime transport disconnected; reconnecting...");
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Session initialization failed");
        setLiveStatus("FAILED");
      }
    })();
    return () => {
      disposed = true;
      socket?.disconnect();
      socketRef.current = null;
      clearCommentaryAudio();
      workletRef.current?.disconnect();
      mediaSourceRef.current?.disconnect();
      workletRef.current = null;
      mediaSourceRef.current = null;
      void audioContextRef.current?.close();
      audioContextRef.current = null;
      const id = sessionRef.current;
      if (id) void fetch(`${API}/playback-sessions/${id}/stop`, { method: "POST" }).catch(() => undefined);
    };
  }, [videoId, clearCommentaryAudio, setLiveStatus, startLiveSession]);

  useEffect(() => {
    const video = videoRef.current;
    const socket = socketRef.current;
    if (!video || !socket) return;
    let frameHandle = 0;
    let lastVisionCaptureAt = -1_000;
    let lastGeminiCaptureAt = -1_000;

    const captureFrame = (timestampMs: number) => {
      if (statusRef.current !== "PLAYING" || video.paused || !socket.connected) return;
      const now = timestampMs;
      if (now - lastVisionCaptureAt < 100 && now >= lastVisionCaptureAt) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const sourceWidth = video.videoWidth || 640;
      const sourceHeight = video.videoHeight || 360;
      const width = Math.min(640, sourceWidth);
      const height = Math.max(1, Math.round(width * sourceHeight / sourceWidth));
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
      const jpegBase64 = canvas.toDataURL("image/jpeg", 0.5).split(",")[1];
      if (!jpegBase64) return;

      if (now - lastVisionCaptureAt >= 100 || now < lastVisionCaptureAt) {
        socket.emit("live:vision-frame", { timestampMs, jpegBase64 });
        lastVisionCaptureAt = now;
      }
      if (now - lastGeminiCaptureAt >= 1_000 || now < lastGeminiCaptureAt) {
        socket.emit("live:video", { timestampMs, jpegBase64 });
        lastGeminiCaptureAt = now;
      }
    };

    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      captureFrame(Math.round(metadata.mediaTime * 1000));
      if (video.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    if (video.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onFrame);
    const fallbackTimer = video.requestVideoFrameCallback ? null : window.setInterval(() => {
      if (!video.paused) captureFrame(Math.round(video.currentTime * 1000));
    }, 100);
    const syncTimer = window.setInterval(() => {
      socket.emit("live:sync", {
        positionMs: Math.round(video.currentTime * 1000),
        playbackRate: video.playbackRate,
        playing: !video.paused,
      });
    }, 250);

    return () => {
      if (frameHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
      window.clearInterval(syncTimer);
    };
  }, [videoId, status]);

  const play = async () => {
    const video = videoRef.current;
    const socket = socketRef.current;
    const sessionId = sessionRef.current;
    if (!video || !socket || !sessionId) return;
    setError("");
    setLiveStatus("CONNECTING");
    try {
      await connectAudioGraph();
      const resume = await fetch(`${API}/playback-sessions/${sessionId}/resume`, { method: "POST" });
      if (!resume.ok) throw new Error(((await resume.json()) as { error?: string }).error ?? "Could not resume playback");
      setLiveStatus("PLAYING");
      await startLiveSession();
      workletRef.current?.port.postMessage({ type: "start" });
      await video.play();
    } catch (cause) {
      workletRef.current?.port.postMessage({ type: "pause" });
      setLiveStatus("PAUSED");
      setError(cause instanceof Error ? cause.message : "Could not start live commentary");
    }
  };

  const pause = async () => {
    const video = videoRef.current;
    const sessionId = sessionRef.current;
    if (!video || !sessionId) return;
    video.pause();
    workletRef.current?.port.postMessage({ type: "pause" });
    setLiveStatus("PAUSED");
    await fetch(`${API}/playback-sessions/${sessionId}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionMs: Math.round(video.currentTime * 1000) }),
    });
  };

  const seek = async () => {
    const video = videoRef.current;
    const sessionId = sessionRef.current;
    if (!video || !sessionId) return;
    const wasPlaying = !video.paused;
    clearCommentaryAudio();
    setTranscript("");
    const response = await fetch(`${API}/playback-sessions/${sessionId}/seek`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionMs: Math.round(video.currentTime * 1000) }),
    });
    if (!response.ok) {
      setError("Could not reset live context after seeking");
      return;
    }
    const updated = await response.json() as { epoch: number };
    epochRef.current = updated.epoch;
    if (wasPlaying) {
      await startLiveSession().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not restart Gemini Live"));
    }
  };

  const stop = async () => {
    videoRef.current?.pause();
    workletRef.current?.port.postMessage({ type: "pause" });
    clearCommentaryAudio();
    setLiveStatus("STOPPED");
    const sessionId = sessionRef.current;
    if (sessionId) await fetch(`${API}/playback-sessions/${sessionId}/stop`, { method: "POST" });
  };

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-xs text-neutral-500">Persistent Gemini Live · continuous original audio · local vision path</p>
        </div>
        <div className="text-right text-xs text-neutral-400">
          <div>{status} · {clock(positionMs)}</div>
          <div className="mt-1">{audioLatencyMs === null ? "Audio latency pending" : `Transport ${audioLatencyMs} ms`}</div>
        </div>
      </header>

      <div className="overflow-hidden rounded-xl border border-neutral-800 bg-black">
        <video
          ref={videoRef}
          crossOrigin="anonymous"
          playsInline
          src={`${API}/videos/${videoId}/stream`}
          className="aspect-video w-full"
          onTimeUpdate={(event) => setPositionMs(Math.round(event.currentTarget.currentTime * 1000))}
          onSeeking={() => void seek()}
          onEnded={() => void stop()}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void play()} disabled={status === "STOPPED"} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black">Play / Resume</button>
        <button onClick={() => void pause()} disabled={status === "STOPPED"} className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">Pause</button>
        <button onClick={() => void stop()} className="rounded-lg border border-neutral-700 px-4 py-2 text-sm">Stop</button>
        <span className="text-xs text-neutral-500">{message}</span>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-neutral-500">
        <span>{visionStatus}</span>
        <span>Audio input: PCM16 / 16 kHz / 40 ms</span>
        <span>Gemini video: max 1 FPS</span>
        {metrics && (
          <span>
            Stream: {metrics.audioChunksIn} audio chunks in · {metrics.audioChunksOut} out ·
            {metrics.geminiVideoFramesIn} Gemini frames · {metrics.visionFramesIn} vision frames ·
            {metrics.reconnects} reconnects
          </span>
        )}
      </div>

      {error && <p className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-200">{error}</p>}

      <div className="rounded-xl border border-neutral-800">
        <div className="border-b border-neutral-800 px-4 py-3 text-xs uppercase tracking-widest text-neutral-500">Live AI commentary</div>
        <div className="max-h-80 space-y-2 overflow-y-auto p-3">
          {transcript && (
            <article className="rounded-lg border border-neutral-700 bg-neutral-900 p-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">Speaking now</div>
              <p className="text-sm leading-relaxed">{transcript}</p>
            </article>
          )}
          {events.map((event) => (
            <article key={event.eventId} className="rounded-lg bg-neutral-900 p-3">
              <div className="mb-1 flex justify-between text-[10px] text-neutral-500">
                <span>{clock(event.startMs)} · {event.eventType.replaceAll("_", " ")}</span>
                <span>LIVE</span>
              </div>
              <p className="text-sm leading-relaxed">{event.commentaryText}</p>
            </article>
          ))}
          {!events.length && !transcript && (
            <p className="py-8 text-center text-xs text-neutral-600">Start playback to stream live cricket commentary.</p>
          )}
        </div>
      </div>
      <canvas ref={canvasRef} className="hidden" />
    </section>
  );
}
