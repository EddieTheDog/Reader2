/* app.js — BarScan */
'use strict';

// ── State ──────────────────────────────────────────────
let codeReader   = null;
let isScanning   = false;
let isPaused     = false;
let results      = [];
let lastScanned  = null;   // { text, format } of last accepted scan

// Canvas tracking
let rafId        = null;
let trackPoints  = null;   // ResultPoint[] from ZXing
let trackExpiry  = 0;      // timestamp after which highlight fades

const HOLD_MS    = 1200;   // how long green highlight stays solid
const FADE_MS    = 400;    // fade duration after HOLD_MS

// ── DOM refs ───────────────────────────────────────────
const screenIdle    = document.getElementById('screen-idle');
const screenScanner = document.getElementById('screen-scanner');
const cameraSelect  = document.getElementById('camera-select');
const lockSelect    = document.getElementById('lock-select');
const startBtn      = document.getElementById('start-btn');
const stopBtn       = document.getElementById('stop-btn');
const preview       = document.getElementById('preview');
const canvas        = document.getElementById('tracker-canvas');
const ctx           = canvas.getContext('2d');
const vfAim         = document.getElementById('vf-aim');
const modeLbl       = document.getElementById('scanner-mode-label');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const bottomHint    = document.getElementById('bottom-hint');
const bottomResult  = document.getElementById('bottom-result');
const resultFormat  = document.getElementById('bottom-result-format');
const resultText    = document.getElementById('bottom-result-text');
const copyBtn       = document.getElementById('copy-btn');
const nextBtn       = document.getElementById('next-btn');
const resultsList   = document.getElementById('results-list');
const emptyHint     = document.getElementById('empty-hint');
const resultsCount  = document.getElementById('results-count');
const clearBtn      = document.getElementById('clear-btn');

// ── Camera list ────────────────────────────────────────
async function loadCameras() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');

    cameraSelect.innerHTML = '';
    if (!cameras.length) {
      cameraSelect.innerHTML = '<option>No cameras found</option>';
      startBtn.disabled = true;
      return;
    }

    cameras.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      cameraSelect.appendChild(opt);
    });

    // prefer rear camera
    const rear = cameras.find(c => /back|rear|environment/i.test(c.label));
    if (rear) cameraSelect.value = rear.deviceId;
  } catch {
    cameraSelect.innerHTML = '<option>Camera access denied</option>';
    startBtn.disabled = true;
  }
}

// ── Canvas tracking ────────────────────────────────────
function syncCanvasSize() {
  // Match canvas to the actual rendered size of the video element,
  // but use the video's intrinsic resolution for coordinate accuracy.
  const vw = preview.videoWidth  || preview.clientWidth;
  const vh = preview.videoHeight || preview.clientHeight;
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width  = vw;
    canvas.height = vh;
  }
}

function drawTracker() {
  syncCanvasSize();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (trackPoints && trackPoints.length >= 2) {
    const elapsed = Date.now() - trackExpiry + HOLD_MS;
    let alpha;
    if (elapsed < HOLD_MS) {
      alpha = 1;
    } else {
      alpha = Math.max(0, 1 - (elapsed - HOLD_MS) / FADE_MS);
    }

    if (alpha > 0) {
      // ZXing points are in video-intrinsic coordinates.
      // The video element uses object-fit:cover so we need to map them
      // to the canvas (which matches the intrinsic resolution).
      const pts = trackPoints;

      // --- filled polygon (tinted) ---
      ctx.save();
      ctx.globalAlpha = alpha * 0.20;
      ctx.fillStyle = '#39FF14';
      ctx.beginPath();
      pts.forEach((p, i) => {
        i === 0 ? ctx.moveTo(p.getX(), p.getY()) : ctx.lineTo(p.getX(), p.getY());
      });
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // --- green corner brackets at each detected corner ---
      const cornerLen = Math.min(
        canvas.width, canvas.height,
        distBetween(pts[0], pts[1]) * 0.22
      );
      const cornerW = Math.max(3, canvas.width * 0.006);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#39FF14';
      ctx.lineWidth   = cornerW;
      ctx.lineCap     = 'square';

      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const curr = pts[i];
        const prev = pts[(i - 1 + n) % n];
        const next = pts[(i + 1) % n];

        // unit vectors along the two edges from this corner
        const toPrev = unitVec(curr, prev);
        const toNext = unitVec(curr, toNext_pt(pts, i));

        drawCornerBracket(
          ctx,
          curr.getX(), curr.getY(),
          toPrev, toNext,
          cornerLen
        );
      }

      ctx.restore();
    }
  }

  rafId = requestAnimationFrame(drawTracker);
}

function toNext_pt(pts, i) {
  return pts[(i + 1) % pts.length];
}

function distBetween(a, b) {
  const dx = b.getX() - a.getX();
  const dy = b.getY() - a.getY();
  return Math.sqrt(dx * dx + dy * dy);
}

function unitVec(from, to) {
  const dx = to.getX() - from.getX();
  const dy = to.getY() - from.getY();
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return { x: dx / len, y: dy / len };
}

function drawCornerBracket(ctx, x, y, dirA, dirB, len) {
  // Draw two lines from corner (x,y): one toward dirA, one toward dirB
  ctx.beginPath();
  ctx.moveTo(x + dirA.x * len, y + dirA.y * len);
  ctx.lineTo(x, y);
  ctx.lineTo(x + dirB.x * len, y + dirB.y * len);
  ctx.stroke();
}

function startTracker() {
  if (!rafId) rafId = requestAnimationFrame(drawTracker);
}

function stopTracker() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  trackPoints = null;
}

// ── Start scanner ──────────────────────────────────────
async function startScanner() {
  if (isScanning) return;

  const deviceId     = cameraSelect.value || undefined;
  const lockedFormat = lockSelect.value || null;

  try {
    codeReader = new ZXing.BrowserMultiFormatReader();
    isScanning = true;
    isPaused   = false;

    screenIdle.hidden    = true;
    screenScanner.hidden = false;

    modeLbl.textContent = lockedFormat
      ? (lockSelect.options[lockSelect.selectedIndex].text)
      : 'Any format';

    setStatus('scanning');
    startTracker();

    await codeReader.decodeFromVideoDevice(deviceId, 'preview', (result, err) => {
      if (!result || isPaused) return;

      const fmtKey = result.getBarcodeFormat();
      const fmt    = ZXing.BarcodeFormat[fmtKey] || String(fmtKey);

      if (lockedFormat && fmt !== lockedFormat) return;

      const text = result.getText();

      // Capture corners
      try {
        trackPoints  = result.getResultPoints();
        trackExpiry  = Date.now();
      } catch { trackPoints = null; }

      // Pause
      isPaused = true;
      setStatus('paused');
      vfAim.classList.add('hidden');

      // Show result in bottom panel
      resultFormat.textContent = fmt.replace(/_/g, '\u202F');  // narrow no-break space
      resultText.textContent   = text;
      bottomHint.hidden        = true;
      bottomResult.hidden      = false;

      lastScanned = { text, format: fmt };
      addResult(text, fmt);
    });

  } catch (err) {
    stopScanner();
    const m = (err.message || '').toLowerCase();
    alert(m.includes('permission')
      ? 'Camera permission denied. Please allow access and try again.'
      : 'Could not open camera: ' + err.message);
  }
}

// ── Resume ─────────────────────────────────────────────
function resumeScanning() {
  if (!isScanning) return;
  isPaused = false;
  trackPoints = null;
  bottomResult.hidden = true;
  bottomHint.hidden   = false;
  vfAim.classList.remove('hidden');
  setStatus('scanning');
}

// ── Stop ───────────────────────────────────────────────
function stopScanner() {
  stopTracker();
  if (codeReader) { codeReader.reset(); codeReader = null; }
  isScanning = false;
  isPaused   = false;

  screenScanner.hidden = true;
  screenIdle.hidden    = false;

  bottomResult.hidden = true;
  bottomHint.hidden   = false;
  vfAim.classList.remove('hidden');
}

// ── Status ─────────────────────────────────────────────
function setStatus(state) {
  if (state === 'scanning') {
    statusDot.className   = 'status-dot';
    statusText.textContent = 'SCANNING';
  } else {
    statusDot.className   = 'status-dot paused';
    statusText.textContent = 'PAUSED';
  }
}

// ── Copy ───────────────────────────────────────────────
copyBtn.addEventListener('click', () => {
  if (!lastScanned) return;
  navigator.clipboard.writeText(lastScanned.text).then(() => {
    const orig = copyBtn.textContent;
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = orig; }, 1500);
  }).catch(() => {});
});

// ── Results ────────────────────────────────────────────
function addResult(text, format) {
  results.unshift({
    id:     Math.random().toString(36).slice(2),
    text, format,
    time:   new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  });
  if (navigator.vibrate) navigator.vibrate(48);
  renderResults();
}

function renderResults() {
  resultsCount.textContent = results.length;

  if (!results.length) {
    resultsList.innerHTML = '';
    resultsList.appendChild(emptyHint);
    return;
  }

  if (emptyHint.parentNode === resultsList) resultsList.removeChild(emptyHint);

  const existing = new Set([...resultsList.querySelectorAll('.result-row')].map(el => el.dataset.id));
  const live     = new Set(results.map(r => r.id));
  existing.forEach(id => { if (!live.has(id)) resultsList.querySelector(`[data-id="${id}"]`)?.remove(); });

  results.forEach((item, idx) => {
    if (existing.has(item.id)) return;

    const isUrl   = /^https?:\/\//i.test(item.text);
    const display = isUrl
      ? `<a href="${escAttr(item.text)}" target="_blank" rel="noopener">${escHtml(item.text)}</a>`
      : escHtml(item.text);

    const row = document.createElement('div');
    row.className  = 'result-row';
    row.dataset.id = item.id;
    row.innerHTML  = `
      <span class="row-fmt">${escHtml(item.format.replace(/_/g, ' '))}</span>
      <div class="row-body">
        <div class="row-text">${display}</div>
        <div class="row-time">${item.time}</div>
      </div>
      <button class="row-copy" data-id="${item.id}">Copy</button>`;

    idx === 0 && resultsList.firstChild
      ? resultsList.insertBefore(row, resultsList.firstChild)
      : resultsList.appendChild(row);
  });
}

resultsList.addEventListener('click', e => {
  const btn = e.target.closest('.row-copy');
  if (!btn) return;
  const item = results.find(r => r.id === btn.dataset.id);
  if (!item) return;
  navigator.clipboard.writeText(item.text).then(() => {
    const o = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = o; }, 1400);
  }).catch(() => {});
});

clearBtn.addEventListener('click', () => {
  results = [];
  resultsList.innerHTML = '';
  resultsList.appendChild(emptyHint);
  resultsCount.textContent = '0';
});

// ── Escape helpers ─────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Wire buttons ───────────────────────────────────────
startBtn.addEventListener('click', startScanner);
stopBtn.addEventListener('click', stopScanner);
nextBtn.addEventListener('click', resumeScanning);

// ── Boot ───────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Inject the two extra corner spans the CSS needs
  vfAim.innerHTML = '<span class="c3"></span><span class="c4"></span>';
  loadCameras();
});
