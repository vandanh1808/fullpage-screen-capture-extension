/**
 * Find the main scrollable container on the page.
 * Many modern apps (SharePoint, Google Docs, PDF viewers, SPAs) use a
 * scrollable div instead of native window scroll.
 */
function findScrollableElement() {
  // Strategy 1: Check if the page itself scrolls
  if (document.documentElement.scrollHeight > window.innerHeight + 10) {
    const style = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const htmlOverflow = style.overflowY;
    const bodyOverflow = bodyStyle.overflowY;

    // If html/body is not explicitly hidden/clip, window scroll works
    if (htmlOverflow !== "hidden" && bodyOverflow !== "hidden") {
      return null; // use window
    }
  }

  // Strategy 2: Find the deepest, largest scrollable element
  const candidates = [];
  const all = document.querySelectorAll("*");

  for (const el of all) {
    const style = getComputedStyle(el);
    const overflowY = style.overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      const scrollable = el.scrollHeight > el.clientHeight + 10;
      if (scrollable) {
        candidates.push({
          el,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          area: el.clientWidth * el.clientHeight,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Pick the candidate with the largest visible area (most likely the main content)
  candidates.sort((a, b) => b.area - a.area);
  return candidates[0].el;
}

let scrollTarget = null;

function getScrollTarget() {
  if (!scrollTarget) {
    scrollTarget = findScrollableElement();
  }
  return scrollTarget;
}

function getScrollInfo() {
  const target = getScrollTarget();
  if (target) {
    return {
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      viewportHeight: target.clientHeight,
    };
  }
  return {
    scrollTop: window.scrollY,
    scrollHeight: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    ),
    viewportHeight: window.innerHeight,
  };
}

function scrollTo(y) {
  const target = getScrollTarget();
  if (target) {
    target.scrollTop = y;
  } else {
    window.scrollTo(0, y);
  }
}

function getCurrentScroll() {
  const target = getScrollTarget();
  return target ? target.scrollTop : window.scrollY;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getPageInfo") {
    // Reset scroll target detection for each new capture
    scrollTarget = null;

    const info = getScrollInfo();
    const totalParts = Math.ceil(info.scrollHeight / info.viewportHeight);

    // Scroll to top first
    scrollTo(0);

    sendResponse({
      totalHeight: info.scrollHeight,
      viewportHeight: info.viewportHeight,
      totalParts,
      usesCustomScroll: getScrollTarget() !== null,
    });
  } else if (msg.action === "scrollDown") {
    const info = getScrollInfo();
    const newScrollY = getCurrentScroll() + info.viewportHeight;
    const maxScrollY = info.scrollHeight - info.viewportHeight;

    scrollTo(Math.min(newScrollY, maxScrollY));

    // Wait for scroll to settle (important for custom scroll containers)
    requestAnimationFrame(() => {
      setTimeout(() => {
        const actualScrollY = getCurrentScroll();
        const done = actualScrollY >= maxScrollY - 2;
        sendResponse({ done, scrollY: actualScrollY });
      }, 50);
    });

    return true; // keep channel open for async response
  } else if (msg.action === "scrollToTop") {
    scrollTo(0);
    sendResponse({ ok: true });
  }
});
