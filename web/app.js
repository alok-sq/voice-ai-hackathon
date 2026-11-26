/* Voice agent console.
 *
 * Both the demo simulator and the live LiveKit connection emit the same event
 * shapes, so the UI never knows which one it is talking to:
 *
 *   {type:"state",      state:"IDENTITY"|...|"DONE"}
 *   {type:"transcript", role:"agent"|"caller", text, final:bool, id}
 *   {type:"lead",       field, value}
 *   {type:"outcome",    outcome:"qualified"|"not_qualified"|"callback"|"wrong_number"|"do_not_call", reason?}
 *   {type:"metric",     replyMs}
 *   {type:"system",     text, level?:"info"|"warn"|"error"}
 *
 * Everything the right-hand panel shows (status, signals, next action, journey)
 * is derived from these events only. Nothing is invented.
 */
(function () {
  "use strict";
  const CFG = window.VOICE_CONSOLE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const LIVE = !!CFG.backendUrl;
  const BASE = LIVE ? CFG.backendUrl.replace(/\/$/, "") : "";
  const TARGET_MS = 1000;
  const LANGS = { hi: "Hindi", mr: "Marathi", ta: "Tamil", kn: "Kannada", en: "English" };

  /* ---------- Domain ---------- */
  const STATES = [
    ["IDENTITY", "Identity", ["identity_confirmed"]],
    ["INTEREST", "Interest", ["solar_interest"]],
    ["PROPERTY", "Property", ["property_type", "roof_ownership", "roof_access", "shadow_free_area"]],
    ["BILL", "Bill", ["monthly_bill", "discom"]],
    ["LOCATION_TIMELINE", "Location", ["city_or_pincode", "timeline"]],
    ["FINANCE", "Finance", ["loan_interest", "subsidy_interest"]],
    ["MEETING_PITCH", "Meeting", ["meeting_slot"]],
    ["WRAP_UP", "Wrap-up", []]
  ];
  const GROUPS = [
    ["Caller", [["identity_confirmed", "Identity confirmed"], ["solar_interest", "Interested in solar"]]],
    ["Property", [["property_type", "Property type"], ["roof_ownership", "Roof ownership"], ["roof_access", "Roof access"], ["shadow_free_area", "Shadow-free area"]]],
    ["Energy", [["monthly_bill", "Monthly bill"], ["discom", "DISCOM"]]],
    ["Location and timing", [["city_or_pincode", "City or pincode"], ["timeline", "Timeline"]]],
    ["Finance", [["loan_interest", "Loan"], ["subsidy_interest", "PM Surya Ghar subsidy"]]],
    ["Meeting", [["meeting_slot", "Preferred slot"]]]
  ];
  const LABEL = Object.fromEntries(GROUPS.flatMap((g) => g[1]));
  const SHORT = { identity_confirmed: "Identity", solar_interest: "Interest", property_type: "Type", roof_ownership: "Ownership", roof_access: "Access", shadow_free_area: "Area", monthly_bill: "Bill", discom: "DISCOM", city_or_pincode: "City", timeline: "Timeline", loan_interest: "Loan", subsidy_interest: "Subsidy", meeting_slot: "Slot" };
  const FIELDS = new Set(Object.keys(LABEL));
  const TILES = [["monthly_bill", "Monthly bill", true], ["shadow_free_area", "Roof area", false], ["city_or_pincode", "Location", false], ["timeline", "Timeline", false]];
  const OUTCOME_NAME = { qualified: "Qualified", not_qualified: "Not qualified", callback: "Callback", wrong_number: "Wrong number", do_not_call: "Do not call" };
  // Outcome -> lead status shown to sales.
  const VERDICT = {
    qualified:     { q: "good",   label: "Qualified",     desc: "The agent marked this lead qualified.",        icon: "badge-check" },
    callback:      { q: "review", label: "Needs review",  desc: "The customer asked for a callback.",           icon: "clock" },
    wrong_number:  { q: "review", label: "Needs review",  desc: "Wrong number. This isn't the lead.",           icon: "phone-missed" },
    not_qualified: { q: "bad",    label: "Not qualified", desc: "Doesn't meet the rooftop criteria.",           icon: "circle-minus" },
    do_not_call:   { q: "bad",    label: "Not qualified", desc: "The customer asked not to be called again.",   icon: "ban" }
  };
  const ACTIVE = new Set(["connecting", "live", "reconnecting"]);

  const store = {
    mode: "browser", callState: "idle", callSeq: 0, session: null,
    lead: {}, outcome: null, outcomeReason: "", flow: null, replies: [], transcript: [],
    startedAt: 0, endedAt: 0, timer: null, endReason: "", endcard: null,
    agent: "off", agentTimer: null, lastTurn: null, latest: null,
    muted: false, handoff: "idle", handoffTimer: null, stick: true, stepStates: [], verdictLabel: "", dialled: ""
  };

  /* ---------- Helpers ---------- */
  function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.75 } }); }
  function setIcon(parent, name) {
    const old = parent.querySelector(":scope > svg, :scope > i");
    const n = document.createElement("i"); n.setAttribute("data-lucide", name);
    if (old) old.replaceWith(n); else parent.prepend(n);
  }
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function iconEl(name, cls) { const i = el("i", cls); i.setAttribute("data-lucide", name); return i; }
  function orbEl(size, icon) { const o = el("span", `orb orb--${size}`); const c = el("span", "orb__core"); if (icon) c.appendChild(iconEl("sparkles")); o.appendChild(c); return o; }
  function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
  function elapsed() { return store.startedAt ? (store.endedAt || Date.now()) - store.startedAt : 0; }
  function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
  function has(k) { const v = store.lead[k]; return v !== undefined && v !== null && v !== ""; }
  function captured() { return [...FIELDS].filter(has).length; }
  function fmt(k, v) {
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (k === "monthly_bill" && v !== "" && !isNaN(Number(v))) return "₹" + Number(v).toLocaleString("en-IN");
    if (k === "property_type") return String(v).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    return String(v);
  }
  function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function flash(node) { if (!node) return; node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash"); }

  function toast(text, kind = "info", ms = 5000) {
    const t = el("div", `toast toast--${kind}`);
    t.setAttribute("role", kind === "error" ? "alert" : "status");
    const close = el("button", "toast__close"); close.type = "button"; close.setAttribute("aria-label", "Dismiss"); close.appendChild(iconEl("x"));
    t.append(iconEl(kind === "error" ? "circle-alert" : kind === "success" ? "circle-check" : "info"), el("span", null, text), close);
    const kill = () => t.remove();
    close.addEventListener("click", kill);
    $("toasts").appendChild(t); icons();
    if (ms) setTimeout(kill, ms);
  }

  function friendlyError(err) {
    const name = err && err.name, msg = (err && err.message) || "";
    if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it in your browser's site settings, then try again.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Plug one in or switch to a phone call.";
    if (name === "TypeError" && /fetch|network|load failed/i.test(msg)) return `Couldn't reach the backend at ${BASE}. Check it's running.`;
    if (name === "AbortError") return "The backend took too long to respond. Try again.";
    return msg || "Couldn't start the call. Try again.";
  }

  async function api(path, body, timeoutMs = 10000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(BASE + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal } : { signal: ctl.signal });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || `The backend returned an error (${r.status}).`);
      return data;
    } finally { clearTimeout(t); }
  }

  /* ---------- Call status + agent voice state ---------- */
  function setConn(tone, text) { $("conn").dataset.tone = tone; $("conn-text").textContent = text; }

  const AGENT = {
    off:        { text: "Offline" },
    joining:    { text: "Joining the call" },
    listening:  { text: "Listening",               live: "Listening" },
    caller:     { text: "Listening",               live: "Customer speaking" },
    speaking:   { text: "Speaking",                live: "Speaking" },
    processing: { text: "Processing",              live: "Processing" },
    done:       { text: "Call finished" }
  };
  function setAgent(s, holdMs) {
    clearTimeout(store.agentTimer);
    store.agent = s;
    $("app").dataset.agent = s;
    $("agent-text").textContent = AGENT[s].text;
    const live = $("live"); live.hidden = !AGENT[s].live; $("live-text").textContent = AGENT[s].live || "";
    showPending(s === "processing");
    document.querySelectorAll(".turn.is-speaking").forEach((n) => n.classList.remove("is-speaking"));
    if (s === "speaking" && store.latest?.classList.contains("turn--agent")) store.latest.classList.add("is-speaking");
    if (holdMs) store.agentTimer = setTimeout(() => ACTIVE.has(store.callState) && setAgent("listening"), holdMs);
  }
  // Roughly how long the agent's line takes to say, so "Speaking" doesn't stick.
  function speakMs(text) { return Math.min(6000, Math.max(1200, String(text).length * 55)); }

  function setStatus(state, text) {
    store.callState = state;
    $("app").dataset.call = state;
    $("status").dataset.state = state;
    $("status-text").textContent = text;
    const active = ACTIVE.has(state);
    const btn = $("call-btn");
    btn.dataset.live = active ? "true" : "false";
    btn.setAttribute("aria-busy", state === "connecting");
    $("call-btn-label").textContent = state === "connecting" ? "Cancel" : active ? "End call" : store.callSeq ? "Start new call" : "Start call";
    setIcon(btn, state === "connecting" ? "loader-circle" : active ? "phone-off" : "phone");
    $("mute-btn").disabled = state !== "live" || store.mode === "phone";
    setHandoffUI();
    ["language", "phone"].forEach((id) => ($(id).disabled = active));
    document.querySelectorAll(".seg__btn").forEach((b) => (b.disabled = active));
    ({
      idle: () => setConn("off", "Not connected"),
      connecting: () => setConn("warn", store.mode === "phone" ? "Connecting to the customer…" : "Connecting to the agent…"),
      live: () => setConn("good", LIVE ? "Connected" : "Connected · demo call"),
      reconnecting: () => setConn("warn", "Reconnecting…"),
      ended: () => setConn("off", "Disconnected"),
      error: () => setConn("bad", "Connection failed")
    })[state]?.();
    if (state === "connecting") setAgent("joining");
    else if (state === "ended") setAgent("done");
    else if (!active) setAgent("off");
    document.title = (state === "live" ? "● " : "") + "Voice agent console · SolarSquare";
    renderIntel();
    icons();
  }

  /* ---------- Qualification journey ---------- */
  function flowIndex() {
    const idx = STATES.findIndex((s) => s[0] === store.flow);
    // Before the agent reports a state, a live call is in the identity step.
    return idx < 0 && store.flow !== "DONE" && ACTIVE.has(store.callState) && store.callState !== "connecting" ? 0 : idx;
  }
  function identityProblem() { return store.outcome === "wrong_number" || store.lead.identity_confirmed === false; }
  function stepStates() {
    const idx = flowIndex();
    const done = store.flow === "DONE";
    const ended = !ACTIVE.has(store.callState);
    return STATES.map(([, , fields], i) => {
      const missing = fields.filter((f) => !has(f)).length;
      const bad = i === 0 && identityProblem();
      if (done || i < idx || (ended && i === idx)) return missing || bad ? "attn" : "done";
      if (bad) return "attn";
      if (i === idx) return store.handoff === "done" ? "attn" : "current";
      return "pending";
    });
  }

  function renderProgress() {
    const states = stepStates();
    const idx = flowIndex();
    const prev = store.stepStates;
    const list = $("stepper"); list.textContent = "";
    STATES.forEach(([, name, fields], i) => {
      const st = states[i];
      const li = el("li", `jstep is-${st}` + (prev[i] && prev[i] !== st && st !== "pending" ? " is-new" : ""));
      if (st === "current") li.setAttribute("aria-current", "step");
      const node = el("span", "jnode");
      if (st === "done") node.appendChild(iconEl("check"));
      if (st === "attn") node.appendChild(el("b", null, "!"));
      const got = fields.filter(has).length;
      let meta = st === "pending" ? "" : fields.length ? `${got}/${fields.length}` : st === "current" ? "Now" : "";
      if (i === 0 && st !== "pending") meta = identity().short;
      const label = el("span", "jlabel", name);
      label.title = { done: "Completed", current: "In progress", pending: "Pending", attn: "Needs attention" }[st];
      li.append(node, label, el("span", "jmeta", meta));
      if (st === "current" && fields.length && i > 0) {
        const fs = el("div", "jfields");
        fields.forEach((f) => { const c = el("span", "jfield" + (has(f) ? " is-got" : "")); c.append(iconEl(has(f) ? "check" : "circle-dashed"), el("span", null, SHORT[f])); fs.appendChild(c); });
        li.appendChild(fs);
      }
      if (st === "attn" && i > 0) {
        const miss = fields.filter((f) => !has(f)).map((f) => LABEL[f]);
        li.appendChild(el("span", "jmissing", miss.length ? "Missing: " + miss.join(", ") : "Handoff requested during this step"));
      }
      list.appendChild(li);
    });
    store.stepStates = states;
    $("prog-count").textContent = `${states.filter((s) => s === "done" || s === "attn").length}/${STATES.length}`;

    $("segbar").innerHTML = states.map((s) => `<span class="is-${s}"></span>`).join("");
    const lbl = $("state-label");
    if (store.flow === "DONE") lbl.innerHTML = "<b>All steps complete</b>";
    else if (idx >= 0) lbl.innerHTML = `Step ${idx + 1} of ${STATES.length} · <b>${STATES[idx][1]}</b>`;
    else lbl.textContent = ACTIVE.has(store.callState) ? "Starting" : store.callState === "ended" ? "Call ended" : "No active call";
  }

  /* ---------- Lead intelligence ---------- */
  function verdict() {
    if (store.outcome) {
      const base = VERDICT[store.outcome] || { q: "review", label: "Needs review", desc: "Outcome: " + store.outcome, icon: "flag" };
      return { ...base, desc: store.outcomeReason || base.desc };
    }
    if (ACTIVE.has(store.callState)) {
      const idx = flowIndex();
      return { q: "live", label: "Qualifying", icon: "loader-circle", desc: idx >= 0 ? `${STATES[idx][1]} step · ${captured()} of ${FIELDS.size} fields captured` : "Connecting to the call." };
    }
    if (store.callState === "ended") return { q: "review", label: "Needs review", icon: "circle-help", desc: "Call ended before qualification was completed." };
    if (store.callState === "error") return { q: "idle", label: "Not started", icon: "phone-off", desc: "The call didn't connect. Nothing was recorded." };
    return { q: "idle", label: "Awaiting call", icon: "circle-dashed", desc: "Ready to start a call." };
  }

  function renderVerdict() {
    const sec = $("qual"), v = verdict();
    if (store.verdictLabel !== v.label + v.q) {
      setIcon(sec.querySelector(".verdict__icon"), v.icon);
      const box = sec.querySelector(".verdict"); box.classList.remove("is-changed"); void box.offsetWidth; box.classList.add("is-changed");
      store.verdictLabel = v.label + v.q;
    }
    sec.dataset.q = v.q; $("q-label").textContent = v.label; $("q-desc").textContent = v.desc;
    $("q-fields").textContent = captured();
    const p50 = median(store.replies);
    $("q-p50").innerHTML = p50 == null ? "—" : `${p50.toLocaleString("en-IN")}<small>ms</small>`;
  }

  function renderNext() {
    const missing = [...FIELDS].filter((f) => !has(f));
    const slot = has("meeting_slot") ? fmt("meeting_slot", store.lead.meeting_slot) : "";
    const city = has("city_or_pincode") ? String(store.lead.city_or_pincode) : "";
    const pending = { tone: "idle", icon: "arrow-right", title: "Complete qualification to determine next action" };
    let n;
    if (store.handoff === "done" && ACTIVE.has(store.callState)) n = { tone: "review", icon: "user-round-check", title: "Take over the call", desc: "A handoff was requested. A team member should join now." };
    else if (store.outcome === "qualified") n = slot ? { tone: "good", icon: "calendar-check", title: "Schedule site survey", desc: [slot, city].filter(Boolean).join(" · ") }
                                                      : { tone: "good", icon: "calendar-plus", title: "Book a site survey", desc: "Qualified, but no survey slot was agreed." + (city ? ` · ${city}` : "") };
    else if (store.outcome === "callback") n = { tone: "review", icon: "phone-forwarded", title: "Schedule a callback", desc: slot ? `Customer suggested ${slot}` : "The customer asked to talk later." };
    else if (store.outcome === "wrong_number") n = { tone: "review", icon: "phone-missed", title: "Verify the lead's number", desc: "The person who answered isn't this lead." };
    else if (store.outcome === "not_qualified") n = { tone: "bad", icon: "archive", title: "Close the lead", desc: "No sales follow-up needed." };
    else if (store.outcome === "do_not_call") n = { tone: "bad", icon: "ban", title: "Don't call this number again", desc: "Add it to the do-not-call list." };
    else if (ACTIVE.has(store.callState)) n = { ...pending, tone: "live", desc: missing.length ? `${missing.length} fields left · ${missing.slice(0, 3).map((f) => LABEL[f]).join(", ")}${missing.length > 3 ? "…" : ""}` : "All fields captured. Waiting for the agent's outcome." };
    else if (store.callState === "ended") n = { tone: "review", icon: "headphones", title: "Review the call manually", desc: "No outcome was set. Check the transcript before updating the lead." };
    else if (store.callState === "error") n = { ...pending, desc: "The last call didn't connect. Check the backend status, then try again." };
    else n = { ...pending, desc: "Start a call to begin." };
    const sec = $("next");
    if (sec.dataset.icon !== n.icon) { setIcon(sec.querySelector(".next__icon"), n.icon); sec.dataset.icon = n.icon; }
    sec.dataset.tone = n.tone; $("next-title").textContent = n.title; $("next-desc").textContent = n.desc;
  }

  /* Identity — only what the events tell us: lead.identity_confirmed (bool) and the
     wrong_number outcome. The contract carries no customer name or lead ID. */
  function identity() {
    const v = store.lead.identity_confirmed;
    if (store.outcome === "wrong_number") return { id: "wrong", label: "Wrong number", short: "Wrong no.", icon: "phone-missed", desc: "The person who answered isn't this lead." };
    if (v === true) return { id: "confirmed", label: "Identity confirmed", short: "Confirmed", icon: "check", desc: "The customer confirmed they're the lead." };
    if (v === false) return { id: "unconfirmed", label: "Identity not confirmed", short: "Not confirmed", icon: "minus", desc: "The person who answered didn't confirm they're the lead." };
    if (ACTIVE.has(store.callState)) {
      const idx = flowIndex();
      return idx <= 0 ? { id: "verifying", label: "Verifying identity", short: "Verifying", icon: "", desc: "The agent is confirming it's speaking with the right person." }
                      : { id: "needs", label: "Identity needs confirmation", short: "Unconfirmed", icon: "circle-help", desc: "The call moved on before identity was confirmed." };
    }
    if (store.callState === "ended") return { id: "needs", label: "Identity not established", short: "Unconfirmed", icon: "circle-help", desc: "The call ended before identity was confirmed." };
    return { id: "unknown", label: "Identity not established", short: "", icon: "", desc: "Confirmed by the agent in the first step of the call." };
  }
  function maskPhone(p) {
    const d = String(p).replace(/\D/g, ""), local = d.slice(-10);
    if (local.length < 10) return p;
    const cc = d.length > 10 ? "+" + d.slice(0, d.length - 10) + " " : "";
    return `${cc}${local.slice(0, 2)}•••• ••${local.slice(-3)}`;
  }
  function renderIdentity() {
    const sec = $("identity"), s = identity();
    if (sec.dataset.id !== s.id) {
      sec.dataset.id = s.id;
      const badge = sec.querySelector(".idblock__badge"); badge.textContent = "";
      if (s.icon) badge.appendChild(iconEl(s.icon));
    }
    $("id-status").textContent = s.label; $("id-desc").textContent = s.desc;
    const started = store.callSeq > 0 && store.callState !== "idle";
    const showPhone = !!store.dialled && started;
    $("id-contact").hidden = !started;
    $("id-contact-v").textContent = showPhone ? maskPhone(store.dialled) : "Browser";
    $("id-contact-v").classList.toggle("mono", showPhone);
    $("id-contact-k").textContent = showPhone ? "Test number" : "Connected via";
  }

  function renderSignals(changed) {
    const tiles = $("tiles"); tiles.textContent = "";
    TILES.forEach(([k, label, num]) => {
      const t = el("div", "tile"); t.dataset.field = k;
      const ok = has(k);
      const v = el("div", "tile__v" + (ok ? (num ? " is-num" : "") : " is-empty"), ok ? fmt(k, store.lead[k]) : "Not captured");
      if (ok) v.title = v.textContent;
      t.append(el("div", "tile__k", label), v); tiles.appendChild(t);
      if (k === changed) flash(t);
    });

    const L = store.lead, sigs = [];
    const yn = (k, yes, no, icon) => { if (typeof L[k] === "boolean") sigs.push([L[k] ? yes : no, icon, !L[k]]); };
    yn("solar_interest", "Interested in solar", "Not interested", "sun");
    if (has("property_type")) sigs.push([fmt("property_type", L.property_type), "building-2", false]);
    if (has("roof_ownership")) { const own = /own/i.test(String(L.roof_ownership)) && !/not|rent/i.test(String(L.roof_ownership)); sigs.push([own ? "Owns the roof" : `Roof: ${L.roof_ownership}`, "key-round", !own]); }
    yn("roof_access", "Roof access", "No roof access", "arrow-up-to-line");
    if (has("discom")) sigs.push([L.discom, "zap", false]);
    yn("subsidy_interest", "Wants subsidy info", "No subsidy interest", "landmark");
    yn("loan_interest", "Wants a loan", "No loan needed", "wallet");
    $("signals").textContent = "";
    sigs.forEach(([text, icon, neg]) => { const s = el("li", "sig" + (neg ? " sig--neg" : "")); s.append(iconEl(icon), el("span", null, text)); $("signals").appendChild(s); });
  }

  function renderLead(changed) {
    const box = $("lead-groups"); box.textContent = "";
    GROUPS.forEach(([title, rows]) => {
      const g = el("div", "group"); g.appendChild(el("h3", "group__title", title));
      rows.forEach(([k, label]) => {
        const ok = has(k);
        const r = el("div", "row"); r.dataset.field = k;
        const v = el("span", "row__v" + (ok ? "" : " is-empty"), ok ? fmt(k, store.lead[k]) : "—");
        if (!ok) v.setAttribute("aria-label", "Not captured");
        r.append(el("span", "row__k", label), v); g.appendChild(r);
        if (k === changed) flash(r);
      });
      box.appendChild(g);
    });
  }

  function renderIntel(changed) {
    renderVerdict(); renderIdentity(); renderSignals(changed); renderNext(); renderProgress(); renderLead(changed); renderEndcard();
    const any = store.outcome || Object.keys(store.lead).length;
    $("copy-json").disabled = !any; $("dl-json").disabled = !any;
    icons();
  }

  function renderMetrics() {
    const r = store.replies, last = r.length ? r[r.length - 1] : null, p50 = median(r);
    const ms = (v) => (v == null ? "—" : `${v.toLocaleString("en-IN")}<small>ms</small>`);
    $("m-turns").textContent = r.length;
    $("m-last").innerHTML = ms(last); $("m-last").dataset.tone = last >= TARGET_MS ? "slow" : "";
    $("m-p50").innerHTML = ms(p50); $("m-p50").dataset.tone = p50 >= TARGET_MS ? "slow" : "";
    const pts = r.slice(-24), W = 260, H = 32, max = Math.max(TARGET_MS * 1.25, ...pts) * 1.05;
    const y = (v) => (H - 2 - (v / max) * (H - 4)).toFixed(1);
    const x = (i) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W).toFixed(1);
    $("spark-target").setAttribute("y1", y(TARGET_MS)); $("spark-target").setAttribute("y2", y(TARGET_MS));
    $("spark-line").setAttribute("points", pts.map((v, i) => `${x(i)},${y(v)}`).join(" "));
    $("spark-dots").innerHTML = pts.map((v, i) => `<circle r="2.25" cx="${x(i)}" cy="${y(v)}" class="${v >= TARGET_MS ? "is-slow" : ""}"><title>${v} ms</title></circle>`).join("");
    $("spark").style.display = pts.length ? "" : "none";
  }

  /* ---------- Transcript ---------- */
  const logEl = () => $("log");
  let pendingEl = null;
  function nearBottom() { const l = logEl(); return l.scrollHeight - l.scrollTop - l.clientHeight < 96; }
  function scrollToEnd() { const l = logEl(); l.scrollTop = l.scrollHeight; $("jump").hidden = true; store.stick = true; }
  function append(node) {
    const stick = store.stick || nearBottom();
    $("empty")?.remove();
    if (pendingEl && pendingEl.isConnected) logEl().insertBefore(node, pendingEl); else logEl().appendChild(node);
    if (stick) scrollToEnd(); else $("jump").hidden = false;
    icons();
  }
  function showPending(on) {
    if (on) {
      if (!pendingEl) {
        pendingEl = el("div", "pending");
        const t = el("span", "pending__text"); t.appendChild(el("span", "shimmer", "AI is preparing a response"));
        pendingEl.append(orbEl("sm", true), t);
      }
      if (!pendingEl.isConnected && !$("empty")) { const stick = store.stick || nearBottom(); logEl().appendChild(pendingEl); icons(); if (stick) scrollToEnd(); }
    } else pendingEl?.remove();
  }

  // Empty states. `visual` is "orb" (uses the live agent state) or a Lucide icon name.
  function setEmpty(visual, title, text, opts = {}) {
    pendingEl?.remove();
    logEl().textContent = "";
    const e = el("div", "empty"); e.id = "empty"; if (opts.tone) e.dataset.tone = opts.tone;
    if (visual === "orb") { const o = orbEl("lg", true); o.classList.add("orb--status"); e.appendChild(o); }
    else { const ic = el("span", "empty__icon"); ic.appendChild(iconEl(visual)); e.appendChild(ic); }
    e.append(el("p", "empty__title", title), el("p", "empty__text", text));
    if (opts.flow) { const f = el("div", "empty__flow"); STATES.forEach((s) => f.appendChild(el("span", null, s[1]))); e.appendChild(f); }
    if (opts.hint) { const h = el("p", "empty__hint"); h.innerHTML = `Press <kbd>${modKey()}</kbd> <kbd>Enter</kbd> to start`; e.appendChild(h); }
    logEl().appendChild(e); icons();
  }
  function idleEmpty() { setEmpty("orb", "Ready to start a call", "The agent qualifies the lead in eight steps. The conversation streams here live.", { flow: true, hint: true }); }

  function addTranscript(e) {
    if (!e.text) return;
    const role = e.role === "agent" ? "agent" : "caller";
    const id = e.id || "m" + store.transcript.length;
    let item = store.transcript.find((m) => m.id === id);
    let node = e.id ? logEl().querySelector(`[data-msg="${CSS.escape(e.id)}"]`) : null;
    if (!item) { item = { id, role, t: elapsed() }; store.transcript.push(item); }
    item.text = e.text; item.final = e.final !== false;
    if (!node) {
      node = el("div", `turn turn--${role}`);
      node.dataset.msg = id;
      if (store.lastTurn === role) node.classList.add("is-cont");
      let av;
      if (role === "agent") { av = orbEl("sm", true); av.classList.add("turn__avatar"); }
      else { av = el("span", "turn__avatar"); av.appendChild(iconEl("user-round")); }
      const head = el("div", "turn__head");
      head.append(el("span", "turn__who", role === "agent" ? "AI agent" : "Customer"), el("span", "turn__time", clock(item.t)));
      node.append(av, head, el("p", "turn__text", e.text));
      store.lastTurn = role;
      store.latest?.classList.remove("is-latest");
      node.classList.add("is-latest"); store.latest = node;
      append(node);
    } else {
      const stick = store.stick || nearBottom();
      node.querySelector(".turn__text").textContent = e.text;
      if (stick) scrollToEnd();
    }
    node.classList.toggle("is-interim", !item.final);
    if (ACTIVE.has(store.callState)) {
      if (role === "agent") setAgent("speaking", item.final ? speakMs(e.text) : 0);
      else if (!item.final) setAgent("caller");
      else setAgent("processing", 8000);
    }
    updateCounts();
  }

  function addSystem(text, level = "info") {
    const d = el("div", `sysline sysline--${level}`);
    const inner = el("span", "sysline__in");
    inner.append(iconEl(level === "error" ? "circle-alert" : level === "warn" ? "triangle-alert" : "info"), el("span", null, text));
    if (store.startedAt) inner.appendChild(el("span", "sysline__t", clock(elapsed())));
    d.appendChild(inner);
    store.transcript.push({ id: "sys" + store.transcript.length, role: "system", text, t: elapsed(), final: true });
    store.lastTurn = null;
    append(d);
  }

  // Summary card at the end of the transcript. Rebuilt if the outcome arrives after the call ends.
  function renderEndcard() {
    const card = store.endcard; if (!card) return;
    const v = verdict();
    card.dataset.q = v.q; card.textContent = "";
    const top = el("div", "endcard__top");
    const ic = el("span", "endcard__icon"); ic.appendChild(iconEl(store.outcome ? (v.q === "good" ? "check" : v.icon) : "phone-off"));
    const tx = el("div"); tx.append(el("p", "endcard__title", "Call ended"), el("p", "endcard__reason", store.endReason));
    top.append(ic, tx);
    const stats = el("dl", "endcard__stats");
    const p50 = median(store.replies);
    [["Duration", clock(elapsed())], ["Fields", `${captured()}/${FIELDS.size}`], ["Median reply", p50 == null ? "—" : `${p50} ms`], ["Outcome", store.outcome ? OUTCOME_NAME[store.outcome] || store.outcome : "Not set"]]
      .forEach(([k, val]) => { const d = el("div"); d.append(el("dt", null, k), el("dd", "mono", val)); stats.appendChild(d); });
    stats.lastChild.lastChild.classList.remove("mono");
    card.append(top, stats);
  }
  function addEndcard(reason) {
    store.endReason = reason;
    store.transcript.push({ id: "sys" + store.transcript.length, role: "system", text: reason, t: elapsed(), final: true });
    store.lastTurn = null;
    store.endcard = el("div", "endcard");
    store.endcard.setAttribute("aria-label", "Call summary");
    renderEndcard();
    append(store.endcard);
  }

  function updateCounts() {
    const n = store.transcript.filter((m) => m.role !== "system").length;
    $("msg-count").textContent = n === 1 ? "1 message" : `${n} messages`;
    $("dl-transcript").disabled = n === 0;
  }

  /* ---------- Event handling ---------- */
  function handle(e) {
    if (!e || typeof e !== "object") return;
    switch (e.type) {
      case "state": store.flow = e.state; renderIntel(); break;
      case "transcript": addTranscript(e); break;
      case "system": addSystem(e.text, e.level); break;
      case "metric":
        if (Number.isFinite(Number(e.replyMs))) { store.replies.push(Math.round(Number(e.replyMs))); renderMetrics(); renderVerdict(); }
        break;
      case "lead":
        if (!e.field) break;
        store.lead[e.field] = e.value; renderIntel(e.field);
        break;
      case "outcome":
        store.outcome = e.outcome; store.outcomeReason = typeof e.reason === "string" ? e.reason : ""; renderIntel();
        break;
    }
  }

  /* ---------- Call lifecycle ---------- */
  function reset() {
    Object.assign(store, { dialled: "", lead: {}, outcome: null, outcomeReason: "", flow: null, replies: [], transcript: [], startedAt: 0, endedAt: 0, endReason: "", endcard: null, stick: true, muted: false, handoff: "idle", lastTurn: null, latest: null, stepStates: [] });
    tick(); $("jump").hidden = true;
    setMuteUI();
    renderMetrics(); updateCounts();
  }

  function tick() {
    const c = clock(elapsed());
    $("t-m").textContent = c.slice(0, 2); $("t-s").textContent = c.slice(3); $("timer").textContent = c; $("q-dur").textContent = c;
  }
  function startTimer() { store.startedAt = Date.now(); store.endedAt = 0; clearInterval(store.timer); store.timer = setInterval(tick, 250); }
  function stopTimer() { clearInterval(store.timer); store.endedAt = Date.now(); tick(); }

  async function start() {
    const seq = ++store.callSeq;
    reset();
    setStatus("connecting", "Connecting");
    setEmpty("orb", store.mode === "phone" ? "Connecting to the customer…" : "Connecting to the agent…", store.mode === "phone" ? "Placing the call to your test number." : "Joining the room and starting your microphone.");
    const opts = { language: $("language").value, mode: store.mode, phone: normalisePhone($("phone").value) };
    store.dialled = store.mode === "phone" ? opts.phone : "";
    renderIdentity();
    const session = LIVE ? liveSession(opts) : demoSession(opts);
    store.session = session;
    try {
      await session.start(handle, {
        ended: (reason) => seq === store.callSeq && end(reason),
        reconnecting: () => seq === store.callSeq && store.callState === "live" && (setStatus("reconnecting", "Reconnecting"), addSystem("Connection dropped. Reconnecting.", "warn")),
        reconnected: () => seq === store.callSeq && store.callState === "reconnecting" && (setStatus("live", "Live"), setAgent("listening"), addSystem("Reconnected.")),
        speaking: (who) => seq === store.callSeq && store.callState === "live" && (who === "agent" ? setAgent("speaking", 1500) : setAgent("caller", 1500))
      });
      if (seq !== store.callSeq || store.callState !== "connecting") { session.stop(); return; }
      startTimer();
      setStatus("live", "Live");
      setAgent("listening");
      if ($("empty")) setEmpty("orb", "Connected", "Waiting for the agent to speak.");
    } catch (err) {
      session.stop();
      if (seq !== store.callSeq) return;
      console.error(err);
      store.session = null;
      const msg = friendlyError(err);
      setStatus("error", "Not connected");
      setEmpty("phone-off", "Call didn't connect", msg, { tone: "error" });
      toast(msg, "error", 8000);
      if (LIVE) checkHealth();
    }
  }

  function end(reason) {
    if (!ACTIVE.has(store.callState)) return;
    const wasConnecting = store.callState === "connecting";
    store.session?.stop(); store.session = null;
    clearTimeout(store.handoffTimer);
    if (wasConnecting) {
      store.callSeq++;
      setStatus("idle", "Ready");
      setEmpty("phone-off", "Call cancelled", "Start a call when you're ready.");
      return;
    }
    stopTimer();
    setStatus("ended", "Ended");
    addEndcard(reason || "Call ended.");
    updateCounts();
  }

  /* ---------- Controls ---------- */
  function modKey() { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl"; }
  function normalisePhone(v) { return v.replace(/[\s()-]/g, ""); }
  function validPhone(v) { return /^(\+91)?[6-9]\d{9}$/.test(v) || /^\+[1-9]\d{9,14}$/.test(v); }
  function phoneError(show) { $("phone-error").hidden = !show; $("phone").setAttribute("aria-invalid", show ? "true" : "false"); }

  function setMode(mode, focus) {
    store.mode = mode;
    document.querySelectorAll(".seg__btn").forEach((x) => {
      const on = x.dataset.mode === mode;
      x.classList.toggle("is-active", on); x.setAttribute("aria-checked", on); x.tabIndex = on ? 0 : -1;
      if (on && focus) x.focus();
    });
    $("phone-field").hidden = mode !== "phone";
    if (mode !== "phone") phoneError(false);
    const cm = $("clock-mode"); cm.lastElementChild.textContent = mode === "phone" ? "Phone" : "Browser";
    setIcon(cm, mode === "phone" ? "phone" : "mic"); icons();
  }

  function setMuteUI() {
    const b = $("mute-btn");
    b.setAttribute("aria-pressed", store.muted);
    $("mute-label").textContent = store.muted ? "Unmute" : "Mute";
    setIcon(b, store.muted ? "mic-off" : "mic"); icons();
  }

  function setHandoffUI() {
    const b = $("handoff-btn");
    b.dataset.confirm = store.handoff === "confirm";
    $("handoff-label").textContent = { idle: "Hand off", confirm: "Confirm?", done: "Requested" }[store.handoff];
    b.disabled = store.callState !== "live" || store.handoff === "done";
  }

  function setLanguage() { $("hdr-agent").textContent = `${LANGS[$("language").value] || "Voice"} agent`; }

  /* ---------- Demo session (no keys) ---------- */
  function demoSession() {
    const A = (t, id) => ({ type: "transcript", role: "agent", text: t, final: true, id });
    const C = (t, id) => ({ type: "transcript", role: "caller", text: t, final: true, id });
    const Ci = (t, id) => ({ type: "transcript", role: "caller", text: t, final: false, id });
    // [delay ms, event(s)]
    const script = [
      [600, [{ type: "system", text: "Agent joined. The call is being recorded." }, { type: "state", state: "IDENTITY" }]],
      [900, [A("Namaste, main SolarSquare se bol rahi hoon. Yeh call record ho rahi hai. Kya meri baat Mr. Nair se ho rahi hai?", "a1")]],
      [1300, [Ci("Haan ji…", "c1")]],
      [600, [C("Haan ji, bol raha hoon.", "c1"), { type: "metric", replyMs: 740 }, { type: "lead", field: "identity_confirmed", value: true }]],
      [1200, [{ type: "state", state: "INTEREST" }, A("Aapne solar ke liye enquiry ki thi. Kya aap abhi bhi interested hain?", "a2")]],
      [1800, [C("Haan, bill bahut aa raha hai.", "c2"), { type: "metric", replyMs: 690 }, { type: "lead", field: "solar_interest", value: true }]],
      [1200, [{ type: "state", state: "PROPERTY" }, A("Aapka ghar independent house hai ya society mein flat?", "a3")]],
      [1100, [Ci("Independent house hai…", "c3")]],
      [600, [C("Independent house hai, apna hai.", "c3"), { type: "metric", replyMs: 810 }, { type: "lead", field: "property_type", value: "independent_house" }, { type: "lead", field: "roof_ownership", value: "Own" }]],
      [1000, [A("Chhat par dhoop ke time koi shadow aata hai?", "a4")]],
      [1600, [C("Nahi, chhat khuli hai, kareeb 600 square feet.", "c4"), { type: "metric", replyMs: 720 }, { type: "lead", field: "roof_access", value: true }, { type: "lead", field: "shadow_free_area", value: "600 sq ft" }]],
      [1100, [{ type: "state", state: "BILL" }, A("Mahine ka bijli bill kitna aata hai, aur provider kaun sa hai?", "a5")]],
      [2000, [C("Around 3 hazaar aata hai, MSEDCL hai.", "c5"), { type: "metric", replyMs: 1120 }, { type: "lead", field: "monthly_bill", value: 3000 }, { type: "lead", field: "discom", value: "MSEDCL" }]],
      [1100, [{ type: "state", state: "LOCATION_TIMELINE" }, A("Aap kis shehar mein hain, aur install kab tak karwana chahenge?", "a6")]],
      [1900, [C("Pune, agle do mahine mein.", "c6"), { type: "metric", replyMs: 700 }, { type: "lead", field: "city_or_pincode", value: "Pune" }, { type: "lead", field: "timeline", value: "Within 2 months" }]],
      [1100, [{ type: "state", state: "FINANCE" }, A("Kya aap loan ya PM Surya Ghar subsidy ke baare mein jaanna chahenge?", "a7")]],
      [1700, [C("Subsidy ke baare mein batayein, loan nahi chahiye.", "c7"), { type: "metric", replyMs: 780 }, { type: "lead", field: "loan_interest", value: false }, { type: "lead", field: "subsidy_interest", value: true }]],
      [1100, [{ type: "state", state: "MEETING_PITCH" }, A("Hamare surveyor aapke ghar aa sakte hain. Kal shaam 5 baje theek rahega?", "a8")]],
      [1700, [C("Haan, kal shaam 5 baje chalega.", "c8"), { type: "metric", replyMs: 650 }, { type: "lead", field: "meeting_slot", value: "Tomorrow, 5 pm" }]],
      [1100, [{ type: "state", state: "WRAP_UP" }, A("Dhanyavaad. Aapka slot confirm hai. Surveyor se call aayega.", "a9")]],
      [1400, [{ type: "state", state: "DONE" }, { type: "outcome", outcome: "qualified" }]]
    ];
    const timers = []; let stopped = false;
    return {
      start(emit, on) {
        return new Promise((resolve) => {
          timers.push(setTimeout(() => {
            if (stopped) return;
            resolve();
            let t = 0;
            script.forEach(([delay, events]) => { t += delay; timers.push(setTimeout(() => !stopped && events.forEach(emit), t)); });
            timers.push(setTimeout(() => !stopped && on.ended("The agent ended the call."), t + 900));
          }, 700));
        });
      },
      setMuted() {},
      stop() { stopped = true; timers.forEach(clearTimeout); }
    };
  }

  /* ---------- Live session (LiveKit + backend) ---------- */
  function liveSession(opts) {
    let room = null, stopped = false, audioEls = [];
    return {
      async start(emit, on) {
        if (opts.mode === "phone") opts.room = (await api("/api/call", { phone: opts.phone, language: opts.language })).room;
        if (stopped) return;
        const { url, token } = await api("/api/token", { language: opts.language, room: opts.room || null, listenOnly: opts.mode === "phone" });
        if (stopped) return;
        await loadScript(CFG.livekitClientSrc);
        const LK = window.LivekitClient;
        room = new LK.Room({ adaptiveStream: true, dynacast: true });
        room.on(LK.RoomEvent.TrackSubscribed, (track) => { if (track.kind === "audio") { const a = track.attach(); audioEls.push(a); document.body.appendChild(a); } });
        room.on(LK.RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((a) => a.remove()));
        room.on(LK.RoomEvent.DataReceived, (payload, _p, _k, topic) => {
          if (topic && topic !== CFG.eventsTopic) return;
          try { emit(JSON.parse(new TextDecoder().decode(payload))); } catch (e) { console.warn("Ignored a malformed event", e); }
        });
        room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
          const s = speakers && speakers[0]; if (!s) return;
          const agent = s.isAgent || s.kind === "agent" || /agent/i.test(s.identity || "");
          on.speaking(agent ? "agent" : "caller");
        });
        room.on(LK.RoomEvent.Reconnecting, on.reconnecting);
        room.on(LK.RoomEvent.Reconnected, on.reconnected);
        room.on(LK.RoomEvent.Disconnected, () => !stopped && on.ended("The call disconnected."));
        await room.connect(url, token);
        if (opts.mode === "browser") await room.localParticipant.setMicrophoneEnabled(true);
      },
      async setMuted(m) { await room?.localParticipant.setMicrophoneEnabled(!m); },
      handoff() { /* Wire to the agent's handoff_to_human once it exists. */ },
      stop() { stopped = true; room?.disconnect(); audioEls.forEach((a) => a.remove()); audioEls = []; }
    };
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.LivekitClient) return res();
      const s = document.createElement("script"); s.src = src; s.onload = res;
      s.onerror = () => rej(new Error("Couldn't load the LiveKit client. Check your network and try again."));
      document.head.appendChild(s);
    });
  }

  async function checkHealth() {
    const chip = $("health-chip"), label = $("health-label");
    chip.hidden = false; chip.dataset.health = "checking"; label.textContent = "Checking backend"; chip.title = "";
    try {
      const h = await api("/api/health", null, 5000);
      const missing = (h.missing || []).join(", ");
      if (h.livekit && h.phone) { chip.dataset.health = "ok"; label.textContent = "Backend ready"; }
      else if (h.livekit) { chip.dataset.health = "warn"; label.textContent = "Phone not set up"; chip.title = "Missing: " + missing; }
      else { chip.dataset.health = "down"; label.textContent = "Backend not configured"; chip.title = "Missing: " + missing; }
    } catch (_) {
      chip.dataset.health = "down"; label.textContent = "Backend unreachable"; chip.title = BASE;
    }
  }

  /* ---------- Exports ---------- */
  function record() {
    return {
      outcome: store.outcome, lead: store.lead,
      call: { mode: store.mode, language: $("language").value, durationSec: Math.round(elapsed() / 1000), replyMs: store.replies, medianReplyMs: median(store.replies) },
      exportedAt: new Date().toISOString()
    };
  }
  function transcriptText() {
    return store.transcript.map((m) => `[${clock(m.t)}] ${m.role === "agent" ? "Agent" : m.role === "caller" ? "Customer" : "System"}: ${m.text}`).join("\n") + "\n";
  }

  /* ---------- Settings popover ---------- */
  function setupSettings() {
    const btn = $("settings-btn"), pop = $("settings");
    $("set-source").textContent = LIVE ? "Live" : "Demo";
    $("set-backend").textContent = LIVE ? BASE : "Not set";
    $("set-backend").title = LIVE ? BASE : "";
    $("set-topic").textContent = CFG.eventsTopic || "call-events";
    $("set-note").hidden = LIVE;
    document.querySelectorAll(".kbd-mod").forEach((k) => (k.textContent = modKey()));
    const toggle = (open) => { pop.hidden = !open; btn.setAttribute("aria-expanded", open); };
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(pop.hidden); });
    document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) toggle(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { toggle(false); btn.focus(); } });
  }

  /* ---------- Wiring ---------- */
  function init() {
    $("source-chip").dataset.source = LIVE ? "live" : "demo";
    $("source-label").textContent = LIVE ? "Live" : "Demo";
    $("source-chip").title = LIVE ? "Connected to " + BASE : "Plays a scripted call. Set backendUrl in config.js to go live.";
    if (LIVE) checkHealth();
    setupSettings();
    setLanguage();
    $("language").addEventListener("change", setLanguage);

    const segs = [...document.querySelectorAll(".seg__btn")];
    segs.forEach((b, i) => {
      b.addEventListener("click", () => setMode(b.dataset.mode));
      b.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return; e.preventDefault();
        setMode(segs[(i + d + segs.length) % segs.length].dataset.mode, true);
      });
    });

    $("phone").addEventListener("input", () => { if ($("phone").getAttribute("aria-invalid") === "true" && validPhone(normalisePhone($("phone").value))) phoneError(false); });
    $("phone").addEventListener("keydown", (e) => { if (e.key === "Enter") $("call-btn").click(); });

    $("call-btn").addEventListener("click", () => {
      if (ACTIVE.has(store.callState)) return end("You ended the call.");
      if (store.mode === "phone" && !validPhone(normalisePhone($("phone").value))) { phoneError(true); $("phone").focus(); return; }
      start();
    });

    $("mute-btn").addEventListener("click", async () => {
      store.muted = !store.muted; setMuteUI();
      try { await store.session?.setMuted?.(store.muted); }
      catch (err) { store.muted = !store.muted; setMuteUI(); toast(friendlyError(err), "error"); }
    });

    $("handoff-btn").addEventListener("click", () => {
      clearTimeout(store.handoffTimer);
      if (store.handoff === "idle") {
        store.handoff = "confirm"; setHandoffUI();
        store.handoffTimer = setTimeout(() => { if (store.handoff === "confirm") { store.handoff = "idle"; setHandoffUI(); } }, 4000);
        return;
      }
      store.handoff = "done"; setHandoffUI();
      addSystem("Handoff requested. A team member will take over.", "warn");
      store.session?.handoff?.();
      renderIntel();
      toast("Handoff requested. A team member will take over the call.", "success");
    });

    $("copy-json").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(record(), null, 2)); toast("Lead record copied as JSON.", "success", 2500); }
      catch (_) { toast("Couldn't copy. Use download instead.", "error"); }
    });
    $("dl-json").addEventListener("click", () => download(`lead-${stamp()}.json`, JSON.stringify(record(), null, 2), "application/json"));
    $("dl-transcript").addEventListener("click", () => download(`transcript-${stamp()}.txt`, transcriptText(), "text/plain"));

    logEl().addEventListener("scroll", () => { store.stick = nearBottom(); if (store.stick) $("jump").hidden = true; }, { passive: true });
    $("jump").addEventListener("click", () => { logEl().scrollTo({ top: logEl().scrollHeight, behavior: "smooth" }); $("jump").hidden = true; store.stick = true; });

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!$("call-btn").disabled) $("call-btn").click(); }
      else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "m" && !$("mute-btn").disabled) $("mute-btn").click();
    });

    window.addEventListener("beforeunload", (e) => { if (ACTIVE.has(store.callState)) { e.preventDefault(); e.returnValue = ""; } });

    renderMetrics(); setMuteUI(); setStatus("idle", "Ready"); idleEmpty();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
