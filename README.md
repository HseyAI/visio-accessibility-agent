# Visio — Live AI Accessibility Agent

> **Real-time AI companion that helps visually impaired users navigate, read, and understand their environment through camera and voice.**

Built with **Google ADK** (Agent Development Kit) and **Gemini 2.5 Flash** with native bidirectional audio streaming. Submitted to the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) — **Live Agents** category.

**Live Demo**: [visio-agent-kiofaqcoyq-uc.a.run.app](https://visio-agent-kiofaqcoyq-uc.a.run.app)

## Features

### Core Experience
- **Real-time scene narration** — continuous spoken descriptions of surroundings with directional language ("to your left", "at your 2 o'clock")
- **Three operating modes** — Navigation (hazard-first), Reading (text/signs), Exploration (detailed descriptions)
- **Multi-language support** — 8 languages, switch spoken language on the fly
- **Google Search grounding** — identifies real-world products, landmarks, and brands

### Safety & Navigation
- **Proactive hazard detection** — scans every frame for vehicles, stairs, obstacles, cyclists; interrupts mid-sentence for critical alerts
- **Obstacle chaining** — after clearing one hazard, immediately scans for the next. Never goes silent after "you're past it"
- **Ground-level trip hazards** — detects posts, bollards, raised bricks, open drains, speed bumps, low chains
- **People awareness** — detects and describes approaching people (appearance, clothing, activity, direction of movement)
- **Turn-triggered re-scanning** — when user changes direction, re-scans the entire new field of view
- **Haptic feedback** — vibration patterns for critical (3 pulses), warning (2 pulses), and info (tap) alerts
- **Visual hazard banners** — screen flashes red for critical hazards (for sighted companions/caregivers)
- **Emergency SOS** — double-tap activation with GPS location sharing, auto-triggers on "help me" / "emergency" voice keywords
- **Gyroscope guidance** — detects bad phone orientation and prompts correction with auto-calibration

### Adaptive Intelligence
- **Speed-adaptive frame rate** — stationary: 0.5 FPS, walking: 2 FPS, running: 2.5 FPS. Saves tokens when still, responsive when moving
- **Obstacle memory** — server-side tracking of recently-seen obstacles. Prevents premature "all clear" and injects scan-ahead prompts after clearing hazards
- **Near-ground proximity detection** — analyzes bottom 25% of camera frame with lower edge thresholds to catch small ground obstacles
- **Silence breaker** — if model goes quiet for 7+ seconds while user is walking in navigation mode, nudges it to report status
- **Walking update prompts** — every 5 seconds while moving, prompts model to scan for new obstacles since last report
- **Frame diff optimization** — skips sending frames when scene hasn't changed (stationary), saves bandwidth and tokens
- **Mode-scoped behaviors** — walking updates and silence monitor only fire in navigation mode, preventing interference in reading/explore

### Spatial Audio
- **Directional stereo panning** — "on your left" plays from the left speaker, "on your right" from the right
- **Clock position mapping** — "at your 2 o'clock" pans right, "at your 9 o'clock" pans left
- **Smooth transitions** — ramps pan over 150ms, auto-resets to center after 3 seconds

### Camera & Focus
- **Auto-focus control** — continuous autofocus on all modes, near-range focus when switching to reading mode
- **Wide-angle capture** — 1024x576 (16:9) for maximum horizontal field of view
- **Clean mode switching** — 1-second debounce on mode buttons, frame diff reset on switch, obstacle memory cleared

### Reliability
- **Auto-reconnection** — exponential backoff reconnect (up to 5 attempts) with state restoration on connection loss
- **Connection quality indicator** — visual dots showing frame delivery success rate
- **Context window compression** — sliding window at 100K tokens prevents context overflow in long sessions
- **Session resumption** — auto-reconnects on WebSocket 10-minute timeout
- **Graceful error handling** — timeouts, fallbacks, and clear user messaging

## Architecture

```
┌──────────────────────────────┐
│     Browser (Mobile Web)     │
│                              │
│  Camera ──── JPEG 1024x576   │       ┌───────────────────────────┐
│  Mic ─────── PCM 16kHz       │  WS   │   FastAPI + ADK Server    │
│  Gyroscope ─ Orientation     ├──────►│                           │
│  Accel ───── Step Detection  │       │  Runner (BIDI Streaming)  │
│  Proximity ─ Edge Analysis   │       │  LiveRequestQueue         │
│                              │       │  Obstacle Memory          │
│  AudioWorklet ◄──────────────│◄──────│  Silence Monitor          │
│  (Ring Buffer, 24kHz)        │  WS   │  Walking Update Injector  │
│  StereoPanner ◄──────────────│       │  Turn Re-scan Detector    │
│  Hazard Vibration            │       │  Session Analytics        │
│  SOS + Geolocation           │       └───────────┬───────────────┘
│  Auto-Focus Control          │                   │
└──────────────────────────────┘                   │ ADK BIDI Streaming
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
| Video frames | JPEG 1024x576 @ 0.5 quality | Wide-angle 16:9 for max FOV |
| Frame rate | Speed-adaptive (0.5-2.5 FPS) | Saves tokens when still, responsive when walking |
| Obstacle tracking | Server-side memory + prompt injection | Model can't persist state across turns, so server bridges the gap |
| Framework | Google ADK | Built-in session management, tool support, BIDI streaming |
| Model | gemini-2.5-flash-native-audio | Native audio I/O, lowest latency for voice |
| Focus control | MediaTrack constraints API | Near-range focus for reading, continuous for navigation |
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
- **Frontend**: Vanilla JS, AudioWorklet API, Web Audio API, Geolocation API, DeviceOrientation API, DeviceMotion API
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
├── server.py                  # FastAPI + ADK Runner + WebSocket + obstacle memory + silence monitor
├── visio_agent/
│   ├── __init__.py
│   └── agent.py               # ADK Agent — system instruction with 15 behavior modules
├── static/
│   ├── index.html             # UI — camera, controls, transcript, SOS, mode switcher
│   ├── style.css              # Dark theme, accessible design, hazard animations
│   ├── app.js                 # WebSocket client, spatial audio, proximity detection, adaptive FPS
│   ├── audio-processor.js     # AudioWorklet — mic capture (16kHz PCM)
│   └── audio-player.js        # AudioWorklet — ring buffer playback (24kHz)
├── deploy.sh                  # Automated GCP deployment (Cloud Build → Cloud Run)
├── Dockerfile                 # Container config (Python 3.11-slim)
├── requirements.txt           # Python dependencies
└── .env.example               # Environment variable template
```

## How It Works

1. **Browser** captures camera frames (JPEG 1024x576, adaptive 0.5-2.5 FPS) and microphone audio (16-bit PCM, 16kHz)
2. **Accelerometer** detects steps and speed; **gyroscope** tracks phone orientation and heading changes
3. **Proximity analyzer** scans bottom third and bottom quarter of frame for near-ground obstacles via edge detection
4. Audio is sent as **raw binary WebSocket frames** — no JSON wrapping, no base64 encoding
5. Video frames are sent as **JSON** with base64-encoded JPEG + sensor data (heading, tilt, turn direction, proximity, steps, speed)
6. **Server** feeds streams into ADK's `LiveRequestQueue` and runs obstacle memory, silence monitoring, walking updates, and turn-triggered re-scans
7. ADK `Runner` manages the Gemini session with BIDI streaming mode, context window compression, and session resumption
8. Gemini processes audio + video together, responds with **native audio** (24kHz PCM) and text transcripts
9. **Obstacle memory** on the server tracks recently-seen hazards — if model says "clear" too soon, it injects `[SCAN AHEAD]` prompts
10. Browser routes audio through a **StereoPannerNode** for spatial positioning based on directional keywords in transcripts
11. A **ring buffer AudioWorklet** ensures gapless, low-latency playback
12. **Cloud Logging** captures structured session logs; **Firestore** persists session analytics

## System Prompt Architecture

The agent's behavior is defined by 15 interconnected modules in the system prompt:

| Module | Purpose |
|--------|---------|
| Directions | Left/right mapping from camera to user perspective |
| Surface Hazards | Steps, curbs, slopes, ground-level trip hazards (posts, drains, bricks) |
| Anticipatory Warnings | Warn 3-5 seconds before user reaches a hazard |
| Mandatory Directions | Every obstacle callout must include which way to move |
| Navigation Co-pilot | SPOTTED → TRACKING → PASSING → CLEARED pattern |
| Obstacle Chaining | After clearing one hazard, immediately scan for the next |
| People Awareness | Detect, describe, and track approaching people |
| Footpath & Road Safety | Keep user on sidewalks, warn about road edges |
| When to Speak | 4-tier priority system (immediate → early warning → confirmation → on request) |
| Object Persistence | Track obstacles across frames, warn if they disappear from view |
| Modes | Navigation, Reading, Exploration — each with distinct behavior |
| Voice Commands | Natural language mode switching and emergency triggers |
| Rules | Interrupt handling, language lock, actionable language |
| Tools | Google Search for landmark/product identification |
| Guardrails | No fabrication, uncertainty disclosure, emergency protocols |

## Contest

Built for the [Gemini Live Agent Challenge](https://geminiliveagentchallenge.devpost.com/) — **Live Agents** category.

## License

MIT
