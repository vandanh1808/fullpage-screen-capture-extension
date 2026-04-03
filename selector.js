(() => {
  // Prevent double injection
  if (document.getElementById("__capture-selector-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "__capture-selector-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    cursor: "crosshair",
    background: "rgba(0, 0, 0, 0.15)",
  });

  const selBox = document.createElement("div");
  Object.assign(selBox.style, {
    position: "fixed",
    border: "2px solid #6366f1",
    background: "rgba(99, 102, 241, 0.08)",
    borderRadius: "2px",
    display: "none",
    pointerEvents: "none",
    zIndex: "2147483647",
  });

  // Info tooltip
  const info = document.createElement("div");
  Object.assign(info.style, {
    position: "fixed",
    background: "#1e1b4b",
    color: "#fff",
    padding: "4px 10px",
    borderRadius: "6px",
    fontSize: "12px",
    fontFamily: "system-ui, sans-serif",
    pointerEvents: "none",
    zIndex: "2147483647",
    whiteSpace: "nowrap",
    display: "none",
  });

  // Hint bar
  const hint = document.createElement("div");
  Object.assign(hint.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "#1e1b4b",
    color: "#fff",
    padding: "8px 20px",
    borderRadius: "8px",
    fontSize: "13px",
    fontFamily: "system-ui, sans-serif",
    fontWeight: "500",
    zIndex: "2147483647",
    boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
  });
  hint.textContent = "Draw a rectangle to capture. Press ESC to cancel.";

  document.body.appendChild(overlay);
  document.body.appendChild(selBox);
  document.body.appendChild(info);
  document.body.appendChild(hint);

  let startX, startY, drawing = false;

  function cleanup() {
    overlay.remove();
    selBox.remove();
    info.remove();
    hint.remove();
    document.removeEventListener("keydown", onKeydown);
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      cleanup();
      chrome.runtime.sendMessage({ action: "areaSelectCancelled" });
    }
  }
  document.addEventListener("keydown", onKeydown);

  overlay.addEventListener("mousedown", (e) => {
    startX = e.clientX;
    startY = e.clientY;
    drawing = true;
    selBox.style.display = "block";
    selBox.style.left = startX + "px";
    selBox.style.top = startY + "px";
    selBox.style.width = "0px";
    selBox.style.height = "0px";
    e.preventDefault();
  });

  overlay.addEventListener("mousemove", (e) => {
    if (!drawing) {
      // Show crosshair coordinates
      info.style.display = "block";
      info.style.left = e.clientX + 14 + "px";
      info.style.top = e.clientY + 14 + "px";
      info.textContent = `${e.clientX}, ${e.clientY}`;
      return;
    }

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    selBox.style.left = x + "px";
    selBox.style.top = y + "px";
    selBox.style.width = w + "px";
    selBox.style.height = h + "px";

    info.style.display = "block";
    info.style.left = e.clientX + 14 + "px";
    info.style.top = e.clientY + 14 + "px";
    info.textContent = `${w} x ${h}`;
    e.preventDefault();
  });

  overlay.addEventListener("mouseup", (e) => {
    if (!drawing) return;
    drawing = false;

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    cleanup();

    // Ignore tiny selections (accidental clicks)
    if (w < 5 || h < 5) {
      chrome.runtime.sendMessage({ action: "areaSelectCancelled" });
      return;
    }

    // Send selection in CSS pixels (CDP clip uses CSS coords)
    chrome.runtime.sendMessage({
      action: "areaSelected",
      rect: { x, y, width: w, height: h },
    });
  });
})();
