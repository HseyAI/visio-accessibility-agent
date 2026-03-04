// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const AUDIO_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;
const VIDEO_SIZE = 768;        // Google recommended — better obstacle detection
const VIDEO_QUALITY = 0.5;     // 768px at 0.5 ≈ same bandwidth as 512 at 0.7

// Mode-specific frame intervals (ms)
const MODE_FRAME_INTERVALS = {
  navigation: 1000,   // 1 FPS — Google recommended, ~258 tokens/frame
  reading: 2000,      // Slower — text doesn't move
  exploration: 2000,  // Save tokens for longer sessions
};

let VIDEO_FRAME_INTERVAL = MODE_FRAME_INTERVALS.navigation;
let currentMode = "navigation";

// ---------------------------------------------------------------------------
// Hazard Detection — keyword patterns & vibration
// ---------------------------------------------------------------------------
const HAZARD_PATTERNS = {
  critical: /\b(stop|danger|watch out|careful|vehicle|car|moving|collision|stairs ahead|don't move|stay back|traffic|running toward|cyclist|bike approaching)\b/i,
  warning: /\b(obstacle|uneven|step|curb|slope|wet|slippery|construction|pothole|crack|low.?hanging|narrow)\b/i,
  info: /\b(door|wall|turn|intersection|crosswalk|elevator|escalator|ramp)\b/i,
};

const VIBRATION_PATTERNS = {
  critical: [200, 100, 200, 100, 200],  // 3 strong pulses
  warning: [100, 50, 100],               // 2 quick pulses
  info: [50],                             // single tap
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let ws = null;
let audioContext = null;
let playbackContext = null;
let playerNode = null;
let mediaStream = null;
let audioWorklet = null;
let videoTimer = null;
let isRunning = false;
let framesSent = 0;
let framesSuccess = 0;
let hazardTimeout = null;
let pannerNode = null;
let panResetTimeout = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000; // ms, doubles each attempt
let lastUserSpeechTime = 0;        // Track when user last spoke

// Orientation state
let orientationBad = false;
let orientationWarningActive = false;
let lastOrientationWarnTime = 0;
let orientationReadings = [];  // rolling window of {beta, gamma, ts}
let badOrientationStart = 0;   // when bad orientation was first detected
let orientationHideTimer = null;

// ---------------------------------------------------------------------------
// DOM Elements
// ---------------------------------------------------------------------------
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const transcript = document.getElementById("transcript");
const video = document.getElementById("camera");
const canvas = document.getElementById("canvas");
const visualizer = document.getElementById("visualizer");
const cameraSection = document.getElementById("cameraSection");
const hazardBanner = document.getElementById("hazardBanner");
const hazardText = document.getElementById("hazardText");
const modeBadge = document.getElementById("modeBadge");
const connectionQuality = document.getElementById("connectionQuality");
const langSelect = document.getElementById("langSelect");
const modeButtons = document.querySelectorAll(".mode-btn");
const orientationBar = document.getElementById("orientationBar");
const orientationIcon = document.getElementById("orientationIcon");
const orientationText = document.getElementById("orientationText");

// ---------------------------------------------------------------------------
// Status & UI helpers
// ---------------------------------------------------------------------------
function setStatus(state, text) {
  statusDot.className = "status-dot " + state;
  statusText.textContent = text;
}

function updateConnectionQuality() {
  const dots = connectionQuality.querySelectorAll(".quality-dot");
  if (framesSent === 0) {
    dots.forEach(function (d) { d.className = "quality-dot"; });
    return;
  }
  var ratio = framesSuccess / framesSent;
  dots[0].className = "quality-dot " + (ratio > 0.3 ? "good" : "");
  dots[1].className = "quality-dot " + (ratio > 0.6 ? "good" : "");
  dots[2].className = "quality-dot " + (ratio > 0.85 ? "good" : "");
}

// ---------------------------------------------------------------------------
// Transcript — color-coded
// ---------------------------------------------------------------------------
function addTranscript(text, type) {
  var empty = transcript.querySelector(".transcript-empty");
  if (empty) empty.remove();

  var entry = document.createElement("div");

  // Detect hazard level for agent messages
  var hazardLevel = "";
  if (type === "agent") {
    if (HAZARD_PATTERNS.critical.test(text)) hazardLevel = "hazard-critical";
    else if (HAZARD_PATTERNS.warning.test(text)) hazardLevel = "hazard-warning";
  }

  entry.className = "transcript-entry " + type + (hazardLevel ? " " + hazardLevel : "");
  entry.textContent = (type === "agent" ? "Visio: " : "You: ") + text;
  transcript.appendChild(entry);
  transcript.scrollTop = transcript.scrollHeight;
}

// ---------------------------------------------------------------------------
// Haptic Feedback
// ---------------------------------------------------------------------------
function triggerHaptic(level) {
  if (!navigator.vibrate) return;
  var pattern = VIBRATION_PATTERNS[level];
  if (pattern) navigator.vibrate(pattern);
}

// ---------------------------------------------------------------------------
// Visual Hazard Alert
// ---------------------------------------------------------------------------
function showHazardAlert(text, level) {
  if (level === "critical") {
    cameraSection.classList.add("hazard-flash");
    hazardBanner.className = "hazard-banner visible critical";
    hazardText.textContent = text.substring(0, 120);

    if (hazardTimeout) clearTimeout(hazardTimeout);
    hazardTimeout = setTimeout(function () {
      cameraSection.classList.remove("hazard-flash");
      hazardBanner.className = "hazard-banner";
    }, 4000);
  } else if (level === "warning") {
    hazardBanner.className = "hazard-banner visible warning";
    hazardText.textContent = text.substring(0, 120);

    if (hazardTimeout) clearTimeout(hazardTimeout);
    hazardTimeout = setTimeout(function () {
      hazardBanner.className = "hazard-banner";
    }, 3000);
  }
}

// ---------------------------------------------------------------------------
// Process incoming transcript for hazards
// ---------------------------------------------------------------------------
function processAgentResponse(text) {
  if (HAZARD_PATTERNS.critical.test(text)) {
    triggerHaptic("critical");
    showHazardAlert(text, "critical");
  } else if (HAZARD_PATTERNS.warning.test(text)) {
    triggerHaptic("warning");
    showHazardAlert(text, "warning");
  } else if (HAZARD_PATTERNS.info.test(text)) {
    triggerHaptic("info");
  }
}

// ---------------------------------------------------------------------------
// Mode Switching
// ---------------------------------------------------------------------------
function switchMode(mode) {
  currentMode = mode;
  VIDEO_FRAME_INTERVAL = MODE_FRAME_INTERVALS[mode];
  modeBadge.textContent = mode.toUpperCase();

  // Update button states
  modeButtons.forEach(function (btn) {
    var isActive = btn.dataset.mode === mode;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive);
  });

  // Restart video capture with new interval
  if (isRunning && videoTimer) {
    clearInterval(videoTimer);
    startVideoCapture();
  }

  // Notify server
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "mode", data: mode }));
  }
}

modeButtons.forEach(function (btn) {
  btn.addEventListener("click", function () { switchMode(btn.dataset.mode); });
});

// ---------------------------------------------------------------------------
// Language Switching
// ---------------------------------------------------------------------------
langSelect.addEventListener("change", function () {
  var lang = langSelect.value;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "language", data: lang }));
  }
});

// ---------------------------------------------------------------------------
// Device Orientation Monitor (Gyroscope Guidance)
// ---------------------------------------------------------------------------
var ORIENT_SAMPLE_INTERVAL = 200;     // ms between readings
var ORIENT_WINDOW_SIZE = 5;           // rolling window count
var ORIENT_BAD_THRESHOLD = 1500;      // ms of bad orientation before warning
var ORIENT_COOLDOWN = 5000;           // ms cooldown between warnings
var ORIENT_SHAKE_VARIANCE = 400;      // variance threshold for shake detection

function classifyOrientation(beta, gamma, readings) {
  // Check shake first — variance of recent readings
  if (readings.length >= 3) {
    var betaValues = readings.map(function (r) { return r.beta; });
    var gammaValues = readings.map(function (r) { return r.gamma; });
    var betaVar = variance(betaValues);
    var gammaVar = variance(gammaValues);
    if (betaVar + gammaVar > ORIENT_SHAKE_VARIANCE) {
      return { bad: true, message: "Hold steady", icon: "\uD83D\uDCF3" };
    }
  }

  // Check tilt angles
  if (beta !== null) {
    if (beta > 130) {
      return { bad: true, message: "Raise your phone up", icon: "\u2B06\uFE0F" };
    }
    if (beta < 40) {
      return { bad: true, message: "Lower your phone", icon: "\u2B07\uFE0F" };
    }
  }

  if (gamma !== null && Math.abs(gamma) > 50) {
    return { bad: true, message: "Straighten your phone", icon: "\u21C6" };
  }

  return { bad: false, message: "Phone position: Good", icon: "\uD83D\uDCF1" };
}

function variance(arr) {
  if (arr.length === 0) return 0;
  var mean = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  return arr.reduce(function (sum, v) { return sum + (v - mean) * (v - mean); }, 0) / arr.length;
}

function showOrientationWarning(message, icon) {
  orientationIcon.textContent = icon;
  orientationText.textContent = message;
  orientationBar.className = "orientation-bar visible warning";
  if (orientationHideTimer) clearTimeout(orientationHideTimer);
}

function hideOrientationWarning() {
  if (orientationHideTimer) clearTimeout(orientationHideTimer);
  orientationHideTimer = setTimeout(function () {
    orientationBar.className = "orientation-bar";
    orientationWarningActive = false;
  }, 1000);
}

function handleOrientationEvent(event) {
  if (!isRunning) return;

  var now = Date.now();
  var beta = event.beta;   // front/back tilt (-180 to 180)
  var gamma = event.gamma; // left/right tilt (-90 to 90)

  if (beta === null && gamma === null) return;

  // Add to rolling window
  orientationReadings.push({ beta: beta || 0, gamma: gamma || 0, ts: now });

  // Trim window to last ORIENT_WINDOW_SIZE samples
  while (orientationReadings.length > ORIENT_WINDOW_SIZE) {
    orientationReadings.shift();
  }

  var result = classifyOrientation(beta, gamma, orientationReadings);

  if (result.bad) {
    if (!orientationBad) {
      // Just became bad — start counting
      badOrientationStart = now;
      orientationBad = true;
    }

    // Only warn if bad orientation persists beyond threshold
    if (now - badOrientationStart > ORIENT_BAD_THRESHOLD) {
      // Check cooldown
      if (now - lastOrientationWarnTime > ORIENT_COOLDOWN) {
        lastOrientationWarnTime = now;
        orientationWarningActive = true;
        showOrientationWarning(result.message, result.icon);

        // Haptic: single short buzz
        if (navigator.vibrate) navigator.vibrate([80]);
      } else if (orientationWarningActive) {
        // Update text even during cooldown if already showing
        showOrientationWarning(result.message, result.icon);
      }
    }
  } else {
    // Orientation is good
    if (orientationBad) {
      orientationBad = false;
      badOrientationStart = 0;
      if (orientationWarningActive) hideOrientationWarning();
    }
  }
}

function startOrientationMonitor() {
  window.addEventListener("deviceorientation", handleOrientationEvent);
}

function stopOrientationMonitor() {
  window.removeEventListener("deviceorientation", handleOrientationEvent);
  orientationReadings = [];
  orientationBad = false;
  orientationWarningActive = false;
  badOrientationStart = 0;
  if (orientationHideTimer) { clearTimeout(orientationHideTimer); orientationHideTimer = null; }
  orientationBar.className = "orientation-bar";
}

function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    // iOS 13+ requires explicit permission
    DeviceOrientationEvent.requestPermission().then(function (state) {
      if (state === "granted") startOrientationMonitor();
    }).catch(function () {
      // Permission denied or unavailable — silently continue without orientation
    });
  } else {
    // Android, desktop — just works
    startOrientationMonitor();
  }
}

// ---------------------------------------------------------------------------
// Emergency SOS — double-tap activation + Geolocation
// ---------------------------------------------------------------------------
const sosBtn = document.getElementById("sosBtn");
let sosActive = false;
let sosLastTap = 0;
let sosLocationWatchId = null;
let lastKnownLocation = null;

// Double-tap detection on SOS button
sosBtn.addEventListener("click", function () {
  var now = Date.now();
  if (now - sosLastTap < 500) {
    // Double tap detected
    toggleSOS();
  }
  sosLastTap = now;
});

function toggleSOS() {
  if (sosActive) {
    deactivateSOS();
  } else {
    activateSOS();
  }
}

function activateSOS() {
  sosActive = true;
  sosBtn.classList.add("active");
  sosBtn.querySelector(".sos-hint").textContent = "Double-tap to cancel";

  // Strong haptic alert
  if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);

  // Get location and send emergency
  getLocationAndSendSOS();

  // Start watching location for continuous updates
  if ("geolocation" in navigator) {
    sosLocationWatchId = navigator.geolocation.watchPosition(
      function (pos) {
        lastKnownLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        };
      },
      function () {},
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }
}

function deactivateSOS() {
  sosActive = false;
  sosBtn.classList.remove("active");
  sosBtn.querySelector(".sos-hint").textContent = "Double-tap for emergency";

  if (sosLocationWatchId !== null) {
    navigator.geolocation.clearWatch(sosLocationWatchId);
    sosLocationWatchId = null;
  }

  // Tell Visio emergency is over
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "text", data: "[SOS DEACTIVATED] The user has cancelled the emergency. Resume normal operation." }));
  }
  addTranscript("SOS deactivated", "user");
}

function getLocationAndSendSOS() {
  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        lastKnownLocation = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        };
        sendSOSMessage(lastKnownLocation);
      },
      function () {
        // Location failed — send SOS without coordinates
        sendSOSMessage(null);
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );
  } else {
    sendSOSMessage(null);
  }
}

function sendSOSMessage(location) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  var msg = "[EMERGENCY SOS ACTIVATED] The user has triggered an emergency alert. ";
  if (location) {
    msg += "GPS Location: " + location.lat.toFixed(6) + ", " + location.lng.toFixed(6) + " (accuracy: ~" + location.accuracy + "m). ";
    msg += "Google Maps: https://maps.google.com/?q=" + location.lat.toFixed(6) + "," + location.lng.toFixed(6) + " — ";
  } else {
    msg += "GPS location unavailable. ";
  }
  msg += "Immediately describe ALL visible signs, street names, landmarks, and building names. Identify exits and safe paths. Stay calm and keep providing location details until the user says they are safe.";

  ws.send(JSON.stringify({ type: "text", data: msg }));
  addTranscript("SOS ACTIVATED" + (location ? " (Location shared)" : ""), "user");
}

// Also listen for the voice keyword "emergency" to auto-trigger SOS
function checkForEmergencyKeyword(text) {
  if (sosActive) return; // Already active
  var lower = text.toLowerCase();
  if (lower.includes("emergency") || lower.includes("help me") || lower.includes("i need help") || lower.includes("i'm lost")) {
    activateSOS();
  }
}

// ---------------------------------------------------------------------------
// Spatial Audio — StereoPanner for directional cues
// ---------------------------------------------------------------------------
const DIRECTION_PATTERNS = [
  { regex: /\b(on your left|to your left|from the left|left side|to the left)\b/i, pan: -0.8 },
  { regex: /\b(on your right|to your right|from the right|right side|to the right)\b/i, pan: 0.8 },
  { regex: /\b(your\s*9\s*o['']?clock|your\s*10\s*o['']?clock)\b/i, pan: -0.7 },
  { regex: /\b(your\s*2\s*o['']?clock|your\s*3\s*o['']?clock)\b/i, pan: 0.7 },
  { regex: /\b(your\s*11\s*o['']?clock|your\s*1\s*o['']?clock)\b/i, pan: -0.3 },
  { regex: /\b(your\s*4\s*o['']?clock|your\s*5\s*o['']?clock)\b/i, pan: 0.3 },
  { regex: /\b(ahead|in front|straight ahead|directly ahead|behind you|your\s*12\s*o['']?clock|your\s*6\s*o['']?clock)\b/i, pan: 0.0 },
];

function detectDirection(text) {
  for (var i = 0; i < DIRECTION_PATTERNS.length; i++) {
    if (DIRECTION_PATTERNS[i].regex.test(text)) {
      return DIRECTION_PATTERNS[i].pan;
    }
  }
  return null; // No directional keyword found
}

function applySpatialPan(panValue) {
  if (!pannerNode || !playbackContext) return;

  // Clear any pending reset
  if (panResetTimeout) { clearTimeout(panResetTimeout); panResetTimeout = null; }

  // Smooth ramp to target pan over 150ms
  var now = playbackContext.currentTime;
  pannerNode.pan.cancelScheduledValues(now);
  pannerNode.pan.linearRampToValueAtTime(panValue, now + 0.15);

  // Reset to center after 3 seconds
  panResetTimeout = setTimeout(function () {
    if (pannerNode && playbackContext) {
      var t = playbackContext.currentTime;
      pannerNode.pan.cancelScheduledValues(t);
      pannerNode.pan.linearRampToValueAtTime(0, t + 0.3);
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
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
    // Resume AudioContext — mobile browsers suspend it until user gesture
    if (playbackContext.state === "suspended") {
      await playbackContext.resume();
    }
    await playbackContext.audioWorklet.addModule("/static/audio-player.js");
    playerNode = new AudioWorkletNode(playbackContext, "pcm-player-processor");
    pannerNode = playbackContext.createStereoPanner();
    pannerNode.pan.value = 0;
    playerNode.connect(pannerNode);
    pannerNode.connect(playbackContext.destination);
    playerNode.port.onmessage = function (e) {
      if (e.data.type === "ended") {
        visualizer.classList.remove("active");
        setStatus("listening", "Listening...");
      }
    };

    setStatus("", "Connecting...");

    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(protocol + "//" + location.host + "/ws");
    ws.binaryType = "arraybuffer";

    // Connection timeout — if WebSocket doesn't open in 10s, retry
    var connectTimeout = setTimeout(function () {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
        setStatus("", "Connection timed out");
      }
    }, 10000);

    ws.onopen = function () {
      clearTimeout(connectTimeout);
      reconnectAttempts = 0;
      isRunning = true;
      framesSent = 0;
      framesSuccess = 0;
      setStatus("connected", "Connected - Visio is watching and listening");
      startBtn.disabled = true;
      stopBtn.disabled = false;
      sosBtn.disabled = false;
      startAudioCapture();
      startVideoCapture();
      requestOrientationPermission();

      // Send initial language if not English
      if (langSelect.value !== "English") {
        ws.send(JSON.stringify({ type: "language", data: langSelect.value }));
      }

      // Restore current mode if reconnecting
      if (currentMode !== "navigation") {
        ws.send(JSON.stringify({ type: "mode", data: currentMode }));
      }
    };

    ws.onmessage = handleWsMessage;

    ws.onclose = function () {
      clearTimeout(connectTimeout);
      handleWsClose();
    };

    ws.onerror = function () {
      // onerror is always followed by onclose — let onclose handle reconnect
    };
  } catch (err) {
    setStatus("", "Error: " + err.message);
  }
}

// Reconnect WebSocket without restarting camera/audio playback
function reconnectWebSocket() {
  if (!isRunning || !mediaStream) return;

  try {
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(protocol + "//" + location.host + "/ws");
    ws.binaryType = "arraybuffer";

    var connectTimeout = setTimeout(function () {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, 10000);

    ws.onopen = function () {
      clearTimeout(connectTimeout);
      reconnectAttempts = 0;
      setStatus("connected", "Reconnected - Visio is back");
      addTranscript("Reconnected successfully.", "agent");
      startAudioCapture();
      startVideoCapture();

      if (langSelect.value !== "English") {
        ws.send(JSON.stringify({ type: "language", data: langSelect.value }));
      }
      if (currentMode !== "navigation") {
        ws.send(JSON.stringify({ type: "mode", data: currentMode }));
      }
    };

    ws.onmessage = handleWsMessage;
    ws.onclose = handleWsClose;
    ws.onerror = function () {};
  } catch (e) {
    // Will retry via onclose
  }
}

function handleWsMessage(event) {
  if (event.data instanceof ArrayBuffer) {
    // Ensure audio context is running (mobile browsers can suspend it)
    if (playbackContext && playbackContext.state === "suspended") {
      playbackContext.resume();
    }
    if (playerNode) playerNode.port.postMessage(event.data);
    setStatus("speaking", "Visio is speaking...");
    visualizer.classList.add("active");
  } else {
    try {
      var msg = JSON.parse(event.data);
      if (msg.type === "transcript") {
        addTranscript(msg.data, "agent");
        processAgentResponse(msg.data);
        var panValue = detectDirection(msg.data);
        if (panValue !== null) applySpatialPan(panValue);
      } else if (msg.type === "user_transcript") {
        addTranscript(msg.data, "user");
        checkForEmergencyKeyword(msg.data);
      }
    } catch (e) {
      addTranscript(event.data, "agent");
    }
  }
}

function handleWsClose() {
  if (isRunning) {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      var delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts);
      reconnectAttempts++;
      setStatus("", "Connection lost — reconnecting (" + reconnectAttempts + "/" + MAX_RECONNECT_ATTEMPTS + ")...");
      addTranscript("Connection lost. Reconnecting...", "agent");

      if (videoTimer) { clearInterval(videoTimer); videoTimer = null; }
      if (audioWorklet) { audioWorklet.disconnect(); audioWorklet = null; }
      if (audioContext) { audioContext.close(); audioContext = null; }

      reconnectTimer = setTimeout(function () {
        reconnectWebSocket();
      }, delay);
    } else {
      setStatus("", "Disconnected — please restart");
      addTranscript("Could not reconnect. Please tap Start to try again.", "agent");
      stopSession();
    }
  }
}

async function startAudioCapture() {
  audioContext = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
  await audioContext.audioWorklet.addModule("/static/audio-processor.js");

  var source = audioContext.createMediaStreamSource(mediaStream);
  audioWorklet = new AudioWorkletNode(audioContext, "audio-processor");

  audioWorklet.port.onmessage = function (event) {
    if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(event.data);
  };

  source.connect(audioWorklet);
}

function startVideoCapture() {
  var ctx = canvas.getContext("2d");
  canvas.width = VIDEO_SIZE;
  canvas.height = VIDEO_SIZE;

  videoTimer = setInterval(function () {
    if (!isRunning || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (orientationBad) return; // Skip frame — phone pointing wrong way

    ctx.drawImage(video, 0, 0, VIDEO_SIZE, VIDEO_SIZE);
    framesSent++;

    canvas.toBlob(
      function (blob) {
        if (!blob) return;
        var reader = new FileReader();
        reader.onloadend = function () {
          var base64 = reader.result.split(",")[1];
          ws.send(JSON.stringify({ type: "image", data: base64, frame: framesSent }));
          framesSuccess++;
          updateConnectionQuality();
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
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent reconnect during intentional stop
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopOrientationMonitor();
  if (videoTimer) { clearInterval(videoTimer); videoTimer = null; }
  if (audioWorklet) { audioWorklet.disconnect(); audioWorklet = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  if (playerNode) { playerNode.port.postMessage({ command: "stop" }); }
  if (panResetTimeout) { clearTimeout(panResetTimeout); panResetTimeout = null; }
  if (pannerNode) { pannerNode.disconnect(); pannerNode = null; }
  if (playbackContext) { playbackContext.close(); playbackContext = null; playerNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(function (t) { t.stop(); }); mediaStream = null; }
  if (ws) { ws.close(); ws = null; }
  video.srcObject = null;
  visualizer.classList.remove("active");
  cameraSection.classList.remove("hazard-flash");
  hazardBanner.className = "hazard-banner";
  setStatus("", "Disconnected");
  if (sosActive) deactivateSOS();
  sosBtn.disabled = true;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
