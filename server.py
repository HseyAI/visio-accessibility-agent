import asyncio
import base64
import json
import os
import logging
import uuid

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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
    return {"status": "ok", "model": root_agent.model}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected")

    user_id = f"user_{uuid.uuid4().hex[:8]}"
    session_id = f"session_{uuid.uuid4().hex[:8]}"

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
                            image_bytes = base64.b64decode(data["data"])
                            image_blob = types.Blob(
                                mime_type="image/jpeg",
                                data=image_bytes,
                            )
                            live_request_queue.send_realtime(image_blob)

                        elif msg_type == "text":
                            content = types.Content(
                                parts=[types.Part(text=data["data"])]
                            )
                            live_request_queue.send_content(content)

                        elif msg_type == "mode":
                            mode = data.get("data", "navigation")
                            logger.info(f"Mode switched to: {mode}")
                            content = types.Content(
                                parts=[types.Part(text=f"[MODE SWITCH: {mode.upper()}] Adjust your behavior to {mode} mode accordingly.")]
                            )
                            live_request_queue.send_content(content)

                        elif msg_type == "language":
                            lang = data.get("data", "English")
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
                            await websocket.send_bytes(part.inline_data.data)

                        if part.text:
                            await websocket.send_text(
                                json.dumps({"type": "transcript", "data": part.text})
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
        logger.info("Session ended")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8080,
        ssl_keyfile="/tmp/key.pem",
        ssl_certfile="/tmp/cert.pem",
    )
