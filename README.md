# Screen Capture - Chrome Extension

A Chrome extension that auto-scrolls and captures entire web pages or selected regions, then exports as **ZIP**, **PDF**, or **Long PDF** (single stitched page).

Works on regular pages, SPAs, PDF viewers (SharePoint, Google Docs), and sites with custom scroll containers. Captures continue in the background even when you switch tabs.

## Features

- **Full Page Capture** - auto-scroll and capture the entire page
- **Select Area Capture** - draw a rectangle, then scroll-capture only that region
- **3 Output Formats**
  - **ZIP** - individual PNG screenshots in a ZIP archive
  - **PDF** - each screenshot as a separate PDF page
  - **Long PDF** - all screenshots stitched into a single continuous PDF page
- **Configurable Overlap** (0-40%) - prevents content from being cut between captures
- **Background Capture** - uses Chrome Debugger Protocol, so captures continue even when the tab is not active
- **Custom Scroll Detection** - auto-detects scrollable containers (not just `window.scrollTo`)
- **Live Progress** - percentage, part count, and ETA; state persists when popup is closed/reopened

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the extension folder
5. The extension icon appears in the toolbar

## Usage

1. Navigate to the page you want to capture
2. Click the extension icon to open the popup
3. Choose **Mode**: `Full Page` or `Select Area`
4. Choose **Format**: `ZIP`, `PDF`, or `Long PDF`
5. Adjust **Overlap** slider (default 15%)
6. Click **Start Capture** (or **Select Area & Capture**)
7. For Select Area: draw a rectangle on the page, press `ESC` to cancel
8. The file is saved to your Downloads folder automatically

## Project Structure

```
fullpage-screen-capture-extension/
├── manifest.json      # Manifest V3 config
├── background.js      # Service worker: CDP capture, scroll, output building
├── popup.html         # Extension popup UI
├── popup.css          # Popup styles
├── popup.js           # Popup logic, state sync, progress display
├── selector.js        # Area selection overlay (injected into page)
├── libs/
│   ├── jszip.min.js   # ZIP archive generation
│   └── jspdf.umd.min.js  # PDF generation
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Architecture

### Capture Pipeline

```
Popup (popup.js)
  │  user clicks "Start Capture"
  ▼
Background (background.js)
  │  1. Attach Chrome Debugger to target tab
  │  2. Detect scrollable container via CDP Runtime.evaluate
  │  3. Capture loop:
  │       screenshot (Page.captureScreenshot)
  │       → scroll (Runtime.evaluate)
  │       → wait interval
  │       → repeat until bottom
  │  4. Detach debugger
  │  5. Build output (ZIP / PDF / Long PDF)
  ▼
Downloads API → file saved
```

### Why Chrome Debugger Protocol?

- `chrome.tabs.captureVisibleTab()` only works on the **active** tab and has rate limits
- CDP `Page.captureScreenshot` captures any tab, even background ones
- CDP `Runtime.evaluate` executes scroll commands without content script throttling

### State Management

Capture state lives in the service worker (`background.js`) and survives popup close/reopen. The popup queries state on open (`getState`) and receives live updates (`stateUpdate` messages).

## Permissions

| Permission   | Purpose                                       |
|-------------|-----------------------------------------------|
| `activeTab`  | Access the current tab for script injection    |
| `scripting`  | Inject the area selector overlay               |
| `downloads`  | Save output files to the Downloads folder      |
| `debugger`   | CDP access for background tab capture & scroll |

## Dependencies

- [JSZip 3.x](https://stuk.github.io/jszip/) - ZIP archive generation
- [jsPDF 2.x](https://github.com/parallax/jsPDF) - PDF document generation

Both are bundled in `libs/` (no npm/build step required).
