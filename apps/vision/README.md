# Boundary local cricket vision sidecar

This optional service runs fast, local frame inference separately from Gemini Live. The first implementation uses Ultralytics YOLO11n with COCO classes `person` and `sports ball`, then derives low-confidence trajectory/edge/near-player candidates across frames.

It deliberately does **not** claim to confirm a wicket, catch, four, six, or run. Generic COCO weights are not cricket-trained and can miss a small, blurred ball. Candidate signals are sent to Gemini as supporting context and must be corroborated with the match audio and surrounding video.

## Setup (Windows PowerShell)

```powershell
cd apps/vision
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
$env:VISION_MODEL = "yolo11n.pt"
$env:VISION_DEVICE = "auto"
$env:VISION_SERVICE_KEY = "change-this-local-key"
python vision_service.py
```

The first run downloads the YOLO weights. Set `VISION_DEVICE=0` only after installing a PyTorch build compatible with your NVIDIA driver/CUDA runtime. `auto` lets Ultralytics choose the available device.

Health check: `http://127.0.0.1:8010/health`.

The API calls `POST /detect` with JPEG bytes and headers `X-Session-Id`, `X-Timestamp-Ms`, and `X-Vision-Key`. It sends the most useful candidate signals to the persistent Gemini session. If the sidecar is offline, Gemini Live continues with the original match audio and one visual sample per second.
