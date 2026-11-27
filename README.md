# Voice agent console (RMX-241)

Web console and backend for the SolarSquare lead-qualification voice agent. Plan: `docs/superpowers/plans/2026-11-22-voice-agent-lead-qualification.md`.

```
web/      React + Vite + TypeScript console (SolarSquare design system).
server/   FastAPI backend: room tokens, SIP dial-out, ending calls. Holds all secrets.
tests/    Backend tests.
```

## Run the console

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

The console has six sources:

| Source | What it does | Needs |
|---|---|---|
| **Demo** | You talk to the cascaded agent (Sarvam STT → Gemini → Cartesia TTS) through the browser microphone. | Backend, agent worker, LiveKit keys |
| **Demo v2** | Speech-to-speech: Gemini native audio hears you and speaks back in one hop. | Same as Demo (`LLM_API_KEY` must be a Gemini key) |
| **Demo v3** | The browser talks straight to the agent saved in the Cartesia dashboard. That agent hears and answers. This repo does not send a prompt. Caller answers, and any `update_lead` / `end_call` / `handoff_to_human` tool the agent calls, are saved to `out/cart-*.json` and the lead card. | Backend and `TTS_API_KEY` plus `CARTESIA_AGENT_ID`. No LiveKit worker. |
| **Demo v4** | The browser talks straight to the agent saved in the ElevenLabs dashboard. That agent hears and answers. This repo does not send a prompt. Answers are saved the same way, to `out/elab-*.json`. | Backend and `ELEVENLABS_API_KEY` plus `ELEVENLABS_AGENT_ID`. No LiveKit worker. |
| **Live call** | The backend dials a team test number. Choose which demo answers: Demo or Demo v2 (you listen in the console), or Demo v3 / Demo v4 (you hear the agent on the phone, and the console follows the transcript). | `TEST_NUMBER_ALLOWLIST`, plus the keys for the agent you pick. Demo and Demo v2 also need `SIP_OUTBOUND_TRUNK_ID`. Demo v3 also needs `CARTESIA_FROM_NUMBER_ID`. Demo v4 also needs `ELEVENLABS_PHONE_NUMBER_ID`. |
| **Scripted** | Plays a pre-written Hindi call through the same screens. | Nothing (offline fallback) |

Checks: `npm test` (contract + call-state tests), `npm run typecheck`, `npm run build`.

## Run it live

1. `cp .env.example .env` and fill in the LiveKit keys (and the SIP trunk id for phone calls).
2. Start the backend from the repo root:
   ```bash
   python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
   .venv/bin/uvicorn server.main:app --port 8000
   ```
3. Start the agent worker (needs Python 3.10+; set up once with `uv venv --python 3.12 .venv-agent && uv pip install --python .venv-agent/bin/python -r src/requirements.txt`):
   ```bash
   PYTHONPATH=src .venv-agent/bin/python -m agent.agent start
   ```
   It registers as `AGENT_NAME` and is dispatched into each call room by the backend. Demo uses Sarvam STT, Gemini (`LLM_MODEL`) and Cartesia Sonic TTS. Demo v2 uses Gemini native audio (`S2S_MODEL`). Demo v3 does not use this worker: the console opens a session with the Cartesia agent in `CARTESIA_AGENT_ID`, and that agent's dashboard prompt is what answers. Demo v4 is the same idea for the ElevenLabs agent in `ELEVENLABS_AGENT_ID`. Each finished Demo or Demo v2 call writes `out/<room>.json`.
4. Start the console (`npm run dev` in `web/`). Vite proxies `/api` to `http://localhost:8000` (override with `BACKEND_URL`). The console polls `GET /api/health`; **Demo** and **Demo v2** become selectable once LiveKit is configured, **Demo v3** once `TTS_API_KEY` and `CARTESIA_AGENT_ID` are set, **Demo v4** once `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` are set, and **Live call** once any phone path is ready. On a live call, pick the agent: Demo and Demo v2 use the SIP trunk (Demo v2 dispatches the speech-to-speech pipeline), Demo v3 dials from `CARTESIA_FROM_NUMBER_ID`, and Demo v4 dials from `ELEVENLABS_PHONE_NUMBER_ID`. The console lists any missing LiveKit or phone settings by name.

For the demo on stage, use `npm run build && npm run preview` (port 4173, same proxy).

## Event contract v1 (the agent must publish these)

Source of truth: [`web/src/contract/events.ts`](web/src/contract/events.ts). The agent publishes JSON on LiveKit data topic **`call-events`** (reliable). The console validates every event and ignores anything malformed or unknown, so a bad event never breaks the UI.

Every event may carry `seq` (monotonic per call; repeats are dropped) and `ts` (epoch ms).

| type | fields | notes |
|---|---|---|
| `state` | `state`: `IDENTITY`, `INTEREST`, `PROPERTY`, `BILL`, `LOCATION_TIMELINE`, `FINANCE`, `MEETING_PITCH`, `WRAP_UP`, `DONE` | |
| `transcript` | `role`: `agent` / `caller`; `text`; `final`; `id?` | same `id` updates an interim line in place |
| `lead` | `field`; `value` (typed, see below) | wrong value types are rejected |
| `outcome` | `outcome`: `qualified`, `not_qualified`, `callback`, `wrong_number`, `do_not_call`; `reason?`; `callbackAt?` | a later outcome replaces an earlier one |
| `metric` | `replyMs`; `sttMs?`; `llmTtftMs?`; `ttsTtfbMs?` | one per agent reply; replyMs = caller stopped -> agent audio started |
| `system` | `text` | |
| `interrupted` | | caller spoke over the agent and it stopped |
| `guardrail` | `kind`: `price` / `savings` / `subsidy` / `other`; `text?` | agent output blocked for stating a figure |
| `reprompt` | `attempt` | caller went quiet, agent prompted again |
| `handoff` | `reason` | agent handed the call to a person |
| `speaking` | `who`: `agent` / `caller` / `none` | |
| `usage` | `costInr`; `llmTokensIn?`; `llmTokensOut?`; `sttSeconds?`; `ttsCharacters?` | running totals for the call |
| `snapshot` | `state`; `lead`; `outcome?`; `transcript?` | **send whenever a participant joins**, so a console joining mid-call (phone mode) catches up |
| `call_ended` | `reason` | |

Lead values: `identity_confirmed`, `solar_interest`, `roof_access`, `loan_interest`, `subsidy_interest` are booleans. `property_type` is `independent_house` / `housing_society` / `commercial`. `roof_ownership` is `owned` / `rented` / `shared`. `shadow_free_area` is a number in sq ft. `monthly_bill` is integer rupees. `discom`, `city_or_pincode`, `timeline` are strings. `meeting_slot` is `{ label, iso?, location? }`.

**Console -> agent:** the console publishes on topic **`console-commands`**: `{ "type": "handoff_request", "reason": "..." }`. The agent should hand off and reply with a `handoff` event.

**Agent setup notes:** in phone mode the console joins the room listen-only, so the agent must treat only the SIP participant as the caller. `POST /api/end` deletes the room, which disconnects the caller, the agent and the console.

## Safety rules built in

- `/api/call` only dials numbers on `TEST_NUMBER_ALLOWLIST`. An empty list blocks all calls.
- `/api/end` only closes rooms this backend created (`call-xxxxxxxx`).
- No API key ever reaches the browser. The browser gets a room token only.
- Never commit `.env`.

## Not done yet

- Agent worker is built (plan Tasks 1-6) but has not run a full call yet. Still open: STT benchmark (Task 7), scenario evals (Task 8), a real Cartesia Hindi voice id, cost rates, telephony tuning.
- More demo scenarios (interruption, silence, subsidy question, "ask my son", do-not-call) and replay of recorded calls.
