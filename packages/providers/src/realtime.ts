import { GoogleGenAI } from "@google/genai";
import {
  commentaryResponseSchema,
  EMOTIONS,
  EVENT_TYPES,
  type CommentaryEvent,
} from "@cricket/shared";

export interface RealtimeFrame {
  timestampMs: number;
  jpegBase64: string;
}
export interface RealtimeContext {
  recentEvents: Array<{ timestampMs: number; eventType: string; summary: string }>;
}

const VALID_EVENTS = new Set<string>(EVENT_TYPES);
const VALID_EMOTIONS = new Set<string>(EMOTIONS);
const FALLBACK_REALTIME_MODEL = "gemini-2.5-flash";

function normalizeDecodedEvents(decoded: unknown): unknown {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return decoded;
  const payload = decoded as { events?: unknown };
  if (!Array.isArray(payload.events)) return decoded;
  payload.events = payload.events.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const event = { ...(item as Record<string, unknown>) };
    for (const key of ["startSeconds", "endSeconds", "confidence"]) {
      const value = event[key];
      if (typeof value === "string" && value.trim() !== "") {
        const numeric = Number(value.trim());
        if (Number.isFinite(numeric)) event[key] = numeric;
      }
    }
    if (typeof event.eventType === "string") {
      const normalized = event.eventType.trim().toUpperCase().replace(/[\s-]+/g, "_");
      event.eventType = VALID_EVENTS.has(normalized) ? normalized : "UNKNOWN";
    }
    if (typeof event.emotion === "string") {
      const normalized = event.emotion.trim().toLowerCase().replace(/[\s-]+/g, "_");
      event.emotion = VALID_EMOTIONS.has(normalized) ? normalized : "neutral";
    }
    return event;
  });
  return payload;
}

function isRetryableModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("503") || msg.includes("UNAVAILABLE") || msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
}

/** A bounded multimodal request for one synchronized playback window. */
export async function analyzeRealtimeWindow(input: {
  startMs: number;
  endMs: number;
  frames: RealtimeFrame[];
  audioWav?: Buffer;
  context: RealtimeContext;
}): Promise<CommentaryEvent[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");
  const windowDurationSec = Math.max(0.1, (input.endMs - input.startMs) / 1000).toFixed(2);
  const context = input.context.recentEvents
    .slice(-8)
    .map((e) => `${(e.timestampMs / 1000).toFixed(1)}s ${e.eventType}: ${e.summary}`)
    .join("\n");
  const instructions = [
    "You are an independent cricket match commentator.",
    "Analyse synchronized original match audio and timestamped video frames.",
    "Use audio for bat impact, crowd, appeals and umpire/broadcast context; use visual evidence to confirm action and outcome.",
    "Crowd noise alone never proves a wicket or boundary. Never invent player names, score, over, ball number, runs, teams or outcomes.",
    "Do not repeat prior commentary. If uncertain, return no event.",
    "Write concise natural Hinglish (Hindi plus common English cricket terms).",
    "Return JSON only with JSON numbers (not strings) for startSeconds, endSeconds, and confidence (0..1): {events:[{startSeconds,endSeconds,eventType,observation,commentaryText,emotion,confidence}]}",
    "Allowed event types: DELIVERY,SHOT,DEFENSIVE_SHOT,DOT_BALL,SINGLE,TWO_RUNS,THREE_RUNS,BOUNDARY_FOUR,SIX,WICKET,CATCH,RUN_OUT,REPLAY,APPEAL,UNKNOWN.",
    "Emotion: neutral,controlled,excited,high_excitement,dramatic,suspenseful.",
    `Window duration is ${windowDurationSec}s. startSeconds and endSeconds MUST be between 0 and ${windowDurationSec} relative to this window's start.`,
    `Confirmed recent context: ${context || "none"}`,
  ].join("\n");
  const parts: Array<Record<string, unknown>> = [{ text: instructions }];
  if (input.audioWav?.length) {
    parts.push({ inlineData: { mimeType: "audio/wav", data: input.audioWav.toString("base64") } });
  }
  for (const frame of input.frames) {
    const relMs = Math.max(0, frame.timestampMs - input.startMs);
    parts.push({ text: `VIDEO FRAME at +${relMs}ms from window start` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: frame.jpegBase64 } });
  }

  const primary = process.env.GEMINI_REALTIME_MODEL ?? "gemini-3-flash-preview";
  const models = primary === FALLBACK_REALTIME_MODEL ? [primary] : [primary, FALLBACK_REALTIME_MODEL];
  const ai = new GoogleGenAI({ apiKey });

  let result;
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    try {
      result = await ai.models.generateContent({
        model: models[i]!,
        contents: [{ role: "user", parts: parts as never }],
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      break;
    } catch (err) {
      lastError = err;
      if (i === models.length - 1 || !isRetryableModelError(err)) throw err;
    }
  }
  if (!result) throw lastError ?? new Error("Gemini realtime call failed");

  const raw = (result.text ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Gemini returned no structured event response");
  const decoded = normalizeDecodedEvents(JSON.parse(raw.slice(first, last + 1)));
  const parsed = commentaryResponseSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("Invalid realtime Gemini response: " + parsed.error.message);
  return parsed.data.events;
}
