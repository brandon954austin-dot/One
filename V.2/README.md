# CareBridge Voice Trainer

The **CareBridge Voice Trainer** is a realtime voice roleplay web app for
practising client interactions.  It uses the OpenAI Realtime API to
generate a lifelike client persona that speaks and listens via WebRTC
while you respond.  After each call the model scores your
performance on discovery, handling objections, clarity and closing
skills, provides coaching notes, and suggests a next step.

## Features

* **Realtime voice roleplay** – the assistant speaks and listens in
  realtime using WebRTC.  Interruptions and barge‑ins are handled
  naturally.
* **Scenario weighting** – choose from *Budget*, *Network*, *Rx*, or
  *Delay* scenarios to emphasise different objection patterns.
* **Live transcript** – both sides of the conversation are transcribed
  and displayed in realtime.  Optional local speech recognition
  captures your side of the call in Chrome.
* **Scoring & coaching** – after you end a call the model returns a
  JSON rubric with scores (0–10), concise feedback, and a practical
  next step.  These results populate the scorecard and can be
  downloaded.
* **Session export & logging** – download a `.txt` summary of any
  session.  The server logs session summaries to `data/sessions.jsonl`
  and can optionally forward them to a webhook via `RESULTS_WEBHOOK`.
* **Accessibility & AA+ contrast** – every input is properly labelled,
  dynamic regions announce updates via ARIA, and focus styles are
  visible for keyboard navigation.
* **Self‑contained** – no external dependencies beyond Node 18+.  The
  backend uses builtin modules only.

## Quick Start

1. **Requirements**
   * Node 18 or later.
   * An OpenAI API key with access to the Realtime API.
   * A modern browser (latest Chrome recommended) with microphone
     support.

2. **Install**
   ```bash
   # Clone or unpack this repository, then from its root:
   cp .env.example .env
   # Edit .env and add your OPENAI_API_KEY and (optionally) other settings
   ```

3. **Run**
   ```bash
   npm start
   # The server starts on the port defined in .env (default 8787)
   # Open http://localhost:8787 in your browser and allow microphone access
   ```

4. **Use**
   * Choose a **Scenario** from the dropdown to tailor objection
     weighting: Budget/Price, Network/Doctor, Prescriptions/Formulary
     (Rx), or Delay/Spouse.
   * Optionally enter your **Agent Name** and select the client's
     **Speaking Rate** (normal, slow, fast).
   * Click **Start**.  After negotiation the assistant greets you and
     the transcript begins to fill.  Speak naturally into your
     microphone.  Objections will arise organically.
   * Click **Stop** to end the call.  The model will analyse the
     conversation and populate the scorecard with four numeric scores
     (Discovery, Objections, Clarity, Close), coaching notes, and a
     recommended next step.
   * Click **Download** to save a plain text summary containing the
     scores, notes, next step, and full transcript.

## Environment Configuration

The application reads configuration from `.env` if present.  See
`.env.example` for all available variables.  At minimum you must set
`OPENAI_API_KEY` with a key that has been provisioned for the
Realtime API.  Other optional variables include:

* `PORT` – HTTP port to listen on (default `8787`).
* `RESULTS_WEBHOOK` – URL to POST session summaries to.  If
  configured, each call to `/log` will forward the JSON record to
  this URL; non‑2xx responses are ignored with a warning.
* `OPENAI_REALTIME_MODEL` – model name (default
  `gpt-4o-realtime-preview`).  Override with another realtime model if
  available.
* `OPENAI_REALTIME_VOICE` – voice name (default `verse`).  Supported
  voices may include `alloy` and others depending on your account.

## Notes & Best Practices

* **No PHI/PII** – this tool is for training.  Never mention real
  personal health information or personally identifiable information.
  When the simulated client asks for plan IDs or prices, politely
  deflect and follow your company’s process.
* **Browser support** – the optional agent‑side speech recognition
  relies on the Web Speech API, which is available in recent Chrome
  releases.  Other browsers will still function, but only the
  assistant’s side will be transcribed automatically.
* **Session logging** – session summaries and transcripts are
  appended to `data/sessions.jsonl` on the server.  Rotate or
  integrate this file into your own systems as needed.

## Troubleshooting

* If **/diag** reports `hasKey: false`, ensure that your `.env` file
  contains a valid `OPENAI_API_KEY` and that the key has access to
  the Realtime API.
* If negotiation fails with “Realtime returned non‑SDP”, double‑check
  your model name and that your API key is authorised for realtime
  sessions.  See the OpenAI documentation for current model names.
* If the UI says “Microphone permission denied”, allow microphone
  access in your browser’s permission prompt and try again.
* Webhook failures are logged to the server console and do not stop
  execution.  Ensure the `RESULTS_WEBHOOK` endpoint returns a 2xx
  status code.

---

Made with ♥ for training and continuous improvement.
