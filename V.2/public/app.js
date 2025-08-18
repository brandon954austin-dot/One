/*
 * CareBridge Voice Trainer frontend (WebRTC + OpenAI Realtime)
 * Add-only fix: wait for data channel to open before sending.
 */
(() => {
  // ---- existing element lookups / state (keep yours if already present) ----
  const els = {
    btnStart: document.getElementById("btnStart"),
    btnStop: document.getElementById("btnStop"),
    btnDownload: document.getElementById("btnDownload"),
    diag: document.getElementById("diag"),
    transcript: document.getElementById("transcript"),
    duration: document.getElementById("duration"),
    scenario: document.getElementById("scenario"),
    agentName: document.getElementById("agentName"),
    speechRate: document.getElementById("speechRate"),
    scores: {
      Discovery: document.getElementById("scoreDiscovery"),
      Objections: document.getElementById("scoreObjections"),
      Clarity: document.getElementById("scoreClarity"),
      Close: document.getElementById("scoreClose"),
    },
    notes: document.getElementById("coachNotes"),
    nextStep: document.getElementById("nextStep"),
    status: document.getElementById("status")
  };

  let pc = null;
  let micStream = null;
  let remoteAudio = null;
  let oaiChan = null;
  let trainerChan = null;
  let recognition = null;
  let running = false;
  let startTime = null;
  let modelBuffer = "";
  let transcriptLines = [];
  let awaitingScore = false;
  let clientSecret = null;
  let realtimeUrl = null;
  let modelName = null;
  let currentVoice = null;

  // Buffer for assistant audio transcript deltas.  When the model sends
  // partial audio transcript updates via `response.audio_transcript.delta`,
  // we accumulate them here until a `response.audio_transcript.done`
  // event delivers the final transcript.  Once done, the buffer is
  // flushed to the transcript log.
  let assistantAudioBuffer = "";

  /**
   * Start local speech recognition for the agent side using the Web
   * Speech API if available (currently Chrome-only).  Interim and
   * final results are captured; final transcripts are added to the
   * transcript pane under the "Agent" role.  If the API is not
   * available or fails to start this function silently returns.
   */
  async function startRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      // Speech recognition unsupported; nothing to do.
      return;
    }
    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          const transcript = res[0].transcript.trim();
          if (transcript) addTranscriptLine("Agent", transcript);
        }
      }
    };
    recognition.onerror = () => {
      // Recognition errors are logged silently; we continue without local transcript.
    };
    try {
      recognition.start();
    } catch {
      // Start may throw if already started or unsupported; ignore.
    }
  }

  function logStatus(msg) { els.status.textContent = msg; }
  function addTranscriptLine(prefix, text) {
    const line = `${prefix}: ${text}`;
    transcriptLines.push(line);
    const div = document.createElement("div");
    div.textContent = line;
    els.transcript.appendChild(div);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }
  function setScores(obj) {
    const n = v => (typeof v === "number" ? v : 0);
    els.scores.Discovery.textContent = n(obj?.scores?.Discovery);
    els.scores.Objections.textContent = n(obj?.scores?.Objections);
    els.scores.Clarity.textContent = n(obj?.scores?.Clarity);
    els.scores.Close.textContent = n(obj?.scores?.Close);
    els.notes.textContent = obj?.notes || "";
    els.nextStep.textContent = obj?.next_step || "";
  }

  // ----------------- ADD-ONLY: wait helper -----------------
  // Wait for a data channel to open (with a timeout)
  function waitForOpen(dc, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
      if (!dc) return reject(new Error("No data channel"));
      if (dc.readyState === "open") return resolve();

      const onOpen = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error("Data channel closed before open")); };
      const onError = () => { cleanup(); reject(new Error("Data channel error")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for data channel to open")); }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        try { dc.removeEventListener("open", onOpen); } catch {}
        try { dc.removeEventListener("close", onClose); } catch {}
        try { dc.removeEventListener("error", onError); } catch {}
      }

      dc.addEventListener("open", onOpen);
      dc.addEventListener("close", onClose);
      dc.addEventListener("error", onError);
    });
  }
  // ---------------------------------------------------------

  async function fetchSession() {
    const resp = await fetch("/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || "Failed to create session");
    clientSecret = json.client_secret?.value;
    realtimeUrl = json.url;
    modelName = json.model;
    currentVoice = json.voice;
    return json;
  }

  async function negotiate() {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const headers = { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" };
    const resp = await fetch(realtimeUrl, { method: "POST", headers, body: offer.sdp });
    const answerSdp = await resp.text();
    if (!answerSdp.startsWith("v=")) throw new Error("Realtime returned non-SDP. Check model/token headers.");
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  function buildPersonaInstructions() {
    const scenario = els.scenario.value;
    const agent = els.agentName.value.trim() || "the agent";
    const rate = els.speechRate.value;
    const rateText = rate === "fast" ? "Speak briskly" : rate === "slow" ? "Speak slowly" : "Speak at a natural pace";
    const weighted = {
      budget: ["the price is too high","I need a cheaper option","I can't afford this right now"],
      network: ["my doctor isn’t in your network","I'm worried about provider coverage","the network doesn’t include my hospital"],
      rx: ["my prescriptions are too expensive","my medications aren’t covered","the formulary is confusing"],
      delay: ["I need to discuss with my spouse","I need more time to decide","can you call me back later?"]
    }[scenario] || [];
    const general = [
      "I already have something cheaper","can you send me the details by email?","I don't trust these plans",
      "I need to check with my doctor","is there a better deal elsewhere?"
    ];
    return `You are "Taylor", a natural and lifelike client for a phone roleplay training. You are speaking with ${agent}.
${rateText}. Use short sentences and vary your tone. Occasionally pause mid-sentence and sometimes interrupt. Over the course of the call, use 3–5 objections overall. PRIORITIZE these scenario-specific concerns: ${weighted.join(", ")}. You may also sprinkle in general concerns such as: ${general.join(", ")}.
Avoid sharing real personal health information or personally identifiable information. Never mention plan names, IDs or prices; if the agent asks for specific product details, politely say you can't discuss prices and let them handle that.
Start the call with a warm greeting and a brief personal introduction. Ask one or two clarifying questions about your needs during the call. Allow barge-in: if the agent starts speaking over you, stop and then respond to their last point.
Stay on topic, be realistic and respectful. Produce both audio and text captions for everything you say.`;
  }

  function buildScoringPrompt() {
    return `Analyze the entire conversation and return ONLY this JSON object, no preface or code block:
{
  "scores": { "Discovery": 0-10, "Objections": 0-10, "Clarity": 0-10, "Close": 0-10 },
  "notes": "2–4 sentences of constructive feedback",
  "next_step": "one practical action"
}
Be strict but fair. Use integers. Do not add or remove fields. Do not include markdown or any explanatory text.`;
  }

  async function startSession() {
    if (running) return;
    logStatus("Starting…");
    // Reset UI
    els.transcript.innerHTML = "";
    transcriptLines = [];
    setScores({ scores: {}, notes: "", next_step: "" });

    // Audio element
    remoteAudio = document.getElementById("remoteAudio");
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.id = "remoteAudio";
      remoteAudio.autoplay = true;
      remoteAudio.playsInline = true;
      document.body.appendChild(remoteAudio);
    }

    // Peer connection
    pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.ontrack = e => { const [stream] = e.streams; remoteAudio.srcObject = stream; };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") logStatus("Connection failed. Check microphone permission and model name.");
    };

    // Data channels
    oaiChan = pc.createDataChannel("oai-events");
    // (optional add-only status hooks)
    oaiChan.addEventListener("open", () => logStatus("Channel open — starting the call…"));
    oaiChan.addEventListener("close", () => console.warn("oai-events channel closed"));
    oaiChan.addEventListener("error", (e) => console.warn("oai-events channel error:", e));

    oaiChan.onmessage = async event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "response.output_text.delta" && typeof msg.delta === "string") {
          modelBuffer += msg.delta;
        } else if (msg.type === "response.completed") {
          const out = modelBuffer.trim();
          if (out) {
            if (awaitingScore) {
              let parsed = null;
              try { parsed = JSON.parse(out); } catch {}
              if (parsed && parsed.scores) {
                setScores(parsed);
                fetch("/log", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ kind: "score", model: modelName, voice: currentVoice, payload: parsed, transcript: transcriptLines })
                }).catch(() => {});
              } else {
                addTranscriptLine("Client", out);
              }
              awaitingScore = false;
            } else {
              addTranscriptLine("Client", out);
            }
          }
          modelBuffer = "";
        } else if (msg.type === "response.audio_transcript.delta" && typeof msg.delta === "string") {
          // Accumulate assistant audio transcript deltas
          assistantAudioBuffer += msg.delta;
        } else if (msg.type === "response.audio_transcript.done") {
          // Final assistant transcript; use provided transcript or buffered deltas
          const t = (msg.transcript || assistantAudioBuffer || "").trim();
          if (t) addTranscriptLine("Client", t);
          assistantAudioBuffer = "";
        } else if (msg.type === "conversation.item.input_audio_transcription.completed") {
          // Completed agent (user) transcript from the server.  Add to log as Agent
          const t = (msg.transcript || "").trim();
          if (t) addTranscriptLine("Agent", t);
        }
      } catch {
        console.warn("Non-JSON model event:", event.data);
      }
    };

    trainerChan = pc.createDataChannel("trainer");

    // Mic
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
      });
    } catch {
      logStatus("Microphone permission denied. Please allow and retry.");
      return;
    }
    micStream.getTracks().forEach(t => pc.addTrack(t, micStream));

    // Session creation and SDP negotiation
    try {
      await fetchSession();
      await negotiate();
    } catch (e) {
      logStatus(e.message || "Failed to negotiate session.");
      return;
    }

    // After negotiation, enable server-side input audio transcription via
    // session.update.  This instructs the OpenAI service to transcribe
    // microphone input using Whisper; without it your audio will not be
    // transcribed.  We wait for the data channel to be open before
    // sending the update message.
    try {
      const updateMsg = {
        type: "session.update",
        session: {
          input_audio_transcription: { model: "whisper-1" }
        }
      };
      await waitForOpen(oaiChan);
      oaiChan.send(JSON.stringify(updateMsg));
    } catch (err) {
      console.warn("Failed to send session.update:", err.message);
    }

    // Mark session as running, start timers and optional local speech
    // recognition for the agent side.  Local recognition is a fallback
    // to display your speech immediately while waiting for server
    // transcription.  The server transcript will still arrive later.
    running = true;
    startTime = Date.now();
    updateDuration();
    startRecognition();

    // Build and send the persona instructions to the assistant.  Use
    // an IIFE to await data channel readiness.  Without waiting, you
    // may see "RTCDataChannel.readyState is not 'open'" errors.
    const persona = buildPersonaInstructions();
    const opening = `Begin the call with a natural greeting (one sentence). Then continue as a realistic client.`;
    const createMsg = {
      type: "response.create",
      response: { modalities: ["text", "audio"], instructions: persona + "\n\n" + opening }
    };
    (async () => {
      try {
        await waitForOpen(oaiChan);
        oaiChan.send(JSON.stringify(createMsg));
        logStatus("Live. You can start speaking.");
      } catch (err) {
        logStatus("Failed to send initial instructions: " + err.message);
      }
    })();
  }

  function updateDuration() {
    if (!running) { els.duration.textContent = "00:00"; return; }
    const s = Math.floor((Date.now() - startTime) / 1000);
    const mStr = String(Math.floor(s / 60)).padStart(2, "0");
    const sStr = String(s % 60).padStart(2, "0");
    els.duration.textContent = `${mStr}:${sStr}`;
    requestAnimationFrame(updateDuration);
  }

  function stopRecognition() { try { recognition && recognition.stop(); } catch {} recognition = null; }

  function stopSession() {
    if (!running) return;
    running = false;
    stopRecognition();

    // Request scoring JSON (ADD-ONLY: wait for open if needed)
    const scorePrompt = buildScoringPrompt();
    awaitingScore = true;
    (async () => {
      try {
        if (oaiChan) {
          await waitForOpen(oaiChan).catch(() => {}); // resolves immediately if already open
          oaiChan.send(JSON.stringify({
            type: "response.create",
            response: { modalities: ["text"], instructions: scorePrompt }
          }));
        }
      } catch {}
    })();

    // Graceful teardown
    setTimeout(() => {
      try { pc && pc.close(); } catch {}
      try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {}
      pc = null; micStream = null; oaiChan = null; trainerChan = null;
      fetch("/log", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "transcript", transcript: transcriptLines })
      }).catch(() => {});
      logStatus("Session ended.");
    }, 1500);
  }

  function downloadText() {
    const scoresText = `Scores:\nDiscovery: ${els.scores.Discovery.textContent}\nObjections: ${els.scores.Objections.textContent}\nClarity: ${els.scores.Clarity.textContent}\nClose: ${els.scores.Close.textContent}\n\nNotes: ${els.notes.textContent}\nNext Step: ${els.nextStep.textContent}\n`;
    const header = `CareBridge Voice Trainer Summary\nModel: ${modelName || ""} | Voice: ${currentVoice || ""}\nDuration: ${els.duration.textContent}\nDate: ${new Date().toLocaleString()}\n\n`;
    const body = transcriptLines.join("\n");
    const blob = new Blob([header + scoresText + "\nTranscript:\n" + body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "session-summary.txt";
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  // Wire up
  els.btnStart?.addEventListener("click", startSession);
  els.btnStop?.addEventListener("click", stopSession);
  els.btnDownload?.addEventListener("click", downloadText);

  // Diag
  fetch("/diag").then(r => r.json()).then(j => {
    els.diag && (els.diag.textContent = `Model: ${j.model} | Voice: ${j.voice} | Key: ${j.hasKey ? "✓" : "✗"}`);
  }).catch(() => {});
})();
