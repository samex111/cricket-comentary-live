# Gemini Live cricket commentary engine

This branch introduces a separate persistent Live path. The existing upload, offline analysis, BullMQ worker and Commentary Studio workflow remain available.

## Architecture

1. The browser creates a playback session and connects Socket.IO using its session capability ID.
2. On Play, an AudioWorklet taps the original video element audio. It downmixes and resamples to mono PCM16 at 16 kHz and sends 40 ms chunks to the API.
3. The API opens one persistent Gemini Live WebSocket session for that playback session. It forwards the continuous audio stream and receives native PCM16 24 kHz speech plus output transcription.
4. The browser captures timestamped video frames. It sends one frame per second to Gemini Live, matching the Live API video input limit.
5. In parallel, it sends up to about 10 JPEG frames per second to the optional local Python vision sidecar. The sidecar runs YOLO11n COCO person/sports-ball detection and produces weak ball trajectory/near-player/edge candidates.
6. The API sends candidate observations to Gemini as untrusted visual context. The model must corroborate them with match audio and must not claim a wicket, catch, run or boundary from weak detector output alone.
7. Native Gemini audio chunks are streamed over Socket.IO to the browser and played through the AudioWorklet. The browser mixes the speech over the original video audio and clears generated speech on interruption, pause, seek and stop.
8. The API stores output transcriptions as playback events, retains a rolling set of visual observations, persists Live session resumption handles and emits status/error events.

## Local setup

### 1. Configure Node services

Copy `.env.example` to `.env` and set:

- `GEMINI_API_KEY` — server-side API key. Never expose this key in browser code.
- `GEMINI_LIVE_MODEL=gemini-3.8-live`
- `GEMINI_LIVE_VOICE=Kore`
- `VISION_SERVICE_URL=http://127.0.0.1:8010`
- `VISION_SERVICE_KEY` — use the same random local secret in the API and vision service.

Apply the new Prisma fields and install the upgraded Google GenAI SDK:

```powershell
npm install
npm run db:push
npm run db:generate
```

### 2. Start the local vision sidecar (optional but recommended)

Follow [apps/vision/README.md](../apps/vision/README.md). On Windows:

```powershell
cd apps/vision
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:VISION_SERVICE_KEY = "same-random-secret-as-api-env"
python vision_service.py
```

The sidecar downloads YOLO11n weights on first startup. Install a CUDA-compatible PyTorch build before setting `VISION_DEVICE=0`; otherwise leave `auto`.

### 3. Run Boundary

From the repository root:

```powershell
npm run dev
```

Connect Google Drive and open a video's **Live multimodal mode** page. Press **Play / Resume** to start the persistent Live session.

## Audio and video formats

- Browser input: mono, signed PCM16, 16 kHz, little-endian, 40 ms (640-sample) chunks.
- Gemini Live video: JPEG, no more than one frame per second.
- Local vision path: JPEG up to about 10 frames per second, subject to browser decode and local model inference speed.
- Gemini output: PCM16, 24 kHz, streamed as model audio chunks.
- Voice is mixed into the original video's audio through the browser AudioWorklet. This is an overlay; it is not a replacement for or suppression of the source broadcast.

## Session lifecycle and synchronization

- Live session state is server-side; the browser only receives the session capability ID.
- Pause stops browser audio capture and speech playback while retaining the resumable model session.
- Seek increments the playback epoch, closes the old model session, clears the saved resumption handle and vision tracker, and starts a fresh context if playback was active.
- Stop closes the Live connection and clears the vision state.
- The API persists resumption handles, handles GoAway, uses exponential reconnect backoff and enables context-window compression.
- Playback position and rate are synchronized to the API every 250 ms. Commentary transcript events carry the match position at the start of the model turn.
- Audio chunks include an epoch and generated timestamp; the browser rejects stale epochs and chunks that have already aged out.

## Important limitations

- The local vision service uses generic COCO YOLO11n weights. COCO's `sports ball` class is not a cricket-trained ball tracker. Small blurred balls, bat-ball contact, stump hits, catches and run-outs can be missed. Candidate events are explicitly weak and must never be treated as proof. High-quality cricket detection will require a cricket-specific labeled dataset/model and camera-aware tracking.
- Gemini Live receives at most one video frame per second. Fast action perception depends on the separate local visual path and original audio.
- This is a server-to-server Gemini Live integration. A deployment with multiple API replicas needs shared session coordination/ownership or sticky routing; in-process connection objects are not distributed.
- The current app has no user authentication. Session IDs act as bearer capabilities. Add user ownership/authentication before exposing sessions to untrusted users.
- Session resumption and context compression are implemented but must be verified with a real API key over long sessions. Audio/video sessions have a short uncompressed context lifetime and WebSocket connections are periodically terminated; reconnection is expected.
- Generated audio is streamed immediately and mixed with the playing source. There is no intentional video delay/buffer, so the system cannot guarantee lip-sync or zero-latency commentary.
- Event type is heuristically derived from output transcription for the event-history UI; its currently stored 0.5 confidence is an uncalibrated placeholder, not a model confidence score.
- The local detector is optional. Without it, continuous match audio and Gemini's low-rate video frames still operate.
- A real end-to-end test requires a valid `GEMINI_API_KEY`, Google Drive-connected video, browser audio permission and the vision sidecar. CI can validate types/build/schema/Python syntax but cannot verify match interpretation or actual response latency.

## Troubleshooting

- `GEMINI_API_KEY is missing`: set the API key in the API process environment.
- `Vision unavailable`: check `VISION_SERVICE_URL`, the matching `VISION_SERVICE_KEY`, and whether port 8010 is listening.
- No audio: start playback from a user click so the browser can unlock AudioContext; verify the video stream is CORS-readable.
- Repeated Live reconnects: inspect `live:error` events and check model availability, quota, session-resumption messages and network connectivity.
