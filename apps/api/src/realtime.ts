import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Server, Socket } from "socket.io";
import { prisma } from "@cricket/database";
import {
  connectGeminiLive,
  type GeminiLiveConnection,
} from "@cricket/providers/gemini-live";
import { analyzeCricketFrame, clearVisionSession, type VisionFrameResult } from "./vision.js";

type Status = "READY" | "PLAYING" | "PAUSED" | "STOPPED" | "FAILED";
type Runtime = {
  epoch: number;
  status: Status;
  positionMs: number;
  playbackRate: number;
  lastDatabaseSyncAt: number;
  lastAudioInputAt: number;
  lastGeminiVideoAt: number;
  lastVisionAt: number;
  lastVisionSignalAt: number;
  visionBusy: boolean;
  live?: GeminiLiveConnection;
  connecting: boolean;
  connectionGeneration: number;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
  resumeHandle?: string;
  transcript: string;
  transcriptStartMs: number;
  transcriptStartedAtMs: number;
  audioSequence: number;
  recentVision: Array<{ timestampMs: number; type: string; confidence: number; evidence?: Record<string, number> }>;
  metricsStartedAt: number;
  lastMetricsEmitAt: number;
  metrics: {
    audioChunksIn: number;
    audioBytesIn: number;
    geminiVideoFramesIn: number;
    visionFramesIn: number;
    visionCandidates: number;
    visionInferenceMsLast: number;
    audioChunksOut: number;
    reconnects: number;
  };
};

const runtimes = new Map<string, Runtime>();
const room = (id: string) => "playback:" + id;
const MAX_AUDIO_CHUNK_BYTES = 16_384;
const MAX_JPEG_BYTES = 512_000;
const GEMINI_VIDEO_INTERVAL_MS = 950;
const VISION_MIN_INTERVAL_MS = 85;

function runtimeFor(id: string, epoch: number, status: Status, positionMs = 0): Runtime {
  let value = runtimes.get(id);
  if (!value) {
    value = {
      epoch,
      status,
      positionMs,
      playbackRate: 1,
      lastDatabaseSyncAt: 0,
      lastAudioInputAt: 0,
      lastGeminiVideoAt: 0,
      lastVisionAt: 0,
      lastVisionSignalAt: 0,
      visionBusy: false,
      connecting: false,
      connectionGeneration: 0,
      reconnectAttempts: 0,
      transcript: "",
      transcriptStartMs: positionMs,
      transcriptStartedAtMs: 0,
      audioSequence: 0,
      recentVision: [],
      metricsStartedAt: Date.now(),
      lastMetricsEmitAt: 0,
      metrics: {
        audioChunksIn: 0,
        audioBytesIn: 0,
        geminiVideoFramesIn: 0,
        visionFramesIn: 0,
        visionCandidates: 0,
        visionInferenceMsLast: 0,
        audioChunksOut: 0,
        reconnects: 0,
      },
    };
    runtimes.set(id, value);
  }
  if (epoch > value.epoch) {
    value.epoch = epoch;
    value.transcript = "";
    value.recentVision = [];
    value.audioSequence = 0;
  }
  value.status = status;
  value.positionMs = positionMs;
  return value;
}

function asBuffer(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

function asJpeg(raw: unknown): Buffer | null {
  if (typeof raw !== "string" || raw.length > Math.ceil(MAX_JPEG_BYTES * 4 / 3)) return null;
  const value = Buffer.from(raw, "base64");
  if (value.length < 16 || value.length > MAX_JPEG_BYTES) return null;
  return value;
}

function classifyCommentary(text: string): string {
  const t = text.toLowerCase();
  if (/run.?out|run out|ran out|direct hit|runout/.test(t)) return "RUN_OUT";
  if (/caught|catch|catches|lapak|pakad liya/.test(t)) return "CATCH";
  if (/wicket|bowled|cleaned up|out ho gaye|ballebaaz out/.test(t)) return "WICKET";
  if (/six|chhakka|छक्का/.test(t)) return "SIX";
  if (/four|boundary|chauka|चौका/.test(t)) return "BOUNDARY_FOUR";
  if (/appeal|how.?zat|shout for/.test(t)) return "APPEAL";
  if (/single|one run|ek run/.test(t)) return "SINGLE";
  if (/two runs|double|do run/.test(t)) return "TWO_RUNS";
  if (/three runs|teen run/.test(t)) return "THREE_RUNS";
  if (/dot ball|no run|koi run nahi/.test(t)) return "DOT_BALL";
  if (/shot|drive|pull|cut|flick|sweep/.test(t)) return "SHOT";
  return "LIVE_COMMENTARY";
}

function isCurrent(runtime: Runtime, generation: number, epoch: number): boolean {
  return runtime.connectionGeneration === generation && runtime.epoch === epoch && runtime.status === "PLAYING";
}

function emitLiveError(io: Server, sessionId: string, message: string) {
  io.to(room(sessionId)).emit("live:error", { message });
}

function emitMetrics(io: Server, sessionId: string, runtime: Runtime, force = false) {
  const now = Date.now();
  if (!force && now - runtime.lastMetricsEmitAt < 2_000) return;
  runtime.lastMetricsEmitAt = now;
  io.to(room(sessionId)).emit("live:metrics", {
    epoch: runtime.epoch,
    uptimeMs: now - runtime.metricsStartedAt,
    lastAudioInputAgeMs: runtime.lastAudioInputAt ? now - runtime.lastAudioInputAt : null,
    ...runtime.metrics,
    emittedAtMs: now,
  });
}

async function persistTranscript(sessionId: string, runtime: Runtime, io: Server) {
  const text = runtime.transcript.replace(/\s+/g, " ").trim();
  const startMs = runtime.transcriptStartMs;
  const epoch = runtime.epoch;
  runtime.transcript = "";
  runtime.transcriptStartedAtMs = 0;
  if (!text || text.length < 3) return;

  const eventType = classifyCommentary(text);
  const endMs = Math.max(startMs, runtime.positionMs);
  const dedupeKey = createHash("sha256")
    .update([sessionId, epoch, startMs, text.toLowerCase()].join("|"))
    .digest("hex");
  try {
    const event = await prisma.playbackEvent.upsert({
      where: { dedupeKey },
      create: {
        sessionId,
        epoch,
        dedupeKey,
        eventType,
        startMs,
        endMs,
        commentaryText: text,
        confidence: 0.5,
        visualEvidence: runtime.recentVision.slice(-4).map((item) => item.type).join(", ") || "No local vision signal",
        audioEvidence: "Continuous original match audio analysed by Gemini Live",
        status: "SPOKEN",
      },
      update: {},
    });
    io.to(room(sessionId)).emit("commentary:event", {
      eventId: event.id,
      epoch,
      startMs,
      endMs,
      eventType,
      commentaryText: text,
      confidence: 0.5,
    });
  } catch (error) {
    emitLiveError(io, sessionId, error instanceof Error ? error.message : "Could not persist live commentary event");
  }
}

function scheduleReconnect(sessionId: string, runtime: Runtime, io: Server, requestedDelayMs = 0) {
  if (runtime.status !== "PLAYING" || runtime.reconnectTimer || runtime.reconnectAttempts >= 10) return;
  const exponential = Math.min(8_000, 500 * 2 ** runtime.reconnectAttempts);
  const delayMs = Math.max(requestedDelayMs, exponential);
  runtime.reconnectAttempts += 1;
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = undefined;
    const old = runtime.live;
    runtime.live = undefined;
    runtime.connectionGeneration += 1;
    old?.close();
    void openLiveSession(sessionId, io).catch((error) => {
      emitLiveError(io, sessionId, error instanceof Error ? error.message : "Gemini Live reconnect failed");
      scheduleReconnect(sessionId, runtime, io);
    });
  }, delayMs);
  runtime.reconnectTimer.unref?.();
}

async function openLiveSession(sessionId: string, io: Server): Promise<void> {
  const runtime = runtimes.get(sessionId);
  if (!runtime || runtime.status !== "PLAYING" || runtime.live || runtime.connecting) return;
  runtime.connecting = true;
  const generation = ++runtime.connectionGeneration;
  const epoch = runtime.epoch;
  try {
    let sessionRecord = await prisma.playbackSession.findUnique({ where: { id: sessionId } });
    if (!sessionRecord || sessionRecord.status !== "PLAYING" || sessionRecord.epoch !== epoch) return;

    const connect = async (resumeHandle?: string | null) =>
      connectGeminiLive({
        resumeHandle,
        callbacks: {
          onAudio: (pcm24k) => {
            if (!isCurrent(runtime, generation, epoch)) return;
            runtime.audioSequence += 1;
            runtime.metrics.audioChunksOut += 1;
            io.to(room(sessionId)).emit("live:audio", {
              epoch,
              sequence: runtime.audioSequence,
              sampleRate: 24_000,
              matchPositionMs: runtime.positionMs,
              generatedAtMs: Date.now(),
              audio: pcm24k,
            });
          },
          onText: (text) => {
            if (!isCurrent(runtime, generation, epoch)) return;
            if (!runtime.transcript) {
              runtime.transcriptStartMs = runtime.positionMs;
              runtime.transcriptStartedAtMs = Date.now();
            }
            runtime.transcript = (runtime.transcript + " " + text).replace(/\s+/g, " ").trim();
            io.to(room(sessionId)).emit("live:transcript", {
              epoch,
              text,
              fullText: runtime.transcript,
              matchPositionMs: runtime.transcriptStartMs,
              partial: true,
            });
          },
          onGenerationComplete: () => {
            if (!isCurrent(runtime, generation, epoch)) return;
            void persistTranscript(sessionId, runtime, io);
            io.to(room(sessionId)).emit("live:turn-complete", {
              epoch,
              matchPositionMs: runtime.positionMs,
              completedAtMs: Date.now(),
            });
          },
          onInterrupted: () => {
            io.to(room(sessionId)).emit("live:interrupt", { epoch, reason: "model-interrupted" });
          },
          onResumptionUpdate: (handle, resumable) => {
            if (runtime.connectionGeneration !== generation) return;
            runtime.resumeHandle = resumable ? handle : undefined;
            void prisma.playbackSession.update({
              where: { id: sessionId },
              data: {
                liveSessionHandle: resumable ? handle : null,
                liveSessionModel: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live",
                liveHandleUpdatedAt: resumable ? new Date() : null,
              },
            }).catch((error) => emitLiveError(io, sessionId, error instanceof Error ? error.message : "Could not save session resume token"));
          },
          onGoAway: (timeLeftMs) => {
            if (runtime.connectionGeneration !== generation || runtime.status !== "PLAYING") return;
            // Reconnect before the server closes the connection; transparent resumption preserves unconsumed client messages.
            scheduleReconnect(sessionId, runtime, io, Math.max(250, timeLeftMs - 1_000));
          },
          onError: (error) => {
            if (runtime.connectionGeneration !== generation) return;
            emitLiveError(io, sessionId, error.message);
            scheduleReconnect(sessionId, runtime, io);
          },
          onClose: (reason) => {
            if (runtime.connectionGeneration !== generation) return;
            runtime.live = undefined;
            if (runtime.status === "PLAYING") {
              io.to(room(sessionId)).emit("live:status", { state: "reconnecting", reason });
              scheduleReconnect(sessionId, runtime, io);
            }
          },
        },
      });

    let connection: GeminiLiveConnection;
    try {
      connection = await connect(sessionRecord.liveSessionHandle ?? runtime.resumeHandle);
    } catch (error) {
      const handle = sessionRecord.liveSessionHandle ?? runtime.resumeHandle;
      if (!handle) throw error;
      // An expired/invalid handle should not permanently block a fresh session.
      runtime.resumeHandle = undefined;
      await prisma.playbackSession.update({
        where: { id: sessionId },
        data: { liveSessionHandle: null, liveHandleUpdatedAt: null },
      }).catch(() => undefined);
      connection = await connect(null);
    }

    if (!isCurrent(runtime, generation, epoch)) {
      connection.close();
      return;
    }
    runtime.live = connection;
    runtime.reconnectAttempts = 0;
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = undefined;
    emitMetrics(io, sessionId, runtime, true);
    io.to(room(sessionId)).emit("live:status", {
      state: "connected",
      model: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live",
      epoch,
      resumed: Boolean(sessionRecord.liveSessionHandle ?? runtime.resumeHandle),
    });
    connection.sendContext(
      `Live match commentary started at match clock ${Math.floor(runtime.positionMs / 60_000)}:${String(Math.floor(runtime.positionMs / 1000) % 60).padStart(2, "0")}. The incoming audio is the original match feed, not a microphone.`,
    );
  } finally {
    runtime.connecting = false;
  }
}

function validMediaPayload(payload: unknown): payload is { timestampMs: number; jpegBase64: string } {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as { timestampMs?: unknown; jpegBase64?: unknown };
  return Number.isInteger(value.timestampMs) && Number(value.timestampMs) >= 0 &&
    typeof value.jpegBase64 === "string" && value.jpegBase64.length >= 16;
}

function sendVisionContext(
  sessionId: string,
  runtime: Runtime,
  io: Server,
  result: VisionFrameResult,
) {
  if (!result.candidateEvents.length) return;
  runtime.recentVision.push(
    ...result.candidateEvents.map((event) => ({
      timestampMs: result.timestampMs,
      type: event.type,
      confidence: event.confidence,
      evidence: event.evidence,
    })),
  );
  runtime.recentVision = runtime.recentVision.slice(-12);
  io.to(room(sessionId)).emit("live:vision", {
    epoch: runtime.epoch,
    timestampMs: result.timestampMs,
    inferenceMs: result.inferenceMs,
    objects: result.objects,
    candidateEvents: result.candidateEvents,
  });

  const strongest = result.candidateEvents.reduce((best, item) => item.confidence > best.confidence ? item : best);
  if (Date.now() - runtime.lastVisionSignalAt < 650 || !runtime.live) return;
  runtime.lastVisionSignalAt = Date.now();
  runtime.live.sendContext(
    `LOCAL VISUAL CANDIDATE at match time ${(result.timestampMs / 1000).toFixed(2)}s: ${strongest.type} (weak detector confidence ${strongest.confidence.toFixed(2)}). Evidence: ${JSON.stringify(strongest.evidence ?? {})}. Treat this only as a candidate; corroborate with the continuous match audio and do not claim a wicket, catch, run or boundary without sufficient evidence.`,
  );
}

export function registerRealtimePlayback(app: FastifyInstance, io: Server) {
  app.post("/v1/videos/:id/playback-sessions", async (req, reply) => {
    const { id: videoId } = req.params as { id: string };
    const body = (req.body ?? {}) as { positionMs?: number };
    const positionMs = Number.isInteger(body.positionMs) && (body.positionMs ?? -1) >= 0 ? body.positionMs! : 0;
    const video = await prisma.video.findUnique({ where: { id: videoId }, select: { id: true, driveFileId: true } });
    if (!video) return reply.code(404).send({ error: "Video not found" });
    if (!video.driveFileId) return reply.code(409).send({ error: "Video source is not available" });
    const session = await prisma.playbackSession.create({
      data: { videoId, status: "READY", currentPositionMs: positionMs, epoch: 0 },
    });
    runtimeFor(session.id, 0, "READY", positionMs);
    return reply.code(201).send(session);
  });

  app.get("/v1/playback-sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await prisma.playbackSession.findUnique({ where: { id } });
    if (!session) return reply.code(404).send({ error: "Playback session not found" });
    return session;
  });

  app.post("/v1/playback-sessions/:id/live/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await prisma.playbackSession.findUnique({ where: { id } });
    if (!session || session.status === "STOPPED") return reply.code(404).send({ error: "Active playback session not found" });
    if (session.status !== "PLAYING") return reply.code(409).send({ error: "Resume playback before starting Gemini Live" });
    const runtime = runtimeFor(id, session.epoch, "PLAYING", session.currentPositionMs);
    try {
      await openLiveSession(id, io);
      return { connected: Boolean(runtime.live), model: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live" };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Could not start Gemini Live session" });
    }
  });

  app.post("/v1/playback-sessions/:id/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { positionMs?: number };
    const current = await prisma.playbackSession.findUnique({ where: { id } });
    if (!current || current.status === "STOPPED") return reply.code(404).send({ error: "Active session not found" });
    const positionMs = Number.isInteger(body.positionMs) && (body.positionMs ?? -1) >= 0
      ? body.positionMs!
      : current.currentPositionMs;
    const updated = await prisma.playbackSession.update({
      where: { id },
      data: { status: "PAUSED", currentPositionMs: positionMs, pausedAt: new Date(), lastHeartbeatAt: new Date() },
    });
    const runtime = runtimeFor(id, updated.epoch, "PAUSED", positionMs);
    runtime.transcript = "";
    io.to(room(id)).emit("live:interrupt", { epoch: updated.epoch, reason: "playback-paused" });
    io.to(room(id)).emit("playback:control", { type: "PAUSE", positionMs, epoch: updated.epoch });
    return updated;
  });

  app.post("/v1/playback-sessions/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await prisma.playbackSession.findUnique({ where: { id } });
    if (!current || current.status === "STOPPED") return reply.code(404).send({ error: "Active session not found" });
    const updated = await prisma.playbackSession.update({
      where: { id },
      data: { status: "PLAYING", pausedAt: null, lastHeartbeatAt: new Date() },
    });
    const runtime = runtimeFor(id, updated.epoch, "PLAYING", updated.currentPositionMs);
    io.to(room(id)).emit("playback:control", { type: "PLAY", positionMs: updated.currentPositionMs, epoch: updated.epoch });
    return updated;
  });

  app.post("/v1/playback-sessions/:id/seek", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { positionMs?: number };
    if (!Number.isInteger(body.positionMs) || (body.positionMs ?? -1) < 0) {
      return reply.code(400).send({ error: "positionMs must be a non-negative integer" });
    }
    const current = await prisma.playbackSession.findUnique({ where: { id } });
    if (!current || current.status === "STOPPED") return reply.code(404).send({ error: "Active session not found" });
    const runtime = runtimes.get(id);
    if (runtime?.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    if (runtime) {
      runtime.reconnectTimer = undefined;
      runtime.status = "PAUSED";
      runtime.connectionGeneration += 1;
      runtime.live?.close();
      runtime.live = undefined;
      runtime.resumeHandle = undefined;
      runtime.transcript = "";
      runtime.recentVision = [];
    }
    const updated = await prisma.playbackSession.update({
      where: { id },
      data: {
        currentPositionMs: body.positionMs!,
        epoch: { increment: 1 },
        lastHeartbeatAt: new Date(),
        liveSessionHandle: null,
        liveHandleUpdatedAt: null,
      },
    });
    runtimeFor(id, updated.epoch, current.status as Status, updated.currentPositionMs);
    io.to(room(id)).emit("live:interrupt", { epoch: updated.epoch, reason: "playback-seeked" });
    io.to(room(id)).emit("playback:control", { type: "SEEK", positionMs: updated.currentPositionMs, epoch: updated.epoch });
    await clearVisionSession(id);
    return updated;
  });

  app.post("/v1/playback-sessions/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await prisma.playbackSession.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ error: "Playback session not found" });
    const runtime = runtimes.get(id);
    if (runtime?.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    if (runtime) {
      runtime.status = "STOPPED";
      runtime.connectionGeneration += 1;
      runtime.live?.close();
      runtimes.delete(id);
    }
    const updated = await prisma.playbackSession.update({
      where: { id },
      data: { status: "STOPPED", endedAt: new Date(), liveSessionHandle: null, liveHandleUpdatedAt: null },
    });
    io.to(room(id)).emit("live:interrupt", { epoch: updated.epoch, reason: "playback-stopped" });
    io.to(room(id)).emit("playback:control", { type: "STOP", epoch: updated.epoch });
    await clearVisionSession(id);
    return updated;
  });

  io.on("connection", (socket: Socket) => {
    const sessionId = typeof socket.handshake.auth?.sessionId === "string" ? socket.handshake.auth.sessionId : "";
    if (!sessionId) {
      socket.disconnect(true);
      return;
    }

    void prisma.playbackSession.findUnique({ where: { id: sessionId } }).then((session) => {
      if (!session || session.status === "STOPPED") {
        socket.disconnect(true);
        return;
      }
      const runtime = runtimeFor(session.id, session.epoch, session.status as Status, session.currentPositionMs);
      socket.join(room(session.id));
      socket.emit("playback:ready", {
        sessionId,
        epoch: session.epoch,
        status: session.status,
        currentPositionMs: session.currentPositionMs,
      });
      socket.emit("live:status", { state: runtime.live ? "connected" : "idle", model: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live" });
    }).catch(() => socket.disconnect(true));

    socket.on("live:audio", (raw: unknown) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime || runtime.status !== "PLAYING" || !runtime.live) return;
      const pcm = asBuffer(raw);
      if (!pcm || pcm.length < 160 || pcm.length > MAX_AUDIO_CHUNK_BYTES || pcm.length % 2 !== 0) return;
      runtime.lastAudioInputAt = Date.now();
      runtime.metrics.audioChunksIn += 1;
      runtime.metrics.audioBytesIn += pcm.length;
      try {
        runtime.live.sendAudio(pcm);
      } catch (error) {
        emitLiveError(io, sessionId, error instanceof Error ? error.message : "Could not forward match audio");
      }
    });

    socket.on("live:video", (payload: unknown) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime || runtime.status !== "PLAYING" || !runtime.live || !validMediaPayload(payload)) return;
      const jpeg = asJpeg(payload.jpegBase64);
      if (!jpeg) return;
      if (Date.now() - runtime.lastGeminiVideoAt < GEMINI_VIDEO_INTERVAL_MS) return;
      runtime.lastGeminiVideoAt = Date.now();
      runtime.metrics.geminiVideoFramesIn += 1;
      try {
        runtime.live.sendContext(`Visual context frame at match time ${(payload.timestampMs / 1000).toFixed(2)} seconds.`);
        runtime.live.sendVideo(jpeg);
      } catch (error) {
        emitLiveError(io, sessionId, error instanceof Error ? error.message : "Could not forward visual context");
      }
    });

    socket.on("live:vision-frame", async (payload: unknown) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime || runtime.status !== "PLAYING" || runtime.visionBusy || !validMediaPayload(payload)) return;
      if (Date.now() - runtime.lastVisionAt < VISION_MIN_INTERVAL_MS) return;
      const jpeg = asJpeg(payload.jpegBase64);
      if (!jpeg) return;
      runtime.visionBusy = true;
      runtime.lastVisionAt = Date.now();
      runtime.metrics.visionFramesIn += 1;
      try {
        const result = await analyzeCricketFrame(sessionId, payload.timestampMs, jpeg);
        if (result && runtime.status === "PLAYING") {
          runtime.metrics.visionInferenceMsLast = result.inferenceMs;
          runtime.metrics.visionCandidates += result.candidateEvents.length;
          sendVisionContext(sessionId, runtime, io, result);
        }
      } catch (error) {
        socket.emit("live:vision-status", {
          available: false,
          message: error instanceof Error ? error.message : "Local vision service unavailable",
        });
      } finally {
        runtime.visionBusy = false;
      }
    });

    socket.on("live:sync", (payload: unknown) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime || !payload || typeof payload !== "object") return;
      const value = payload as { positionMs?: unknown; playbackRate?: unknown; playing?: unknown };
      if (Number.isInteger(value.positionMs) && Number(value.positionMs) >= 0) {
        runtime.positionMs = Number(value.positionMs);
      }
      if (typeof value.playbackRate === "number" && Number.isFinite(value.playbackRate)) {
        runtime.playbackRate = Math.min(2, Math.max(0.25, value.playbackRate));
      }
      emitMetrics(io, sessionId, runtime);
      if (Date.now() - runtime.lastDatabaseSyncAt > 3_000) {
        runtime.lastDatabaseSyncAt = Date.now();
        void prisma.playbackSession.update({
          where: { id: sessionId },
          data: { currentPositionMs: runtime.positionMs, lastHeartbeatAt: new Date() },
        }).catch(() => undefined);
      }
    });

    socket.on("disconnect", () => {
      // Keep the server-side Live session alive briefly so a transient browser reconnect can resume the same match context.
      const runtime = runtimes.get(sessionId);
      if (runtime && runtime.status === "PLAYING") {
        io.to(room(sessionId)).emit("live:status", { state: "client-disconnected" });
      }
    });
  });
}
