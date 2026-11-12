# Implementation status

## Included
- TypeScript npm-workspaces monorepo
- Next.js dark upload/library/commentary dashboard
- Fastify API, Google Drive OAuth, private uploads and range-stream playback
- Prisma schema for connection, videos, jobs, chunks, commentary and audio
- Redis/BullMQ worker for sequential chunk processing
- FFmpeg/FFprobe video inspection and segmentation
- Gemini video analysis with Zod output validation
- Optional Gemini TTS and Drive audio storage
- Unit tests for upload validation, output schema and chunk planner
- Docker Compose for PostgreSQL and Redis

## Required verification before production
- Install dependencies, generate Prisma client, run typecheck and tests in Node 22
- Confirm exact Gemini model IDs and SDK request shape against the target Google project
- Confirm TTS audio encoding/sample-rate metadata and WAV conversion
- Connect worker events to Socket.IO through Redis pub/sub; dashboard currently polls
- Add retry-safe idempotency for Drive audio uploads and orphan cleanup
- Add range-stream correctness and real provider integration tests
- Add upload cancellation, codec validation, retention and temp-file cleanup
- Review security before exposing the unauthenticated dashboard/API publicly


## Commentary quality gate
- A separate commentary-director package sits between Gemini event extraction and persistence.
- Routine delivery/shot/appeal/replay observations are suppressed from the spoken feed.
- SIX, WICKET, CATCH and RUN_OUT require at least 0.90 model confidence; boundary fours require 0.85.
- Event type sets a conservative delivery emotion for defensive shots, boundaries and wickets.
- These thresholds are heuristic safeguards, not measured accuracy. Tune them only against a labelled clip set.
