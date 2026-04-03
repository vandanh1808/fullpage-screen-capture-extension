// ═══════════════════════════════════════════════════════════════════
// DOM references
// ═══════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const dom = {
  startBtn: $("startBtn"),
  startBtnLabel: $("startBtnLabel"),
  status: $("status"),
  progressPanel: $("progressPanel"),
  progressBar: $("progressBar"),
  progressPct: $("progressPct"),
  progressLabel: $("progressLabel"),
  progressParts: $("progressParts"),
  progressETA: $("progressETA"),
  overlapRange: $("overlapRange"),
  overlapValue: $("overlapValue"),
};

const FORMAT_DISPLAY = { pdf: "PDF", longpdf: "Long PDF", zip: "ZIP" };

// ═══════════════════════════════════════════════════════════════════
// Toggle groups
// ═══════════════════════════════════════════════════════════════════

document.querySelectorAll(".toggle-group").forEach((group) => {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest(".toggle-btn");
    if (!btn) return;
    group.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    onSettingsChange();
  });
});

function getToggleValue(groupId) {
  return document.querySelector(`#${groupId} .toggle-btn.active`).dataset.value;
}

function setToggleValue(groupId, value) {
  const group = $(groupId);
  if (!group) return;
  group.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

// ═══════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════

dom.overlapRange.addEventListener("input", () => {
  dom.overlapValue.textContent = dom.overlapRange.value + "%";
});

function onSettingsChange() {
  const isArea = getToggleValue("modeToggle") === "area";
  dom.startBtnLabel.textContent = isArea ? "Select Area & Capture" : "Start Capture";
}

// ═══════════════════════════════════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════════════════════════════════

function setStatus(text, type = "info") {
  dom.status.textContent = text;
  dom.status.className = "status " + type;
  dom.status.classList.remove("hidden");
}

function hideStatus() { dom.status.classList.add("hidden"); }
function showProgress() { dom.progressPanel.classList.remove("hidden"); }
function hideProgress() { dom.progressPanel.classList.add("hidden"); }

function updateProgress(current, total, eta) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  dom.progressBar.style.width = pct + "%";
  dom.progressPct.textContent = pct + "%";
  dom.progressParts.textContent = `${current} / ${total}`;
  dom.progressETA.textContent = eta || "--";
}

function formatETA(seconds) {
  if (seconds <= 0) return "Almost done...";
  if (seconds < 60) return `~${Math.ceil(seconds)}s left`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  return `~${m}m ${s}s left`;
}

function computeETA(current, total, startTime) {
  if (current <= 0 || current >= total) return "Almost done...";
  const elapsed = (Date.now() - startTime) / 1000;
  return formatETA((elapsed / current) * (total - current));
}

// ═══════════════════════════════════════════════════════════════════
// State rendering
// ═══════════════════════════════════════════════════════════════════

function renderState(state) {
  if (state.mode) setToggleValue("modeToggle", state.mode);
  if (state.format) setToggleValue("formatToggle", state.format);
  if (state.overlap !== undefined) {
    dom.overlapRange.value = state.overlap;
    dom.overlapValue.textContent = state.overlap + "%";
  }
  onSettingsChange();

  const renderers = {
    idle: () => {
      dom.startBtn.disabled = false;
      hideProgress();
      hideStatus();
    },
    selecting: () => {
      dom.startBtn.disabled = true;
      hideProgress();
      setStatus("Draw a rectangle on the page to capture", "info");
    },
    capturing: () => {
      dom.startBtn.disabled = true;
      showProgress();
      dom.progressLabel.textContent = state.phase;
      updateProgress(state.current, state.total, computeETA(state.current, state.total, state.startTime));
      hideStatus();
    },
    packing: () => {
      dom.startBtn.disabled = true;
      showProgress();
      dom.progressLabel.textContent = state.phase;
      updateProgress(state.total, state.total, "Processing...");
      hideStatus();
    },
    done: () => {
      dom.startBtn.disabled = false;
      showProgress();
      dom.progressLabel.textContent = "Completed";
      updateProgress(state.total || 1, state.total || 1, "Done!");
      const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
      const label = state.mode === "area" ? "Capture" : (FORMAT_DISPLAY[state.format] || "File");
      setStatus(`${label} saved to Downloads! (${elapsed}s)`, "done");
    },
    error: () => {
      dom.startBtn.disabled = false;
      hideProgress();
      setStatus("Error: " + state.error, "error");
    },
  };

  (renderers[state.status] || renderers.idle)();
}

// ═══════════════════════════════════════════════════════════════════
// Background communication
// ═══════════════════════════════════════════════════════════════════

chrome.runtime.sendMessage({ action: "getState" }, (response) => {
  if (response?.state) renderState(response.state);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "stateUpdate" && msg.state) renderState(msg.state);
});

// ═══════════════════════════════════════════════════════════════════
// Capture trigger
// ═══════════════════════════════════════════════════════════════════

dom.startBtn.addEventListener("click", () => {
  const mode = getToggleValue("modeToggle");
  const format = getToggleValue("formatToggle");
  const overlap = parseInt(dom.overlapRange.value);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return setStatus("No active tab found", "error");

    const tabId = tabs[0].id;
    const action = mode === "area" ? "startAreaSelect" : "startCapture";

    if (mode !== "area") {
      dom.startBtn.disabled = true;
      hideStatus();
      showProgress();
      dom.progressLabel.textContent = "Starting...";
      updateProgress(0, 0, "Estimating...");
    }

    chrome.runtime.sendMessage({ action, tabId, format, overlap }, (res) => {
      if (chrome.runtime.lastError) {
        setStatus("Error: " + chrome.runtime.lastError.message, "error");
        dom.startBtn.disabled = false;
        return;
      }
      if (mode === "area") window.close();
    });
  });
});
