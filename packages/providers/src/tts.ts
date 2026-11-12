import { GoogleGenAI } from "@google/genai";

const styles: Record<string, string> = {
  neutral: "Clear natural Indian Hindi sports broadcast delivery.",
  controlled: "Composed confident Indian cricket commentary.",
  excited: "Energetic Indian cricket commentator, brisk pace and clear articulation.",
  high_excitement: "High-energy cricket broadcast reaction, emphatic but intelligible.",
  dramatic: "Dramatic delivery with a pause before the key phrase.",
  suspenseful: "Build suspense with measured pacing and deliberate pauses.",
};

const FALLBACK_TTS_MODEL = "gemini-2.5-flash-preview-tts";

function isRetryableTtsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("503") || msg.includes("UNAVAILABLE");
}

export async function speak(text: string, emotion: string) {
  if (!process.env.GEMINI_API_KEY) throw Error("GEMINI_API_KEY missing");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const primary = process.env.GEMINI_TTS_MODEL ?? "gemini-3.8-flash-tts";
  const models = primary === FALLBACK_TTS_MODEL ? [primary] : [primary, FALLBACK_TTS_MODEL];

  let r: any;
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    try {
      r = await ai.models.generateContent({
        model: models[i]!,
        contents: [{ role: "user", parts: [{ text: styles[emotion] ?? styles.neutral }, { text }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_TTS_VOICE ?? "Kore" } } },
        },
      } as any);
      break;
    } catch (err) {
      lastError = err;
      if (i === models.length - 1 || !isRetryableTtsError(err)) throw err;
    }
  }
  if (!r) throw lastError ?? Error("TTS failed");

  const part = (r.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw Error("TTS returned no audio");
  const raw = Buffer.from(part.inlineData.data, "base64");
  const mime = part.inlineData.mimeType ?? "";
  if (mime.includes("wav")) return raw;
  const rate = 24000,
    channels = 1,
    bits = 16,
    header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + raw.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(raw.length, 40);
  return Buffer.concat([header, raw]);
}
