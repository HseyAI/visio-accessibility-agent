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
    }

    await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )

    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        # Unlimited session duration — prevents hallucination after 2min
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=80000,
            sliding_window=types.SlidingWindow(target_tokens=60000),
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

    async def upstream():
        nonlocal running
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
                            mode = session_stats.get("current_mode", "navigation")

                            # Stream ALL frames silently — model accumulates context
                            live_request_queue.send_realtime(image_blob)

                            # Prompt periodically — short prompts to avoid token waste
                            # Navigation: every 3rd frame (~3s), Reading/Explore: every 5th frame (~10s)
                            prompt_interval = 3 if mode == "navigation" else 5
                            if frame_num > 0 and frame_num % prompt_interval == 0:
                                if mode == "navigation":
                                    prompt_text = "[NAV] What's in the path? Warn if obstacle, else confirm clear."
                                elif mode == "reading":
                                    prompt_text = "[READ] What text is visible? Acknowledge briefly — wait for user to ask for details."
                                else:
                                    prompt_text = "[EXPLORE] Brief scene update — only mention changes from last update."
                                context = types.Content(
                                    parts=[types.Part(text=prompt_text)]
                                )
                                live_request_queue.send_content(context)

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
        nonlocal running
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
                            await websocket.send_bytes(part.inline_data.data)

                        if part.text:
                            session_stats["transcripts_sent"] += 1
                            # Distinguish user transcription from agent response
                            is_user = getattr(event, 'author', '') == 'user' or (
                                event.content.role and event.content.role == 'user'
                            )
                            msg_type = "user_transcript" if is_user else "transcript"
                            await websocket.send_text(
                                json.dumps({"type": msg_type, "data": part.text})
                            )
                    except Exception:
                        pass

        except WebSocketDisconnect:
            running = False
        except Exception as e:
            logger.error(f"Downstream error: {e}")

    try:
        await asyncio.gather(upstream(), downstream(), return_exceptions=True)
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
