/* app.js — BarScan */

'use strict';

// ─── State ────────────────────────────────────────────
let codeReader = null;
let isScanning = false;
let results    = [];
let lastText   = null;
let lastTs     = 0;

// ─── DOM refs ─────────────────────────────────────────
const cameraSelect   = document.getElementById('camera-select');
const startBtn       = document.getElementById('start-btn');
const stopBtn        = document.getElementById('stop-btn');
const viewfinderCard = document.getElementById('viewfinder-card');
const preview        = document.getElementById('preview');
const resultsList    = document.getElementById('results-list');
const emptyHint      = document.getElementById('empty-hint');
const resultsCount   = document.getElementById('results-count');
const clearBtn       = document.getElementById('clear-btn');

// ─── Icons by format ──────────────────────────────────
function iconForFormat(fmt) {
  const f = (fmt || '').toUpperCase();

  if (f === 'QR_CODE') return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <path d="M14 14h2v2h-2z M18 14h2 M14 18h2 M18 18h2v2h-2z"/>
    </svg>`;

  if (['CODE_128','CODE_39','CODE_93','EAN_13','EAN_8','UPC_A','UPC_E','ITF','CODABAR','RSS_14','RSS_EXPANDED'].includes(f)) return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <rect x="2" y="5" width="20" height="14" rx="1"/>
      <line x1="6"  y1="5" x2="6"  y2="19"/>
      <line x1="9"  y1="5" x2="9"  y2="19"/>
      <line x1="11" y1="5" x2="11" y2="19"/>
      <line x1="14" y1="5" x2="14" y2="19"/>
      <line x1="17" y1="5" x2="17" y2="19"/>
    </svg>`;

  if (f === 'PDF_417') return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <rect x="2" y="6" width="20" height="12" rx="1"/>
      <line x1="6"  y1="6" x2="6"  y2="18"/>
      <line x1="8"  y1="6" x2="8"  y2="18"/>
      <line x1="11" y1="6" x2="11" y2="18"/>
      <line x1="15" y1="6" x2="15" y2="18"/>
      <line x1="18" y1="6" x2="18" y2="18"/>
    </svg>`;

  // Aztec / DataMatrix / fallback
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="1"/>
      <path d="M9 9h6v6H9z"/>
    </svg>`;
}

// ─── Camera list ──────────────────────────────────────
async function loadCameras() {
  try {
    // Request permission first so labels are available
    await navigator.mediaDevices.getUserMedia({ video: true }).then(s => s.getTracks().forEach(t => t.stop()));
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

    // Prefer rear camera on mobile
    const rear = cameras.find(c => /back|rear|environment/i.test(c.label));
    if (rear) cameraSelect.value = rear.deviceId;

  } catch (err) {
    cameraSelect.innerHTML = '<option value="">Camera access denied</option>';
    startBtn.disabled = true;
  }
}

// ─── Start scanning ───────────────────────────────────
async function startScanner() {
  if (isScanning) return;

  const deviceId = cameraSelect.value || undefined;

  try {
    codeReader = new ZXing.BrowserMultiFormatReader();
    isScanning = true;

    // Show viewfinder, hide setup controls
    viewfinderCard.hidden = false;
    startBtn.disabled = true;
    cameraSelect.disabled = true;

    await codeReader.decodeFromVideoDevice(deviceId, 'preview', (result, err) => {
      if (!result) return;

      const text   = result.getText();
      const fmtKey = result.getBarcodeFormat();
      const fmt    = ZXing.BarcodeFormat[fmtKey] || String(fmtKey);

      // Debounce same value for 2.5s
      const now = Date.now();
      if (text === lastText && now - lastTs < 2500) return;
      lastText = text;
      lastTs   = now;

      addResult(text, fmt);
    });

  } catch (err) {
    stopScanner();
    const msg = (err.message || '').toLowerCase();
    alert(msg.includes('permission')
      ? 'Camera permission was denied. Please allow camera access and try again.'
      : 'Could not start the camera. ' + (err.message || ''));
  }
}

// ─── Stop scanning ────────────────────────────────────
function stopScanner() {
  if (codeReader) {
    codeReader.reset();
    codeReader = null;
  }
  isScanning = false;
  viewfinderCard.hidden = true;
  startBtn.disabled = false;
  cameraSelect.disabled = false;
}

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

  // Remove empty hint
  if (emptyHint.parentNode === resultsList) resultsList.removeChild(emptyHint);

  // Remove rows no longer in state
  const existingIds = new Set([...resultsList.querySelectorAll('.result-row')].map(el => el.dataset.id));
  const stateIds    = new Set(results.map(r => r.id));
  existingIds.forEach(id => { if (!stateIds.has(id)) resultsList.querySelector(`[data-id="${id}"]`)?.remove(); });

  // Prepend new rows
  results.forEach((item, idx) => {
    if (existingIds.has(item.id)) return;

    const isUrl   = /^https?:\/\//i.test(item.text);
    const display = isUrl
      ? `<a href="${escAttr(item.text)}" target="_blank" rel="noopener noreferrer">${escHtml(item.text)}</a>`
      : escHtml(item.text);

    const row = document.createElement('div');
    row.className = 'result-row';
    row.dataset.id = item.id;

    row.innerHTML = `
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

// ─── Copy handler (delegated) ─────────────────────────
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
  results  = [];
  lastText = null;
  resultsList.innerHTML = '';
  resultsList.appendChild(emptyHint);
  resultsCount.textContent = '0';
});

// ─── Button events ────────────────────────────────────
startBtn.addEventListener('click', startScanner);
stopBtn.addEventListener('click', stopScanner);

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
