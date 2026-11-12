from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from math import atan2, degrees, hypot
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request
from ultralytics import YOLO

MODEL_NAME = os.getenv("VISION_MODEL", "yolo11n.pt")
DEVICE = os.getenv("VISION_DEVICE", "auto")
API_KEY = os.getenv("VISION_SERVICE_KEY", "")
IMAGE_SIZE = int(os.getenv("VISION_IMAGE_SIZE", "640"))
CONFIDENCE = float(os.getenv("VISION_CONFIDENCE", "0.15"))
MAX_FRAME_BYTES = 512_000

app = FastAPI(title="Boundary Cricket Vision", version="0.1.0")
_model: YOLO | None = None
_model_load_lock = threading.Lock()
_inference_lock = threading.Lock()
_state_lock = threading.Lock()


@dataclass
class BallState:
    x: float
    y: float
    timestamp_ms: int
    vx: float | None = None
    vy: float | None = None


_states: dict[str, BallState] = {}


def angle_change_degrees(old_v: tuple[float, float], new_v: tuple[float, float]) -> float:
    old_angle = degrees(atan2(old_v[1], old_v[0]))
    new_angle = degrees(atan2(new_v[1], new_v[0]))
    delta = abs((new_angle - old_angle + 180) % 360 - 180)
    return delta


def get_model() -> YOLO:
    global _model
    if _model is None:
        with _model_load_lock:
            if _model is None:
                _model = YOLO(MODEL_NAME)
    return _model


def _distance_to_box(x: float, y: float, box: list[float]) -> float:
    x1, y1, x2, y2 = box
    dx = max(x1 - x, 0.0, x - x2)
    dy = max(y1 - y, 0.0, y - y2)
    return hypot(dx, dy)


def _update_ball_state(
    session_id: str,
    timestamp_ms: int,
    x: float,
    y: float,
    width: int,
    height: int,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    diagonal = max(1.0, hypot(width, height))
    with _state_lock:
        previous = _states.get(session_id)
        if previous:
            dt_ms = timestamp_ms - previous.timestamp_ms
            if 40 <= dt_ms <= 700:
                dx = x - previous.x
                dy = y - previous.y
                speed = hypot(dx, dy) / diagonal / (dt_ms / 1000.0)
                if previous.vx is not None and previous.vy is not None:
                    turn = angle_change_degrees((previous.vx, previous.vy), (dx, dy))
                    # Candidate only: camera pans and missed detections can also cause turns.
                    if turn >= 65 and speed >= 0.08:
                        events.append({
                            "type": "POSSIBLE_BAT_CONTACT",
                            "confidence": 0.35,
                            "evidence": {"directionChangeDegrees": round(turn, 1), "normalizedSpeed": round(speed, 3)},
                        })
                if dx or dy:
                    previous.vx, previous.vy = dx, dy
            _states[session_id] = BallState(x=x, y=y, timestamp_ms=timestamp_ms, vx=previous.vx, vy=previous.vy)
        else:
            _states[session_id] = BallState(x=x, y=y, timestamp_ms=timestamp_ms)

        edge_distance = min(x, y, width - x, height - y) / diagonal
        if edge_distance <= 0.055:
            events.append({
                "type": "BALL_NEAR_FRAME_EDGE",
                "confidence": 0.25,
                "evidence": {"normalizedEdgeDistance": round(edge_distance, 3)},
            })
    return events


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "boundary-cricket-vision",
        "model": MODEL_NAME,
        "loaded": _model is not None,
        "device": DEVICE,
    }


@app.post("/detect")
async def detect_frame(
    request: Request,
    x_session_id: str = Header(default="default"),
    x_vision_key: str = Header(default=""),
    x_timestamp_ms: int = Header(default=0),
) -> dict[str, Any]:
    if API_KEY and x_vision_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid vision service key")
    raw = await request.body()
    if not raw or len(raw) > MAX_FRAME_BYTES:
        raise HTTPException(status_code=413, detail="Frame missing or exceeds 512 KB")

    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Invalid JPEG frame")
    height, width = image.shape[:2]

    started = time.perf_counter()
    try:
        # Load outside the inference lock to avoid recursively acquiring the model-load lock.
        model = get_model()
        kwargs: dict[str, Any] = {
                "source": image,
                "imgsz": IMAGE_SIZE,
                "conf": CONFIDENCE,
                "classes": [0, 32],  # COCO: person and sports ball.
                "verbose": False,
            }
        if DEVICE != "auto":
            kwargs["device"] = DEVICE
        # Inference is serialized because one model instance is shared across requests.
        with _inference_lock:
            results = model.predict(**kwargs)
    except Exception as error:
        raise HTTPException(status_code=503, detail=f"Vision inference failed: {error}") from error

    objects: list[dict[str, Any]] = []
    ball_candidates: list[tuple[float, float, float, list[float]]] = []
    players: list[list[float]] = []
    if results and results[0].boxes is not None:
        for box in results[0].boxes:
            class_id = int(box.cls.item())
            confidence = float(box.conf.item())
            x1, y1, x2, y2 = [float(value) for value in box.xyxy[0].tolist()]
            xyxy = [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)]
            if class_id == 32:
                cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
                ball_candidates.append((confidence, cx, cy, xyxy))
                objects.append({"type": "sports_ball_candidate", "confidence": round(confidence, 3), "box": xyxy})
            elif class_id == 0:
                players.append(xyxy)
                objects.append({"type": "player", "confidence": round(confidence, 3), "box": xyxy})

    events: list[dict[str, Any]] = []
    ball = max(ball_candidates, key=lambda item: item[0]) if ball_candidates else None
    if ball:
        confidence, cx, cy, box = ball
        events.extend(_update_ball_state(x_session_id, x_timestamp_ms, cx, cy, width, height))
        closest_player = min((_distance_to_box(cx, cy, player) for player in players), default=None)
        if closest_player is not None and closest_player / max(1.0, hypot(width, height)) <= 0.045:
            events.append({
                "type": "BALL_NEAR_PLAYER",
                "confidence": round(min(0.45, confidence * 0.5), 3),
                "evidence": {"normalizedDistance": round(closest_player / max(1.0, hypot(width, height)), 3)},
            })

    return {
        "timestampMs": x_timestamp_ms,
        "width": width,
        "height": height,
        "objects": objects,
        "candidateEvents": events,
        "inferenceMs": round((time.perf_counter() - started) * 1000, 1),
        "model": MODEL_NAME,
        "note": "COCO sports-ball/person detections are weak candidate signals, not confirmed cricket events.",
    }


@app.delete("/sessions/{session_id}")
def clear_session(
    session_id: str,
    x_vision_key: str = Header(default="", alias="X-Vision-Key"),
) -> dict[str, bool]:
    if API_KEY and x_vision_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid vision service key")
    with _state_lock:
        _states.pop(session_id, None)
    return {"cleared": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "vision_service:app",
        host=os.getenv("VISION_HOST", "127.0.0.1"),
        port=int(os.getenv("VISION_PORT", "8010")),
        reload=False,
    )
