import { GoogleGenAI } from "@google/genai";
import { commentaryResponseSchema, type CommentaryEvent } from "@cricket/shared";

export interface RealtimeFrame { timestampMs: number; jpegBase64: string }
export interface RealtimeContext {
  recentEvents: Array<{ timestampMs: number; eventType: string; summary: string }>;
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
  const context = input.context.recentEvents.slice(-8)
    .map(e => `${(e.timestampMs / 1000).toFixed(1)}s ${e.eventType}: ${e.summary}`).join("\n");
  const instructions = [
    "You are an independent cricket match commentator.",
    "Analyse synchronized original match audio and timestamped video frames.",
    "Use audio for bat impact, crowd, appeals and umpire/broadcast context; use visual evidence to confirm action and outcome.",
    "Crowd noise alone never proves a wicket or boundary. Never invent player names, score, over, ball number, runs, teams or outcomes.",
    "Do not repeat prior commentary. If uncertain, return no event.",
    "Write concise natural Hinglish (Hindi plus common English cricket terms).",
    "Return JSON only: {events:[{startSeconds,endSeconds,eventType,observation,commentaryText,emotion,confidence}]}",
    "Allowed event types: DELIVERY,SHOT,DEFENSIVE_SHOT,DOT_BALL,SINGLE,TWO_RUNS,THREE_RUNS,BOUNDARY_FOUR,SIX,WICKET,CATCH,RUN_OUT,REPLAY,APPEAL,UNKNOWN.",
    "Emotion: neutral,controlled,excited,high_excitement,dramatic,suspenseful.",
    `Window ${input.startMs}-${input.endMs}ms. Times are relative to window start.`,
    `Confirmed recent context: ${context || "none"}`,
  ].join("\n");
  const parts: Array<Record<string, unknown>> = [{ text: instructions }];
  if (input.audioWav?.length) {
    parts.push({ inlineData: { mimeType: "audio/wav", data: input.audioWav.toString("base64") } });
  }
  for (const frame of input.frames) {
    parts.push({ text: `VIDEO FRAME at match timestamp ${frame.timestampMs}ms` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: frame.jpegBase64 } });
  }
  const ai = new GoogleGenAI({ apiKey });
  const result = await ai.models.generateContent({
    model: process.env.GEMINI_REALTIME_MODEL ?? "gemini-2.5-flash",
    contents: [{ role: "user", parts: parts as never }],
    config: { responseMimeType: "application/json", temperature: 0.2 },
  });
  const raw = (result.text ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Gemini returned no structured event response");
  const parsed = commentaryResponseSchema.safeParse(JSON.parse(raw.slice(first, last + 1)));
  if (!parsed.success) throw new Error("Invalid realtime Gemini response: " + parsed.error.message);
  return parsed.data.events;
}
