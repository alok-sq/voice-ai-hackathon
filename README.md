# Voice agent console (RMX-241)

Web console and backend for the SolarSquare lead-qualification voice agent. Plan: `docs/superpowers/plans/2026-11-22-voice-agent-lead-qualification.md`.

```
web/      React + Vite + TypeScript console (SolarSquare design system).
server/   FastAPI backend: room tokens, SIP dial-out, ending calls. Holds all secrets.
tests/    Backend tests.
```

## Run the console (demo mode, no keys)

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

Pick **Demo**, choose a scenario and press **Start call**. A scripted Hindi call plays through the same event pipeline as a live call, so the UI behaves identically.

Checks: `npm test` (contract + call-state tests), `npm run typecheck`, `npm run build`.

## Run it live

1. `cp .env.example .env` and fill in the LiveKit keys (and the SIP trunk id for phone calls).
2. Start the backend from the repo root:
   ```bash
   python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
   .venv/bin/uvicorn server.main:app --port 8000
   ```
3. Start the console (`npm run dev` in `web/`). Vite proxies `/api` to `http://localhost:8000` (override with `BACKEND_URL`). The console polls `GET /api/health`; **Live agent** becomes selectable once LiveKit is configured, and the console lists any missing settings by name.

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

- The agent worker (plan Tasks 1-6): live mode needs it to publish the events above.
- More demo scenarios (interruption, silence, subsidy question, "ask my son", do-not-call) and replay of recorded calls.
