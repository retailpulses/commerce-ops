/**
 * Homebliss Ticket Report Viewer — Frontend
 * Talks to Cloudflare Worker at /api/*
 */

const SESSION_KEY = "hb_report_token";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getToken() {
  return sessionStorage.getItem(SESSION_KEY);
}

function setToken(t) {
  sessionStorage.setItem(SESSION_KEY, t);
}

function clearToken() {
  sessionStorage.removeItem(SESSION_KEY);
}

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
  });
  return res;
}

// ── Auth ───────────────────────────────────────────────────────────────────────

async function login(password) {
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!res.ok) return false;
  const data = await res.json();
  if (!data.token) return false;

  setToken(data.token);
  return true;
}

function logout() {
  clearToken();
  showGate();
}

// ── UI: Gate ───────────────────────────────────────────────────────────────────

function showGate() {
  document.getElementById("gate").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("password-input").value = "";
  document.getElementById("gate-error").classList.add("hidden");
}

function showApp() {
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
}

// ── UI: Reports ────────────────────────────────────────────────────────────────

async function loadReportList() {
  const res = await apiFetch("/api/reports");
  if (res.status === 401) {
    clearToken();
    showGate();
    return;
  }
  const data = await res.json();
  const list = document.getElementById("report-list");
  list.innerHTML = "";

  if (!data.reports || data.reports.length === 0) {
    list.innerHTML = '<li style="color:#aaa;padding:10px 20px;font-size:0.8rem;">レポートなし</li>';
    return;
  }

  data.reports.forEach((r) => {
    const li = document.createElement("li");
    const [datePart, timePart] = r.label.split(" ");
    li.innerHTML = `<span>${datePart}</span><span class="report-date">${timePart || ""}</span>`;
    li.dataset.runId = r.run_id;
    li.addEventListener("click", () => loadReport(r.run_id, r.label, li));
    list.appendChild(li);
  });
}

async function loadReport(runId, label, li) {
  // Highlight active
  document.querySelectorAll("#report-list li").forEach((el) => el.classList.remove("active"));
  if (li) li.classList.add("active");

  // Show loading
  const content = document.getElementById("report-view");
  const placeholder = document.getElementById("placeholder");
  const body = document.getElementById("report-body");
  const title = document.getElementById("report-title");

  placeholder.classList.add("hidden");
  content.classList.remove("hidden");
  title.textContent = label;
  body.innerHTML = '<span class="loading"></span> 読み込み中...';

  const res = await apiFetch(`/api/reports/${encodeURIComponent(runId)}`);
  if (res.status === 401) {
    clearToken();
    showGate();
    return;
  }
  if (!res.ok) {
    body.innerHTML = '<p style="color:#e53e3e">レポートの取得に失敗しました。</p>';
    return;
  }

  const markdown = await res.text();
  body.innerHTML = marked.parse(markdown);

  // Make all links open in new tab
  body.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────

async function boot() {
  // If already have a session token, try to go straight to app
  if (getToken()) {
    const res = await apiFetch("/api/reports");
    if (res.ok) {
      showApp();
      await loadReportList();
      return;
    }
    clearToken();
  }
  showGate();
}

// ── Event listeners ────────────────────────────────────────────────────────────

document.getElementById("login-btn").addEventListener("click", async () => {
  const pw = document.getElementById("password-input").value;
  const errEl = document.getElementById("gate-error");
  errEl.classList.add("hidden");

  if (!pw) return;

  try {
    const ok = await login(pw);
    if (ok) {
      showApp();
      await loadReportList();
      return;
    }
    errEl.textContent = "\u30d1\u30b9\u30ef\u30fc\u30c9\u304c\u6b63\u3057\u304f\u3042\u308a\u307e\u305b\u3093";
    errEl.classList.remove("hidden");
  } catch (error) {
    errEl.textContent = "\u30ed\u30b0\u30a4\u30f3\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u3082\u3046\u4e00\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044";
    errEl.classList.remove("hidden");
  }
});

document.getElementById("password-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("login-btn").click();
});

document.getElementById("logout-btn").addEventListener("click", logout);

// Start
boot();
