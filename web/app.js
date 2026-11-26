/* Voice agent console.
 *
 * Both the demo simulator and the live LiveKit connection emit the same event
 * shapes, so the UI never knows which one it is talking to:
 *
 *   {type:"state",      state:"IDENTITY"|...|"DONE"}
 *   {type:"transcript", role:"agent"|"caller", text, final:bool, id}
 *   {type:"lead",       field, value}
 *   {type:"outcome",    outcome:"qualified"|"not_qualified"|"callback"|"wrong_number"|"do_not_call"}
 *   {type:"metric",     replyMs}
 *   {type:"system",     text, level?:"info"|"warn"|"error"}
 */
(function () {
  "use strict";
  const CFG = window.VOICE_CONSOLE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const LIVE = !!CFG.backendUrl;
  const BASE = LIVE ? CFG.backendUrl.replace(/\/$/, "") : "";
  const TARGET_MS = 1000;

  const STATES = [
    ["IDENTITY", "Identity"], ["INTEREST", "Interest"], ["PROPERTY", "Property"], ["BILL", "Bill"],
    ["LOCATION_TIMELINE", "Location"], ["FINANCE", "Finance"], ["MEETING_PITCH", "Meeting"], ["WRAP_UP", "Wrap-up"]
  ];
  const GROUPS = [
    ["Caller", [["identity_confirmed", "Identity confirmed"], ["solar_interest", "Interested in solar"]]],
    ["Property", [["property_type", "Property type"], ["roof_ownership", "Roof ownership"], ["roof_access", "Roof access"], ["shadow_free_area", "Shadow-free area"]]],
    ["Energy", [["monthly_bill", "Monthly bill"], ["discom", "DISCOM"]]],
    ["Location and timing", [["city_or_pincode", "City or pincode"], ["timeline", "Timeline"]]],
    ["Finance", [["loan_interest", "Loan"], ["subsidy_interest", "PM Surya Ghar subsidy"]]],
    ["Meeting", [["meeting_slot", "Preferred slot"]]]
  ];
  const FIELDS = new Set(GROUPS.flatMap((g) => g[1].map((r) => r[0])));
  const OUTCOMES = {
    none:          { label: "Pending",         icon: "hourglass",        desc: "Set by the agent when the call ends." },
    live:          { label: "Call in progress", icon: "radio",           desc: "Set by the agent when the call ends." },
    missing:       { label: "No outcome",      icon: "circle-dashed",    desc: "The call ended before the agent set one." },
    qualified:     { label: "Qualified",       icon: "badge-check",      desc: "Ready for a site survey. Pass the record to sales." },
    not_qualified: { label: "Not qualified",   icon: "circle-x",         desc: "Doesn't meet the criteria for a rooftop install." },
    callback:      { label: "Callback",        icon: "phone-forwarded",  desc: "The caller asked to talk later. Schedule a callback." },
    wrong_number:  { label: "Wrong number",    icon: "phone-missed",     desc: "The person who answered isn't this lead." },
    do_not_call:   { label: "Do not call",     icon: "ban",              desc: "The caller asked not to be called again. Don't call this number." }
  };
  const ACTIVE = new Set(["connecting", "live", "reconnecting"]);

  const store = {
    mode: "browser", callState: "idle", callSeq: 0, session: null,
    lead: {}, outcome: null, replies: [], transcript: [],
    startedAt: 0, endedAt: 0, timer: null, speakerTimer: null,
    muted: false, handoff: "idle", handoffTimer: null, stick: true
  };

  /* ---------- Small helpers ---------- */
  function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.5 } }); }
  function setIcon(parent, name) {
    const old = parent.querySelector(":scope > svg, :scope > i");
    const el = document.createElement("i");
    el.setAttribute("data-lucide", name);
    if (old) old.replaceWith(el); else parent.prepend(el);
  }
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clock(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
  function elapsed() { return store.startedAt ? (store.endedAt || Date.now()) - store.startedAt : 0; }
  function median(arr) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
  function fmtMs(v) { return v == null ? "—" : v.toLocaleString("en-IN") + "<small>ms</small>"; }
  function fmt(k, v) {
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (k === "monthly_bill" && !isNaN(Number(v))) return "₹" + Number(v).toLocaleString("en-IN");
    if (k === "property_type") return String(v).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    return String(v);
  }
  function stamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toast(text, kind = "info", ms = 5000) {
    const t = el("div", `toast toast--${kind}`);
    t.setAttribute("role", kind === "error" ? "alert" : "status");
    const ic = el("i"); ic.setAttribute("data-lucide", kind === "error" ? "circle-alert" : kind === "success" ? "circle-check" : "info");
    const close = el("button", "toast__close"); close.type = "button"; close.setAttribute("aria-label", "Dismiss");
    close.innerHTML = '<i data-lucide="x"></i>';
    t.append(ic, el("span", null, text), close);
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

  /* ---------- Rendering ---------- */
  function renderSteps(current) {
    const idx = STATES.findIndex((s) => s[0] === current);
    const done = current === "DONE";
    $("steps").innerHTML = STATES.map((s, i) => {
      const cls = done || i < idx ? "is-done" : i === idx ? "is-current" : "";
      const cur = i === idx && !done ? ' aria-current="step"' : "";
      return `<li class="${cls}"${cur}>${cls === "is-done" ? '<i data-lucide="check"></i>' : ""}${s[1]}</li>`;
    }).join("");
    const pct = done ? 100 : idx >= 0 ? ((idx + 0.5) / STATES.length) * 100 : 0;
    $("progress-fill").style.width = pct + "%";
    document.querySelector(".progress").dataset.done = done;
    $("state-label").textContent = done ? "All steps complete"
      : idx >= 0 ? `Step ${idx + 1} of ${STATES.length} · ${STATES[idx][1]}`
      : ACTIVE.has(store.callState) ? "Starting" : "Waiting for a call";
    icons();
  }

  function renderLead(changed) {
    const box = $("lead-groups"); box.textContent = "";
    GROUPS.forEach(([title, rows]) => {
      const g = el("div", "group"); g.appendChild(el("h3", "group__title", title));
      rows.forEach(([k, label]) => {
        const v = store.lead[k], has = v !== undefined && v !== null && v !== "";
        const r = el("div", "row" + (has ? " is-set" : "") + (k === changed ? " flash" : ""));
        r.dataset.field = k;
        const ic = el("i", "row__check"); ic.setAttribute("data-lucide", has ? "circle-check" : "circle");
        r.append(ic, el("span", "row__k", label), el("span", "row__v" + (has ? "" : " is-empty"), has ? fmt(k, v) : "—"));
        if (!has) r.lastChild.setAttribute("aria-label", "Not captured");
        g.appendChild(r);
      });
      box.appendChild(g);
    });
    const n = Object.keys(store.lead).filter((k) => FIELDS.has(k)).length;
    $("lead-count").textContent = `${n} of ${FIELDS.size}`;
    $("lead-fill").style.width = (n / FIELDS.size) * 100 + "%";
    $("lead-meter").setAttribute("aria-valuenow", n);
    icons();
    return n;
  }

  function renderOutcome(key) {
    const o = OUTCOMES[key] || { label: key, icon: "flag", desc: "" };
    $("outcome").dataset.outcome = key;
    $("outcome-value").textContent = o.label;
    $("outcome-desc").textContent = o.desc;
    setIcon(document.querySelector(".outcome__icon"), o.icon);
    icons();
  }

  function renderMetrics() {
    const r = store.replies, last = r.length ? r[r.length - 1] : null, p50 = median(r);
    $("m-turns").textContent = r.length;
    $("m-last").innerHTML = fmtMs(last); $("m-last").dataset.tone = last >= TARGET_MS ? "slow" : "";
    $("m-p50").innerHTML = fmtMs(p50); $("m-p50").dataset.tone = p50 >= TARGET_MS ? "slow" : "";
    const pts = r.slice(-24), W = 260, H = 56, max = Math.max(TARGET_MS * 1.25, ...pts) * 1.05;
    const y = (v) => (H - 2 - (v / max) * (H - 4)).toFixed(1);
    const x = (i) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W).toFixed(1);
    $("spark-target").setAttribute("y1", y(TARGET_MS)); $("spark-target").setAttribute("y2", y(TARGET_MS));
    $("spark-line").setAttribute("points", pts.map((v, i) => `${x(i)},${y(v)}`).join(" "));
    $("spark-dots").innerHTML = pts.map((v, i) => `<circle r="2.5" cx="${x(i)}" cy="${y(v)}" class="${v >= TARGET_MS ? "is-slow" : ""}"><title>${v} ms</title></circle>`).join("");
    $("spark").style.display = pts.length ? "" : "none";
    $("spark-empty").hidden = pts.length > 0;
  }

  function setSpeaker(who) {
    $("voice").dataset.speaker = who;
    $("voice-label").textContent = { agent: "Agent speaking", caller: "Caller speaking", listening: "Listening", none: "Not connected" }[who] || "";
  }
  function pulseSpeaker(role, ms = 1600) {
    if (!ACTIVE.has(store.callState)) return;
    setSpeaker(role); clearTimeout(store.speakerTimer);
    store.speakerTimer = setTimeout(() => ACTIVE.has(store.callState) && setSpeaker("listening"), ms);
  }

  function setStatus(state, text) {
    store.callState = state;
    $("status").dataset.state = state;
    $("status-text").textContent = text;
    const active = ACTIVE.has(state);
    const btn = $("call-btn");
    btn.dataset.live = active ? "true" : "false";
    btn.setAttribute("aria-busy", state === "connecting");
    $("call-btn-label").textContent = state === "connecting" ? "Cancel" : active ? "End call" : store.callSeq ? "Start new call" : "Start call";
    setIcon(btn, active ? "phone-off" : "phone-call");
    $("handoff-btn").disabled = state !== "live" || store.handoff === "done";
    $("mute-btn").disabled = state !== "live" || store.mode === "phone";
    ["language", "phone"].forEach((id) => ($(id).disabled = active));
    document.querySelectorAll(".seg__btn").forEach((b) => (b.disabled = active));
    if (!active) setSpeaker("none");
    document.title = (state === "live" ? "● " : "") + "Voice agent console · SolarSquare";
    icons();
  }

  /* ---------- Transcript ---------- */
  const logEl = () => $("log");
  function nearBottom() { const l = logEl(); return l.scrollHeight - l.scrollTop - l.clientHeight < 80; }
  function scrollToEnd() { const l = logEl(); l.scrollTop = l.scrollHeight; $("jump").hidden = true; store.stick = true; }
  function append(node) {
    const stick = store.stick || nearBottom();
    $("empty")?.remove();
    logEl().appendChild(node);
    if (stick) scrollToEnd(); else $("jump").hidden = false;
    icons();
  }
  function setEmpty(title, text, icon, loading) {
    logEl().innerHTML = `<div class="empty${loading ? " empty--loading" : ""}" id="empty"><span class="empty__icon"><i data-lucide="${icon}"></i></span><p class="empty__title"></p><p></p></div>`;
    const ps = logEl().querySelectorAll("p"); ps[0].textContent = title; ps[1].textContent = text;
    icons();
  }

  function addTranscript(e) {
    if (!e.text) return;
    const id = e.id || "m" + store.transcript.length;
    let item = store.transcript.find((m) => m.id === id);
    let node = e.id ? logEl().querySelector(`[data-msg="${CSS.escape(e.id)}"]`) : null;
    if (!item) { item = { id, role: e.role, t: elapsed() }; store.transcript.push(item); }
    item.text = e.text; item.final = e.final !== false;
    if (!node) {
      const agent = e.role === "agent";
      node = el("div", `msg msg--${agent ? "agent" : "caller"}`);
      node.dataset.msg = id;
      const av = el("span", "msg__avatar"); av.innerHTML = `<i data-lucide="${agent ? "bot" : "user-round"}"></i>`;
      const main = el("div", "msg__main"), meta = el("div", "msg__meta");
      meta.append(el("span", "msg__who", agent ? "Agent" : "Caller"), el("span", "msg__time", clock(item.t)));
      main.append(meta, el("div", "msg__bubble"));
      node.append(av, main);
      node.querySelector(".msg__bubble").textContent = e.text;
      append(node);
    } else {
      const stick = store.stick || nearBottom();
      node.querySelector(".msg__bubble").textContent = e.text;
      if (stick) scrollToEnd();
    }
    node.classList.toggle("is-interim", !item.final);
    pulseSpeaker(e.role === "agent" ? "agent" : "caller", item.final ? 1400 : 2500);
    updateCounts();
  }

  function addSystem(text, level = "info") {
    const d = el("div", `sys sys--${level}`);
    d.innerHTML = `<i data-lucide="${level === "error" ? "circle-alert" : level === "warn" ? "triangle-alert" : "info"}"></i>`;
    d.appendChild(el("span", null, text));
    store.transcript.push({ id: "sys" + store.transcript.length, role: "system", text, t: elapsed(), final: true });
    append(d);
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
      case "state": renderSteps(e.state); break;
      case "transcript": addTranscript(e); break;
      case "system": addSystem(e.text, e.level); break;
      case "metric":
        if (Number.isFinite(Number(e.replyMs))) { store.replies.push(Math.round(Number(e.replyMs))); renderMetrics(); }
        break;
      case "lead":
        if (!e.field) break;
        store.lead[e.field] = e.value; renderLead(e.field); setRecordActions();
        break;
      case "outcome":
        store.outcome = e.outcome; renderOutcome(e.outcome); setRecordActions();
        break;
    }
  }

  function setRecordActions() {
    const any = store.outcome || Object.keys(store.lead).length;
    $("copy-json").disabled = !any; $("dl-json").disabled = !any;
  }

  /* ---------- Call lifecycle ---------- */
  function reset() {
    store.lead = {}; store.outcome = null; store.replies = []; store.transcript = [];
    store.startedAt = 0; store.endedAt = 0; store.stick = true;
    store.muted = false; store.handoff = "idle";
    $("timer").textContent = "00:00"; $("summary").hidden = true; $("jump").hidden = true;
    setMuteUI(); setHandoffUI();
    setEmpty("Connecting", store.mode === "phone" ? "Placing the call to your test number." : "Joining the room and starting your microphone.", "loader-circle", true);
    renderOutcome("live"); renderLead(); renderMetrics(); renderSteps(null); updateCounts(); setRecordActions();
  }

  function startTimer() {
    store.startedAt = Date.now(); store.endedAt = 0;
    clearInterval(store.timer);
    store.timer = setInterval(() => ($("timer").textContent = clock(elapsed())), 250);
  }
  function stopTimer() { clearInterval(store.timer); store.endedAt = Date.now(); $("timer").textContent = clock(elapsed()); }

  async function start() {
    const seq = ++store.callSeq;
    reset();
    setStatus("connecting", store.mode === "phone" ? "Dialling" : "Connecting");
    const opts = { language: $("language").value, mode: store.mode, phone: normalisePhone($("phone").value) };
    const session = LIVE ? liveSession(opts) : demoSession(opts);
    store.session = session;
    try {
      await session.start(handle, {
        ended: (reason) => seq === store.callSeq && end(reason),
        reconnecting: () => seq === store.callSeq && store.callState === "live" && (setStatus("reconnecting", "Reconnecting"), addSystem("Connection dropped. Reconnecting.", "warn")),
        reconnected: () => seq === store.callSeq && store.callState === "reconnecting" && (setStatus("live", "On call"), addSystem("Reconnected.")),
        speaking: (who) => seq === store.callSeq && pulseSpeaker(who)
      });
      if (seq !== store.callSeq || store.callState !== "connecting") { session.stop(); return; }
      setStatus("live", store.mode === "phone" ? "On call · phone" : "On call");
      setSpeaker("listening");
      startTimer();
      if ($("empty")) setEmpty("Connected", "Waiting for the agent to speak.", "audio-lines");
    } catch (err) {
      session.stop();
      if (seq !== store.callSeq) return;
      console.error(err);
      store.session = null;
      const msg = friendlyError(err);
      setStatus("error", "Couldn't connect");
      setEmpty("Call didn't start", msg, "phone-off");
      renderOutcome("none");
      toast(msg, "error", 8000);
      if (LIVE) checkHealth();
    }
  }

  function end(reason) {
    if (!ACTIVE.has(store.callState)) return;
    const wasConnecting = store.callState === "connecting";
    store.session?.stop(); store.session = null;
    clearTimeout(store.speakerTimer); clearTimeout(store.handoffTimer);
    if (wasConnecting) {
      store.callSeq++;
      setStatus("idle", "Ready"); renderOutcome("none"); renderSteps(null);
      setEmpty("Call cancelled", "Press Start call when you're ready.", "phone-off");
      return;
    }
    stopTimer();
    setStatus("ended", "Call ended");
    addSystem(reason || "Call ended");
    if (!store.outcome) renderOutcome("missing");
    $("s-dur").textContent = clock(elapsed());
    $("s-fields").textContent = `${Object.keys(store.lead).filter((k) => FIELDS.has(k)).length}/${FIELDS.size}`;
    const p50 = median(store.replies); $("s-p50").textContent = p50 == null ? "—" : p50 + " ms";
    $("summary").hidden = false;
    setRecordActions(); updateCounts();
  }

  /* ---------- Controls ---------- */
  function normalisePhone(v) { return v.replace(/[\s()-]/g, ""); }
  function validPhone(v) { return /^(\+91)?[6-9]\d{9}$/.test(v) || /^\+[1-9]\d{9,14}$/.test(v); }
  function phoneError(show) {
    $("phone-error").hidden = !show;
    $("phone").setAttribute("aria-invalid", show ? "true" : "false");
  }

  function setMode(mode, focus) {
    store.mode = mode;
    document.querySelectorAll(".seg__btn").forEach((x) => {
      const on = x.dataset.mode === mode;
      x.classList.toggle("is-active", on); x.setAttribute("aria-checked", on); x.tabIndex = on ? 0 : -1;
      if (on && focus) x.focus();
    });
    $("phone-field").hidden = mode !== "phone";
    if (mode !== "phone") phoneError(false);
  }

  function setMuteUI() {
    const b = $("mute-btn");
    b.setAttribute("aria-pressed", store.muted);
    $("mute-label").textContent = store.muted ? "Unmute" : "Mute";
    setIcon(b, store.muted ? "mic-off" : "mic");
    icons();
  }

  function setHandoffUI() {
    const b = $("handoff-btn");
    b.dataset.confirm = store.handoff === "confirm";
    $("handoff-label").textContent = { idle: "Hand off", confirm: "Confirm handoff", done: "Handoff requested" }[store.handoff];
    b.disabled = store.callState !== "live" || store.handoff === "done";
  }

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
      else if (h.livekit) { chip.dataset.health = "warn"; label.textContent = "Phone calls not set up"; chip.title = "Missing: " + missing; }
      else { chip.dataset.health = "down"; label.textContent = "Backend not configured"; chip.title = "Missing: " + missing; }
    } catch (_) {
      chip.dataset.health = "down"; label.textContent = "Backend unreachable"; chip.title = BASE;
    }
    setIcon(chip, chip.dataset.health === "ok" ? "circle-check" : chip.dataset.health === "checking" ? "activity" : "circle-alert");
    icons();
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
    return store.transcript.map((m) => `[${clock(m.t)}] ${m.role === "agent" ? "Agent" : m.role === "caller" ? "Caller" : "System"}: ${m.text}`).join("\n") + "\n";
  }

  /* ---------- Wiring ---------- */
  function init() {
    $("source-chip").dataset.source = LIVE ? "live" : "demo";
    $("source-label").textContent = LIVE ? "Live" : "Demo mode";
    $("source-chip").title = LIVE ? "Connected to " + BASE : "Plays a scripted call. Set backendUrl in config.js to go live.";
    setIcon($("source-chip"), LIVE ? "radio" : "flask-conical");
    if (LIVE) checkHealth();

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
      toast("Handoff requested. A team member will take over the call.", "success");
    });

    $("copy-json").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(record(), null, 2)); toast("Lead record copied as JSON.", "success", 2500); }
      catch (_) { toast("Couldn't copy. Use Download instead.", "error"); }
    });
    $("dl-json").addEventListener("click", () => download(`lead-${stamp()}.json`, JSON.stringify(record(), null, 2), "application/json"));
    $("dl-transcript").addEventListener("click", () => download(`transcript-${stamp()}.txt`, transcriptText(), "text/plain"));

    logEl().addEventListener("scroll", () => { store.stick = nearBottom(); if (store.stick) $("jump").hidden = true; }, { passive: true });
    $("jump").addEventListener("click", () => { logEl().scrollTo({ top: logEl().scrollHeight, behavior: "smooth" }); $("jump").hidden = true; store.stick = true; });

    window.addEventListener("beforeunload", (e) => { if (ACTIVE.has(store.callState)) { e.preventDefault(); e.returnValue = ""; } });

    renderSteps(null); renderLead(); renderMetrics(); renderOutcome("none"); setMuteUI(); setHandoffUI(); icons();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
