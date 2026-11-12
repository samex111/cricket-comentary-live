# Boundary — AI Cricket Commentary Studio

Upload cricket clips to private Google Drive storage, analyse them progressively with Gemini, and generate timestamped Hinglish commentary with optional TTS audio.

## Requirements
- Node.js 22+, npm 10+
- Docker Desktop
- FFmpeg and FFprobe on PATH
- Google Cloud project with Drive API and OAuth web client
- Gemini API key with access to configured video and TTS models

## Local setup
1. Copy .env.example to .env and fill Google OAuth and Gemini credentials.
2. Generate a 32-byte key with: openssl rand -base64 32. Put it in TOKEN_ENCRYPTION_KEY.
3. Add http://localhost:4000/v1/google/callback as an authorized OAuth redirect URI.
4. Run docker compose up -d.
5. Run npm install.
6. Run npm run db:generate and npm run db:push.
7. Run npm run dev and open http://localhost:3000.
8. Connect Drive, upload a clip, select it and press Start AI commentary.

## Flow
The API validates the multipart video and writes it to a temporary disk file, then streams it to Drive using resumable upload. The database record is created only after Drive confirms upload completion. The user explicitly starts analysis to avoid unexpected inference costs. BullMQ downloads the private Drive source, FFprobe inspects it, FFmpeg extracts overlapping chunks, and Gemini analyses each chunk sequentially. Zod validates model output; timestamps are translated into the original video timeline and saved to PostgreSQL. Optional TTS generates per-event audio stored privately in Drive. The dashboard polls persisted commentary and lets the user seek to each event.

## Services
Web: localhost:3000. API: localhost:4000. Health: /health. PostgreSQL: localhost:5432. Redis: localhost:6379.

## Important notes
- No app-user authentication is implemented. Google OAuth is still required to grant Drive access.
- Original video and generated audio remain private Drive files. The API streams them; it does not make them public.
- The first release uses explicit Start AI commentary rather than automatically triggering on Play, to avoid accidental API spend.
- Dashboard updates currently use polling. Worker-to-Socket.IO pub/sub is a follow-up; do not assume Socket.IO events are currently emitted.
- Chunk analysis is sequential. Sampling/FPS configuration must be checked against the selected Gemini API/model before claiming exact frame sampling behaviour.
- TTS response encoding metadata must be verified for the selected model. Do not assume a fixed PCM sample rate without checking provider output.
- Tests cover upload validation, schema validation and chunk planning. Real Google/Gemini integration has not been executed from this environment.
- Do not expose the unauthenticated API publicly. Add access controls, quotas, CSRF protections, cleanup and tenant isolation before deployment.

## Commands
- npm run dev: start API, worker and web
- npm run typecheck: type-check workspaces
- npm test: run Vitest tests
- npm run db:generate: generate Prisma client
- npm run db:push: sync schema to local database

See docs/implementation-status.md for remaining production verification tasks.
