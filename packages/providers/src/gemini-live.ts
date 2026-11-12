import { GoogleGenAI } from "@google/genai";

export type GeminiLiveCallbacks = {
  onAudio: (pcm24k: Buffer) => void;
  onText: (text: string) => void;
  onGenerationComplete: () => void;
  onInterrupted: () => void;
  onResumptionUpdate: (handle: string, resumable: boolean) => void;
  onGoAway: (timeLeftMs: number) => void;
  onError: (error: Error) => void;
  onClose: (reason: string) => void;
};

export type GeminiLiveConnection = {
  sendAudio: (pcm16k: Buffer) => void;
  sendVideo: (jpeg: Buffer) => void;
  sendContext: (text: string) => void;
  close: () => void;
};

export type ConnectGeminiLiveOptions = {
  apiKey?: string;
  model?: string;
  resumeHandle?: string | null;
  voiceName?: string;
  callbacks: GeminiLiveCallbacks;
};

const SYSTEM_INSTRUCTION = `
You are Boundary, an independent Indian cricket radio commentator watching a live cricket match.
Your role is to describe only what the match audio and supplied visual evidence support.
Speak natural, lively Hinglish (Hindi grammar with familiar English cricket terms), as a professional Indian broadcast commentator.
Be concise and specific. Do not narrate every ball mechanically. Stay quiet during routine gaps and speak when a delivery, shot, run, appeal, wicket chance, boundary, fielding action, or meaningful tactical moment deserves commentary.
Never copy, quote, translate, or repeat the source broadcast commentator. You are an independent commentator.
Never invent player names, teams, score, over, ball number, run count, umpire decision, wicket, catch, or boundary. Crowd noise alone is not proof of an outcome.
Treat local vision detections as candidate evidence, not facts. A "possible bat contact" or "ball near player" is not confirmation of a shot, catch, or wicket.
Use recent context to avoid repeated commentary. Do not describe an event twice.
Do not speak about the AI, the stream, the API, or your analysis process.
When uncertain, remain silent rather than fabricate.
`;

function durationMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = value.match(/([0-9.]+)\s*(ms|s|m)?/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = (match[2] ?? "ms").toLowerCase();
  return Math.round(amount * (unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1));
}

function toBase64(bytes: Buffer): string {
  return bytes.toString("base64");
}

/**
 * One persistent Gemini Live session for one playback session.
 * Audio is streamed as raw PCM16/16kHz; generated speech is raw PCM16/24kHz.
 */
export async function connectGeminiLive(options: ConnectGeminiLiveOptions): Promise<GeminiLiveConnection> {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing");
  const ai = new GoogleGenAI({ apiKey });
  const model = options.model ?? process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live";

  const config = {
    responseModalities: ["AUDIO"],
    generationConfig: {
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: options.voiceName ?? process.env.GEMINI_LIVE_VOICE ?? "Kore",
          },
        },
      },
    },
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    outputAudioTranscription: {},
    sessionResumption: {
      ...(options.resumeHandle ? { handle: options.resumeHandle } : {}),
      transparent: true,
    },
    contextWindowCompression: {
      triggerTokens: "16000",
      slidingWindow: { targetTokens: "8000" },
    },
    proactivity: { proactiveAudio: true },
  };

  const session = await ai.live.connect({
    model,
    config: config as never,
    callbacks: {
      onmessage: (message) => {
        const msg = message as {
          serverContent?: {
            modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> };
            outputTranscription?: { text?: string };
            generationComplete?: boolean;
            turnComplete?: boolean;
            interrupted?: boolean;
          };
          sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
          goAway?: { timeLeft?: string };
        };
        const content = msg.serverContent;
        let fallbackText = "";
        if (content?.modelTurn?.parts) {
          for (const part of content.modelTurn.parts) {
            const audio = part.inlineData?.data;
            if (audio) options.callbacks.onAudio(Buffer.from(audio, "base64"));
            if (part.text?.trim()) fallbackText += (fallbackText ? " " : "") + part.text.trim();
          }
        }
        // Prefer the dedicated audio transcription stream; part.text is a fallback only.
        const transcript = content?.outputTranscription?.text?.trim();
        if (transcript) options.callbacks.onText(transcript);
        else if (fallbackText) options.callbacks.onText(fallbackText);
        if (content?.interrupted) options.callbacks.onInterrupted();
        if (content?.generationComplete || content?.turnComplete) options.callbacks.onGenerationComplete();

        const resume = msg.sessionResumptionUpdate;
        if (resume?.newHandle) options.callbacks.onResumptionUpdate(resume.newHandle, resume.resumable !== false);
        if (msg.goAway?.timeLeft) options.callbacks.onGoAway(durationMs(msg.goAway.timeLeft));
      },
      onerror: (event) => {
        const message = typeof event === "object" && event !== null && "message" in event
          ? String((event as { message?: unknown }).message ?? "Gemini Live connection error")
          : "Gemini Live connection error";
        options.callbacks.onError(new Error(message));
      },
      onclose: (event) => {
        const reason = typeof event === "object" && event !== null && "reason" in event
          ? String((event as { reason?: unknown }).reason ?? "Gemini Live connection closed")
          : "Gemini Live connection closed";
        options.callbacks.onClose(reason);
      },
    },
  });

  return {
    sendAudio(pcm16k) {
      if (pcm16k.length === 0) return;
      session.sendRealtimeInput({
        audio: { data: toBase64(pcm16k), mimeType: "audio/pcm;rate=16000" },
      } as never);
    },
    sendVideo(jpeg) {
      if (jpeg.length === 0) return;
      session.sendRealtimeInput({
        video: { data: toBase64(jpeg), mimeType: "image/jpeg" },
      } as never);
    },
    sendContext(text) {
      if (!text.trim()) return;
      session.sendRealtimeInput({ text } as never);
    },
    close() {
      session.close();
    },
  };
}
