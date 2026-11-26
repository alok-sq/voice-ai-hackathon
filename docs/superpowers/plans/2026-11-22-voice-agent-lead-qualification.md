# SolarSquare Voice Agent (Lead Qualification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone-line voice agent that runs the lead-qualification call end to end in one language, returns a structured lead record plus one of five outcomes, and hands off to a human when stuck.

**Architecture:** Cascaded streaming pipeline (telephony -> VAD/turn detection -> streaming STT -> small fast LLM -> streaming TTS with cloned voice) orchestrated by LiveKit Agents. A deterministic state machine owns the call flow and guardrails; the LLM only does language work (slot extraction, side questions, code-mixed phrasing) through tool calls. Pure logic (models, flow, normalisers, guardrails) is built and tested first with no network, so it can be developed before vendor keys arrive.

**Tech Stack:** Python 3.11+, LiveKit Agents (pin the version at setup), pytest, one STT / LLM / TTS vendor each (chosen in Task 7), SIP trunk from the telephony provider.

**Spec:** `/Users/arvindkumarsingh/Desktop/Building Future of Conversation Intelligence.pdf` (sections 3 and "Ground rules")

## Global Constraints

- Outcomes are exactly: `qualified`, `not_qualified`, `callback`, `wrong_number`, `do_not_call`.
- Property type is exactly: `independent_house`, `housing_society`, `commercial`.
- Lead fields to capture: confirmed identity, solar interest, property type, roof ownership, roof access, shadow-free roof area, monthly bill, DISCOM, city or pincode, timeline, loan interest, PM Surya Ghar subsidy interest, meeting slot (location and time).
- The agent states that the call is recorded, near the start of the call.
- The agent stops when asked ("do not call", "stop").
- The agent never promises prices, savings or subsidy amounts.
- No calls to real customers. Test only with team members or test numbers.
- Recordings are used only for the hackathon and never leave the company.
- API keys live only in `.env` (git-ignored). Never in code, Slack or WhatsApp.
- Stay within the team API budget. Log tokens and audio seconds per call.
- Target reply latency under 1 second (stretch ~200ms is only realistic for speech-to-speech).

## Review Focus

- Caller says nothing or goes silent: agent re-prompts twice, then ends with `callback`.
- Caller says "ask my son" / "main nahi, mere bete se baat karo": agent offers a callback instead of continuing, and does not record the wrong person's answers.
- Caller interrupts mid-sentence (barge-in): agent stops speaking within ~300ms and does not repeat itself.
- Caller mixes languages and number words ("bill around 3 hazaar aata hai", "paanch sau"): amounts normalise to integers.
- Caller asks "kitni subsidy milegi?" or "kitna bachega?": agent deflects without stating any figure.
- Caller asks "are you a robot?": agent answers truthfully that it is an AI assistant (see Open Questions).
- Wrong number or "do not call" said late in the call: outcome overrides everything captured so far.

## Open Questions (resolve before Task 6)

1. Team language (Hindi assumed throughout; only Task 3 data and Task 6 prompts change).
2. Telephony: SIP trunk and number supplied by organisers, or self-arranged?
3. Voice clone: whose voice, and written consent from them.
4. Disclosure: the brief rewards a voice indistinguishable from a human but only mandates a recording notice. Confirm with organisers whether the agent must also say it is an AI. The plan assumes it answers truthfully if asked directly.
5. ITT ticket: confirm a valid ITT ticket assigned to you, in an active status, before creating a branch. Put its key in the branch name.

## File Structure

```
voice-agent-hackathon/
  pyproject.toml
  .env.example                 # key names only
  src/agent/
    models.py                  # Lead, Outcome, PropertyType (pure)
    flow.py                    # CallFlow state machine (pure)
    normalise.py               # Hinglish number/yes-no/property parsing (pure)
    guardrails.py              # disclosure, stop detection, claim filter (pure)
    tools.py                   # update_lead / end_call / handoff_to_human
    prompts.py                 # system prompt + per-state instructions
    agent.py                   # LiveKit Agent wiring (STT/LLM/TTS/turn detection)
    metrics.py                 # per-call latency, tokens, audio seconds
  bench/stt_bench.py           # WER over recordings per STT vendor
  evals/
    scenarios/*.yaml           # scripted caller transcripts + expected lead/outcome
    run_evals.py
  tests/
```

---

### Task 1: Lead model and outcomes

**Files:**
- Create: `src/agent/models.py`
- Test: `tests/test_models.py`

**Interfaces:**
- Produces: `class Outcome(str, Enum)` with the five values above; `class PropertyType(str, Enum)`; `@dataclass class Lead` with every field in Global Constraints (all `Optional`, default `None`); `Lead.missing_required() -> list[str]`; `Lead.to_record(outcome: Outcome) -> dict` (JSON-serialisable).

- [ ] **Step 1: Write failing tests** `test_missing_required_lists_unfilled_fields`, `test_to_record_includes_outcome_value` (`record["outcome"] == "callback"`), `test_outcome_rejects_unknown_value` (`Outcome("maybe")` raises `ValueError`).
- [ ] **Step 2: Run** `pytest tests/test_models.py -v`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the types in `src/agent/models.py` as stdlib `dataclass`/`Enum`. Required fields for `qualified`: identity confirmed, interest, property type, bill, DISCOM, city or pincode.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: lead model and outcomes`.

### Task 2: Call flow state machine

**Files:**
- Create: `src/agent/flow.py`
- Test: `tests/test_flow.py`

**Interfaces:**
- Consumes: `Lead`, `Outcome` from Task 1.
- Produces: `class State(str, Enum)` in order `IDENTITY, INTEREST, PROPERTY, BILL, LOCATION_TIMELINE, FINANCE, MEETING_PITCH, WRAP_UP, DONE`; `class CallFlow` with `__init__(self, lead: Lead)`, `current: State`, `next_state(self) -> State` (skips states whose fields are already filled), `finish(self, outcome: Outcome) -> dict`, `silence_strike(self) -> bool` (True after the second consecutive strike), `reset_silence(self) -> None`.

- [ ] **Step 1: Write failing tests** `test_skips_filled_states` (lead with bill and DISCOM jumps past `BILL`), `test_two_silences_triggers_callback`, `test_finish_do_not_call_overrides_captured_fields` (record outcome is `do_not_call` even if lead was fully qualified), `test_next_state_after_done_stays_done`.
- [ ] **Step 2: Run** `pytest tests/test_flow.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** `CallFlow` in `src/agent/flow.py` as a plain class with a table of `State -> required Lead fields`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: call flow state machine`.

### Task 3: Hinglish normalisers

**Files:**
- Create: `src/agent/normalise.py`
- Test: `tests/test_normalise.py`

**Interfaces:**
- Produces: `parse_amount(text: str) -> int | None`; `parse_yes_no(text: str) -> bool | None`; `parse_property_type(text: str) -> PropertyType | None`; `parse_discom(text: str) -> str | None` (canonical name from a fixed list of the target state's DISCOMs, filled in at setup).

- [ ] **Step 1: Write failing tests** with the real phrases: `parse_amount("bill around 3 hazaar aata hai") == 3000`, `parse_amount("paanch sau") == 500`, `parse_amount("dhai hazaar") == 2500`, `parse_amount("3,500 rupaye") == 3500`, `parse_amount("pata nahi") is None`, `parse_yes_no("haan ji") is True`, `parse_yes_no("nahi chahiye") is False`, `parse_yes_no("hmm shayad") is None`, `parse_property_type("society mein flat hai") == PropertyType.housing_society`.
- [ ] **Step 2: Run** `pytest tests/test_normalise.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** with rule-based parsing (number-word table for the team language plus digit regex). No LLM calls here, because these must be deterministic and instant. Add test cases from the real recordings as they are reviewed (Task 7).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: hinglish normalisers`.

### Task 4: Guardrails

**Files:**
- Create: `src/agent/guardrails.py`
- Test: `tests/test_guardrails.py`

**Interfaces:**
- Produces: `DISCLOSURE: str` (recording notice in the team language, spoken within the first agent turn); `is_stop_request(text: str) -> bool`; `contains_forbidden_claim(text: str) -> bool` (True for any agent text stating a price, savings or subsidy figure); `safe_deflection() -> str`.

- [ ] **Step 1: Write failing tests** `test_stop_request_detected` for "mat call karo", "do not call me", "band karo"; `test_normal_no_is_not_stop` for "abhi nahi"; `test_forbidden_claim_blocks_subsidy_amount` for "aapko 78,000 ki subsidy milegi"; `test_forbidden_claim_allows_generic_mention` for "PM Surya Ghar ke baare mein interest hai?".
- [ ] **Step 2: Run** `pytest tests/test_guardrails.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** with keyword and regex rules (currency or digits near subsidy, savings, price words). Keep it strict: a false positive costs one deflection, a false negative breaks a ground rule.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: guardrails`.

### Task 5: Tools

**Files:**
- Create: `src/agent/tools.py`
- Test: `tests/test_tools.py`

**Interfaces:**
- Consumes: `Lead`, `CallFlow`, normalisers.
- Produces: `class CallSession` holding `lead`, `flow`, `result: dict | None`, `handoff_requested: bool`; async tool functions `update_lead(session, field: str, raw_value: str) -> str` (normalises, stores, returns the next instruction or a re-ask hint), `end_call(session, outcome: str) -> str`, `handoff_to_human(session, reason: str) -> str`.

- [ ] **Step 1: Write failing tests** `test_update_lead_normalises_bill` (`raw_value="3 hazaar"` stores `3000`), `test_update_lead_unparseable_returns_reask_hint_and_leaves_field_empty`, `test_end_call_do_not_call_sets_result`, `test_end_call_rejects_invalid_outcome`, `test_handoff_sets_flag`.
- [ ] **Step 2: Run** `pytest tests/test_tools.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the tools in `src/agent/tools.py`; `end_call` writes the final record to `out/{call_id}.json`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: agent tools`.

### Task 6: LiveKit agent assembly

**Files:**
- Create: `src/agent/agent.py`, `src/agent/prompts.py`, `src/agent/metrics.py`, `.env.example`
- Test: `tests/test_prompts.py`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: `build_system_prompt(state: State, lead: Lead) -> str`; `entrypoint(ctx)` LiveKit job entrypoint; `metrics.record_turn(call_id, stt_ms, llm_ttft_ms, tts_ttfb_ms)`.

- [ ] **Step 1: Write failing tests** `test_prompt_includes_forbidden_claims_rule`, `test_prompt_only_mentions_current_state_goal`, `test_prompt_lists_filled_fields_so_agent_does_not_reask`.
- [ ] **Step 2: Run** `pytest tests/test_prompts.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** `prompts.py`, then `agent.py` wiring: streaming STT, the small LLM (direct provider API, not OpenRouter), streaming cloned-voice TTS, LiveKit's turn detector with VAD, barge-in enabled. Speak `DISCLOSURE` first. Route every LLM output through `contains_forbidden_claim`, and replace it with `safe_deflection()` when it trips. Cache the greeting and disclosure audio. Verify current LiveKit Agents API names against its docs when pinning the version.
- [ ] **Step 4: Run** `pytest tests/test_prompts.py -v` (PASS), then smoke test: `python -m agent.agent dev`, join the console room, and complete one scripted call by voice. Expected: a JSON record in `out/` with an outcome.
- [ ] **Step 5: Commit** `feat: livekit voice agent`.

### Task 7: STT benchmark on real recordings

**Files:**
- Create: `bench/stt_bench.py`
- Test: `tests/test_wer.py`

**Interfaces:**
- Produces: `wer(reference: str, hypothesis: str) -> float`; CLI `python bench/stt_bench.py --vendor <name> --audio-dir <dir> --refs <file>` printing WER per file and mean.

- [ ] **Step 1: Write failing tests** `test_wer_identical_is_zero`, `test_wer_one_substitution_in_four_words_is_0_25`.
- [ ] **Step 2: Run** `pytest tests/test_wer.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** `wer` (word-level edit distance) and the CLI. Hand-transcribe 10-15 call snippets as references. Run 2-3 candidate STT vendors on 8kHz audio.
- [ ] **Step 4: Run** the unit tests (PASS), then the benchmark. Pick the vendor with the lowest WER on key slots (numbers, DISCOM, city), not on total WER. Record the choice in `docs/decisions.md`.
- [ ] **Step 5: Commit** `feat: stt benchmark`.

### Task 8: Scenario eval harness

**Files:**
- Create: `evals/run_evals.py`, `evals/scenarios/*.yaml`
- Test: `tests/test_eval_runner.py`

**Interfaces:**
- Consumes: `CallSession`, tools, `build_system_prompt`.
- Produces: scenario schema `{id, caller_turns: [str], expected_outcome, expected_lead: {field: value}}`; `run_scenario(path) -> ScenarioResult(passed: bool, diffs: list[str])`; CLI prints pass rate and exits non-zero below 100%.

- [ ] **Step 1: Write failing tests** `test_runner_passes_matching_scenario` and `test_runner_reports_field_diff_on_mismatch`, using a stub LLM.
- [ ] **Step 2: Run** `pytest tests/test_eval_runner.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** the runner (text-only, real LLM, no audio). Write scenarios for every Review Focus line plus a happy path, a not-qualified path, a callback, a wrong number, and a do-not-call.
- [ ] **Step 4: Run** `python evals/run_evals.py`. Expected: all scenarios pass. Fix prompts or logic until they do.
- [ ] **Step 5: Commit** `feat: scenario evals`.

### Task 9: Telephony and latency pass

**Files:**
- Modify: `src/agent/agent.py`, `src/agent/metrics.py`
- Test: `tests/test_metrics.py`

**Interfaces:**
- Produces: `metrics.summary(call_id) -> {p50_ms, p95_ms, tokens, audio_seconds, est_cost}`.

- [ ] **Step 1: Write failing tests** `test_summary_percentiles` (known turn latencies give known p50 and p95) and `test_summary_cost_uses_configured_rates`.
- [ ] **Step 2: Run** `pytest tests/test_metrics.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement** `summary`. Connect the SIP trunk to LiveKit and place a call from a team phone. Add short backchannels and pre-rendered fillers. Tune the end-of-turn threshold from the measured p95.
- [ ] **Step 4: Run** unit tests (PASS), then 5 real calls from team phones (one from a noisy place). Expected: p50 under 1000ms, a record written per call, est cost printed.
- [ ] **Step 5: Commit** `feat: telephony and latency tuning`.

### Task 10: Demo readiness

**Files:**
- Create: `docs/demo.md`

- [ ] **Step 1:** Write the demo script: three calls (happy path, noisy and interrupting, hand-off to human) and the fallback (a pre-recorded call plus the transcript) if the line fails.
- [ ] **Step 2:** Rehearse twice end to end on the real number. Expected: both runs produce correct records.
- [ ] **Step 3:** Prepare a one-page cost and latency summary from `metrics.summary`, since judging includes cost per call.
- [ ] **Step 4: Commit** `docs: demo script`.

---

## Timeline (24 hours)

| Hours | Tasks |
|---|---|
| Before kickoff | Open Questions, Tasks 1-5 (pure logic needs no keys) |
| 0-4 | Task 6 smoke, telephony echo test |
| 4-10 | Task 7, Task 8 |
| 10-18 | Task 9 |
| 18-22 | Fix eval failures, second flow (appointment confirmation) only if everything is green |
| 22-24 | Task 10 |

## Self-Review

- **Spec coverage:** the lead fields, five outcomes, recording notice, stop-on-request, no-price-promises, handover, noisy and interrupting callers, cost and latency reporting each map to Tasks 1-9. Appointment confirmation, follow-ups, service scheduling and rating collection are not covered (single flow, by decision).
- **Type consistency:** `Lead`, `Outcome`, `CallFlow`, `CallSession` and the tool names are used identically across tasks.
- **Weak spots:** the DISCOM list and number-word table need real data at setup, and the LiveKit API names should be verified when the version is pinned.
