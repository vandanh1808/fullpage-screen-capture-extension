importScripts("libs/jszip.min.js", "libs/jspdf.umd.min.js");

// ── Persistent state (survives popup close/reopen) ────────────────

let captureState = {
  status: "idle", // idle | selecting | capturing | packing | done | error
  current: 0,
  total: 0,
  phase: "",
  startTime: 0,
  error: "",
  format: "zip",
  mode: "fullpage",
  overlap: 15,
  downloadFilename: "",
};

let pendingAreaTabId = null;
let pendingAreaFormat = "zip";
let pendingAreaOverlap = 15;

function updateState(patch) {
  Object.assign(captureState, patch);
  broadcastMessage({ action: "stateUpdate", state: { ...captureState } });
}

function resetToIdle() {
  updateState({ status: "idle" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "startCapture" && captureState.status === "idle") {
    updateState({
      status: "capturing",
      current: 0,
      total: 0,
      phase: "Starting...",
      startTime: Date.now(),
      error: "",
      format: msg.format,
      mode: "fullpage",
      overlap: msg.overlap ?? 15,
      downloadFilename: "",
    });
    startCapture(msg.tabId, msg.format, msg.overlap ?? 15);
    sendResponse({ started: true });
  } else if (msg.action === "startAreaSelect" && captureState.status === "idle") {
    pendingAreaTabId = msg.tabId;
    pendingAreaFormat = msg.format || "zip";
    pendingAreaOverlap = msg.overlap ?? 15;
    updateState({
      status: "selecting",
      mode: "area",
      format: pendingAreaFormat,
      overlap: pendingAreaOverlap,
      startTime: Date.now(),
      error: "",
      downloadFilename: "",
    });
    chrome.scripting.executeScript({
      target: { tabId: msg.tabId },
      files: ["selector.js"],
    });
    sendResponse({ started: true });
  } else if (msg.action === "areaSelected") {
    const tabId = pendingAreaTabId || (sender.tab && sender.tab.id);
    if (tabId && msg.rect) {
      updateState({
        status: "capturing",
        phase: "Starting area capture...",
        startTime: Date.now(),
        current: 0,
        total: 0,
      });
      startAreaCapture(tabId, pendingAreaFormat, msg.rect, pendingAreaOverlap);
    }
  } else if (msg.action === "areaSelectCancelled") {
    resetToIdle();
  } else if (msg.action === "getState") {
    sendResponse({ state: { ...captureState } });
  }
  return true;
});

// ── Debugger helpers ──────────────────────────────────────────────

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

function debuggerSendCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function captureTab(tabId, clip) {
  const params = { format: "png", fromSurface: true };
  if (clip) {
    params.clip = { ...clip, scale: 1 };
  }
  const result = await debuggerSendCommand(tabId, "Page.captureScreenshot", params);
  return "data:image/png;base64," + result.data;
}

async function evalInTab(tabId, expression) {
  const result = await debuggerSendCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

// ── CDP-based scroll functions (work in background tabs) ──────────

async function getPageInfo(tabId) {
  return await evalInTab(
    tabId,
    `(() => {
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
      const scrollHeight = scroller ? scroller.scrollHeight : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const viewportHeight = scroller ? scroller.clientHeight : window.innerHeight;
      if (scroller) scroller.scrollTop = 0;
      else window.scrollTo(0, 0);
      return { scrollHeight, viewportHeight };
    })()`
  );
}

async function scrollDown(tabId, overlap) {
  return await evalInTab(
    tabId,
    `(() => {
      const scroller = window.__captureScroller;
      const overlapPx = ${overlap};
      const vh = scroller ? scroller.clientHeight : window.innerHeight;
      const currentScroll = scroller ? scroller.scrollTop : window.scrollY;
      const totalHeight = scroller
        ? scroller.scrollHeight
        : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const maxScroll = totalHeight - vh;
      const step = vh - overlapPx;

      const target = Math.min(currentScroll + step, maxScroll);
      if (scroller) scroller.scrollTop = target;
      else window.scrollTo(0, target);

      const actual = scroller ? scroller.scrollTop : window.scrollY;
      return { done: actual >= maxScroll - 2, scrollY: actual };
    })()`
  );
}

async function scrollByAmount(tabId, amount) {
  return await evalInTab(
    tabId,
    `(() => {
      const scroller = window.__captureScroller;
      if (scroller) {
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        scroller.scrollTop = Math.min(scroller.scrollTop + ${amount}, maxScroll);
        return { done: scroller.scrollTop >= maxScroll - 2 };
      } else {
        const maxScroll = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
        window.scrollTo(0, Math.min(window.scrollY + ${amount}, maxScroll));
        return { done: window.scrollY >= maxScroll - 2 };
      }
    })()`
  );
}

async function scrollToTop(tabId) {
  await evalInTab(
    tabId,
    `(() => {
      const scroller = window.__captureScroller;
      if (scroller) scroller.scrollTop = 0;
      else window.scrollTo(0, 0);
    })()`
  );
}

// ── Area capture flow (scroll + clip) ─────────────────────────────

async function startAreaCapture(tabId, format, rect, overlapPct) {
  const MIN_CAPTURE_INTERVAL = 600;

  try {
    await debuggerAttach(tabId);

    const pageInfo = await getPageInfo(tabId);

    const clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };

    const overlap = Math.round(rect.height * (overlapPct / 100));
    const scrollStep = rect.height - overlap;
    const estTotal = Math.max(1, Math.ceil((pageInfo.scrollHeight - overlap) / scrollStep));

    updateState({ total: estTotal });
    await sleep(500);

    const screenshots = [];
    let partIndex = 0;
    let reachedEnd = false;

    while (true) {
      partIndex++;
      updateState({
        current: partIndex,
        total: Math.max(estTotal, partIndex),
        phase: `Capturing area ${partIndex}...`,
      });

      const dataUrl = await captureTab(tabId, clip);
      screenshots.push(dataUrl);

      if (reachedEnd) break;

      const result = await scrollByAmount(tabId, scrollStep);
      reachedEnd = result.done;
      await sleep(MIN_CAPTURE_INTERVAL);
    }

    await scrollToTop(tabId);
    await debuggerDetach(tabId);

    // Build output
    const phaseLabel = { pdf: "Generating PDF...", longpdf: "Stitching Long PDF...", zip: "Packing ZIP..." };
    updateState({
      status: "packing",
      phase: phaseLabel[format] || "Packing...",
    });

    const tab = await chrome.tabs.get(tabId);
    let hostname = "page";
    try {
      hostname = new URL(tab.url).hostname.replace(/[^a-z0-9]/gi, "_");
    } catch (e) {}
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);

    let filename;
    if (format === "longpdf") {
      filename = `fullpage_${hostname}_${timestamp}.pdf`;
      await buildAndDownloadLongPDF(screenshots, filename, overlapPct);
    } else if (format === "pdf") {
      filename = `capture_${hostname}_${timestamp}.pdf`;
      await buildAndDownloadPDF(screenshots, filename);
    } else {
      filename = `captures_${hostname}_${timestamp}.zip`;
      await buildAndDownloadZIP(screenshots, filename);
    }

    updateState({
      status: "done",
      phase: "Completed",
      downloadFilename: filename,
    });

    setTimeout(() => {
      if (captureState.status === "done") resetToIdle();
    }, 30000);
  } catch (err) {
    await debuggerDetach(tabId).catch(() => {});
    updateState({ status: "error", error: err.message, phase: "Error" });
    setTimeout(() => {
      if (captureState.status === "error") resetToIdle();
    }, 10000);
  }
}

// ── Full page capture flow ────────────────────────────────────────

async function startCapture(tabId, format, overlapPct) {
  const MIN_CAPTURE_INTERVAL = 600;

  try {
    await debuggerAttach(tabId);

    const pageInfo = await getPageInfo(tabId);
    const { scrollHeight, viewportHeight } = pageInfo;
    const overlap = Math.round(viewportHeight * (overlapPct / 100));
    const scrollStep = viewportHeight - overlap;
    const estTotal = Math.max(1, Math.ceil((scrollHeight - overlap) / scrollStep));

    updateState({ total: estTotal });
    await sleep(500);

    const screenshots = [];
    let partIndex = 0;
    let reachedEnd = false;

    while (true) {
      partIndex++;
      updateState({
        current: partIndex,
        total: Math.max(estTotal, partIndex),
        phase: `Capturing part ${partIndex}...`,
      });

      const dataUrl = await captureTab(tabId);
      screenshots.push(dataUrl);

      if (reachedEnd) break;

      const result = await scrollDown(tabId, overlap);
      reachedEnd = result.done;
      await sleep(MIN_CAPTURE_INTERVAL);
    }

    await scrollToTop(tabId);
    await debuggerDetach(tabId);

    const phaseLabel = { pdf: "Generating PDF...", longpdf: "Stitching Long PDF...", zip: "Packing ZIP..." };
    updateState({
      status: "packing",
      phase: phaseLabel[format] || "Packing...",
    });

    const tab = await chrome.tabs.get(tabId);
    let hostname = "page";
    try {
      hostname = new URL(tab.url).hostname.replace(/[^a-z0-9]/gi, "_");
    } catch (e) {}
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);

    let filename;
    if (format === "longpdf") {
      filename = `fullpage_${hostname}_${timestamp}.pdf`;
      await buildAndDownloadLongPDF(screenshots, filename, overlapPct);
    } else if (format === "pdf") {
      filename = `screenshot_${hostname}_${timestamp}.pdf`;
      await buildAndDownloadPDF(screenshots, filename);
    } else {
      filename = `screenshots_${hostname}_${timestamp}.zip`;
      await buildAndDownloadZIP(screenshots, filename);
    }

    updateState({
      status: "done",
      phase: "Completed",
      downloadFilename: filename,
    });

    setTimeout(() => {
      if (captureState.status === "done") resetToIdle();
    }, 30000);
  } catch (err) {
    await debuggerDetach(tabId).catch(() => {});
    updateState({ status: "error", error: err.message, phase: "Error" });

    setTimeout(() => {
      if (captureState.status === "error") resetToIdle();
    }, 10000);
  }
}

// ── Output builders ───────────────────────────────────────────────

async function buildAndDownloadZIP(screenshots, filename) {
  const zip = new JSZip();
  for (let i = 0; i < screenshots.length; i++) {
    const base64Data = screenshots[i].split(",")[1];
    const padded = String(i + 1).padStart(3, "0");
    zip.file(`screenshot_${padded}.png`, base64Data, { base64: true });
  }

  const blob = await zip.generateAsync({ type: "blob" });
  await downloadBlob(blob, filename);
}

async function buildAndDownloadLongPDF(screenshots, filename, overlapPct) {
  const { width: imgW, height: imgH } = getPngDimensions(screenshots[0]);

  // Convert overlap percentage to pixels
  const overlapPx = Math.round(imgH * (overlapPct / 100));
  // Effective height per image after removing overlap
  const effectiveH = imgH - overlapPx;

  // Total stitched height: first image full + rest without overlap
  const totalH = imgH + effectiveH * (screenshots.length - 1);

  // PDF dimensions in mm (A4 width as reference)
  const pdfWidthMM = 210;
  const scale = pdfWidthMM / imgW;
  const imgHMM = imgH * scale;
  const effectiveHMM = effectiveH * scale;
  const totalHMM = totalH * scale;

  const { jsPDF } = jspdf;
  const pdf = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: [pdfWidthMM, totalHMM],
  });

  for (let i = 0; i < screenshots.length; i++) {
    const yMM = i * effectiveHMM;
    pdf.addImage(screenshots[i], "PNG", 0, yMM, pdfWidthMM, imgHMM);
  }

  const blob = pdf.output("blob");
  await downloadBlob(blob, filename);
}

async function buildAndDownloadPDF(screenshots, filename) {
  const { width: imgWidthPx, height: imgHeightPx } = getPngDimensions(
    screenshots[0]
  );

  const pdfWidthMM = 210;
  const pdfHeightMM = (imgHeightPx / imgWidthPx) * pdfWidthMM;

  const { jsPDF } = jspdf;
  const pdf = new jsPDF({
    orientation: imgWidthPx > imgHeightPx ? "landscape" : "portrait",
    unit: "mm",
    format: [pdfWidthMM, pdfHeightMM],
  });

  for (let i = 0; i < screenshots.length; i++) {
    if (i > 0) {
      pdf.addPage([pdfWidthMM, pdfHeightMM]);
    }
    pdf.addImage(screenshots[i], "PNG", 0, 0, pdfWidthMM, pdfHeightMM);
  }

  const blob = pdf.output("blob");
  await downloadBlob(blob, filename);
}

// ── Utilities ─────────────────────────────────────────────────────

function getPngDimensions(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const width =
    (binary.charCodeAt(16) << 24) |
    (binary.charCodeAt(17) << 16) |
    (binary.charCodeAt(18) << 8) |
    binary.charCodeAt(19);
  const height =
    (binary.charCodeAt(20) << 24) |
    (binary.charCodeAt(21) << 16) |
    (binary.charCodeAt(22) << 8) |
    binary.charCodeAt(23);
  return { width, height };
}

async function downloadBlob(blob, filename) {
  const reader = new FileReader();
  const dataUrl = await new Promise((resolve) => {
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });

  await chrome.downloads.download({
    url: dataUrl,
    filename: filename,
  });
}

function broadcastMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
