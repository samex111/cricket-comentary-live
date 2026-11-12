import { describe, expect, it } from "vitest";
import { realtimeWindowSchema } from "./playback.js";

const validWindow = {
  epoch: 2,
  startMs: 1000,
  endMs: 3500,
  frames: [
    { timestampMs: 1200, jpegBase64: "a".repeat(32) },
    { timestampMs: 2200, jpegBase64: "b".repeat(32) },
    { timestampMs: 3200, jpegBase64: "c".repeat(32) },
  ],
  audioWavBase64: "d".repeat(32),
};

describe("realtime playback media windows", () => {
  it("accepts bounded, timestamp-aligned audio/video windows", () => {
    expect(realtimeWindowSchema.safeParse(validWindow).success).toBe(true);
  });
  it("rejects frames outside the media-time window", () => {
    expect(realtimeWindowSchema.safeParse({
      ...validWindow,
      frames: [{ timestampMs: 4000, jpegBase64: "a".repeat(32) }],
    }).success).toBe(false);
  });
  it("rejects inverted windows", () => {
    expect(realtimeWindowSchema.safeParse({ ...validWindow, endMs: 500 }).success).toBe(false);
  });
  it("rejects too many frames to keep transport bounded", () => {
    expect(realtimeWindowSchema.safeParse({
      ...validWindow,
      frames: Array.from({ length: 9 }, (_, i) => ({ timestampMs: 1100 + i * 100, jpegBase64: "a".repeat(32) })),
    }).success).toBe(false);
  });
  it("accepts video-only windows when audio capture is unavailable", () => {
    const { audioWavBase64: _audio, ...videoOnly } = validWindow;
    expect(realtimeWindowSchema.safeParse(videoOnly).success).toBe(true);
  });
});
