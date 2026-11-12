import { describe, expect, it } from "vitest";
import { decideCommentary } from "./index.js";
import type { CommentaryEvent } from "@cricket/shared";

const event = (eventType: CommentaryEvent["eventType"], confidence = 0.95): CommentaryEvent => ({
  startSeconds: 1,
  endSeconds: 2,
  eventType,
  observation: "Ball clears the boundary",
  commentaryText: "क्या शानदार शॉट!",
  emotion: "excited",
  confidence,
});

describe("commentary director", () => {
  it("suppresses routine delivery observations", () => {
    expect(decideCommentary(event("DELIVERY"))).toBeNull();
  });
  it("requires stronger evidence for a six", () => {
    expect(decideCommentary(event("SIX", 0.89))).toBeNull();
    expect(decideCommentary(event("SIX", 0.95))?.emotion).toBe("high_excitement");
  });
  it("uses composed delivery for defensive shots", () => {
    expect(decideCommentary(event("DEFENSIVE_SHOT", 0.85))?.emotion).toBe("controlled");
  });
  it("keeps useful singles without overreacting", () => {
    expect(decideCommentary(event("SINGLE", 0.75))?.emotion).toBe("excited");
  });
  it("suppresses unknown events", () => {
    expect(decideCommentary(event("UNKNOWN"))).toBeNull();
  });
});
