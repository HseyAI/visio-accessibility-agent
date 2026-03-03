const AUDIO_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const VIDEO_FRAME_INTERVAL = 2000;
const VIDEO_SIZE = 768;
const VIDEO_QUALITY = 0.5;

let ws = null;
let audioContext = null;
let playbackContext = null;
let playerNode = null;
let mediaStream = null;
let audioWorklet = null;
let videoTimer = null;
let isRunning = false;

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
        width: { ideal: VIDEO_SIZE },
        height: { ideal: VIDEO_SIZE },
      },
    });

    video.srcObject = mediaStream;

    // Setup audio playback with ring buffer
    playbackContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
    await playbackContext.audioWorklet.addModule("/static/audio-player.js");
    playerNode = new AudioWorkletNode(playbackContext, "pcm-player-processor");
    playerNode.connect(playbackContext.destination);
    playerNode.port.onmessage = (e) => {
      if (e.data.type === "ended") {
        visualizer.classList.remove("active");
        setStatus("listening", "Listening...");
      }
    };

    setStatus("", "Connecting...");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      isRunning = true;
      setStatus("connected", "Connected - Visio is watching and listening");
      startBtn.disabled = true;
      stopBtn.disabled = false;
      startAudioCapture();
      startVideoCapture();
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary audio from agent — feed to ring buffer player
        playerNode.port.postMessage(event.data);
        setStatus("speaking", "Visio is speaking...");
        visualizer.classList.add("active");
      } else {
        // Text JSON message
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "transcript") {
            addTranscript(msg.data, "agent");
          }
        } catch (e) {
          // Plain text
          addTranscript(event.data, "agent");
        }
      }
    };

    ws.onclose = () => {
      if (isRunning) {
        setStatus("", "Disconnected");
        stopSession();
      }
    };
    ws.onerror = () => setStatus("", "Connection error");
  } catch (err) {
    setStatus("", "Error: " + err.message);
  }
}

async function startAudioCapture() {
  audioContext = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  await audioContext.audioWorklet.addModule("/static/audio-processor.js");

  const source = audioContext.createMediaStreamSource(mediaStream);
  audioWorklet = new AudioWorkletNode(audioContext, "audio-processor");

  audioWorklet.port.onmessage = (event) => {
    if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Send raw binary audio — no JSON wrapping
    ws.send(event.data);
  };

  source.connect(audioWorklet);
}

function startVideoCapture() {
  const ctx = canvas.getContext("2d");
  canvas.width = VIDEO_SIZE;
  canvas.height = VIDEO_SIZE;

  videoTimer = setInterval(() => {
    if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;

    ctx.drawImage(video, 0, 0, VIDEO_SIZE, VIDEO_SIZE);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(",")[1];
          ws.send(JSON.stringify({ type: "image", data: base64 }));
        };
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      VIDEO_QUALITY
    );
  }, VIDEO_FRAME_INTERVAL);
}

function stopSession() {
  isRunning = false;
  if (videoTimer) { clearInterval(videoTimer); videoTimer = null; }
  if (audioWorklet) { audioWorklet.disconnect(); audioWorklet = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (playerNode) { playerNode.port.postMessage({ command: "stop" }); }
  if (playbackContext) { playbackContext.close(); playbackContext = null; playerNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (ws) { ws.close(); ws = null; }
  video.srcObject = null;
  visualizer.classList.remove("active");
  setStatus("", "Disconnected");
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
