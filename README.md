# Voice agent console (RMX-241)

Web console and backend for the SolarSquare lead-qualification voice agent. Plan: `docs/superpowers/plans/2026-11-22-voice-agent-lead-qualification.md`.

```
web/      Static console (SolarSquare design system). No build step.
server/   FastAPI backend: room tokens and SIP dial-out. Holds all secrets.
tests/    Backend tests.
```

## Run the console in demo mode (no keys)

```bash
cd web && python3 -m http.server 8080      # open http://localhost:8080
```

Press **Start call**. A scripted Hindi lead-qualification call plays through the UI so you can see the transcript, progress steps, lead record and outcome.

## Run it live

1. `cp .env.example .env` and fill in the LiveKit keys (and the SIP trunk id for phone calls).
2. Start the backend from the repo root:
   ```bash
   python3 -m venv .venv && .venv/bin/pip install -r server/requirements.txt
   .venv/bin/uvicorn server.main:app --port 8000
   ```
3. Set `backendUrl: "http://localhost:8000"` in `web/config.js`. The chip in the header switches from **Demo mode** to **Live**.
4. Check `GET /api/health`: it lists which settings are still missing (names only).

## Event contract (the agent must publish these)

The agent publishes JSON on LiveKit data topic `call-events`. The demo simulator emits the same shapes, so the UI is identical in both modes.

| type | fields |
|---|---|
| `state` | `state`: `IDENTITY`, `INTEREST`, `PROPERTY`, `BILL`, `LOCATION_TIMELINE`, `FINANCE`, `MEETING_PITCH`, `WRAP_UP`, `DONE` |
| `transcript` | `role`: `agent` or `caller`; `text`; `final` (bool); `id` (same id updates an interim line) |
| `lead` | `field` (see below); `value` |
| `outcome` | `outcome`: `qualified`, `not_qualified`, `callback`, `wrong_number`, `do_not_call` |
| `metric` | `replyMs`: time from caller stopping to agent audio starting |
| `system` | `text` |

Lead fields: `identity_confirmed`, `solar_interest`, `property_type`, `roof_ownership`, `roof_access`, `shadow_free_area`, `monthly_bill`, `discom`, `city_or_pincode`, `timeline`, `loan_interest`, `subsidy_interest`, `meeting_slot`.

## Safety rules built in

- `/api/call` only dials numbers on `TEST_NUMBER_ALLOWLIST`. An empty list blocks all calls.
- No API key ever reaches the browser. The browser gets a room token only. Its lifetime is the LiveKit default; shorten it with the SDK's TTL option once `livekit-api` is installed and pinned.
- Never commit `.env`.

## Not done yet

- The agent worker (plan Tasks 1-6): the console shows the demo until it exists and publishes events.
- The LiveKit API names in `server/main.py` and the `livekit-client` version in `web/config.js` should be checked against the versions you pin.
- Human handoff: the button logs a request in the UI. Wire it to the agent's `handoff_to_human` once that exists.
