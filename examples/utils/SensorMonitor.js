// examples/utils/SensorMonitor.js
//
// Real-time sensor monitor and telemetry panel for robot models.
// Decodes and inspects all MuJoCo sensor channels (accelerometer,
// gyroscope, force/torque, touch, rangefinder, joint pos/vel, etc.),
// displays live formatted readings, and allows streaming any sensor
// signal directly into the LivePlotter oscilloscope.

import { readNames } from '../mujocoUtils.js';

export const SENSOR_TYPES = {
  0:  { type: 'touch', name: 'Touch', icon: '👆', unit: 'N' },
  1:  { type: 'accelerometer', name: 'Accelerometer', icon: '🏃', unit: 'm/s²' },
  2:  { type: 'velocimeter', name: 'Velocimeter', icon: '🏎️', unit: 'm/s' },
  3:  { type: 'gyro', name: 'Gyroscope', icon: '🧭', unit: 'rad/s' },
  4:  { type: 'force', name: 'Force', icon: '💪', unit: 'N' },
  5:  { type: 'torque', name: 'Torque', icon: '🔄', unit: 'N·m' },
  6:  { type: 'magnetometer', name: 'Magnetometer', icon: '🧲', unit: 'μT' },
  7:  { type: 'rangefinder', name: 'Rangefinder', icon: '📏', unit: 'm' },
  8:  { type: 'jointpos', name: 'Joint Pos', icon: '⚙️', unit: 'rad' },
  9:  { type: 'jointvel', name: 'Joint Vel', icon: '⚡', unit: 'rad/s' },
  10: { type: 'tendonpos', name: 'Tendon Pos', icon: '🧵', unit: 'm' },
  11: { type: 'tendonvel', name: 'Tendon Vel', icon: '💨', unit: 'm/s' },
  12: { type: 'actuatorpos', name: 'Actuator Pos', icon: '🦾', unit: 'rad' },
  13: { type: 'actuatorvel', name: 'Actuator Vel', icon: '⏩', unit: 'rad/s' },
  14: { type: 'actuatorfrc', name: 'Actuator Force', icon: '💥', unit: 'N' },
  15: { type: 'ballquat', name: 'Ball Quat', icon: '⚽', unit: '' },
  16: { type: 'ballangvel', name: 'Ball AngVel', icon: '🔄', unit: 'rad/s' },
  17: { type: 'framepos', name: 'Frame Pos', icon: '📍', unit: 'm' },
  18: { type: 'framequat', name: 'Frame Quat', icon: '📐', unit: '' },
  19: { type: 'framexaxis', name: 'Frame X', icon: '➡️', unit: '' },
  20: { type: 'frameyaxis', name: 'Frame Y', icon: '⬆️', unit: '' },
  21: { type: 'framezaxis', name: 'Frame Z', icon: '↗️', unit: '' },
  22: { type: 'framelinvel', name: 'Frame LinVel', icon: '🚀', unit: 'm/s' },
  23: { type: 'frameangvel', name: 'Frame AngVel', icon: '💫', unit: 'rad/s' },
  24: { type: 'framelinacc', name: 'Frame LinAcc', icon: '🏎️', unit: 'm/s²' },
  25: { type: 'frameangacc', name: 'Frame AngAcc', icon: '⚡', unit: 'rad/s²' },
  26: { type: 'subtreecom', name: 'Subtree CoM', icon: '⚖️', unit: 'm' },
  27: { type: 'subtreelinvel', name: 'Subtree LinVel', icon: '💨', unit: 'm/s' },
  28: { type: 'subtreeangmom', name: 'Subtree AngMom', icon: '🌀', unit: 'kg·m²/s' },
  29: { type: 'user', name: 'User Sensor', icon: '📊', unit: '' },
  30: { type: 'plugin', name: 'Plugin Sensor', icon: '🔌', unit: '' },
};

export class SensorMonitor {
  constructor(containerEl) {
    this._container = containerEl || document.getElementById('appbody') || document.body;
    this._visible = false;
    this._minimized = false;
    this._sensors = []; // list of sensor specs: { id, name, typeId, type, icon, unit, adr, dim }
    this._currentValues = []; // latest sliced values per sensor
    this._domValueEls = []; // DOM elements caching text references for fast update

    this._panel = null;
    this._listEl = null;
    this._filterEl = null;
    this._countBadgeEl = null;
    this._toggleBtn = null;
    this._livePlotter = null;
    this._plottedSensorIndex = -1;

    this._raf = null;
    this._dirty = false;
    this._lastUpdate = 0;

    this._createPanel();
    this._setupDragging();
  }

  // ── Public API ──────────────────────────────────────────────

  get visible() {
    return this._visible;
  }

  get sensors() {
    return this._sensors;
  }

  show() {
    this._visible = true;
    this._panel.style.display = 'flex';
    if (this._toggleBtn) this._toggleBtn.classList.add('active');
    this._scheduleUpdate();
  }

  hide() {
    this._visible = false;
    this._panel.style.display = 'none';
    if (this._toggleBtn) this._toggleBtn.classList.remove('active');
  }

  toggle() {
    if (this._visible) this.hide();
    else this.show();
  }

  setToggleButton(btn) {
    this._toggleBtn = btn;
    if (btn) {
      btn.addEventListener('click', () => this.toggle());
      this._updateButtonLabel();
    }
  }

  setLivePlotter(plotter) {
    this._livePlotter = plotter;
  }

  /**
   * Called when a scene is loaded or reloaded.
   */
  onModelChanged(model, simulation) {
    this._sensors = [];
    this._currentValues = [];
    this._plottedSensorIndex = -1;

    if (model && model.nsensor > 0) {
      const names = readNames(model, model.name_sensoradr, model.nsensor, 'sensor');
      for (let i = 0; i < model.nsensor; i++) {
        const typeId = model.sensor_type ? model.sensor_type[i] : 29;
        const meta = SENSOR_TYPES[typeId] || { type: 'unknown', name: 'Sensor', icon: '📡', unit: '' };
        const adr = model.sensor_adr ? model.sensor_adr[i] : 0;
        const dim = model.sensor_dim ? model.sensor_dim[i] : 1;

        this._sensors.push({
          id: i,
          name: names[i] || `sensor_${i}`,
          typeId,
          typeName: meta.name,
          icon: meta.icon,
          unit: meta.unit,
          adr,
          dim,
        });
        this._currentValues.push(dim === 1 ? 0 : new Array(dim).fill(0));
      }
    }

    this._rebuildList();
    this._updateButtonLabel();
    this._dirty = true;
  }

  /**
   * Called per frame from the simulation step / render loop.
   */
  sample(simulation, model) {
    if (!simulation || !simulation.sensordata || this._sensors.length === 0) return;

    const data = simulation.sensordata;

    for (let i = 0; i < this._sensors.length; i++) {
      const s = this._sensors[i];
      if (s.dim === 1) {
        this._currentValues[i] = data[s.adr];
      } else {
        const slice = this._currentValues[i];
        for (let d = 0; d < s.dim; d++) {
          slice[d] = data[s.adr + d];
        }
      }
    }

    // Pipe active plotted sensor to LivePlotter if selected
    if (this._livePlotter && this._plottedSensorIndex >= 0) {
      const s = this._sensors[this._plottedSensorIndex];
      if (s) {
        const val = this._currentValues[this._plottedSensorIndex];
        const arr = s.dim === 1 ? [val] : Array.from(val);
        this._livePlotter.sample(arr);
      }
    }

    if (this._visible && !this._minimized) {
      this._dirty = true;
      this._scheduleUpdate();
    }
  }

  /**
   * Returns current sensor telemetry formatted for Python or bridge queries.
   */
  getReadings() {
    const out = {};
    for (let i = 0; i < this._sensors.length; i++) {
      const s = this._sensors[i];
      const v = this._currentValues[i];
      out[s.name] = {
        name: s.name,
        type: s.typeName,
        unit: s.unit,
        dim: s.dim,
        value: s.dim === 1 ? v : Array.from(v),
      };
    }
    return out;
  }

  dispose() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this._panel && this._panel.parentElement) {
      this._panel.parentElement.removeChild(this._panel);
    }
  }

  // ── Internal Helpers ────────────────────────────────────────

  _scheduleUpdate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame((timestamp) => {
      this._raf = null;
      // Throttle DOM text updates to ~30fps (every 33ms)
      if (this._dirty && this._visible && timestamp - this._lastUpdate >= 33) {
        this._lastUpdate = timestamp;
        this._updateDomValues();
        this._dirty = false;
      }
      if (this._visible && this._dirty) {
        this._scheduleUpdate();
      }
    });
  }

  _formatValue(val, dim, unit) {
    const u = unit ? ` ${unit}` : '';
    if (dim === 1) {
      const n = typeof val === 'number' ? val : 0;
      return `${n >= 0 ? ' ' : ''}${n.toFixed(4)}${u}`;
    }
    if (dim === 3) {
      const x = val[0] || 0;
      const y = val[1] || 0;
      const z = val[2] || 0;
      return `X:${x >= 0 ? ' ' : ''}${x.toFixed(3)}  Y:${y >= 0 ? ' ' : ''}${y.toFixed(3)}  Z:${z >= 0 ? ' ' : ''}${z.toFixed(3)}${u}`;
    }
    if (dim === 4) {
      const w = val[0] || 0;
      const x = val[1] || 0;
      const y = val[2] || 0;
      const z = val[3] || 0;
      return `W:${w.toFixed(2)} X:${x.toFixed(2)} Y:${y.toFixed(2)} Z:${z.toFixed(2)}`;
    }
    // Generic multi-dim
    return Array.from(val).map((v) => Number(v).toFixed(3)).join(', ') + u;
  }

  _updateDomValues() {
    for (let i = 0; i < this._sensors.length; i++) {
      const el = this._domValueEls[i];
      if (!el) continue;
      const s = this._sensors[i];
      const val = this._currentValues[i];
      el.textContent = this._formatValue(val, s.dim, s.unit);
    }
  }

  _createPanel() {
    const panel = document.createElement('div');
    panel.id = 'sensor-monitor-panel';
    panel.className = 'sensor-monitor-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div id="sensor-monitor-header" class="sensor-monitor-header">
        <div class="sensor-monitor-title-group">
          <span class="sensor-monitor-icon">⚡</span>
          <span class="sensor-monitor-title">Robot Sensors</span>
          <span id="sensor-count-badge" class="sensor-count-badge">0</span>
        </div>
        <div class="sensor-monitor-actions">
          <button id="sensor-monitor-min" class="sensor-monitor-btn" title="Minimize">_</button>
          <button id="sensor-monitor-close" class="sensor-monitor-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="sensor-monitor-body" class="sensor-monitor-body">
        <div class="sensor-search-box">
          <input type="text" id="sensor-filter-input" class="sensor-filter-input" placeholder="Filter sensors…" />
        </div>
        <div id="sensor-list" class="sensor-list">
          <div class="sensor-empty">No sensors in active model</div>
        </div>
      </div>
    `;

    this._container.appendChild(panel);
    this._panel = panel;
    this._listEl = panel.querySelector('#sensor-list');
    this._filterEl = panel.querySelector('#sensor-filter-input');
    this._countBadgeEl = panel.querySelector('#sensor-count-badge');

    panel.querySelector('#sensor-monitor-close').addEventListener('click', () => this.hide());
    panel.querySelector('#sensor-monitor-min').addEventListener('click', () => this._toggleMinimize());

    this._filterEl.addEventListener('input', (e) => {
      this._applyFilter(e.target.value.toLowerCase().trim());
    });
  }

  _toggleMinimize() {
    this._minimized = !this._minimized;
    const body = this._panel.querySelector('#sensor-monitor-body');
    if (body) body.style.display = this._minimized ? 'none' : 'flex';
    const minBtn = this._panel.querySelector('#sensor-monitor-min');
    if (minBtn) minBtn.textContent = this._minimized ? '▢' : '_';
  }

  _updateButtonLabel() {
    if (!this._toggleBtn) return;
    const n = this._sensors.length;
    this._toggleBtn.textContent = n > 0 ? `⚡ Sensors (${n})` : '⚡ Sensors';
  }

  _applyFilter(query) {
    const cards = this._listEl.querySelectorAll('.sensor-card');
    cards.forEach((card) => {
      const name = card.getAttribute('data-sensor-name') || '';
      const type = card.getAttribute('data-sensor-type') || '';
      const match = !query || name.includes(query) || type.includes(query);
      card.style.display = match ? 'flex' : 'none';
    });
  }

  _rebuildList() {
    if (!this._listEl) return;
    this._listEl.innerHTML = '';
    this._domValueEls = [];

    if (this._countBadgeEl) {
      this._countBadgeEl.textContent = String(this._sensors.length);
    }

    if (this._sensors.length === 0) {
      this._listEl.innerHTML = '<div class="sensor-empty">No sensors in active model</div>';
      return;
    }

    this._sensors.forEach((s, idx) => {
      const card = document.createElement('div');
      card.className = 'sensor-card';
      card.setAttribute('data-sensor-name', s.name.toLowerCase());
      card.setAttribute('data-sensor-type', s.typeName.toLowerCase());

      card.innerHTML = `
        <div class="sensor-card-top">
          <div class="sensor-card-meta">
            <span class="sensor-type-icon">${s.icon}</span>
            <span class="sensor-name" title="${s.name}">${s.name}</span>
            <span class="sensor-type-tag">${s.typeName}</span>
          </div>
          <button class="sensor-plot-btn" data-sensor-idx="${idx}" title="Plot this sensor in LivePlotter">📈 Plot</button>
        </div>
        <div class="sensor-card-val-row">
          <span class="sensor-val" id="sensor-val-${idx}">${this._formatValue(this._currentValues[idx], s.dim, s.unit)}</span>
        </div>
      `;

      const plotBtn = card.querySelector('.sensor-plot-btn');
      plotBtn.addEventListener('click', () => this._togglePlotSensor(idx, plotBtn));

      this._listEl.appendChild(card);
      this._domValueEls[idx] = card.querySelector(`#sensor-val-${idx}`);
    });
  }

  _togglePlotSensor(idx, btn) {
    if (!this._livePlotter) return;

    if (this._plottedSensorIndex === idx) {
      // Disengage plot
      this._plottedSensorIndex = -1;
      btn.classList.remove('active');
      btn.textContent = '📈 Plot';
    } else {
      // Clear previous active button
      this._listEl.querySelectorAll('.sensor-plot-btn').forEach((b) => {
        b.classList.remove('active');
        b.textContent = '📈 Plot';
      });

      this._plottedSensorIndex = idx;
      btn.classList.add('active');
      btn.textContent = '✓ Plotting';

      const s = this._sensors[idx];
      let labels = [];
      if (s.dim === 1) {
        labels = [s.name];
      } else if (s.dim === 3) {
        labels = [`${s.name}.x`, `${s.name}.y`, `${s.name}.z`];
      } else {
        labels = Array.from({ length: s.dim }, (_, i) => `${s.name}[${i}]`);
      }

      this._livePlotter.setLabels(labels);
      this._livePlotter.show();

      // Ensure main plot button is marked active
      const plotBtn = document.getElementById('plot-toggle-button');
      if (plotBtn) plotBtn.classList.add('active');
    }
  }

  _setupDragging() {
    const header = this._panel.querySelector('#sensor-monitor-header');
    if (!header) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initLeft = 0;
    let initTop = 0;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      isDragging = true;
      header.setPointerCapture(e.pointerId);

      startX = e.clientX;
      startY = e.clientY;

      const rect = this._panel.getBoundingClientRect();
      const parentRect = this._container.getBoundingClientRect();

      initLeft = rect.left - parentRect.left;
      initTop = rect.top - parentRect.top;

      this._panel.style.left = `${initLeft}px`;
      this._panel.style.top = `${initTop}px`;

      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const parentRect = this._container.getBoundingClientRect();
      const panelRect = this._panel.getBoundingClientRect();

      const maxLeft = parentRect.width - panelRect.width - 4;
      const maxTop = parentRect.height - panelRect.height - 4;

      const nextLeft = Math.max(4, Math.min(maxLeft, initLeft + dx));
      const nextTop = Math.max(4, Math.min(maxTop, initTop + dy));

      this._panel.style.left = `${nextLeft}px`;
      this._panel.style.top = `${nextTop}px`;
    });

    const endDrag = (e) => {
      if (!isDragging) return;
      isDragging = false;
      try {
        header.releasePointerCapture(e.pointerId);
      } catch (_) {}
    };

    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }
}
