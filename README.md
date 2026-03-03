# Visio - Live Accessibility Agent

Real-time AI accessibility assistant that helps visually impaired users navigate and understand their environment using camera and voice.

Built with **Google ADK** (Agent Development Kit) and **Gemini 2.5 Flash** with native audio support.

## What It Does

Visio uses your device's camera and microphone to:

- **Describe surroundings** in clear, natural spoken language with directional cues
- **Read text** — signs, labels, menus, screens — aloud instantly
- **Answer questions** about what's in front of you
- **Warn about hazards** — stairs, obstacles, uneven surfaces, moving objects
- **Search for information** about objects, products, or landmarks using Google Search grounding

## Architecture

```
Browser (PWA)                    Server (FastAPI)                 Google Cloud
+------------------+            +-------------------+            +------------------+
|                  |  Binary WS |                   |  ADK BIDI  |                  |
|  Camera (768px)  |----------->|  FastAPI + ADK    |<---------->|  Gemini 2.5      |
|  Mic (16kHz PCM) |  JSON WS   |  Runner           |  Streaming |  Flash Native    |
|                  |<-----------|  LiveRequestQueue |            |  Audio           |
|  Ring Buffer     |  Binary WS |                   |            |                  |
|  AudioWorklet    |            |  Session Service  |            |  Google Search   |
|  Playback (24kHz)|            |                   |            |  (grounding)     |
+------------------+            +-------------------+            +------------------+
```

### Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Audio transport | Raw binary PCM over WebSocket | ~3x lower latency vs base64 JSON |
| Audio playback | Ring buffer AudioWorklet | Gapless playback, no clicks/pops |
| Video frames | JPEG 768x768 @ 0.5 quality, every 2s | Balanced detail vs bandwidth |
| Framework | Google ADK (not raw SDK) | Built-in session management, tool support, streaming |
| Model | gemini-2.5-flash-native-audio | Native audio I/O, lowest latency for voice |
| Tool | google_search | Real-world grounding for product/landmark identification |

## Tech Stack

- **AI Framework**: Google ADK (`google-adk`) with `Runner` + `LiveRequestQueue`
- **Model**: `gemini-2.5-flash-native-audio-preview-12-2025`
- **Backend**: FastAPI + Uvicorn (ASGI WebSocket)
- **Frontend**: Vanilla JS with AudioWorklet API
- **Deployment**: GCP Compute Engine / Cloud Run
- **Tool**: Google Search (via ADK `google_search`)

## Quick Start

### Prerequisites

- Python 3.11+
- A [Google AI Studio](https://aistudio.google.com/) API key

### Local Setup

```bash
# Clone
git clone https://github.com/HseyAI/visio-accessibility-agent.git
cd visio-accessibility-agent

# Install dependencies
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Configure
cp .env.example .env
# Edit .env and add your GOOGLE_API_KEY

# Run (HTTPS required for camera/mic access)
# Option A: Self-signed cert (for local testing)
openssl req -x509 -newkey rsa:2048 -keyout /tmp/key.pem -out /tmp/cert.pem -days 365 -nodes -subj '/CN=localhost'
python server.py

# Option B: Without SSL (camera won't work, but API will)
uvicorn server:app --host 0.0.0.0 --port 8080
```

Open `https://localhost:8080` (accept the self-signed cert warning).

### Docker

```bash
docker build -t visio-agent .
docker run -p 8080:8080 --env-file .env visio-agent
```

### Deploy to Cloud Run

```bash
# Build and push
gcloud builds submit --tag gcr.io/YOUR_PROJECT/visio-agent

# Deploy
gcloud run deploy visio-agent \
  --image gcr.io/YOUR_PROJECT/visio-agent \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_API_KEY=your_key,GOOGLE_GENAI_USE_VERTEXAI=FALSE"
```

## Project Structure

```
visio-accessibility-agent/
├── server.py                  # FastAPI server with ADK Runner + WebSocket
├── visio_agent/
│   ├── __init__.py
│   └── agent.py               # ADK Agent definition + system instruction
├── static/
│   ├── index.html             # UI — camera, controls, transcript
│   ├── style.css              # Dark theme, accessible design
│   ├── app.js                 # WebSocket client, video/audio capture
│   ├── audio-processor.js     # AudioWorklet — mic capture (16kHz PCM)
│   └── audio-player.js        # AudioWorklet — ring buffer playback (24kHz)
├── Dockerfile                 # Container config for Cloud Run
├── requirements.txt           # Python dependencies
└── .env.example               # Environment variable template
```

## How It Works

1. **Browser** captures camera frames (JPEG, every 2s) and microphone audio (16-bit PCM, 16kHz)
2. Audio is sent as **raw binary WebSocket frames** — no JSON wrapping, no base64 encoding
3. Video frames are sent as **JSON** with base64-encoded JPEG data
4. **Server** feeds both streams into ADK's `LiveRequestQueue` for bidirectional streaming
5. ADK `Runner` manages the Gemini session with BIDI streaming mode
6. Gemini responds with **native audio** (24kHz PCM) and optional text transcripts
7. Audio responses are sent back as **binary WebSocket frames** to the browser
8. Browser uses a **ring buffer AudioWorklet** for gapless, low-latency playback

## Google Cloud Services Used

- **Gemini 2.5 Flash** (Native Audio) — Real-time multimodal AI
- **Google Search** (via ADK tool) — Grounding for real-world information
- **GCP Compute Engine** — Hosting (or Cloud Run for containerized deployment)

## Contest

Built for the [Gemini Live Agent Challenge](https://devpost.com/software/visio-live-accessibility-agent) — Live Agents category.

## License

MIT
