"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, API } from "@/lib/api";
import {
  AlertCircle,
  CheckCircle2,
  Clapperboard,
  Film,
  FolderOpen,
  Link2,
  LoaderCircle,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Settings,
  UploadCloud,
  Volume2,
} from "lucide-react";

type Job = {
  id: string;
  status: string;
  model?: string;
  progress: number;
  stage: string;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type Video = {
  id: string;
  title: string;
  originalName: string;
  sizeBytes: string;
  status: string;
  failureReason?: string | null;
  durationMs: number | null;
  createdAt: string;
  _count?: { segments: number };
  jobs?: Job[];
};

type Segment = {
  id: string;
  startMs: number;
  endMs: number;
  eventType: string;
  commentaryText: string;
  emotion: string;
  audioStatus: string;
  audio?: { id: string } | null;
};

const bytes = (n: number) =>
  n < 1024 * 1024 ? (n / 1024).toFixed(0) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB";

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60).toString().padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};

function parseFailureText(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    return parsed?.error?.message ?? parsed?.message ?? raw;
  } catch {
    return raw;
  }
}

function describeJobStatus(video: Video, segmentCount: number) {
  const job = video.jobs?.[0];
  const stage = (job?.stage ?? "").toLowerCase();
  const isAnalyzing =
    video.status === "ANALYZING" || job?.status === "QUEUED" || job?.status === "RUNNING";
  const failure = parseFailureText(job?.errorMessage ?? video.failureReason);

  if (video.status === "FAILED" || job?.status === "FAILED") {
    return {
      active: false,
      failed: true,
      completed: false,
      progress: job?.progress ?? 0,
      badge: "FAILED",
      title: "Analysis failed",
      detail: failure ?? "The analysis job failed. Check worker logs or retry.",
      model: job?.model,
    };
  }

  if (isAnalyzing) {
    let title = "Starting AI commentary";
    let detail = "Waiting for worker to pick up the job...";
    if (stage === "downloading") {
      title = "Downloading from Google Drive";
      detail = "Fetching source video clip for processing.";
    } else if (stage === "probing") {
      title = "Inspecting video clip";
      detail = "Checking duration and preparing analysis chunks.";
    } else if (stage.startsWith("extracting chunk")) {
      title = `Preparing ${stage.replace("extracting ", "")}`;
      detail = "Extracting clip segment with FFmpeg.";
    } else if (stage.startsWith("analyzing chunk") || stage === "analysing") {
      title = stage.startsWith("analyzing ")
        ? `Analyzing ${stage.replace("analyzing ", "")} with Gemini`
        : "Analyzing video with Gemini";
      detail = `Sending frames to ${job?.model ?? "Gemini"} for cricket event detection.`;
    } else if (stage.startsWith("generating audio")) {
      title = `Generating Hinglish voice (${stage.replace("generating audio ", "")})`;
      detail = "Synthesizing commentary audio and saving to Google Drive.";
    } else if (stage.startsWith("completed chunk")) {
      title = `Finished ${stage.replace("completed ", "")}`;
      detail = "Moving to the next video chunk...";
    }

    return {
      active: true,
      failed: false,
      completed: false,
      progress: job?.progress ?? 0,
      badge: job?.status ?? "ANALYZING",
      title,
      detail,
      model: job?.model,
    };
  }

  if (video.status === "READY" || job?.status === "COMPLETED") {
    const total = Math.max(segmentCount, video._count?.segments ?? 0);
    return {
      active: false,
      failed: false,
      completed: true,
      progress: 100,
      badge: "COMPLETED",
      title: total > 0 ? `Completed (${total} event${total === 1 ? "" : "s"})` : "Completed (0 events)",
      detail:
        total > 0
          ? "Commentary and audio are ready. Play the video or click an event below."
          : "Gemini finished analyzing, but no qualifying cricket scoring/wicket events matched the filter.",
      model: job?.model,
    };
  }

  return {
    active: false,
    failed: false,
    completed: false,
    progress: 0,
    badge: video.status,
    title: "Ready to analyze",
    detail: 'Click "Start AI commentary" to begin Gemini video analysis and Hinglish TTS.',
    model: job?.model,
  };
}

export default function Home() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fallbackVideo, setFallbackVideo] = useState<Video | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [connected, setConnected] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);

  const input = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLVideoElement>(null);

  const selected =
    videos.find((x) => x.id === selectedId) ??
    (fallbackVideo?.id === selectedId ? fallbackVideo : null);

  const isSelectedAnalyzing = Boolean(
    selected &&
      (selected.status === "ANALYZING" ||
        selected.status === "PARTIAL" ||
        selected.jobs?.[0]?.status === "QUEUED" ||
        selected.jobs?.[0]?.status === "RUNNING"),
  );

  const refresh = useCallback(async () => {
    try {
      const [v, c] = await Promise.all([
        api<Video[]>("/videos"),
        api<{ connected: boolean }>("/google/status"),
      ]);
      setVideos(v);
      setConnected(c.connected);
    } catch (e) {
      setError(e instanceof Error ? e.message : "API unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const intervalMs = isSelectedAnalyzing ? 1500 : 5000;
    const t = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(t);
  }, [refresh, isSelectedAnalyzing]);

  useEffect(() => {
    if (!selectedId) {
      setSegments([]);
      return;
    }
    let live = true;
    const load = async () => {
      try {
        const s = await api<Segment[]>("/videos/" + selectedId + "/commentary");
        if (live) setSegments(s);
      } catch {
        // Ignore transient polling errors while commentary is still generating
      }
    };
    void load();
    const t = setInterval(() => void load(), isSelectedAnalyzing ? 1500 : 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [selectedId, isSelectedAnalyzing]);

  const upload = async (file?: File) => {
    if (!file) return;
    setError("");
    setUploading(true);
    setProgress(0);
    try {
      const form = new FormData();
      form.append("file", file);
      const xhr = new XMLHttpRequest();
      const result = await new Promise<Video>((resolve, reject) => {
        xhr.open("POST", API + "/videos/upload");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
          else reject(Error(JSON.parse(xhr.responseText).error ?? "Upload failed"));
        };
        xhr.onerror = () => reject(Error("Network error during upload"));
        xhr.send(form);
      });
      setFallbackVideo(result);
      setSelectedId(result.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  const start = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const job = await api<Job>("/videos/" + selected.id + "/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      setVideos((prev) =>
        prev.map((v) =>
          v.id === selected.id
            ? { ...v, status: "ANALYZING", failureReason: null, jobs: [job] }
            : v,
        ),
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start analysis");
    } finally {
      setBusy(false);
    }
  };

  const seek = (s: Segment) => {
    if (player.current) {
      player.current.currentTime = s.startMs / 1000;
      void player.current.play();
      setPlaying(true);
    }
  };

  const active = segments.find((s) => currentMs >= s.startMs && currentMs <= s.endMs);
  const statusInfo = selected ? describeJobStatus(selected, segments.length) : null;

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[#242424] bg-[#090909]/95 px-7 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white text-black">
              <Radio size={20} />
            </div>
            <div>
              <div className="text-sm font-bold tracking-[.18em]">
                BOUNDARY<span className="text-[#777]"> / STUDIO</span>
              </div>
              <div className="text-[10px] tracking-[.22em] text-[#777]">
                AI CRICKET COMMENTARY
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs text-[#999]">
            <span className="flex items-center gap-2">
              <span className={"h-2 w-2 rounded-full " + (connected ? "bg-white" : "bg-[#666]")} />
              {connected ? "DRIVE CONNECTED" : "DRIVE NOT CONNECTED"}
            </span>
            <a
              className="flex items-center gap-2 rounded-lg border border-[#333] px-3 py-2 hover:bg-[#1b1b1b]"
              href={API + "/google/connect"}
            >
              <Link2 size={14} /> Connect Drive
            </a>
            <a href="/settings" className="rounded-lg p-2 hover:bg-[#222]">
              <Settings size={17} />
            </a>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-6 p-7 xl:grid-cols-[330px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs tracking-[.2em] text-[#777]">MEDIA LIBRARY</div>
              <div className="mt-1 text-xl font-semibold">Your clips</div>
            </div>
            <button
              onClick={() => void refresh()}
              className="rounded-lg border border-[#303030] p-2 text-[#999]"
            >
              <RefreshCw size={15} />
            </button>
          </div>

          <button
            onClick={() => input.current?.click()}
            disabled={uploading || !connected}
            className="w-full rounded-xl border border-dashed border-[#555] bg-[#121212] p-6 text-left transition hover:border-white disabled:opacity-40"
          >
            <div className="mb-4 grid h-10 w-10 place-items-center rounded-lg bg-white text-black">
              <UploadCloud />
            </div>
            <div className="font-medium">Upload cricket video</div>
            <div className="mt-1 text-xs text-[#777]">MP4, MOV, WEBM, AVI · Up to 512 MB</div>
            <input
              ref={input}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,video/mpeg"
              className="hidden"
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </button>

          {uploading && (
            <div className="panel p-4">
              <div className="flex justify-between text-xs">
                <span>Uploading to Google Drive</span>
                <span>{progress}%</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#333]">
                <div className="h-full bg-white transition-all" style={{ width: progress + "%" }} />
              </div>
              <div className="mt-2 text-[11px] text-[#777]">
                Analysis starts only after Drive upload completes.
              </div>
            </div>
          )}

          {!connected && (
            <div className="rounded-lg border border-[#343434] p-3 text-xs text-[#999]">
              Connect Google Drive once to enable private video and audio storage. No app account
              is needed.
            </div>
          )}

          <div className="space-y-2">
            {videos.map((v) => (
              <button
                key={v.id}
                onClick={() => {
                  setFallbackVideo(v);
                  setSelectedId(v.id);
                }}
                className={
                  "w-full rounded-xl border p-3 text-left " +
                  (selected?.id === v.id
                    ? "border-white bg-[#1a1a1a]"
                    : "border-[#282828] bg-[#101010] hover:border-[#555]")
                }
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-11 w-12 place-items-center rounded-lg bg-[#242424] text-[#aaa]">
                    <Film size={19} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{v.title}</div>
                    <div className="mt-1 text-[11px] text-[#777]">
                      {bytes(Number(v.sizeBytes))} · {v.status}
                      {v.status === "ANALYZING" && v.jobs?.[0]
                        ? ` (${v.jobs[0].progress}%)`
                        : ""}
                    </div>
                  </div>
                  <div className="text-[10px] text-[#777]">{v._count?.segments ?? 0} events</div>
                </div>
              </button>
            ))}
            {videos.length === 0 && (
              <div className="py-8 text-center text-xs text-[#666]">
                <FolderOpen className="mx-auto mb-2" size={22} />
                No clips uploaded yet
              </div>
            )}
          </div>
        </aside>

        <section className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs tracking-[.2em] text-[#777]">COMMENTARY WORKSPACE</div>
              <h1 className="mt-1 truncate text-2xl font-semibold">
                {selected?.title ?? "Select a cricket clip"}
              </h1>
            </div>
            {selected && (
              <button
                onClick={() => void start()}
                disabled={busy || !connected || isSelectedAnalyzing}
                className="flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-xs font-semibold text-black disabled:opacity-40"
              >
                {busy || isSelectedAnalyzing ? (
                  <LoaderCircle className="animate-spin" size={15} />
                ) : (
                  <Radio size={15} />
                )}
                {isSelectedAnalyzing ? "Analyzing..." : "Start AI commentary"}
              </button>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-[#633] bg-[#241414] p-3 text-sm text-[#e9aaaa]">
              {error}
            </div>
          )}

          {selected && statusInfo && (
            <div
              className={
                "rounded-xl border p-4 " +
                (statusInfo.failed
                  ? "border-[#663333] bg-[#1e1212]"
                  : statusInfo.active
                    ? "border-[#444] bg-[#141414]"
                    : "border-[#282828] bg-[#111]")
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 text-sm font-medium">
                  {statusInfo.active ? (
                    <LoaderCircle className="animate-spin text-white" size={16} />
                  ) : statusInfo.failed ? (
                    <AlertCircle className="text-[#e9aaaa]" size={16} />
                  ) : statusInfo.completed ? (
                    <CheckCircle2 className="text-white" size={16} />
                  ) : (
                    <Radio className="text-[#888]" size={16} />
                  )}
                  <span>{statusInfo.title}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  {statusInfo.model && (
                    <span className="mono rounded border border-[#333] px-2 py-0.5 text-[#999]">
                      {statusInfo.model}
                    </span>
                  )}
                  <span className="mono rounded bg-[#222] px-2 py-0.5 text-[#ddd]">
                    {statusInfo.badge} · {statusInfo.progress}%
                  </span>
                </div>
              </div>
              <div className="mt-2 text-xs text-[#aaa]">{statusInfo.detail}</div>
              {(statusInfo.active || statusInfo.completed) && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#2a2a2a]">
                  <div
                    className="h-full bg-white transition-all duration-300"
                    style={{ width: statusInfo.progress + "%" }}
                  />
                </div>
              )}
            </div>
          )}

          <div className="grid gap-5 2xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,.8fr)]">
            <div className="panel overflow-hidden">
              <div className="flex items-center justify-between border-b border-[#292929] px-4 py-3 text-[11px] tracking-widest text-[#888]">
                <span>VIDEO MONITOR</span>
                <span>{selected?.status ?? "NO SOURCE"}</span>
              </div>
              {selected ? (
                <video
                  ref={player}
                  src={API + "/videos/" + selected.id + "/stream"}
                  controls
                  className="aspect-video w-full bg-black"
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
                />
              ) : (
                <div className="grid aspect-video place-items-center bg-[#0c0c0c] text-center text-[#555]">
                  <Clapperboard size={38} />
                  <div className="mt-3 text-sm">Upload or select a video to begin</div>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-[#292929] px-4 py-3 text-xs text-[#888]">
                <span className="flex items-center gap-2">
                  {playing ? <Pause size={13} /> : <Play size={13} />}{" "}
                  {playing ? "PLAYING" : "PAUSED"}
                </span>
                <span className="mono">{segments.length} COMMENTARY EVENTS</span>
              </div>
            </div>

            <div className="panel flex min-h-[300px] flex-col">
              <div className="flex items-center justify-between border-b border-[#292929] px-4 py-3">
                <span className="text-[11px] tracking-widest text-[#888]">
                  AI COMMENTARY FEED
                </span>
                <span className="flex items-center gap-1 text-[10px] text-[#aaa]">
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                  Hinglish
                </span>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {segments.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => seek(s)}
                    className={
                      "w-full rounded-lg border p-3 text-left transition " +
                      (active?.id === s.id
                        ? "border-white bg-[#222]"
                        : "border-[#282828] bg-[#151515] hover:border-[#555]")
                    }
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="mono text-[10px] text-[#999]">
                        {clock(s.startMs)} · {s.eventType.replaceAll("_", " ")}
                      </span>
                      {s.audioStatus === "READY" ? (
                        <Volume2 size={13} className="text-white" />
                      ) : (
                        <span className="text-[9px] text-[#666]">{s.audioStatus}</span>
                      )}
                    </div>
                    <div className="text-sm leading-relaxed">{s.commentaryText}</div>
                    {s.audio?.id && (
                      <audio
                        controls
                        preload="none"
                        className="mt-3 h-8 w-full"
                        src={API + "/audio/" + s.audio.id}
                      />
                    )}
                  </button>
                ))}
                {segments.length === 0 && (
                  <div className="grid h-full min-h-48 place-items-center px-4 text-center text-xs text-[#888]">
                    {statusInfo?.active ? (
                      <div>
                        <LoaderCircle className="mx-auto mb-2 animate-spin text-white" size={24} />
                        <div className="font-medium text-white">
                          {statusInfo.title} ({statusInfo.progress}%)
                        </div>
                        <div className="mt-1 text-[#777]">{statusInfo.detail}</div>
                      </div>
                    ) : statusInfo?.failed ? (
                      <div className="text-[#e9aaaa]">
                        <AlertCircle className="mx-auto mb-2" size={24} />
                        <div className="font-medium">{statusInfo.title}</div>
                        <div className="mt-1 text-[11px]">{statusInfo.detail}</div>
                      </div>
                    ) : statusInfo?.completed ? (
                      <div>
                        <CheckCircle2 className="mx-auto mb-2 text-[#aaa]" size={24} />
                        <div className="font-medium text-[#ccc]">{statusInfo.title}</div>
                        <div className="mt-1 text-[11px] text-[#777]">{statusInfo.detail}</div>
                      </div>
                    ) : (
                      <div className="text-[#666]">
                        <Radio size={25} className="mx-auto mb-2" />
                        Start commentary to see events appear here.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs tracking-widest text-[#888]">PROCESSING STATUS</div>
              <button onClick={() => void refresh()} className="text-[#888]">
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span>{statusInfo?.title ?? "Waiting for video"}</span>
              <span className="mono text-[#aaa]">{statusInfo?.progress ?? 0}%</span>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#333]">
              <div
                className="h-full bg-white transition-all"
                style={{ width: (statusInfo?.progress ?? 0) + "%" }}
              />
            </div>
            <div className="mt-3 text-[11px] text-[#777]">
              {statusInfo?.detail ??
                "Commentary segments appear as each video chunk is analysed. Voice generation is optional and runs per segment."}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
