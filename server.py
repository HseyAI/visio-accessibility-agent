import asyncio
import base64
import json
import os
import logging
import uuid
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from starlette.websockets import WebSocketState
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Cloud Logging — structured logs on GCP, standard logging locally
# ---------------------------------------------------------------------------
cloud_logging_enabled = False
try:
    import google.cloud.logging as cloud_logging
    cloud_client = cloud_logging.Client()
    cloud_client.setup_logging()
    cloud_logging_enabled = True
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)
    logger.info("Cloud Logging initialized")
except Exception:
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger(__name__)
    logger.info("Cloud Logging unavailable — using standard logging")

# ---------------------------------------------------------------------------
# Firestore — session analytics on GCP, in-memory fallback locally
# ---------------------------------------------------------------------------
firestore_db = None
try:
    from google.cloud import firestore
    firestore_db = firestore.Client()
    # Quick connectivity test
    firestore_db.collection("_health").document("ping").set({"ts": time.time()})
    logger.info("Firestore initialized")
except Exception:
    firestore_db = None
    logger.info("Firestore unavailable — session analytics disabled")

APP_NAME = "visio-agent"

# ---------------------------------------------------------------------------
# Object Memory — track obstacles across frames per session
# ---------------------------------------------------------------------------
# Obstacle keywords the model might mention in responses
OBSTACLE_KEYWORDS = [
    "car", "vehicle", "motorcycle", "bike", "bicycle", "scooter", "bus", "truck",
    "person", "pedestrian", "child", "dog", "animal",
    "chair", "table", "bench", "pole", "post", "sign", "tree", "branch",
    "wall", "fence", "barrier", "bollard", "cone", "construction",
    "stairs", "steps", "curb", "pothole", "hole", "crack",
    "door", "gate", "pillar", "column", "box", "bin", "trash",
    "slope", "ramp", "curb edge", "uneven", "gravel", "drop", "elevation",
]

def create_object_memory():
    """Create a fresh object memory dict for a session."""
    return {
        "last_obstacles": [],        # [{name, side, frame_num, timestamp}]
        "last_clear_frame": 0,       # frame when scene was last fully clear
        "consecutive_clear": 0,      # count of consecutive clear responses
        "last_obstacle_cleared_frame": 0,  # frame when last obstacle was cleared
    }

def parse_obstacles_from_text(text, frame_num):
    """Extract obstacle mentions from model response text."""
    lower = text.lower()
    found = []
    for kw in OBSTACLE_KEYWORDS:
        if kw in lower:
            # Determine side from text
            side = "ahead"
            if "left" in lower:
                side = "left"
            elif "right" in lower:
                side = "right"
            found.append({
                "name": kw,
                "side": side,
                "frame_num": frame_num,
                "timestamp": time.time(),
            })
    return found

def check_obstacle_memory(obj_memory, model_text, frame_num):
    """
    Check if model says 'clear' or 'proceed' but we recently tracked close obstacles.
    Returns a scan-ahead or caution message, or None.
    """
    lower = model_text.lower()

    # Parse any new obstacles from model response
    new_obstacles = parse_obstacles_from_text(model_text, frame_num)
    if new_obstacles:
        obj_memory["last_obstacles"] = new_obstacles
        obj_memory["consecutive_clear"] = 0
        return None

    # Check if model is saying it's clear or telling user to proceed
    clear_phrases = ["clear", "no obstacle", "path is free", "nothing ahead", "all clear", "safe to"]
    proceed_phrases = ["keep going", "proceed", "continue", "go ahead", "carry on", "you're past", "you've passed"]
    is_clear = any(phrase in lower for phrase in clear_phrases)
    is_proceed = any(phrase in lower for phrase in proceed_phrases)

    if not is_clear and not is_proceed:
        return None

    # Model says clear/proceed — check memory for recent obstacles
    now = time.time()
    obj_memory["consecutive_clear"] += 1

    # Only inject if obstacles were seen recently (<5s) and fewer than 5 consecutive clears
    recent = [o for o in obj_memory["last_obstacles"] if now - o["timestamp"] < 5.0]

    if recent and obj_memory["consecutive_clear"] < 5:
        names = list(set(o["name"] for o in recent))
        obj_memory["last_obstacle_cleared_frame"] = frame_num

        # First clear after obstacles — prompt to scan ahead
        if obj_memory["consecutive_clear"] == 1:
            return f"[SCAN AHEAD] You just cleared {', '.join(names)}. Scan for the NEXT obstacle. What's ahead NOW?"
        else:
            return f"[CAUTION] Recently passed {', '.join(names)}. What's NEXT in the path?"

    # After 5 consecutive clears, trust the model and flush memory
    if obj_memory["consecutive_clear"] >= 5:
        obj_memory["last_obstacles"] = []

    return None

from visio_agent.agent import root_agent

session_service = InMemorySessionService()

runner = Runner(
    app_name=APP_NAME,
    agent=root_agent,
    session_service=session_service,
)

app = FastAPI(title="Visio - Live Accessibility Agent")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    with open("static/index.html") as f:
        return HTMLResponse(f.read())


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": root_agent.model,
        "services": {
            "cloud_logging": cloud_logging_enabled,
            "firestore": firestore_db is not None,
        },
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected")

    user_id = f"user_{uuid.uuid4().hex[:8]}"
    session_id = f"session_{uuid.uuid4().hex[:8]}"

    # Session analytics
    session_start = time.time()
    session_stats = {
        "frames_sent": 0,
        "audio_chunks_sent": 0,
        "audio_chunks_received": 0,
        "transcripts_sent": 0,
        "mode_switches": 0,
        "language_switches": 0,
        "sos_activations": 0,
        "current_mode": "navigation",
        "detected_environments": [],
    }

    await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )

    # Object memory for obstacle persistence
    obj_memory = create_object_memory()
    last_frame_num = 0  # Track latest frame for obstacle memory

    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        # Unlimited session duration — prevents hallucination after 2min
        # Video = ~258 tokens/sec, 128k context burns in ~8min without compression
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=100000,
            sliding_window=types.SlidingWindow(target_tokens=80000),
        ),
        # Auto-reconnect on WebSocket ~10min timeout
        session_resumption=types.SessionResumptionConfig(),
        # Model decides when to speak vs stay silent
        proactivity=types.ProactivityConfig(proactive_audio=True),
        # VAD: HIGH start sensitivity so user can interrupt by speaking
        # HIGH end sensitivity so model responds quickly after user stops
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=False,
                start_of_speech_sensitivity=types.StartSensitivity.START_SENSITIVITY_HIGH,
                end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                silence_duration_ms=500,
            ),
        ),
    )

    live_request_queue = LiveRequestQueue()
    running = True
    last_user_speech_time = 0.0  # Track when user last spoke
    last_model_speech_time = time.time()  # Track when model last spoke
    last_proximity_alert_time = 0.0  # Cooldown for proximity alerts
    last_proximity_state = "clear"   # Track proximity changes
    last_walking_update_time = 0.0   # Track walking-context prompt injection
    last_turn_rescan_time = 0.0      # Track turn-triggered re-scans
    session_stats["last_is_moving"] = False  # Track user movement from sensors

    async def upstream():
        nonlocal running, last_user_speech_time, last_frame_num, last_proximity_alert_time, last_proximity_state, last_walking_update_time, last_turn_rescan_time
        try:
            while running:
                msg = await websocket.receive()
                ws_type = msg.get("type", "")

                if ws_type == "websocket.disconnect":
                    running = False
                    break

                # Binary frame = raw audio PCM
                raw_bytes = msg.get("bytes")
                if raw_bytes:
                    session_stats["audio_chunks_sent"] += 1
                    audio_blob = types.Blob(
                        mime_type="audio/pcm;rate=16000",
                        data=raw_bytes,
                    )
                    live_request_queue.send_realtime(audio_blob)
                    continue

                # Text frame = JSON (image or text)
                raw_text = msg.get("text")
                if raw_text:
                    try:
                        data = json.loads(raw_text)
                        msg_type = data.get("type")

                        if msg_type == "image":
                            session_stats["frames_sent"] += 1
                            image_bytes = base64.b64decode(data["data"])
                            image_blob = types.Blob(
                                mime_type="image/jpeg",
                                data=image_bytes,
                            )
                            frame_num = data.get("frame", 0)
                            last_frame_num = frame_num
                            sensors = data.get("sensors")

                            # Always stream frames — model accumulates visual context
                            live_request_queue.send_realtime(image_blob)

                            # Proximity alert: only send on transition to "close" with 5s cooldown
                            now = time.time()
                            if sensors and sensors.get("proximity") == "close":
                                if (last_proximity_state != "close"
                                        and now - last_proximity_alert_time > 5.0):
                                    last_proximity_alert_time = now
                                    ground = sensors.get("ground_obstructed", False)
                                    center = sensors.get("center_blocked", False)
                                    near_ground = sensors.get("near_ground_hazard", False)
                                    hints = []
                                    if near_ground:
                                        hints.append("object close on ground — possible post, stone, or step")
                                    if ground:
                                        hints.append("ground obstruction detected")
                                    if center:
                                        hints.append("large object in center of frame")
                                    hint_str = " — ".join(hints) if hints else "obstacle very close"
                                    live_request_queue.send_content(
                                        types.Content(parts=[types.Part(
                                            text=f"[PROXIMITY ALERT] {hint_str}"
                                        )])
                                    )
                            if sensors:
                                last_proximity_state = sensors.get("proximity", "clear")
                                # Track movement state for silence monitor
                                session_stats["last_is_moving"] = sensors.get("is_moving", False)

                                # Turn-triggered re-scan: if user is turning, re-scan scene
                                turn = sensors.get("turn", "steady")
                                if turn != "steady" and now - last_turn_rescan_time > 2.0 and now - last_walking_update_time > 2.0:
                                    last_turn_rescan_time = now
                                    live_request_queue.send_content(
                                        types.Content(parts=[types.Part(
                                            text=f"[DIRECTION CHANGE] User is {turn}. Re-scan — what obstacles are now in their path?"
                                        )])
                                    )

                            # Walking-context prompt: every 5s while user is walking in navigation mode
                            now2 = time.time()
                            if (session_stats.get("last_is_moving")
                                    and session_stats["current_mode"] == "navigation"
                                    and now2 - last_walking_update_time > 5.0
                                    and now2 - last_user_speech_time > 3.0):
                                last_walking_update_time = now2
                                live_request_queue.send_content(
                                    types.Content(parts=[types.Part(
                                        text="[WALKING UPDATE] User is walking. Scan for NEW obstacles since last report. Steps, curbs, posts, vehicles, surface changes ahead? If you recently cleared an obstacle, what's NEXT? If clear, confirm briefly."
                                    )])
                                )

                        elif msg_type == "user_speech":
                            # Client signals user is speaking — pause nav prompts
                            last_user_speech_time = time.time()

                        elif msg_type == "text":
                            text_data = data["data"]
                            if "[EMERGENCY SOS" in text_data:
                                session_stats["sos_activations"] += 1
                                logger.warning(f"SOS activated — {session_id}")
                            content = types.Content(
                                parts=[types.Part(text=text_data)]
                            )
                            live_request_queue.send_content(content)

                        elif msg_type == "mode":
                            mode = data.get("data", "navigation")
                            session_stats["mode_switches"] += 1
                            session_stats["current_mode"] = mode
                            # Reset obstacle memory on mode switch
                            obj_memory["last_obstacles"] = []
                            obj_memory["consecutive_clear"] = 0
                            logger.info(f"Mode switched to: {mode}")
                            if mode == "navigation":
                                switch_text = "[MODE: NAVIGATION] Focus on path safety. What's in the user's path right now? Warn if obstacle, else confirm clear."
                            elif mode == "reading":
                                switch_text = "[MODE: READING] Switched to reading mode. What text or content do you see? Acknowledge briefly."
                            else:
                                switch_text = "[MODE: EXPLORATION] Switched to exploration mode. Briefly describe what you see around the user."
                            content = types.Content(
                                parts=[types.Part(text=switch_text)]
                            )
                            live_request_queue.send_content(content)

                        elif msg_type == "language":
                            lang = data.get("data", "English")
                            session_stats["language_switches"] += 1
                            logger.info(f"Language switched to: {lang}")
                            content = types.Content(
                                parts=[types.Part(text=f"[LANGUAGE: {lang}] Respond in {lang} from now on. Translate any text you see into {lang}.")]
                            )
                            live_request_queue.send_content(content)
                    except Exception as e:
                        logger.error(f"Parse error: {e}")

        except WebSocketDisconnect:
            running = False
            logger.info("Client disconnected (upstream)")
        except Exception as e:
            running = False
            logger.error(f"Upstream error: {e}")

    async def downstream():
        nonlocal running, last_model_speech_time
        try:
            async for event in runner.run_live(
                user_id=user_id,
                session_id=session_id,
                live_request_queue=live_request_queue,
                run_config=run_config,
            ):
                if not running:
                    break
                if not event.content or not event.content.parts:
                    continue

                for part in event.content.parts:
                    try:
                        if (
                            part.inline_data
                            and part.inline_data.mime_type
                            and "audio" in part.inline_data.mime_type
                        ):
                            session_stats["audio_chunks_received"] += 1
                            last_model_speech_time = time.time()
                            await websocket.send_bytes(part.inline_data.data)

                        if part.text:
                            session_stats["transcripts_sent"] += 1
                            last_model_speech_time = time.time()
                            # Distinguish user transcription from agent response
                            is_user = getattr(event, 'author', '') == 'user' or (
                                event.content.role and event.content.role == 'user'
                            )
                            msg_type = "user_transcript" if is_user else "transcript"
                            await websocket.send_text(
                                json.dumps({"type": msg_type, "data": part.text})
                            )

                            # Object memory — track obstacles in model responses
                            if not is_user:
                                caution = check_obstacle_memory(obj_memory, part.text, last_frame_num)
                                if caution:
                                    # Inject caution back to model so it relays to user
                                    live_request_queue.send_content(
                                        types.Content(parts=[types.Part(text=caution)])
                                    )
                    except Exception:
                        pass

        except WebSocketDisconnect:
            running = False
        except Exception as e:
            logger.error(f"Downstream error: {e}")

    async def silence_monitor():
        """Nudge model if it goes silent while user is walking."""
        nonlocal running
        try:
            while running:
                await asyncio.sleep(2)
                if not running:
                    break
                now = time.time()
                silence_duration = now - last_model_speech_time
                is_moving = session_stats.get("last_is_moving", False)
                user_recently_spoke = (now - last_user_speech_time) < 3.0

                if (silence_duration > 7.0
                        and is_moving
                        and not user_recently_spoke
                        and session_stats["current_mode"] == "navigation"):
                    live_request_queue.send_content(
                        types.Content(parts=[types.Part(
                            text='[HEARTBEAT] User is still walking. What\'s in their path? Give brief status — even just "clear ahead".'
                        )])
                    )
        except Exception as e:
            logger.error(f"Silence monitor error: {e}")

    try:
        await asyncio.gather(upstream(), downstream(), silence_monitor(), return_exceptions=True)
    finally:
        live_request_queue.close()
        duration = round(time.time() - session_start, 1)
        logger.info(f"Session ended — {session_id} — {duration}s, {session_stats['frames_sent']} frames, {session_stats['transcripts_sent']} transcripts")

        # Persist session analytics to Firestore
        if firestore_db:
            try:
                firestore_db.collection("sessions").document(session_id).set({
                    "user_id": user_id,
                    "session_id": session_id,
                    "started_at": session_start,
                    "duration_seconds": duration,
                    "frames_sent": session_stats["frames_sent"],
                    "audio_chunks_sent": session_stats["audio_chunks_sent"],
                    "audio_chunks_received": session_stats["audio_chunks_received"],
                    "transcripts_sent": session_stats["transcripts_sent"],
                    "mode_switches": session_stats["mode_switches"],
                    "language_switches": session_stats["language_switches"],
                    "final_mode": session_stats["current_mode"],
                    "detected_environments": session_stats["detected_environments"],
                })
            except Exception as e:
                logger.warning(f"Failed to save session analytics: {e}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8080,
        ssl_keyfile="/tmp/key.pem",
        ssl_certfile="/tmp/cert.pem",
    )
