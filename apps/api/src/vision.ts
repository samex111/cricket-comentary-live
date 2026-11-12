export type VisionCandidate = {
  type: string;
  confidence: number;
  evidence?: Record<string, number>;
};

export type VisionFrameResult = {
  timestampMs: number;
  width: number;
  height: number;
  objects: Array<{ type: string; confidence: number; box: number[] }>;
  candidateEvents: VisionCandidate[];
  inferenceMs: number;
  model: string;
  note?: string;
};

export async function analyzeCricketFrame(
  sessionId: string,
  timestampMs: number,
  jpeg: Buffer,
): Promise<VisionFrameResult | null> {
  const baseUrl = process.env.VISION_SERVICE_URL?.trim();
  if (!baseUrl) return null;
  const timeoutMs = Math.max(150, Number(process.env.VISION_REQUEST_TIMEOUT_MS ?? 900));
  const response = await fetch(baseUrl.replace(/\/$/, "") + "/detect", {
    method: "POST",
    headers: {
      "content-type": "image/jpeg",
      "x-session-id": sessionId,
      "x-timestamp-ms": String(timestampMs),
      ...(process.env.VISION_SERVICE_KEY ? { "x-vision-key": process.env.VISION_SERVICE_KEY } : {}),
    },
    body: jpeg,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Vision service returned ${response.status}: ${detail.slice(0, 200)}`);
  }
  return (await response.json()) as VisionFrameResult;
}

export async function clearVisionSession(sessionId: string): Promise<void> {
  const baseUrl = process.env.VISION_SERVICE_URL?.trim();
  if (!baseUrl) return;
  await fetch(baseUrl.replace(/\/$/, "") + "/sessions/" + encodeURIComponent(sessionId), {
    method: "DELETE",
    headers: process.env.VISION_SERVICE_KEY ? { "x-vision-key": process.env.VISION_SERVICE_KEY } : {},
    signal: AbortSignal.timeout(700),
  }).catch(() => undefined);
}
