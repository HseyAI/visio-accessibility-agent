const AUDIO_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const VIDEO_FRAME_INTERVAL = 2000;
const VIDEO_WIDTH = 320;
const VIDEO_HEIGHT = 240;
const VIDEO_QUALITY = 0.4;

let ws = null;
let audioContext = null;
let playbackContext = null;
let mediaStream = null;
let audioWorklet = null;
let videoTimer = null;
let isRunning = false;
let nextPlayTime = 0;

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const transcript = document.getElementById("transcript");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const visualizer = document.getElementById("visualizer");

function setStatus(state, text) {
  statusDot.className = "status-dot " + state;
  statusText.textContent = text;
}

function addTranscript(text, type) {
  const empty = transcript.querySelector(".transcript-empty");
  if (empty) empty.remove();

  const entry = document.createElement("div");
  entry.className = "transcript-entry " + type;
  entry.textContent = (type === "agent" ? "Visio: " : "You: ") + text;
  transcript.appendChild(entry);
  transcript.scrollTop = transcript.scrollHeight;
}

async function startSession() {
  try {
    setStatus("", "Starting camera and microphone...");

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: AUDIO_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: {
        facingMode: "environment",
        width: { ideal: VIDEO_WIDTH },
        height: { ideal: VIDEO_HEIGHT },
      },
    });

    video.srcObject = mediaStream;

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      isRunning = true;
      setStatus("connected", "Connected - Visio is watching and listening");
      startBtn.disabled = true;
      stopBtn.disabled = false;
      startAudioCapture();
      startVideoCapture();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "audio") {
        const audioBytes = base64ToArrayBuffer(msg.data);
        scheduleAudio(audioBytes);
        setStatus("speaking", "Visio is speaking...");
        visualizer.classList.add("active");
      }

      if (msg.type === "text") {
        addTranscript(msg.data, "agent");
      }

      if (msg.type === "error") {
        setStatus("", "Error: " + msg.data);
      }
    };

    ws.onclose = () => {
      if (isRunning) {
        setStatus("", "Disconnected");
        stopSession();
      }
    };

    ws.onerror = () => {
      setStatus("", "Connection error");
    };
  } catch (err) {
    setStatus("", "Error: " + err.message);
    console.error("Start error:", err);
  }
}

async function startAudioCapture() {
  audioContext = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  await audioContext.audioWorklet.addModule("/static/audio-processor.js");

  const source = audioContext.createMediaStreamSource(mediaStream);
  audioWorklet = new AudioWorkletNode(audioContext, "audio-processor");

  audioWorklet.port.onmessage = (event) => {
    if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;

    const pcmData = new Uint8Array(event.data);
    const base64 = arrayBufferToBase64(pcmData);
    ws.send(JSON.stringify({ type: "audio", data: base64 }));
  };

  source.connect(audioWorklet);
}

function startVideoCapture() {
  const ctx = canvas.getContext("2d");
  canvas.width = VIDEO_WIDTH;
  canvas.height = VIDEO_HEIGHT;

  videoTimer = setInterval(() => {
    if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;

    ctx.drawImage(video, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    const dataUrl = canvas.toDataURL("image/jpeg", VIDEO_QUALITY);
    const base64 = dataUrl.split(",")[1];
    ws.send(JSON.stringify({ type: "video", data: base64 }));
  }, VIDEO_FRAME_INTERVAL);
}

function scheduleAudio(pcmArrayBuffer) {
  if (!playbackContext) {
    playbackContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    nextPlayTime = 0;
  }

  const int16 = new Int16Array(pcmArrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  const buffer = playbackContext.createBuffer(
    1,
    float32.length,
    PLAYBACK_SAMPLE_RATE
  );
  buffer.getChannelData(0).set(float32);

  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);

  const now = playbackContext.currentTime;
  const startTime = Math.max(now, nextPlayTime);
  source.start(startTime);
  nextPlayTime = startTime + buffer.duration;

  source.onended = () => {
    if (playbackContext && playbackContext.currentTime >= nextPlayTime - 0.05) {
      visualizer.classList.remove("active");
      setStatus("listening", "Listening...");
    }
  };
}

function stopSession() {
  isRunning = false;

  if (videoTimer) {
    clearInterval(videoTimer);
    videoTimer = null;
  }
  if (audioWorklet) {
    audioWorklet.disconnect();
    audioWorklet = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (playbackContext) {
    playbackContext.close();
    playbackContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }

  video.srcObject = null;
  nextPlayTime = 0;
  visualizer.classList.remove("active");
  setStatus("", "Disconnected");
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
