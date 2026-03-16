// LivePlotter.js — lightweight canvas-based oscilloscope for joint data
// Shows up to MAX_TRACES signals scrolling left over a fixed time window.

const MAX_TRACES  = 8;   // max joints plotted at once
const HISTORY_LEN = 300; // samples kept (≈5 s at 60 fps)
const COLORS = [
  '#0a7fff', '#ff5f5f', '#4dff91', '#ffd700',
  '#ff8c00', '#bf7fff', '#00e5ff', '#ff69b4',
];

export class LivePlotter {
  constructor() {
    this._data    = [];   // array of Float32Array ring-buffers, one per trace
    this._labels  = [];
    this._head    = 0;    // write index into ring-buffer
    this._count   = 0;    // samples written so far (capped at HISTORY_LEN)
    this._visible = false;
    this._canvas  = null;
    this._ctx     = null;
    this._panel   = null;
    this._raf     = null;
    this._dirty   = false;
    this._createPanel();
  }

  // ── Public API ────────────────────────────────────────────

  /** Call once per sim step with an array of values (one per trace). */
  sample(values) {
    if (!this._visible || !values || values.length === 0) return;

    const n = Math.min(values.length, MAX_TRACES);

    // (Re)initialise buffers when trace count changes
    if (this._data.length !== n) {
      this._data   = Array.from({ length: n }, () => new Float32Array(HISTORY_LEN));
      this._head   = 0;
      this._count  = 0;
    }

    for (let i = 0; i < n; i++) {
      this._data[i][this._head] = values[i];
    }
    this._head  = (this._head + 1) % HISTORY_LEN;
    this._count = Math.min(this._count + 1, HISTORY_LEN);
    this._dirty = true;
  }

  /** Update signal labels shown in the legend. */
  setLabels(labels) {
    this._labels = labels ? labels.slice(0, MAX_TRACES) : [];
  }

  show() { this._panel.style.display = 'flex'; this._visible = true;  this._scheduleRedraw(); }
  hide() { this._panel.style.display = 'none';  this._visible = false; }
  toggle() { this._visible ? this.hide() : this.show(); }
  get visible() { return this._visible; }

  // ── Internal ──────────────────────────────────────────────

  _scheduleRedraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      if (this._dirty && this._visible) this._draw();
      this._dirty = false;
      if (this._visible) this._scheduleRedraw();
    });
  }

  _draw() {
    const canvas = this._canvas;
    const ctx    = this._ctx;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = '#1e1e1e';
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = Math.round(H * g / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    for (let g = 0; g <= 6; g++) {
      const x = Math.round(W * g / 6) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    if (this._data.length === 0 || this._count < 2) return;

    const n      = this._data.length;
    const nPts   = Math.min(this._count, HISTORY_LEN);
    const xStep  = W / (HISTORY_LEN - 1);

    // Compute global min/max for auto-scaling
    let lo =  Infinity;
    let hi = -Infinity;
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < nPts; k++) {
        const v = this._data[t][k];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const range = hi - lo || 1;
    const pad   = range * 0.1;
    const yLo   = lo - pad;
    const yHi   = hi + pad + pad;

    // Draw each trace
    for (let t = 0; t < n; t++) {
      ctx.beginPath();
      ctx.strokeStyle = COLORS[t % COLORS.length];
      ctx.lineWidth = 1.5;

      for (let k = 0; k < nPts; k++) {
        // Map ring-buffer index to a chronological slot
        const slot = (this._head - nPts + k + HISTORY_LEN) % HISTORY_LEN;
        const v    = this._data[t][slot];
        const x    = k * xStep;
        const y    = H - ((v - yLo) / (yHi - yLo)) * H;

        if (k === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Value label at right edge
      const lastSlot = (this._head - 1 + HISTORY_LEN) % HISTORY_LEN;
      const lastVal  = this._data[t][lastSlot];
      const lastY    = H - ((lastVal - yLo) / (yHi - yLo)) * H;
      ctx.fillStyle  = COLORS[t % COLORS.length];
      ctx.font       = '10px monospace';
      const label    = this._labels[t] || `j${t}`;
      ctx.fillText(`${label}: ${lastVal.toFixed(3)}`, 4, Math.max(12, Math.min(H - 4, lastY - 2)));
    }
  }

  _createPanel() {
    const panel = document.createElement('div');
    panel.id = 'live-plot-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div id="live-plot-header">
        <span>Live Joint Plot</span>
        <div style="display:flex;gap:6px;align-items:center">
          <label style="font-size:11px;color:#aaa">Joints (0–${MAX_TRACES - 1})</label>
          <button id="live-plot-close" title="Close plot">✕</button>
        </div>
      </div>
      <canvas id="live-plot-canvas"></canvas>
    `;
    document.body.appendChild(panel);

    this._panel  = panel;
    this._canvas = panel.querySelector('#live-plot-canvas');
    this._ctx    = this._canvas.getContext('2d');

    panel.querySelector('#live-plot-close').addEventListener('click', () => this.hide());

    // Resize canvas to match its CSS layout size
    const ro = new ResizeObserver(() => this._resizeCanvas());
    ro.observe(this._canvas);
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const c = this._canvas;
    c.width  = c.offsetWidth  || 300;
    c.height = c.offsetHeight || 120;
    this._dirty = true;
  }
}
