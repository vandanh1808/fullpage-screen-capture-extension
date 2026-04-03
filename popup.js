const startBtn = document.getElementById("startBtn");
const startBtnLabel = document.getElementById("startBtnLabel");
const statusEl = document.getElementById("status");
const progressPanel = document.getElementById("progressPanel");
const progressBar = document.getElementById("progressBar");
const progressPct = document.getElementById("progressPct");
const progressLabel = document.getElementById("progressLabel");
const progressParts = document.getElementById("progressParts");
const progressETA = document.getElementById("progressETA");
const overlapRange = document.getElementById("overlapRange");
const overlapValue = document.getElementById("overlapValue");

let captureStartTime = 0;

// ── Toggle buttons ───────────────────────────────────────────────

document.querySelectorAll(".toggle-group").forEach((group) => {
  group.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      group.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onSettingsChange();
    });
  });
});

function getToggleValue(groupId) {
  return document.querySelector(`#${groupId} .toggle-btn.active`).dataset.value;
}

function setToggleValue(groupId, value) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.value === value);
  });
}

// ── Overlap slider ───────────────────────────────────────────────

overlapRange.addEventListener("input", () => {
  overlapValue.textContent = overlapRange.value + "%";
});

// ── Settings change ──────────────────────────────────────────────

function onSettingsChange() {
  const mode = getToggleValue("modeToggle");
  startBtnLabel.textContent = mode === "area" ? "Select Area & Capture" : "Start Capture";
}

// ── UI helpers ────────────────────────────────────────────────────

function setStatus(text, type = "info") {
  statusEl.textContent = text;
  statusEl.className = "status " + type;
  statusEl.classList.remove("hidden");
}

function hideStatus() { statusEl.classList.add("hidden"); }
function showProgress() { progressPanel.classList.remove("hidden"); }
function hideProgress() { progressPanel.classList.add("hidden"); }

function updateProgress(current, total, eta) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = pct + "%";
  progressPct.textContent = pct + "%";
  progressParts.textContent = `${current} / ${total}`;
  progressETA.textContent = eta || "--";
}

function formatETA(seconds) {
  if (seconds <= 0) return "Almost done...";
  if (seconds < 60) return `~${Math.ceil(seconds)}s left`;
  const min = Math.floor(seconds / 60);
  const sec = Math.ceil(seconds % 60);
  return `~${min}m ${sec}s left`;
}

function computeETA(current, total, startTime) {
  if (current <= 0 || current >= total) return "Almost done...";
  const elapsed = (Date.now() - startTime) / 1000;
  return formatETA((elapsed / current) * (total - current));
}

// ── Render state from background ──────────────────────────────────

function renderState(state) {
  if (state.mode) setToggleValue("modeToggle", state.mode);
  if (state.format) setToggleValue("formatToggle", state.format);
  if (state.overlap !== undefined) {
    overlapRange.value = state.overlap;
    overlapValue.textContent = state.overlap + "%";
  }
  onSettingsChange();

  if (state.status === "idle") {
    startBtn.disabled = false;
    hideProgress();
    hideStatus();
  } else if (state.status === "selecting") {
    startBtn.disabled = true;
    hideProgress();
    setStatus("Draw a rectangle on the page to capture", "info");
  } else if (state.status === "capturing") {
    startBtn.disabled = true;
    showProgress();
    progressLabel.textContent = state.phase;
    updateProgress(state.current, state.total, computeETA(state.current, state.total, state.startTime));
    hideStatus();
  } else if (state.status === "packing") {
    startBtn.disabled = true;
    showProgress();
    progressLabel.textContent = state.phase;
    updateProgress(state.total, state.total, "Processing...");
    hideStatus();
  } else if (state.status === "done") {
    startBtn.disabled = false;
    showProgress();
    progressLabel.textContent = "Completed";
    updateProgress(state.total || 1, state.total || 1, "Done!");
    const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
    const labels = { pdf: "PDF", longpdf: "Long PDF", zip: "ZIP" };
    const label = state.mode === "area" ? "Capture" : (labels[state.format] || "File");
    setStatus(`${label} saved to Downloads! (${elapsed}s)`, "done");
  } else if (state.status === "error") {
    startBtn.disabled = false;
    hideProgress();
    setStatus("Error: " + state.error, "error");
  }
}

// ── Sync state on open ───────────────────────────────────────────

chrome.runtime.sendMessage({ action: "getState" }, (response) => {
  if (response && response.state) {
    captureStartTime = response.state.startTime;
    renderState(response.state);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "stateUpdate" && msg.state) {
    captureStartTime = msg.state.startTime;
    renderState(msg.state);
  }
});

// ── Start capture ─────────────────────────────────────────────────

startBtn.addEventListener("click", () => {
  const mode = getToggleValue("modeToggle");
  const format = getToggleValue("formatToggle");
  const overlap = parseInt(overlapRange.value);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      setStatus("No active tab found", "error");
      return;
    }
    const tabId = tabs[0].id;

    if (mode === "area") {
      chrome.runtime.sendMessage(
        { action: "startAreaSelect", tabId, format, overlap },
        (response) => {
          if (chrome.runtime.lastError) {
            setStatus("Error: " + chrome.runtime.lastError.message, "error");
            return;
          }
          window.close();
        }
      );
    } else {
      startBtn.disabled = true;
      hideStatus();
      showProgress();
      progressLabel.textContent = "Starting...";
      updateProgress(0, 0, "Estimating...");

      chrome.runtime.sendMessage(
        { action: "startCapture", tabId, format, overlap },
        (response) => {
          if (chrome.runtime.lastError) {
            setStatus("Error: " + chrome.runtime.lastError.message, "error");
            startBtn.disabled = false;
          }
        }
      );
    }
  });
});
