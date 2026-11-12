import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Server, Socket } from "socket.io";
import { prisma } from "@cricket/database";
import { analyzeRealtimeWindow } from "@cricket/providers/realtime";
import { speak } from "@cricket/providers/tts";
import { decideCommentary } from "@cricket/commentary-director";
import { realtimeWindowSchema, type RealtimeWindow } from "@cricket/shared";

type Status = "READY" | "PLAYING" | "PAUSED" | "STOPPED" | "FAILED";
type QueuedWindow = { socket: Socket; window: RealtimeWindow };
type Runtime = {
  epoch: number;
  status: Status;
  inFlight: boolean;
  pendingWindows: QueuedWindow[];
  ttsQueue: Promise<void>;
  recentEvents: Array<{ timestampMs: number; eventType: string; summary: string }>;
};

const MAX_PENDING_WINDOWS = 6;
const runtimes = new Map<string, Runtime>();
const room = (id: string) => "playback:" + id;

const runtimeFor = (id: string, epoch: number, status: Status): Runtime => {
  let value = runtimes.get(id);
  if (!value) {
    value = {
      epoch,
      status,
      inFlight: false,
      pendingWindows: [],
      ttsQueue: Promise.resolve(),
      recentEvents: [],
    };
    runtimes.set(id, value);
  }
  if (epoch > value.epoch) {
    value.epoch = epoch;
    value.pendingWindows = [];
    value.recentEvents = [];
  }
  value.status = status;
  if (status !== "PLAYING") value.pendingWindows = [];
  return value;
};

async function drainWindows(sessionId: string, io: Server) {
  const runtime = runtimes.get(sessionId);
  if (!runtime || runtime.inFlight) return;
  runtime.inFlight = true;
  try {
    while (runtime.pendingWindows.length > 0) {
      const next = runtime.pendingWindows.shift()!;
      const { socket, window } = next;
      if (!runtimes.has(sessionId) || runtime.status !== "PLAYING" || runtime.epoch !== window.epoch) {
        continue;
      }

      const startedAt = Date.now();
      let candidates;
      try {
        candidates = await analyzeRealtimeWindow({
          startMs: window.startMs,
          endMs: window.endMs,
          frames: window.frames,
          audioWav: window.audioWavBase64 ? Buffer.from(window.audioWavBase64, "base64") : undefined,
          context: { recentEvents: runtime.recentEvents },
        });
      } catch (error) {
        socket.emit("playback:error", {
          message: error instanceof Error ? error.message : "Realtime inference failed",
        });
        socket.emit("playback:window:done", {
          epoch: window.epoch,
          queued: runtime.pendingWindows.length,
          durationMs: Date.now() - startedAt,
        });
        continue;
      }

      for (const candidate of candidates) {
        const approved = decideCommentary(candidate);
        if (!approved || runtime.epoch !== window.epoch || runtime.status !== "PLAYING") continue;
        const startMs = window.startMs + Math.round(approved.startSeconds * 1000);
        const endMs = window.startMs + Math.round(approved.endSeconds * 1000);
        if (endMs > window.endMs + 2000) continue;
        const dedupeKey = createHash("sha256")
          .update([sessionId, window.epoch, approved.eventType, Math.round(startMs / 700)].join("|"))
          .digest("hex");
        const event = await prisma.playbackEvent.upsert({
          where: { dedupeKey },
          create: {
            sessionId,
            epoch: window.epoch,
            dedupeKey,
            eventType: approved.eventType,
            startMs,
            endMs,
            commentaryText: approved.commentaryText,
            confidence: approved.confidence,
            visualEvidence: "Timestamped video frames analysed",
            audioEvidence: window.audioWavBase64 ? "Original match audio analysed" : "Audio unavailable",
            status: "DETECTED",
          },
          update: {},
        });
        if (event.status !== "DETECTED") continue;
        runtime.recentEvents.push({
          timestampMs: startMs,
          eventType: approved.eventType,
          summary: approved.observation,
        });
        runtime.recentEvents = runtime.recentEvents.slice(-12);
        io.to(room(sessionId)).emit("commentary:event", {
          eventId: event.id,
          epoch: window.epoch,
          startMs,
          endMs,
          eventType: approved.eventType,
          commentaryText: approved.commentaryText,
          confidence: approved.confidence,
        });

        runtime.ttsQueue = runtime.ttsQueue.then(async () => {
          if (!runtimes.has(sessionId) || runtime.epoch !== window.epoch || runtime.status !== "PLAYING") {
            await prisma.playbackEvent
              .update({ where: { id: event.id }, data: { status: "SUPPRESSED" } })
              .catch(() => undefined);
            return;
          }
          let audio: Buffer;
          try {
            audio = await speak(approved.commentaryText, approved.emotion);
          } catch (error) {
            await prisma.playbackEvent
              .update({ where: { id: event.id }, data: { status: "FAILED" } })
              .catch(() => undefined);
            const raw = error instanceof Error ? error.message : "Commentary voice synthesis failed";
            const msg = raw.includes("429") || raw.includes("RESOURCE_EXHAUSTED")
              ? "TTS voice quota limit reached; text commentary is still live."
              : raw;
            socket.emit("playback:error", { message: msg });
            return;
          }
          const latest = await prisma.playbackSession.findUnique({ where: { id: sessionId } }).catch(() => null);
          if (!latest || latest.status !== "PLAYING" || latest.epoch !== window.epoch || runtime.epoch !== window.epoch) {
            await prisma.playbackEvent
              .update({ where: { id: event.id }, data: { status: "SUPPRESSED" } })
              .catch(() => undefined);
            return;
          }
          await prisma.playbackEvent.update({ where: { id: event.id }, data: { status: "SPOKEN" } });
          io.to(room(sessionId)).emit("commentary:audio", {
            eventId: event.id,
            epoch: window.epoch,
            startMs,
            endMs,
            commentaryText: approved.commentaryText,
            generatedAtMs: Date.now(),
            audio,
          });
        });
      }

      socket.emit("playback:window:done", {
        epoch: window.epoch,
        queued: runtime.pendingWindows.length,
        durationMs: Date.now() - startedAt,
      });
    }
  } finally {
    runtime.inFlight = false;
  }
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
    runtimeFor(session.id, 0, "READY");
    return reply.code(201).send(session);
  });

  app.get("/v1/playback-sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await prisma.playbackSession.findUnique({ where: { id } });
    if (!session) return reply.code(404).send({ error: "Playback session not found" });
    return session;
  });

  app.post("/v1/playback-sessions/:id/pause", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { positionMs?: number };
    const current = await prisma.playbackSession.findUnique({ where: { id } });
    if (!current || current.status === "STOPPED") return reply.code(404).send({ error: "Active session not found" });
    const positionMs =
      Number.isInteger(body.positionMs) && (body.positionMs ?? -1) >= 0
        ? body.positionMs!
        : current.currentPositionMs;
    const updated = await prisma.playbackSession.update({
      where: { id },
      data: { status: "PAUSED", currentPositionMs: positionMs, pausedAt: new Date(), lastHeartbeatAt: new Date() },
    });
    runtimeFor(id, updated.epoch, "PAUSED");
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
    runtimeFor(id, updated.epoch, "PLAYING");
    io.to(room(id)).emit("playback:control", {
      type: "PLAY",
      positionMs: updated.currentPositionMs,
      epoch: updated.epoch,
    });
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
    const updated = await prisma.playbackSession.update({
      where: { id },
      data: { currentPositionMs: body.positionMs!, epoch: { increment: 1 }, lastHeartbeatAt: new Date() },
    });
    runtimeFor(id, updated.epoch, current.status as Status);
    io.to(room(id)).emit("playback:control", {
      type: "SEEK",
      positionMs: updated.currentPositionMs,
      epoch: updated.epoch,
    });
    return updated;
  });

  app.post("/v1/playback-sessions/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await prisma.playbackSession.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ error: "Playback session not found" });
    const updated = await prisma.playbackSession.update({
      where: { id },
      data: { status: "STOPPED", endedAt: new Date() },
    });
    runtimeFor(id, updated.epoch, "STOPPED");
    io.to(room(id)).emit("playback:control", { type: "STOP", epoch: updated.epoch });
    runtimes.delete(id);
    return updated;
  });

  io.on("connection", (socket: Socket) => {
    const sessionId = typeof socket.handshake.auth?.sessionId === "string" ? socket.handshake.auth.sessionId : "";
    if (!sessionId) return;
    void prisma.playbackSession
      .findUnique({ where: { id: sessionId } })
      .then((session) => {
        if (!session || session.status === "STOPPED") {
          socket.disconnect(true);
          return;
        }
        runtimeFor(session.id, session.epoch, session.status as Status);
        socket.join(room(session.id));
        socket.emit("playback:ready", {
          sessionId,
          epoch: session.epoch,
          status: session.status,
          currentPositionMs: session.currentPositionMs,
        });
      })
      .catch(() => socket.disconnect(true));

    socket.on("media:window", async (raw: unknown, ack?: (result: unknown) => void) => {
      const session = await prisma.playbackSession.findUnique({ where: { id: sessionId } }).catch(() => null);
      const runtime = session ? runtimeFor(session.id, session.epoch, session.status as Status) : null;
      if (!session || !runtime || session.status !== "PLAYING" || runtime.status !== "PLAYING") {
        ack?.({ accepted: false, reason: "Session is not playing" });
        return;
      }
      const parsed = realtimeWindowSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ accepted: false, reason: "Invalid media window", details: parsed.error.flatten() });
        return;
      }
      const window = parsed.data;
      if (window.epoch !== session.epoch || window.epoch !== runtime.epoch) {
        ack?.({ accepted: false, reason: "Stale playback epoch" });
        return;
      }
      if (runtime.pendingWindows.length >= MAX_PENDING_WINDOWS) {
        runtime.pendingWindows.shift();
      }
      runtime.pendingWindows.push({ socket, window });
      await prisma.playbackSession
        .update({ where: { id: sessionId }, data: { currentPositionMs: window.endMs, lastHeartbeatAt: new Date() } })
        .catch(() => undefined);
      ack?.({ accepted: true, queued: runtime.inFlight ? runtime.pendingWindows.length : 0 });
      void drainWindows(sessionId, io);
    });
  });
}
