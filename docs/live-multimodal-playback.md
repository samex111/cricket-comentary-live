# Live multimodal playback (experimental)

This branch adds a separate playback-controlled path. The existing BullMQ offline analysis pipeline remains unchanged.

## Flow

1. The browser creates a playback session with POST /v1/videos/:id/playback-sessions.
2. The browser opens Socket.IO with auth.sessionId.
3. While the video is playing, the browser captures timestamped JPEG frames using requestVideoFrameCallback and original audio from the video element.
4. Every 2.5 seconds it sends a bounded media window to media:window.
5. The API calls the realtime Gemini provider with aligned audio and frames, validates candidate events with Commentary Director, and invokes TTS only for approved events.
6. The API emits commentary:event and commentary:audio. The browser queues speech and rejects stale epochs.

## Local setup

1. Apply the Prisma schema: npm run db:push.
2. Regenerate Prisma: npm run db:generate.
3. Set GEMINI_API_KEY and optionally GEMINI_REALTIME_MODEL (defaults to gemini-2.5-flash).
4. Run npm run dev.
5. Upload a video as usual, then open /live/<video-id>.

## Experimental limitations

- The initial browser audio capture uses ScriptProcessorNode for broad compatibility; replace it with AudioWorklet before production.
- The API uses an in-process inference lock per playback session. Multi-instance deployments need a Redis-backed lease/queue.
- The browser drops windows while inference is busy rather than building an unbounded backlog.
- Inference uses short-window Gemini generateContent, not Gemini Live. It is incremental and playback-controlled, but each request incurs model latency.
- Generated audio plays as soon as ready; this is low-latency mode, not a delayed-video buffer.
- Session IDs act as capability tokens. The existing app has no user authentication, so add user ownership checks before exposing sessions to untrusted users.
- Browser media capture requires a CORS-readable stream and user interaction to unlock audio.
- Run db:push before using the new endpoints. This branch does not include a production migration.

## Timeline safety

Every media window and generated event carries an epoch. Seeking increments the epoch; server and browser reject stale inference/audio from earlier epochs. Pause prevents new windows and suppresses results that finish while paused. Stop ends the session.
