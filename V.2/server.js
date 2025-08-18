/**
 * CareBridge Voice Trainer - Realtime WebRTC server (no external deps)
 *
 * This server exposes a minimal HTTP API and static file host to power the
 * real-time voice roleplay trainer.  It reads configuration from a `.env`
 * file in the project root (if present) and supports the following
 * endpoints:
 *
 *   GET  /diag    → returns runtime info (port, node version, model, voice)
 *   GET  /health  → simple liveness probe
 *   POST /session → creates a short-lived OpenAI Realtime session
 *   POST /log     → append a JSON record to `data/sessions.jsonl` and
 *                   optionally forward to a webhook defined by RESULTS_WEBHOOK
 *
 * No external dependencies are required; everything is built on Node’s
 * builtin `http`/`https` modules.  The static assets under `public/` are
 * served directly from disk.  Directory traversal outside of `public/` is
 * prevented by normalising file paths.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---- Minimal .env loader (no third-party deps) ----
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("<")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
})();

// ---- Configuration with sane defaults ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const PORT = parseInt(process.env.PORT || "8787", 10);
const RESULTS_WEBHOOK = process.env.RESULTS_WEBHOOK || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "verse";

// Paths
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const LOG_FILE = path.join(DATA_DIR, "sessions.jsonl");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Helpers ----
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(text);
}
function notFound(res) { sendText(res, 404, "Not Found"); }

// Static file server (locked to PUBLIC_DIR)
function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset-utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg"
  };
  const contentType = typeMap[ext] || "application/octet-stream";
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  stream.pipe(res);
}

// Parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      const ct = req.headers["content-type"] || "";
      try {
        if (ct.includes("application/json")) return resolve(JSON.parse(data));
        return resolve({ raw: data });
      } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

// Simple HTTPS JSON request
function httpsRequestJson(options, bodyObj) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data || "{}")); }
          catch (e) { reject(new Error("Failed to parse JSON from OpenAI: " + e.message + "\n" + data)); }
        } else {
          reject(new Error("OpenAI error: " + res.statusCode + " " + data));
        }
      });
    });
    req.on("error", reject);
    req.setHeader("Content-Type", "application/json");
    if (bodyObj) req.write(JSON.stringify(bodyObj));
    req.end();
  });
}

// Create realtime session
async function createRealtimeSession({ model, voice }) {
  // Include additional audio configuration when creating a realtime session.  The
  // `input_audio_format` indicates we are sending PCM16 audio and
  // `input_audio_transcription` tells the service to transcribe incoming
  // microphone audio using Whisper.  Without these fields the model will not
  // automatically transcribe the agent's speech.
  const requestBody = {
    model,
    voice,
    modalities: ["text", "audio"],
    input_audio_format: "pcm16",
    input_audio_transcription: { model: "whisper-1" }
  };
  const options = {
    method: "POST",
    hostname: "api.openai.com",
    path: "/v1/realtime/sessions",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }
  };
  const json = await httpsRequestJson(options, requestBody);
  if (!json || !json.client_secret || !json.client_secret.value) {
    throw new Error("Realtime session did not return a client_secret");
  }
  return {
    client_secret: json.client_secret,
    url: `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    model, voice
  };
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    if (pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === "/diag" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        hasKey: !!OPENAI_API_KEY,
        port: PORT,
        node: process.version,
        model: OPENAI_REALTIME_MODEL,
        voice: OPENAI_REALTIME_VOICE
      });
    }

    if (pathname === "/session" && req.method === "POST") {
      if (!OPENAI_API_KEY) {
        return sendJson(res, 400, { ok: false, error: "Missing OPENAI_API_KEY in server environment." });
      }
      let body = {};
      try { body = await parseBody(req); }
      catch (_) { return sendJson(res, 400, { ok: false, error: "Invalid JSON body" }); }
      const model = (body && body.model) || OPENAI_REALTIME_MODEL;
      const voice = (body && body.voice) || OPENAI_REALTIME_VOICE;
      try {
        const sess = await createRealtimeSession({ model, voice });
        return sendJson(res, 200, { ok: true, ...sess });
      } catch (e) {
        return sendJson(res, 500, {
          ok: false,
          error: e.message,
          hint: "Check your OPENAI_API_KEY, model name, and network connectivity."
        });
      }
    }

    if (pathname === "/log" && req.method === "POST") {
      let payload = {};
      try { payload = await parseBody(req); }
      catch (err) { return sendJson(res, 400, { ok: false, error: "Invalid JSON body" }); }
      const record = { ts: new Date().toISOString(), ...payload };
      try { fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n", "utf8"); }
      catch (err) { console.warn("Failed to append log: ", err.message); }

      if (RESULTS_WEBHOOK) {
        try {
          await new Promise((resolve, reject) => {
            const hook = new URL(RESULTS_WEBHOOK);
            const opts = {
              method: "POST",
              hostname: hook.hostname,
              path: hook.pathname + (hook.search || ""),
              protocol: hook.protocol,
              port: hook.port || (hook.protocol === "https:" ? 443 : 80),
              headers: { "Content-Type": "application/json" }
            };
            const req2 = (hook.protocol === "https:" ? https : http).request(opts, resp => {
              resp.on("data", () => {});
              resp.on("end", () => resolve());
            });
            req2.on("error", reject);
            req2.write(JSON.stringify(record));
            req2.end();
          });
        } catch (err) {
          console.warn("Webhook forward failed: ", err.message);
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    // --- STATIC ROUTING (add-only fixes) ---

    // Serve homepage (no leading slash)
    if (pathname === "/" || pathname === "") {
      return serveStatic(req, res, "index.html");
    }

    // Map /public/* to files under PUBLIC_DIR
    if (pathname.startsWith("/public/")) {
      const rel = pathname.slice("/public/".length); // e.g. "app.js", "styles.css"
      return serveStatic(req, res, rel);
    }

    // Fallback: serve relative to PUBLIC_DIR (strip any leading slashes)
    {
      const rel = pathname.replace(/^\/+/, "");
      return serveStatic(req, res, rel);
    }
  } catch (err) {
    console.error("Server error: ", err);
    return sendJson(res, 500, { ok: false, error: "Internal Server Error" });
  }
});

server.listen(PORT, () => {
  console.log(`✅ CareBridge Voice Trainer running at http://localhost:${PORT}`);
});
