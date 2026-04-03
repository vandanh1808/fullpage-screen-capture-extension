importScripts("libs/jszip.min.js", "libs/jspdf.umd.min.js");

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const CAPTURE_INTERVAL_MS = 600;
const SCROLL_SETTLE_MS = 500;
const AUTO_RESET_DONE_MS = 30_000;
const AUTO_RESET_ERROR_MS = 10_000;
const DEFAULT_OVERLAP_PCT = 0;
const PDF_WIDTH_MM = 210;
const LONG_PDF_SEAM_BUFFER_MM = 1;

const FORMAT_LABELS = {
  pdf: "Generating PDF...",
  longpdf: "Stitching Long PDF...",
  zip: "Packing ZIP...",
};

// ═══════════════════════════════════════════════════════════════════
// State management
// ═══════════════════════════════════════════════════════════════════

let captureState = {
  status: "idle",
  current: 0,
  total: 0,
  phase: "",
  startTime: 0,
  error: "",
  format: "zip",
  mode: "fullpage",
  overlap: DEFAULT_OVERLAP_PCT,
  downloadFilename: "",
};

let pendingArea = { tabId: null, format: "zip", overlap: DEFAULT_OVERLAP_PCT };

function updateState(patch) {
  Object.assign(captureState, patch);
  broadcastMessage({ action: "stateUpdate", state: { ...captureState } });
}

function resetToIdle() {
  updateState({ status: "idle" });
}

function scheduleAutoReset(status, delayMs) {
  setTimeout(() => {
    if (captureState.status === status) resetToIdle();
  }, delayMs);
}

// ═══════════════════════════════════════════════════════════════════
// Message router
// ═══════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    startCapture: () => handleStartCapture(msg, sendResponse),
    startAreaSelect: () => handleStartAreaSelect(msg, sendResponse),
    areaSelected: () => handleAreaSelected(msg, sender),
    areaSelectCancelled: () => resetToIdle(),
    getState: () => sendResponse({ state: { ...captureState } }),
  };

  const handler = handlers[msg.action];
  if (handler) handler();
  return true;
});

function canStartNew() {
  return captureState.status === "idle" || captureState.status === "done" || captureState.status === "error";
}

function handleStartCapture(msg, sendResponse) {
  if (!canStartNew()) return;

  const overlapPct = msg.overlap ?? DEFAULT_OVERLAP_PCT;
  updateState({
    status: "capturing",
    current: 0,
    total: 0,
    phase: "Starting...",
    startTime: Date.now(),
    error: "",
    format: msg.format,
    mode: "fullpage",
    overlap: overlapPct,
    downloadFilename: "",
  });
  runFullPageCapture(msg.tabId, msg.format, overlapPct);
  sendResponse({ started: true });
}

function handleStartAreaSelect(msg, sendResponse) {
  if (!canStartNew()) return;

  pendingArea = {
    tabId: msg.tabId,
    format: msg.format || "zip",
    overlap: msg.overlap ?? DEFAULT_OVERLAP_PCT,
  };
  updateState({
    status: "selecting",
    mode: "area",
    format: pendingArea.format,
    overlap: pendingArea.overlap,
    startTime: Date.now(),
    error: "",
    downloadFilename: "",
  });
  chrome.scripting.executeScript({
    target: { tabId: msg.tabId },
    files: ["selector.js"],
  });
  sendResponse({ started: true });
}

function handleAreaSelected(msg, sender) {
  const tabId = pendingArea.tabId || (sender.tab && sender.tab.id);
  if (!tabId || !msg.rect) return;

  updateState({
    status: "capturing",
    phase: "Starting area capture...",
    startTime: Date.now(),
    current: 0,
    total: 0,
  });
  runAreaCapture(tabId, pendingArea.format, msg.rect, pendingArea.overlap);
}

// ═══════════════════════════════════════════════════════════════════
// Chrome Debugger Protocol (CDP) helpers
// ═══════════════════════════════════════════════════════════════════

function cdpAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve();
    });
  });
}

function cdpDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve(result);
    });
  });
}

async function cdpCaptureScreenshot(tabId, clip) {
  const params = { format: "png", fromSurface: true };
  if (clip) params.clip = { ...clip, scale: 1 };
  const { data } = await cdpSend(tabId, "Page.captureScreenshot", params);
  return "data:image/png;base64," + data;
}

async function cdpEval(tabId, expression) {
  const result = await cdpSend(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

// ═══════════════════════════════════════════════════════════════════
// In-tab scroll operations (via CDP, works on background tabs)
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect the scrollable container and cache it on `window.__captureScroller`.
 * Returns { scrollHeight, viewportHeight } and resets scroll to top.
 */
function initPageScroller(tabId) {
  return cdpEval(tabId, `(() => {
    function findScroller() {
      if (document.documentElement.scrollHeight > window.innerHeight + 10) {
        const hs = getComputedStyle(document.documentElement).overflowY;
        const bs = getComputedStyle(document.body).overflowY;
        if (hs !== "hidden" && bs !== "hidden") return null;
      }
      let best = null, bestArea = 0;
      for (const el of document.querySelectorAll("*")) {
        const s = getComputedStyle(el);
        if ((s.overflowY === "auto" || s.overflowY === "scroll") &&
            el.scrollHeight > el.clientHeight + 10) {
          const area = el.clientWidth * el.clientHeight;
          if (area > bestArea) { best = el; bestArea = area; }
        }
      }
      return best;
    }
    const scroller = findScroller();
    window.__captureScroller = scroller;
    const scrollHeight = scroller
      ? scroller.scrollHeight
      : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const viewportHeight = scroller ? scroller.clientHeight : window.innerHeight;
    if (scroller) scroller.scrollTop = 0; else window.scrollTo(0, 0);
    return { scrollHeight, viewportHeight };
  })()`);
}

function scrollByStep(tabId, overlapPx) {
  return cdpEval(tabId, `(() => {
    const s = window.__captureScroller;
    const vh = s ? s.clientHeight : window.innerHeight;
    const cur = s ? s.scrollTop : window.scrollY;
    const max = (s ? s.scrollHeight : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)) - vh;
    const target = Math.min(cur + vh - ${overlapPx}, max);
    if (s) s.scrollTop = target; else window.scrollTo(0, target);
    const actual = s ? s.scrollTop : window.scrollY;
    return { done: actual >= max - 2, scrollY: actual };
  })()`);
}

function scrollByAmount(tabId, amount) {
  return cdpEval(tabId, `(() => {
    const s = window.__captureScroller;
    const max = (s ? s.scrollHeight - s.clientHeight : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight);
    const target = Math.min((s ? s.scrollTop : window.scrollY) + ${amount}, max);
    if (s) s.scrollTop = target; else window.scrollTo(0, target);
    const actual = s ? s.scrollTop : window.scrollY;
    return { done: actual >= max - 2 };
  })()`);
}

function scrollToTop(tabId) {
  return cdpEval(tabId, `(() => {
    const s = window.__captureScroller;
    if (s) s.scrollTop = 0; else window.scrollTo(0, 0);
  })()`);
}

// ═══════════════════════════════════════════════════════════════════
// Shared capture loop
// ═══════════════════════════════════════════════════════════════════

/**
 * Core scroll-and-capture loop used by both full-page and area modes.
 *
 * @param {number}   tabId       - Target tab
 * @param {object}   [clip]      - CDP clip rect (null for full viewport)
 * @param {function} scrollFn    - Async function that scrolls and returns { done }
 * @param {number}   estTotal    - Estimated total parts for progress display
 * @param {string}   phasePrefix - Label prefix for progress updates
 * @returns {Promise<string[]>}  - Array of data-URL screenshots
 */
async function captureLoop(tabId, clip, scrollFn, estTotal, phasePrefix) {
  const screenshots = [];
  let partIndex = 0;
  let reachedEnd = false;

  while (true) {
    partIndex++;
    updateState({
      current: partIndex,
      total: Math.max(estTotal, partIndex),
      phase: `${phasePrefix} ${partIndex}...`,
    });

    screenshots.push(await cdpCaptureScreenshot(tabId, clip));

    if (reachedEnd) break;

    const result = await scrollFn();
    reachedEnd = result.done;
    await sleep(CAPTURE_INTERVAL_MS);
  }

  return screenshots;
}

// ═══════════════════════════════════════════════════════════════════
// Capture flows
// ═══════════════════════════════════════════════════════════════════

async function runFullPageCapture(tabId, format, overlapPct) {
  try {
    await cdpAttach(tabId);
    const { scrollHeight, viewportHeight } = await initPageScroller(tabId);

    const overlapPx = Math.round(viewportHeight * (overlapPct / 100));
    const scrollStep = viewportHeight - overlapPx;
    const estTotal = Math.max(1, Math.ceil((scrollHeight - overlapPx) / scrollStep));

    updateState({ total: estTotal });
    await sleep(SCROLL_SETTLE_MS);

    const screenshots = await captureLoop(
      tabId, null,
      () => scrollByStep(tabId, overlapPx),
      estTotal, "Capturing part"
    );

    await scrollToTop(tabId);
    await cdpDetach(tabId);
    await buildAndDownload(tabId, format, screenshots, overlapPct);
  } catch (err) {
    await cdpDetach(tabId).catch(() => {});
    updateState({ status: "error", error: err.message, phase: "Error" });
    scheduleAutoReset("error", AUTO_RESET_ERROR_MS);
  }
}

async function runAreaCapture(tabId, format, rect, overlapPct) {
  try {
    await cdpAttach(tabId);
    const { scrollHeight } = await initPageScroller(tabId);

    const clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const overlapPx = Math.round(rect.height * (overlapPct / 100));
    const scrollStep = rect.height - overlapPx;
    const estTotal = Math.max(1, Math.ceil((scrollHeight - overlapPx) / scrollStep));

    updateState({ total: estTotal });
    await sleep(SCROLL_SETTLE_MS);

    const screenshots = await captureLoop(
      tabId, clip,
      () => scrollByAmount(tabId, scrollStep),
      estTotal, "Capturing area"
    );

    await scrollToTop(tabId);
    await cdpDetach(tabId);
    await buildAndDownload(tabId, format, screenshots, overlapPct);
  } catch (err) {
    await cdpDetach(tabId).catch(() => {});
    updateState({ status: "error", error: err.message, phase: "Error" });
    scheduleAutoReset("error", AUTO_RESET_ERROR_MS);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Output building & download
// ═══════════════════════════════════════════════════════════════════

async function buildAndDownload(tabId, format, screenshots, overlapPct) {
  updateState({
    status: "packing",
    phase: FORMAT_LABELS[format] || "Packing...",
  });

  const filename = generateFilename(tabId, format);
  const builders = {
    longpdf: () => buildLongPDF(screenshots, overlapPct),
    pdf: () => buildMultiPagePDF(screenshots),
    zip: () => buildZIP(screenshots),
  };

  const blob = await (builders[format] || builders.zip)();
  await downloadBlob(blob, await filename);

  updateState({
    status: "done",
    phase: "Completed",
    downloadFilename: await filename,
  });
  scheduleAutoReset("done", AUTO_RESET_DONE_MS);
}

async function generateFilename(tabId, format) {
  const tab = await chrome.tabs.get(tabId);
  let hostname = "page";
  try {
    hostname = new URL(tab.url).hostname.replace(/[^a-z0-9]/gi, "_");
  } catch (_) {}
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const prefixes = { longpdf: "fullpage", pdf: "screenshot", zip: "screenshots" };
  const exts = { longpdf: "pdf", pdf: "pdf", zip: "zip" };
  const prefix = prefixes[format] || "capture";
  const ext = exts[format] || "zip";

  return `${prefix}_${hostname}_${ts}.${ext}`;
}

async function buildZIP(screenshots) {
  const zip = new JSZip();
  for (let i = 0; i < screenshots.length; i++) {
    const base64 = screenshots[i].split(",")[1];
    zip.file(`screenshot_${String(i + 1).padStart(3, "0")}.png`, base64, { base64: true });
  }
  return zip.generateAsync({ type: "blob" });
}

function buildMultiPagePDF(screenshots) {
  const { width, height } = getPngDimensions(screenshots[0]);
  const widthMM = PDF_WIDTH_MM;
  const heightMM = (height / width) * widthMM;

  const { jsPDF } = jspdf;
  const pdf = new jsPDF({
    orientation: width > height ? "landscape" : "portrait",
    unit: "mm",
    format: [widthMM, heightMM],
  });

  for (let i = 0; i < screenshots.length; i++) {
    if (i > 0) pdf.addPage([widthMM, heightMM]);
    pdf.addImage(screenshots[i], "PNG", 0, 0, widthMM, heightMM);
  }
  return pdf.output("blob");
}

function buildLongPDF(screenshots, overlapPct) {
  const { width: imgW, height: imgH } = getPngDimensions(screenshots[0]);
  const scale = PDF_WIDTH_MM / imgW;
  const imgHMM = imgH * scale;

  const overlapMM = Math.round(imgH * (overlapPct / 100)) * scale + LONG_PDF_SEAM_BUFFER_MM;
  const stepMM = imgHMM - overlapMM;
  const totalHMM = imgHMM + stepMM * (screenshots.length - 1);

  const { jsPDF } = jspdf;
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: [PDF_WIDTH_MM, totalHMM],
  });

  for (let i = 0; i < screenshots.length; i++) {
    pdf.addImage(screenshots[i], "PNG", 0, i * stepMM, PDF_WIDTH_MM, imgHMM);
  }
  return pdf.output("blob");
}

// ═══════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════

/** Read width/height from the IHDR chunk of a PNG data-URL (bytes 16–23). */
function getPngDimensions(dataUrl) {
  const bin = atob(dataUrl.split(",")[1]);
  const u32 = (offset) =>
    (bin.charCodeAt(offset) << 24) |
    (bin.charCodeAt(offset + 1) << 16) |
    (bin.charCodeAt(offset + 2) << 8) |
    bin.charCodeAt(offset + 3);
  return { width: u32(16), height: u32(20) };
}

async function downloadBlob(blob, filename) {
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
  await chrome.downloads.download({ url: dataUrl, filename });
}

function broadcastMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
