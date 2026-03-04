# Visio — Live AI Accessibility Agent

> **Real-time AI assistant that helps visually impaired users navigate, read, and understand their environment through camera and voice.**

Built with **Google ADK** (Agent Development Kit) and **Gemini 2.5 Flash** with native bidirectional audio streaming. Submitted to the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) — **Live Agents** category.

## Features

### Core Experience
- **Real-time scene narration** — continuous spoken descriptions of surroundings with directional language ("to your left", "at your 2 o'clock")
- **Three operating modes** — Navigation (hazard-first), Reading (text/signs), Exploration (detailed descriptions)
- **Multi-language support** — switch spoken language on the fly
- **Google Search grounding** — identifies real-world products, landmarks, and brands

### Safety & Navigation
- **Proactive hazard detection** — scans every frame for vehicles, stairs, obstacles, cyclists; interrupts mid-sentence for critical alerts
- **Haptic feedback** — vibration patterns for critical (3 pulses), warning (2 pulses), and info (tap) alerts
- **Visual hazard banners** — screen flashes red for critical hazards (for sighted companions/caregivers)
- **Emergency SOS** — double-tap activation with GPS location sharing, auto-triggers on "help me" / "emergency" voice keywords
- **Gyroscope guidance** — detects bad phone orientation and prompts correction

### Spatial Intelligence
- **Spatial audio cues** — directional stereo panning so "on your left" plays from the left speaker via Web Audio API StereoPannerNode
- **Smart Landmark Memory** — remembers locations (exits, bathrooms, landmarks), provides reverse directions, proactively announces familiar places
- **Object & scene tracking** — maintains mental model across frames, describes movement ("the dog moved from left to right") instead of re-describing
- **Multi-user awareness** — crowd density estimation, tracks people approaching, queue detection
- **Conversation awareness** — summarizes nearby conversations, flags when someone speaks to the user

### Reliability
- **Auto-reconnection** — exponential backoff reconnect (up to 5 attempts) with state restoration on connection loss
- **Connection quality indicator** — visual dots showing frame delivery success rate
- **Graceful error handling** — timeouts, fallbacks, and clear user messaging

## Architecture

```
┌─────────────────────────┐
│     Browser (PWA)       │
│                         │
│  Camera ──── JPEG 768px │        ┌──────────────────────┐
│  Mic ─────── PCM 16kHz  │  WS    │   FastAPI + ADK      │
│  Gyroscope ─ Orientation├───────►│                      │
│                         │        │  Runner (BIDI)       │
│  AudioWorklet ◄─────────│◄───────│  LiveRequestQueue    │
│  (Ring Buffer, 24kHz)   │  WS    │  Session Analytics   │
│  StereoPanner ◄─────────│        │                      │
│  Hazard Vibration       │        └──────────┬───────────┘
│  SOS + Geolocation      │                   │
└─────────────────────────┘                   │ ADK BIDI Streaming
                                              ▼
                                ┌──────────────────────────┐
                                │    Google Cloud           │
                                │                           │
                                │  Gemini 2.5 Flash         │
                                │  (Native Audio I/O)       │
                                │                           │
                                │  Google Search (grounding)│
                                │  Cloud Run (hosting)      │
                                │  Cloud Build (CI/CD)      │
                                │  Cloud Logging (logs)     │
                                │  Firestore (analytics)    │
                                │  Container Registry       │
                                └──────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Audio transport | Raw binary PCM over WebSocket | ~3x lower latency vs base64 JSON |
| Audio playback | Ring buffer AudioWorklet | Gapless playback, no clicks/pops |
| Spatial audio | StereoPannerNode | Lightweight, cross-browser, works with any headphones |
| Video frames | JPEG 768x768 @ 0.5 quality | Balanced detail vs bandwidth |
| Frame interval | 1s (nav), 2s (read/explore) | Mode-adaptive to save bandwidth |
| Framework | Google ADK | Built-in session management, tool support, BIDI streaming |
| Model | gemini-2.5-flash-native-audio | Native audio I/O, lowest latency for voice |
| Session analytics | Firestore | Serverless, auto-scales, native GCP integration |
| Logging | Cloud Logging | Structured logs with session correlation |

## Google Cloud Services Used

| Service | Purpose |
|---------|---------|
| **Gemini 2.5 Flash** (Native Audio) | Real-time multimodal AI with bidirectional audio streaming |
| **Google ADK** | Agent framework with session management, tool support, live streaming |
| **Google Search** (ADK tool) | Grounding — identifies real-world products, landmarks, brands |
| **Cloud Run** | Serverless container hosting with auto-scaling |
| **Cloud Build** | Automated container image builds from source |
| **Container Registry** | Docker image storage |
| **Cloud Logging** | Structured application logs with session correlation |
| **Firestore** | Session analytics persistence (duration, frames, features used) |

## Tech Stack

- **AI**: Google ADK + Gemini 2.5 Flash (native audio, BIDI streaming)
- **Backend**: Python 3.11, FastAPI, Uvicorn (ASGI WebSocket)
- **Frontend**: Vanilla JS, AudioWorklet API, Web Audio API, Geolocation API, DeviceOrientation API
- **Deployment**: Docker → Cloud Build → Cloud Run
- **Analytics**: Cloud Logging + Firestore

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
# One-command deploy (builds, pushes, and deploys)
./deploy.sh YOUR_PROJECT_ID
```

Or manually:

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT/visio-agent
gcloud run deploy visio-agent \
  --image gcr.io/YOUR_PROJECT/visio-agent \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_API_KEY=your_key,GOOGLE_GENAI_USE_VERTEXAI=FALSE"
```

## Project Structure

```
visio-accessibility-agent/
├── server.py                  # FastAPI + ADK Runner + WebSocket + Cloud Logging + Firestore
├── visio_agent/
│   ├── __init__.py
│   └── agent.py               # ADK Agent — system instruction with 10 behavior modules
├── static/
│   ├── index.html             # UI — camera, controls, transcript, SOS, mode switcher
│   ├── style.css              # Dark theme, accessible design, hazard animations
│   ├── app.js                 # WebSocket client, spatial audio, reconnection, hazard detection
│   ├── audio-processor.js     # AudioWorklet — mic capture (16kHz PCM)
│   └── audio-player.js        # AudioWorklet — ring buffer playback (24kHz)
├── deploy.sh                  # Automated GCP deployment (Cloud Build → Cloud Run)
├── Dockerfile                 # Container config (Python 3.11-slim)
├── requirements.txt           # Python dependencies
└── .env.example               # Environment variable template
```

## How It Works

1. **Browser** captures camera frames (JPEG 768px, every 1-2s) and microphone audio (16-bit PCM, 16kHz)
2. Audio is sent as **raw binary WebSocket frames** — no JSON wrapping, no base64 encoding
3. Video frames are sent as **JSON** with base64-encoded JPEG data + frame sequence numbers
4. **Server** feeds both streams into ADK's `LiveRequestQueue` for bidirectional streaming
5. ADK `Runner` manages the Gemini session with BIDI streaming mode and native audio
6. Gemini processes audio + video together, responds with **native audio** (24kHz PCM) and text transcripts
7. Audio responses are sent as **binary WebSocket frames** to the browser
8. Browser routes audio through a **StereoPannerNode** for spatial positioning based on directional keywords
9. A **ring buffer AudioWorklet** ensures gapless, low-latency playback
10. **Cloud Logging** captures structured session logs; **Firestore** persists session analytics

## Contest

Built for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) — **Live Agents** category.

## License

MIT
