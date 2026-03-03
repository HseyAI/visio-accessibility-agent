import asyncio
import base64
import json
import os
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from google import genai
from google.genai import types
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

SYSTEM_PROMPT = """You are Visio, a real-time AI accessibility assistant designed to help visually impaired users navigate and understand their environment.

Your responsibilities:
- Describe what you see in the camera feed in clear, natural spoken language
- Answer spoken questions about the surroundings immediately
- Read any visible text, signs, labels, or screens aloud
- Proactively warn about hazards: stairs, obstacles, uneven surfaces, moving objects
- Be concise and prioritize the most important information

Speaking style:
- Use directional language: "to your left", "ahead of you", "behind you"
- Keep descriptions short unless asked for more detail
- Always mention safety hazards first before general descriptions
- Respond naturally and conversationally
- Handle interruptions gracefully - stop talking and listen when the user speaks

You are always watching and listening. Be proactive about important changes in the environment."""

app = FastAPI(title="Visio - Live Accessibility Agent")
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def root():
    with open("static/index.html") as f:
        return HTMLResponse(f.read())


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected")

    client = genai.Client(api_key=GEMINI_API_KEY)

    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=SYSTEM_PROMPT,
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Aoede"
                )
            )
        ),
    )

    try:
        async with client.aio.live.connect(model=MODEL, config=config) as session:
            logger.info("Gemini Live session started")

            async def send_to_gemini():
                try:
                    while True:
                        message = await websocket.receive_text()
                        data = json.loads(message)
                        msg_type = data.get("type")

                        if msg_type == "audio":
                            audio_bytes = base64.b64decode(data["data"])
                            await session.send_realtime_input(
                                audio=types.Blob(
                                    data=audio_bytes,
                                    mime_type="audio/pcm;rate=16000",
                                )
                            )

                        elif msg_type == "video":
                            image_bytes = base64.b64decode(data["data"])
                            await session.send_realtime_input(
                                video=types.Blob(
                                    data=image_bytes,
                                    mime_type="image/jpeg",
                                )
                            )

                except WebSocketDisconnect:
                    logger.info("Client disconnected")
                except Exception as e:
                    logger.error(f"Send error: {e}")

            async def receive_from_gemini():
                try:
                    while True:
                        async for response in session.receive():
                            # Send audio
                            try:
                                if response.data:
                                    await websocket.send_json(
                                        {
                                            "type": "audio",
                                            "data": base64.b64encode(
                                                response.data
                                            ).decode(),
                                        }
                                    )
                            except Exception:
                                pass

                            # Send text
                            try:
                                if response.text:
                                    await websocket.send_json(
                                        {"type": "text", "data": response.text}
                                    )
                            except Exception:
                                pass

                            # Handle parts directly
                            try:
                                sc = response.server_content
                                if sc and sc.model_turn and sc.model_turn.parts:
                                    for part in sc.model_turn.parts:
                                        if part.inline_data and part.inline_data.data:
                                            await websocket.send_json(
                                                {
                                                    "type": "audio",
                                                    "data": base64.b64encode(
                                                        part.inline_data.data
                                                    ).decode(),
                                                }
                                            )
                                        if part.text:
                                            await websocket.send_json(
                                                {"type": "text", "data": part.text}
                                            )
                            except (AttributeError, TypeError):
                                pass

                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    logger.error(f"Receive error: {e}")

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(send_to_gemini()),
                    asyncio.create_task(receive_from_gemini()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in pending:
                task.cancel()

    except Exception as e:
        logger.error(f"Session error: {e}")
        try:
            await websocket.send_json({"type": "error", "data": str(e)})
        except:
            pass
    finally:
        logger.info("Session ended")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
