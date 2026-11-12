import type { CommentaryEvent } from "@cricket/shared";

/**
 * A conservative editorial gate between model perception and the commentary feed.
 * It deliberately suppresses routine observations and raises confidence requirements
 * for high-impact claims that would damage trust if hallucinated.
 */
const MIN_CONFIDENCE: Record<string, number> = {
  DELIVERY: 1.01,
  SHOT: 1.01,
  APPEAL: 1.01,
  REPLAY: 1.01,
  UNKNOWN: 1.01,
  DEFENSIVE_SHOT: 0.8,
  DOT_BALL: 0.9,
  SINGLE: 0.7,
  TWO_RUNS: 0.7,
  THREE_RUNS: 0.7,
  BOUNDARY_FOUR: 0.85,
  SIX: 0.9,
  WICKET: 0.9,
  CATCH: 0.9,
  RUN_OUT: 0.9,
};

const EVENT_EMOTION: Record<string, CommentaryEvent["emotion"]> = {
  DEFENSIVE_SHOT: "controlled",
  DOT_BALL: "controlled",
  BOUNDARY_FOUR: "excited",
  SIX: "high_excitement",
  WICKET: "dramatic",
  CATCH: "high_excitement",
  RUN_OUT: "dramatic",
};

export function decideCommentary(event: CommentaryEvent): CommentaryEvent | null {
  const threshold = MIN_CONFIDENCE[event.eventType] ?? 0.65;
  if (event.confidence < threshold) return null;
  const commentaryText = event.commentaryText.trim();
  if (!commentaryText || event.eventType === "UNKNOWN") return null;
  return {
    ...event,
    commentaryText,
    emotion: EVENT_EMOTION[event.eventType] ?? event.emotion,
  };
}
