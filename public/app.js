const POLL_INTERVAL = 5000;
const STALE_THRESHOLD_MIN = 10;

let selectedSid = null;
let examineCache = {};
let obsidianCache = {};
let claudeUsage = null;
let closeTargetSid = null;
let closeTargetName = null;

// ── Helpers ──

function relTime(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  if (isNaN(d)) return "--";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 0) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function shortTime(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  if (isNaN(d)) return "--";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortPath(p) {
  if (!p) return "--";
  const parts = p.split("/");
  const idx = parts.indexOf(".worktrees");
  if (idx >= 0) return ".worktrees/" + parts.slice(idx + 1).join("/");
  return parts.slice(-2).join("/");
}

function usageLevel(n) {
  if (n == null || Number.isNaN(Number(n))) return "loading";
  const v = Number(n);
  if (v > 80) return "crit";
  if (v > 50) return "warn";
  return "ok";
}

function isResetPending(session) {
  if (!session?.resets_at) return false;
  const pct = Number(session.utilization);
  const resetMs = new Date(session.resets_at).getTime();
  return pct >= 95 && resetMs <= Date.now() + 60_000;
}

function esc(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => (btn.textContent = orig), 1200);
  } catch {}
}

// ── Worker State Classification ──

// Find the most recent event matching a worker by session_id or name
function lastEventOfType(w, ...types) {
  // lastEvents is ordered oldest-first; scan from the end
  for (let i = lastEvents.length - 1; i >= 0; i--) {
    const e = lastEvents[i];
    const matchesWorker =
      e.session_id === w.session_id ||
      e.worker_id === w.session_id ||
      (e.data && (e.data.session_id === w.session_id || e.data.name === w.name));
    if (matchesWorker && types.includes(e.type)) return e;
  }
  return null;
}

function classifyWorker(w) {
  const status = (w.status || "").toLowerCase();
  const lastActivity = w.last_activity ? new Date(w.last_activity) : null;
  const agoMin = lastActivity ? (Date.now() - lastActivity.getTime()) / 60000 : Infinity;

  // Explicitly closed or done
  if (status === "closed" || status === "completed" || status === "exited") {
    return "closed";
  }

  // Event-aware: check if the worker went idle and never came back active
  const idleEvt = lastEventOfType(w, "worker_idle", "state_change");
  const activeEvt = lastEventOfType(w, "worker_active");

  const wentIdle =
    idleEvt &&
    (idleEvt.type === "worker_idle" ||
      (idleEvt.type === "state_change" &&
        (idleEvt.data?.state === "idle" || idleEvt.data?.state === "done")));
  const idleTs = wentIdle ? new Date(idleEvt.ts).getTime() : 0;
  const activeTs = activeEvt ? new Date(activeEvt.ts).getTime() : 0;

  // If worker went idle *after* its last active event → likely done / awaiting review.
  // Trust the event stream even when list_workers hasn't updated w.is_idle yet.
  if (wentIdle && idleTs > activeTs) {
    return "done";
  }

  // Idle: explicitly flagged or status says so
  if (w.is_idle || status === "idle" || status === "waiting" || status === "paused") {
    // If idle for a very long time with no idle event trail, it's stale
    if (agoMin > 30 && !wentIdle) return "stale";
    // Even with idle flag, if the idle event is recent treat as done
    return "done";
  }

  // Stale: no activity for a while but not explicitly idle/closed
  if (agoMin > STALE_THRESHOLD_MIN) {
    return "stale";
  }

  return "active";
}

const STATE_LABELS = {
  active: "active",
  idle: "idle",
  done: "awaiting review",
  stale: "stale",
  closed: "closed",
};

function stateLabel(state) {
  return STATE_LABELS[state] || state;
}

// ── API Helpers ──

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Actions ──

window.actionCopy = function (ev, text, btn) {
  if (ev) ev.stopPropagation();
  copyText(text, btn);
};

window.actionInspect = function (ev, sid) {
  if (ev) ev.stopPropagation();
  selectedSid = sid;
  // Always fetch fresh examine data
  fetch(`/api/examine?id=${encodeURIComponent(sid)}`)
    .then((r) => r.json())
    .then((data) => {
      examineCache[sid] = data;
      renderDetail();
      renderAll();
    })
    .catch((err) => console.error("Inspect error:", err));
};

window.actionClose = function (ev, sid) {
  if (ev) ev.stopPropagation();
  const worker = lastWorkers.find((w) => w.session_id === sid);
  closeTargetSid = sid;
  closeTargetName = worker?.name || sid;
  document.getElementById("close-modal-text").textContent = `Are you sure you want to close ${closeTargetName}?`;
  document.getElementById("close-modal").classList.remove("hidden");
};

window.closeCloseModal = function () {
  document.getElementById("close-modal").classList.add("hidden");
  closeTargetSid = null;
  closeTargetName = null;
};

let msgTargetSid = null;
window.actionMessage = function (ev, sid) {
  if (ev) ev.stopPropagation();
  msgTargetSid = sid;
  document.getElementById("msg-modal").classList.remove("hidden");
  document.getElementById("msg-input").focus();
};

window.closeModal = function () {
  document.getElementById("msg-modal").classList.add("hidden");
  document.getElementById("msg-input").value = "";
  msgTargetSid = null;
};

document.getElementById("msg-send-btn").addEventListener("click", async () => {
  const msg = document.getElementById("msg-input").value.trim();
  if (!msg || !msgTargetSid) return;
  try {
    await apiPost("/api/action/message", { session_id: msgTargetSid, message: msg });
    closeModal();
  } catch (err) {
    console.error("Message error:", err);
  }
});

document.getElementById("close-confirm-btn").addEventListener("click", async () => {
  if (!closeTargetSid) return;
  try {
    await apiPost("/api/action/close", { session_id: closeTargetSid });
    closeCloseModal();
    if (selectedSid === closeTargetSid) selectedSid = null;
    poll();
  } catch (err) {
    console.error("Close error:", err);
  }
});

// ── Rendering ──

function renderWorkerCard(w) {
  const state = classifyWorker(w);
  const selected = selectedSid === w.session_id;
  const examine = examineCache[w.session_id];
  const msgCount = examine?.conversation_stats?.total_messages ?? w.message_count ?? "--";

  return `
    <div class="worker-card ${selected ? "selected" : ""}" data-sid="${esc(w.session_id)}">
      <div class="card-header">
        <span class="worker-name" onclick="actionInspect(event, '${esc(w.session_id)}')">
          <span class="pulse ${state}"></span>
          ${esc(w.name)}
        </span>
        <span class="status-badge ${state}">${stateLabel(state)}</span>
      </div>
      ${w.coordinator_badge ? `<div class="card-badge">${esc(w.coordinator_badge)}</div>` : ""}
      <dl class="card-meta">
        <dt>created</dt><dd>${relTime(w.created_at)}</dd>
        <dt>activity</dt><dd>${relTime(w.last_activity)}</dd>
        <dt>msgs</dt><dd>${msgCount}</dd>
        <dt>agent</dt><dd>${esc(w.agent_type || "claude")}</dd>
      </dl>
      <div class="card-actions">
        <button class="btn-ghost" onclick="actionInspect(event, '${esc(w.session_id)}')">inspect</button>
        ${w.worktree_path ? `<button class="btn-ghost" onclick="actionCopy(event, '${esc(w.worktree_path)}', this)">copy path</button>` : ""}
        <button class="btn-ghost" onclick="actionMessage(event, '${esc(w.session_id)}')">message</button>
        ${state === "done" ? `<button class="btn-ghost" style="color:var(--cyan)" onclick="actionClose(event, '${esc(w.session_id)}')">dismiss</button>` : state !== "closed" ? `<button class="btn-ghost" style="color:var(--red)" onclick="actionClose(event, '${esc(w.session_id)}')">close</button>` : ""}
      </div>
    </div>
  `;
}

function renderDetail() {
  const panel = document.getElementById("detail-panel");
  const body = document.getElementById("detail-body");
  const title = document.getElementById("detail-title");
  const main = document.querySelector("main");

  if (!selectedSid) {
    panel.classList.add("hidden");
    main.classList.remove("has-detail");
    return;
  }

  const w = lastWorkers.find((w) => w.session_id === selectedSid);
  if (!w) {
    panel.classList.add("hidden");
    main.classList.remove("has-detail");
    return;
  }

  panel.classList.remove("hidden");
  main.classList.add("has-detail");

  const examine = examineCache[w.session_id];
  const state = classifyWorker(w);
  const preview = examine?.conversation_stats?.last_assistant_preview;
  const obsidian = obsidianCache[w.name];

  title.textContent = w.name || "Worker";

  let html = `
    <div class="detail-section">
      <div class="detail-section-title">Status</div>
      <span class="status-badge ${state}" style="display:inline-block;margin-bottom:8px">${stateLabel(state)}</span>
      <dl class="detail-kv">
        <dt>session</dt><dd>${esc(w.session_id)}</dd>
        <dt>terminal</dt><dd>${esc(w.terminal_id || "--")}</dd>
        <dt>raw status</dt><dd>${esc(w.status || "--")}</dd>
        <dt>created</dt><dd>${relTime(w.created_at)}</dd>
        <dt>last activity</dt><dd>${relTime(w.last_activity)}</dd>
        <dt>agent</dt><dd>${esc(w.agent_type || "claude")}</dd>
      </dl>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Paths</div>
      <dl class="detail-kv">
        <dt>worktree</dt>
        <dd class="path-row">
          <span>${esc(shortPath(w.worktree_path))}</span>
          ${w.worktree_path ? `<button class="btn-ghost" onclick="actionCopy(event, '${esc(w.worktree_path)}', this)">copy</button>` : ""}
        </dd>
        <dt>project</dt>
        <dd class="path-row">
          <span>${esc(shortPath(w.project_path))}</span>
          ${w.project_path ? `<button class="btn-ghost" onclick="actionCopy(event, '${esc(w.project_path)}', this)">copy</button>` : ""}
        </dd>
      </dl>
    </div>
  `;

  if (examine) {
    const stats = examine.conversation_stats || {};
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Conversation</div>
        <dl class="detail-kv">
          <dt>messages</dt><dd>${stats.total_messages ?? "--"}</dd>
          <dt>user msgs</dt><dd>${stats.user_messages ?? "--"}</dd>
          <dt>asst msgs</dt><dd>${stats.assistant_messages ?? "--"}</dd>
          <dt>tool calls</dt><dd>${stats.tool_use_count ?? "--"}</dd>
        </dl>
      </div>
    `;
    if (preview) {
      html += `
        <div class="detail-section">
          <div class="detail-section-title">Last Assistant Output</div>
          <div class="assistant-preview">
            <span class="label">Preview</span>${esc(preview)}
          </div>
        </div>
      `;
    }
  }

  // Obsidian integration
  if (obsidian) {
    if (obsidian.found) {
      html += `
        <div class="obsidian-note found">
          Session note found: ${esc(obsidian.path)}
        </div>
      `;
    } else {
      html += `
        <div class="obsidian-note missing">
          No session note. Suggested: ${esc(obsidian.suggestion)}
        </div>
      `;
    }
  }

  html += `
    <div class="card-actions" style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
      <button class="btn btn-secondary" onclick="actionInspect(event, '${esc(w.session_id)}')">Refresh</button>
      <button class="btn btn-secondary" onclick="actionMessage(event, '${esc(w.session_id)}')">Message</button>
      ${state !== "closed" && state !== "done" ? `<button class="btn btn-danger" onclick="actionClose(event, '${esc(w.session_id)}')">Close Worker</button>` : ""}
      ${state === "done" ? `<button class="btn btn-danger" onclick="actionClose(event, '${esc(w.session_id)}')">Dismiss</button>` : ""}
    </div>
  `;

  body.innerHTML = html;
}

function renderEvents(events) {
  if (!events || events.length === 0) {
    return '<div class="empty-state">No events yet</div>';
  }
  return events
    .slice()
    .reverse()
    .slice(0, 40)
    .map((e) => {
      const name = e.data?.name || e.worker_id || "";
      const type = e.type || "unknown";
      let detail = "";
      if (type === "worker_started") detail = `${name} started`;
      else if (type === "worker_closed") detail = `${name} closed`;
      else if (type === "worker_idle") detail = `${name} idle (awaiting review)`;
      else if (type === "worker_active") detail = `${name} resumed`;
      else if (type === "state_change") detail = `${name}: ${e.data?.previous_state || "?"} → ${e.data?.state || "?"}`;
      else if (type === "snapshot") detail = `${e.data?.count ?? 0} workers`;
      else detail = name;

      return `
        <div class="event-item ${esc(type)}">
          <div class="event-header">
            <span class="event-ts">${shortTime(e.ts)}</span>
            <span class="event-type">${esc(type.replace(/_/g, " "))}</span>
          </div>
          <div class="event-detail">${esc(detail)}</div>
        </div>
      `;
    })
    .join("");
}

// ── State ──

let lastWorkers = [];
let lastEvents = [];
let connOk = false;

function renderAll() {
  const grid = document.getElementById("workers-grid");
  if (lastWorkers.length === 0) {
    grid.innerHTML = '<div class="empty-state">No workers found</div>';
  } else {
    grid.innerHTML = lastWorkers.map(renderWorkerCard).join("");
  }

  // Summary counts
  const counts = {};
  for (const w of lastWorkers) {
    const s = classifyWorker(w);
    counts[s] = (counts[s] || 0) + 1;
  }

  document.getElementById("stat-total").textContent = lastWorkers.length;
  document.getElementById("stat-active").textContent = counts.active || 0;
  document.getElementById("stat-done").textContent = counts.done || 0;
  document.getElementById("stat-stale").textContent = counts.stale || 0;
  document.getElementById("stat-closed").textContent = counts.closed || 0;

  // Highlight stale if any
  const staleStat = document.querySelector(".stat-stale");
  staleStat.classList.toggle("highlight", (counts.stale || 0) > 0);

  // Events
  document.getElementById("events-list").innerHTML = renderEvents(lastEvents);

  // Claude usage badge
  const badge = document.getElementById("claude-usage-badge");
  if (badge) {
    const usageError = claudeUsage?.error;
    const s = claudeUsage?.session?.utilization;
    const w = claudeUsage?.weekly?.utilization;
    const pendingReset = isResetPending(claudeUsage?.session);
    const badgeLevel = usageError ? "crit" : (pendingReset ? "warn" : ([usageLevel(s), usageLevel(w)].includes("crit") ? "crit" : ([usageLevel(s), usageLevel(w)].includes("warn") ? "warn" : ([usageLevel(s), usageLevel(w)].includes("ok") ? "ok" : "loading"))));
    badge.className = `usage-badge ${badgeLevel}`;
    document.getElementById("usage-session").textContent = usageError ? "usage error" : (s != null ? `${s}% session` : "--");
    document.getElementById("usage-reset").textContent = usageError ? "provider failed" : (claudeUsage?.session?.resets_in ? `resets in ${claudeUsage.session.resets_in}` : "--");
    document.getElementById("usage-weekly").textContent = usageError ? "check tooltip" : (w != null ? `${w}% week` : "--");
    const noteEl = document.getElementById("usage-note");
    if (usageError) {
      noteEl.classList.remove("hidden");
      noteEl.textContent = "usage unavailable";
    } else if (pendingReset) {
      noteEl.classList.remove("hidden");
      noteEl.textContent = "reset pending";
    } else {
      noteEl.classList.add("hidden");
    }
    badge.title = usageError ? `Claude usage provider error: ${usageError}` : (claudeUsage?.session ? `Claude session ${s}% · resets in ${claudeUsage.session.resets_in} | weekly ${w}% · resets in ${claudeUsage.weekly.resets_in}` : "Claude Code usage");
  }

  // Timestamp
  document.getElementById("last-update").textContent = "updated " + new Date().toLocaleTimeString("en-GB");

  // Connection indicator
  const ci = document.getElementById("conn-indicator");
  ci.classList.toggle("ok", connOk);
  ci.classList.toggle("error", !connOk);

  // Detail panel
  renderDetail();
}

async function poll() {
  try {
    const [workersRes, eventsRes, usageRes] = await Promise.all([
      fetch("/api/workers").then((r) => r.json()),
      fetch("/api/events").then((r) => r.json()),
      fetch("/api/claude-usage").then((r) => r.json()).catch(() => null),
    ]);
    lastWorkers = workersRes.workers || [];
    lastEvents = eventsRes.events || [];
    claudeUsage = usageRes || { error: 'usage unavailable' };
    connOk = true;

    // Refresh examine cache for selected worker
    if (selectedSid) {
      try {
        const data = await fetch(`/api/examine?id=${encodeURIComponent(selectedSid)}`).then((r) => r.json());
        examineCache[selectedSid] = data;
      } catch {}
    }

    // Fetch obsidian notes for workers we haven't checked
    for (const w of lastWorkers) {
      if (w.name && !obsidianCache[w.name]) {
        fetch(`/api/obsidian?name=${encodeURIComponent(w.name)}`)
          .then((r) => r.json())
          .then((data) => { obsidianCache[w.name] = data; })
          .catch(() => {});
      }
    }
  } catch (err) {
    connOk = false;
    console.error("Poll error:", err);
  }
  renderAll();
}

// ── Init ──

document.getElementById("refresh-btn").addEventListener("click", () => {
  const btn = document.getElementById("refresh-btn");
  btn.classList.add("spinning");
  setTimeout(() => btn.classList.remove("spinning"), 600);
  poll();
});

document.getElementById("detail-close").addEventListener("click", () => {
  selectedSid = null;
  renderAll();
});

// Keyboard shortcut: Escape closes detail/modal
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!document.getElementById("msg-modal").classList.contains("hidden")) {
      closeModal();
    } else if (!document.getElementById("close-modal").classList.contains("hidden")) {
      closeCloseModal();
    } else if (selectedSid) {
      selectedSid = null;
      renderAll();
    }
  }
});

poll();
setInterval(poll, POLL_INTERVAL);
