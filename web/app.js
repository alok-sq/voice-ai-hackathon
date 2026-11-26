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
 *   {type:"system",     text}
 */
(function () {
  "use strict";
  const CFG = window.VOICE_CONSOLE_CONFIG || {};
  const $ = (id) => document.getElementById(id);

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
  const FIELD_COUNT = GROUPS.reduce((n, g) => n + g[1].length, 0);
  const OUTCOMES = { qualified: "Qualified", not_qualified: "Not qualified", callback: "Callback", wrong_number: "Wrong number", do_not_call: "Do not call" };

  const store = { mode: "browser", callState: "idle", lead: {}, outcome: null, replies: [], startedAt: 0, timer: null, session: null };

  /* ---------- Rendering ---------- */
  function icons() { if (window.lucide) window.lucide.createIcons(); }
  // lucide swaps <i> for <svg>, so re-render by replacing the element.
  function setIcon(parent, name) {
    const old = parent.querySelector("svg, i");
    const el = document.createElement("i");
    el.setAttribute("data-lucide", name);
    if (old) old.replaceWith(el); else parent.prepend(el);
  }

  function renderSteps(current) {
    const idx = STATES.findIndex((s) => s[0] === current);
    $("steps").innerHTML = STATES.map((s, i) => {
      const cls = current === "DONE" || i < idx ? "is-done" : i === idx ? "is-current" : "";
      return `<li class="${cls}">${s[1]}</li>`;
    }).join("");
    $("state-label").textContent = current === "DONE" ? "Call complete" : idx >= 0 ? `Now: ${STATES[idx][1].toLowerCase()}` : "Waiting for a call";
  }

  function renderLead() {
    $("lead-groups").innerHTML = GROUPS.map(([title, rows]) => `
      <div class="group"><h6>${title}</h6>${rows.map(([k, label]) => {
        const v = store.lead[k];
        const has = v !== undefined && v !== null && v !== "";
        return `<div class="row" data-field="${k}"><span class="row__k">${label}</span><span class="row__v ${has ? "" : "is-empty"}">${has ? esc(fmt(k, v)) : "Not captured"}</span></div>`;
      }).join("")}</div>`).join("");
    $("lead-count").textContent = `${Object.keys(store.lead).length} / ${FIELD_COUNT}`;
  }

  function fmt(k, v) {
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (k === "monthly_bill") return "₹" + Number(v).toLocaleString("en-IN");
    if (k === "property_type") return String(v).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    return String(v);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  function setStatus(state, text) {
    store.callState = state;
    $("status").dataset.state = state;
    $("status-text").textContent = text;
    const live = state === "live" || state === "connecting";
    $("call-btn").dataset.live = live ? "true" : "false";
    $("call-btn-label").textContent = live ? "End call" : "Start call";
    setIcon($("call-btn"), live ? "phone-off" : "phone-call");
    $("handoff-btn").disabled = state !== "live";
    ["language", "phone"].forEach((id) => ($(id).disabled = live));
    document.querySelectorAll(".seg__btn").forEach((b) => (b.disabled = live));
    icons();
  }

  function log(el) { const l = $("log"); $("empty")?.remove(); l.appendChild(el); l.scrollTop = l.scrollHeight; }

  function addTranscript(e) {
    let node = document.querySelector(`[data-msg="${CSS.escape(e.id || "")}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = `msg msg--${e.role}`;
      if (e.id) node.dataset.msg = e.id;
      node.innerHTML = `<span class="msg__who">${e.role === "agent" ? "Agent" : "Caller"}</span><div class="msg__bubble"></div>`;
      log(node);
    }
    node.classList.toggle("is-interim", !e.final);
    node.querySelector(".msg__bubble").textContent = e.text;
    $("log").scrollTop = $("log").scrollHeight;
  }

  function addSystem(text) { const d = document.createElement("div"); d.className = "sys"; d.textContent = text; log(d); }

  function renderMetrics() {
    const r = store.replies;
    $("m-turns").textContent = r.length;
    if (!r.length) { $("m-last").textContent = "—"; $("m-p50").textContent = "—"; return; }
    const sorted = [...r].sort((a, b) => a - b);
    $("m-last").textContent = r[r.length - 1] + " ms";
    $("m-p50").textContent = sorted[Math.floor(sorted.length / 2)] + " ms";
  }

  /* ---------- Event handling ---------- */
  function handle(e) {
    switch (e.type) {
      case "state": renderSteps(e.state); break;
      case "transcript": addTranscript(e); break;
      case "system": addSystem(e.text); break;
      case "metric": store.replies.push(Math.round(e.replyMs)); renderMetrics(); break;
      case "lead":
        store.lead[e.field] = e.value; renderLead();
        document.querySelector(`[data-field="${e.field}"]`)?.classList.add("flash");
        break;
      case "outcome":
        store.outcome = e.outcome;
        $("outcome").dataset.outcome = e.outcome;
        $("outcome-pill").textContent = OUTCOMES[e.outcome] || e.outcome;
        $("copy-json").disabled = false;
        break;
    }
  }

  /* ---------- Call lifecycle ---------- */
  function reset() {
    store.lead = {}; store.outcome = null; store.replies = [];
    $("log").innerHTML = '<div class="empty" id="empty"><i data-lucide="audio-lines"></i><p>Connecting.</p></div>';
    $("outcome").dataset.outcome = "none"; $("outcome-pill").textContent = "Pending"; $("copy-json").disabled = true;
    renderLead(); renderMetrics(); renderSteps(null); icons();
  }

  function startTimer() {
    store.startedAt = Date.now();
    store.timer = setInterval(() => {
      const s = Math.floor((Date.now() - store.startedAt) / 1000);
      $("timer").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    }, 500);
  }
  function stopTimer() { clearInterval(store.timer); }

  async function start() {
    reset(); $("timer").textContent = "00:00";
    setStatus("connecting", "Connecting");
    const opts = { language: $("language").value, mode: store.mode, phone: $("phone").value.trim() };
    try {
      store.session = CFG.backendUrl ? await liveSession(opts) : demoSession(opts);
      await store.session.start(handle, (reason) => end(reason));
      setStatus("live", store.mode === "phone" ? "Calling" : "On call");
      startTimer();
    } catch (err) {
      console.error(err);
      setStatus("error", "Could not connect");
      addSystem(err.message || "Could not start the call.");
      store.session = null;
    }
  }

  function end(reason) {
    if (store.callState === "ended" || store.callState === "idle") return;
    store.session?.stop(); store.session = null; stopTimer();
    setStatus("ended", "Call ended");
    addSystem(reason || "Call ended");
  }

  /* ---------- Demo session (no keys) ---------- */
  function demoSession(opts) {
    const L = {
      agent: (t) => ({ type: "transcript", role: "agent", text: t, final: true }),
      caller: (t) => ({ type: "transcript", role: "caller", text: t, final: true })
    };
    // [delay ms, event(s)]
    const script = [
      [600, [{ type: "system", text: "Agent joined. Calls are recorded." }, { type: "state", state: "IDENTITY" }]],
      [900, [L.agent("Namaste, main SolarSquare se bol rahi hoon. Yeh call record ho rahi hai. Kya meri baat Mr. Nair se ho rahi hai?")]],
      [1900, [L.caller("Haan ji, bol raha hoon."), { type: "metric", replyMs: 740 }, { type: "lead", field: "identity_confirmed", value: true }]],
      [1200, [{ type: "state", state: "INTEREST" }, L.agent("Aapne solar ke liye enquiry ki thi. Kya aap abhi bhi interested hain?")]],
      [1800, [L.caller("Haan, bill bahut aa raha hai."), { type: "metric", replyMs: 690 }, { type: "lead", field: "solar_interest", value: true }]],
      [1200, [{ type: "state", state: "PROPERTY" }, L.agent("Aapka ghar independent house hai ya society mein flat?")]],
      [1700, [L.caller("Independent house hai, apna hai."), { type: "metric", replyMs: 810 }, { type: "lead", field: "property_type", value: "independent_house" }, { type: "lead", field: "roof_ownership", value: "Own" }]],
      [1000, [L.agent("Chhat par dhoop ke time koi shadow aata hai?")]],
      [1600, [L.caller("Nahi, chhat khuli hai, kareeb 600 square feet."), { type: "metric", replyMs: 720 }, { type: "lead", field: "roof_access", value: true }, { type: "lead", field: "shadow_free_area", value: "600 sq ft" }]],
      [1100, [{ type: "state", state: "BILL" }, L.agent("Mahine ka bijli bill kitna aata hai, aur provider kaun sa hai?")]],
      [2000, [L.caller("Around 3 hazaar aata hai, MSEDCL hai."), { type: "metric", replyMs: 860 }, { type: "lead", field: "monthly_bill", value: 3000 }, { type: "lead", field: "discom", value: "MSEDCL" }]],
      [1100, [{ type: "state", state: "LOCATION_TIMELINE" }, L.agent("Aap kis shehar mein hain, aur install kab tak karwana chahenge?")]],
      [1900, [L.caller("Pune, agle do mahine mein."), { type: "metric", replyMs: 700 }, { type: "lead", field: "city_or_pincode", value: "Pune" }, { type: "lead", field: "timeline", value: "Within 2 months" }]],
      [1100, [{ type: "state", state: "FINANCE" }, L.agent("Kya aap loan ya PM Surya Ghar subsidy ke baare mein jaanna chahenge?")]],
      [1700, [L.caller("Subsidy ke baare mein batayein, loan nahi chahiye."), { type: "metric", replyMs: 780 }, { type: "lead", field: "loan_interest", value: false }, { type: "lead", field: "subsidy_interest", value: true }]],
      [1100, [{ type: "state", state: "MEETING_PITCH" }, L.agent("Hamare surveyor aapke ghar aa sakte hain. Kal shaam 5 baje theek rahega?")]],
      [1700, [L.caller("Haan, kal shaam 5 baje chalega."), { type: "metric", replyMs: 650 }, { type: "lead", field: "meeting_slot", value: "Tomorrow, 5 pm" }]],
      [1100, [{ type: "state", state: "WRAP_UP" }, L.agent("Dhanyavaad. Aapka slot confirm hai. Surveyor se call aayega.")]],
      [1400, [{ type: "state", state: "DONE" }, { type: "outcome", outcome: "qualified" }]]
    ];
    let timers = [], stopped = false;
    return {
      async start(emit, onEnd) {
        let t = 0;
        script.forEach(([delay, events]) => { t += delay; timers.push(setTimeout(() => events.forEach(emit), t)); });
        timers.push(setTimeout(() => !stopped && onEnd("Call ended by agent"), t + 800));
      },
      stop() { stopped = true; timers.forEach(clearTimeout); }
    };
  }

  /* ---------- Live session (LiveKit + backend) ---------- */
  async function liveSession(opts) {
    const base = CFG.backendUrl.replace(/\/$/, "");
    let room = null;
    return {
      async start(emit, onEnd) {
        if (opts.mode === "phone") {
          const r = await fetch(base + "/api/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: opts.phone, language: opts.language }) });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not place the call.");
          opts.room = (await r.json()).room;
        }
        const r = await fetch(base + "/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: opts.language, room: opts.room || null, listenOnly: opts.mode === "phone" }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not get a room token.");
        const { url, token } = await r.json();
        await loadScript(CFG.livekitClientSrc);
        const LK = window.LivekitClient;
        room = new LK.Room({ adaptiveStream: true });
        room.on(LK.RoomEvent.TrackSubscribed, (track) => { if (track.kind === "audio") track.attach(); });
        room.on(LK.RoomEvent.DataReceived, (payload, _p, _k, topic) => {
          if (topic && topic !== CFG.eventsTopic) return;
          try { emit(JSON.parse(new TextDecoder().decode(payload))); } catch (e) { console.warn("Bad event", e); }
        });
        room.on(LK.RoomEvent.Disconnected, () => onEnd("Call ended"));
        await room.connect(url, token);
        if (opts.mode === "browser") await room.localParticipant.setMicrophoneEnabled(true);
      },
      stop() { room?.disconnect(); }
    };
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.LivekitClient) return res();
      const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load the LiveKit client."));
      document.head.appendChild(s);
    });
  }

  /* ---------- Wiring ---------- */
  function init() {
    const live = !!CFG.backendUrl;
    $("source-chip").dataset.source = live ? "live" : "demo";
    $("source-label").textContent = live ? "Live" : "Demo mode";
    setIcon($("source-chip"), live ? "radio" : "flask-conical");

    document.querySelectorAll(".seg__btn").forEach((b) => b.addEventListener("click", () => {
      store.mode = b.dataset.mode;
      document.querySelectorAll(".seg__btn").forEach((x) => { const on = x === b; x.classList.toggle("is-active", on); x.setAttribute("aria-selected", on); });
      $("phone-field").hidden = store.mode !== "phone";
    }));

    $("call-btn").addEventListener("click", () => {
      if (store.callState === "live" || store.callState === "connecting") end("Call ended by you");
      else if (store.mode === "phone" && !/^\+?[0-9 ()-]{10,16}$/.test($("phone").value.trim())) { $("phone").focus(); setStatus("error", "Enter a valid number"); }
      else start();
    });
    $("handoff-btn").addEventListener("click", () => { addSystem("Handoff requested. A team member will take over."); store.session?.handoff?.(); });
    $("copy-json").addEventListener("click", async () => {
      const rec = JSON.stringify({ outcome: store.outcome, lead: store.lead }, null, 2);
      try { await navigator.clipboard.writeText(rec); $("copy-json").lastChild.textContent = "Copied"; setTimeout(() => ($("copy-json").lastChild.textContent = "Copy record as JSON"), 1500); } catch (_) { /* clipboard blocked */ }
    });

    renderSteps(null); renderLead(); renderMetrics(); icons();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
