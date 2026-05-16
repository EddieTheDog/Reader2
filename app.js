/* app.js — BarScan */
'use strict';

// ─── State ────────────────────────────────────────────
let codeReader      = null;   // ZXing reader instance
let isScanning      = false;  // camera is active and searching
let isPaused        = false;  // camera active but we've already caught one
let lockedFormat    = null;   // format string to lock to, or null
let results         = [];

// Canvas tracking
let trackerRaf      = null;
let lastPoints      = null;   // ResultPoint[] from last ZXing result
let trackerFadeTs   = 0;      // timestamp when we should start fading the highlight

const HIGHLIGHT_MS  = 800;    // how long to show highlight before fading

// ─── DOM refs ─────────────────────────────────────────
const cameraSelect   = document.getElementById('camera-select');
const startBtn       = document.getElementById('start-btn');
const stopBtn        = document.getElementById('stop-btn');
const viewfinderCard = document.getElementById('viewfinder-card');
const preview        = document.getElementById('preview');
const canvas         = document.getElementById('tracker-canvas');
const ctx            = canvas.getContext('2d');
const finderOverlay  = document.getElementById('finder-overlay');
const liveDot        = document.getElementById('live-dot');
const liveLabel      = document.getElementById('live-label');
const lockPill       = document.getElementById('lock-pill');
const lockToggle     = document.getElementById('lock-toggle');
const lockFormatName = document.getElementById('lock-format-name');
const pausedOverlay  = document.getElementById('paused-overlay');
const pausedFormat   = document.getElementById('paused-format');
const pausedText     = document.getElementById('paused-text');
const nextBtn        = document.getElementById('next-btn');
const resultsList    = document.getElementById('results-list');
const emptyHint      = document.getElementById('empty-hint');
const resultsCount   = document.getElementById('results-count');
const clearBtn       = document.getElementById('clear-btn');

// ─── Format icons ─────────────────────────────────────
function iconForFormat(fmt) {
  const f = (fmt || '').toUpperCase();
  if (f === 'QR_CODE') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h2v2h-2z M18 14h2 M14 18h2 M18 18h2v2h-2z"/></svg>`;
  if (f === 'PDF_417') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="1"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="8" y1="6" x2="8" y2="18"/><line x1="11" y1="6" x2="11" y2="18"/><line x1="15" y1="6" x2="15" y2="18"/><line x1="18" y1="6" x2="18" y2="18"/></svg>`;
  if (f === 'AZTEC' || f === 'DATA_MATRIX') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 9h6v6H9z"/></svg>`;
  // linear barcodes
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="5" width="20" height="14" rx="1"/><line x1="6" y1="5" x2="6" y2="19"/><line x1="9" y1="5" x2="9" y2="19"/><line x1="11" y1="5" x2="11" y2="19"/><line x1="14" y1="5" x2="14" y2="19"/><line x1="17" y1="5" x2="17" y2="19"/></svg>`;
}

// ─── Camera list ──────────────────────────────────────
async function loadCameras() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');

    cameraSelect.innerHTML = '';
    if (!cameras.length) {
      cameraSelect.innerHTML = '<option value="">No cameras found</option>';
      startBtn.disabled = true;
      return;
    }

    cameras.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      cameraSelect.appendChild(opt);
    });

    const rear = cameras.find(c => /back|rear|environment/i.test(c.label));
    if (rear) cameraSelect.value = rear.deviceId;

  } catch {
    cameraSelect.innerHTML = '<option value="">Camera access denied</option>';
    startBtn.disabled = true;
  }
}

// ─── Canvas tracking loop ─────────────────────────────
function startTrackerLoop() {
  function drawFrame() {
    // Keep canvas sized to video element
    canvas.width  = preview.videoWidth  || preview.clientWidth;
    canvas.height = preview.videoHeight || preview.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (lastPoints && lastPoints.length >= 2) {
      const elapsed = Date.now() - trackerFadeTs;
      const alpha   = elapsed < HIGHLIGHT_MS
        ? 1
        : Math.max(0, 1 - (elapsed - HIGHLIGHT_MS) / 300);

      if (alpha > 0) {
        // Scale result points from video dimensions to canvas dimensions
        const scaleX = canvas.width  / (preview.videoWidth  || canvas.width);
        const scaleY = canvas.height / (preview.videoHeight || canvas.height);

        ctx.save();
        ctx.globalAlpha = alpha;

        // Fill polygon
        ctx.beginPath();
        lastPoints.forEach((pt, i) => {
          const x = pt.getX() * scaleX;
          const y = pt.getY() * scaleY;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle   = 'rgba(0, 122, 255, 0.18)';
        ctx.strokeStyle = 'rgba(0, 122, 255, 0.85)';
        ctx.lineWidth   = 2.5;
        ctx.fill();
        ctx.stroke();

        ctx.restore();
      }
    }

    trackerRaf = requestAnimationFrame(drawFrame);
  }
  trackerRaf = requestAnimationFrame(drawFrame);
}

function stopTrackerLoop() {
  if (trackerRaf) { cancelAnimationFrame(trackerRaf); trackerRaf = null; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  lastPoints = null;
}

// ─── Start scanner ────────────────────────────────────
async function startScanner() {
  if (isScanning) return;

  const deviceId = cameraSelect.value || undefined;

  try {
    codeReader = new ZXing.BrowserMultiFormatReader();
    isScanning = true;
    isPaused   = false;

    viewfinderCard.hidden  = false;
    pausedOverlay.hidden   = true;
    finderOverlay.classList.remove('hidden');
    startBtn.disabled      = true;
    cameraSelect.disabled  = true;

    setLiveState('live');
    startTrackerLoop();

    await codeReader.decodeFromVideoDevice(deviceId, 'preview', (result, err) => {
      if (!result || isPaused) return;

      const fmtKey = result.getBarcodeFormat();
      const fmt    = ZXing.BarcodeFormat[fmtKey] || String(fmtKey);

      // If locked, ignore other formats
      if (lockedFormat && fmt !== lockedFormat) return;

      const text = result.getText();

      // Capture result points for the highlight
      try {
        lastPoints    = result.getResultPoints();
        trackerFadeTs = Date.now();
      } catch { lastPoints = null; }

      // Pause scanning — one at a time
      isPaused = true;
      finderOverlay.classList.add('hidden');
      setLiveState('paused');

      // Show paused state
      pausedFormat.textContent = fmt.replace(/_/g, ' ');
      pausedText.textContent   = text;
      pausedOverlay.hidden     = false;

      // Add to results
      addResult(text, fmt);

      // Show lock pill after first scan (if not already locked)
      if (!lockedFormat) {
        lockFormatName.textContent = fmt.replace(/_/g, ' ');
        lockPill.hidden = false;
      }
    });

  } catch (err) {
    stopScanner();
    const msg = (err.message || '').toLowerCase();
    alert(msg.includes('permission')
      ? 'Camera permission was denied. Please allow camera access and try again.'
      : 'Could not start the camera. ' + (err.message || ''));
  }
}

// ─── Resume (Scan Next) ───────────────────────────────
function resumeScanning() {
  if (!isScanning) return;
  isPaused = false;
  pausedOverlay.hidden = true;
  finderOverlay.classList.remove('hidden');
  lastPoints = null;
  setLiveState(lockedFormat ? 'locked' : 'live');
}

// ─── Stop scanner ─────────────────────────────────────
function stopScanner() {
  stopTrackerLoop();
  if (codeReader) { codeReader.reset(); codeReader = null; }
  isScanning            = false;
  isPaused              = false;
  viewfinderCard.hidden = true;
  pausedOverlay.hidden  = true;
  lockPill.hidden       = true;
  startBtn.disabled     = false;
  cameraSelect.disabled = false;
  setLiveState('live');
}

// ─── Live badge state ─────────────────────────────────
function setLiveState(state) {
  liveDot.className = 'live-dot';
  if (state === 'locked') {
    liveDot.classList.add('locked');
    liveLabel.textContent = 'LOCKED';
  } else if (state === 'paused') {
    liveDot.classList.add('paused');
    liveLabel.textContent = 'PAUSED';
  } else {
    liveLabel.textContent = 'LIVE';
  }
}

// ─── Lock toggle ──────────────────────────────────────
lockToggle.addEventListener('click', () => {
  const isOn = lockToggle.getAttribute('aria-checked') === 'true';
  if (isOn) {
    // Unlock
    lockedFormat = null;
    lockToggle.setAttribute('aria-checked', 'false');
    if (isScanning && !isPaused) setLiveState('live');
  } else {
    // Lock to the format shown in the pill
    lockedFormat = lockFormatName.textContent.replace(/ /g, '_').toUpperCase();
    lockToggle.setAttribute('aria-checked', 'true');
    if (isScanning && !isPaused) setLiveState('locked');
  }
});

// ─── Add result ───────────────────────────────────────
function addResult(text, format) {
  const item = {
    id:     Math.random().toString(36).slice(2),
    text,
    format,
    time:   new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
  results.unshift(item);
  if (navigator.vibrate) navigator.vibrate(50);
  renderResults();
}

// ─── Render results ───────────────────────────────────
function renderResults() {
  resultsCount.textContent = results.length;

  if (!results.length) {
    resultsList.innerHTML = '';
    resultsList.appendChild(emptyHint);
    return;
  }

  if (emptyHint.parentNode === resultsList) resultsList.removeChild(emptyHint);

  const existingIds = new Set([...resultsList.querySelectorAll('.result-row')].map(el => el.dataset.id));
  const stateIds    = new Set(results.map(r => r.id));
  existingIds.forEach(id => { if (!stateIds.has(id)) resultsList.querySelector(`[data-id="${id}"]`)?.remove(); });

  results.forEach((item, idx) => {
    if (existingIds.has(item.id)) return;

    const isUrl   = /^https?:\/\//i.test(item.text);
    const display = isUrl
      ? `<a href="${escAttr(item.text)}" target="_blank" rel="noopener noreferrer">${escHtml(item.text)}</a>`
      : escHtml(item.text);

    const row = document.createElement('div');
    row.className  = 'result-row';
    row.dataset.id = item.id;
    row.innerHTML  = `
      <div class="row-icon">${iconForFormat(item.format)}</div>
      <div class="row-body">
        <div class="row-format">${escHtml(item.format.replace(/_/g, ' '))}</div>
        <div class="row-text">${display}</div>
        <div class="row-time">${item.time}</div>
      </div>
      <button class="row-copy" data-id="${item.id}" aria-label="Copy">Copy</button>
    `;

    if (idx === 0 && resultsList.firstChild) {
      resultsList.insertBefore(row, resultsList.firstChild);
    } else {
      resultsList.appendChild(row);
    }
  });
}

// ─── Copy (delegated) ─────────────────────────────────
resultsList.addEventListener('click', e => {
  const btn = e.target.closest('.row-copy');
  if (!btn) return;
  const item = results.find(r => r.id === btn.dataset.id);
  if (!item) return;
  navigator.clipboard.writeText(item.text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = orig; }, 1600);
  }).catch(() => {});
});

// ─── Clear ────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  results = [];
  resultsList.innerHTML = '';
  resultsList.appendChild(emptyHint);
  resultsCount.textContent = '0';
});

// ─── Button events ────────────────────────────────────
startBtn.addEventListener('click', startScanner);
stopBtn.addEventListener('click', stopScanner);
nextBtn.addEventListener('click', resumeScanning);

// ─── Escape helpers ───────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Init ─────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', loadCameras);
