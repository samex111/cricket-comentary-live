import { z } from "zod";

export const playbackStatusSchema = z.enum(["READY", "PLAYING", "PAUSED", "STOPPED", "FAILED"]);
export const realtimeFrameSchema = z.object({ timestampMs: z.number().int().min(0), jpegBase64: z.string().min(16).max(350_000) });
export const realtimeWindowSchema = z.object({
  epoch: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  frames: z.array(realtimeFrameSchema).min(1).max(8),
  audioWavBase64: z.string().max(700_000).optional(),
}).refine(v => v.endMs > v.startMs, { path: ["endMs"], message: "Window end must be after start" })
  .refine(v => v.frames.every(f => f.timestampMs >= v.startMs && f.timestampMs <= v.endMs), { path: ["frames"], message: "Frame timestamps must fall inside the media window" });

export type PlaybackStatus = z.infer<typeof playbackStatusSchema>;
export type RealtimeWindow = z.infer<typeof realtimeWindowSchema>;
