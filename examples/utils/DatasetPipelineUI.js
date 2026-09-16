// examples/utils/DatasetPipelineUI.js
//
// Episode Pipeline UI
// Provides a frontend interface to configure, run, monitor, and export
// scripted policy data collection pipelines into LeRobot datasets.

import { DataRecorder } from './dataLogger.js';
import { LeRobotExporter } from './lerobotExporter.js';
import { TEACHER_TASKS } from './macroTeacher.js';

export class DatasetPipelineUI {
  /**
   * @param {object} demo The RoboSpaceDemo instance
   * @param {HTMLElement} [containerEl]
   */
  constructor(demo, containerEl = null) {
    this.demo = demo;
    this.container = containerEl || document.getElementById('appbody') || document.body;

    this.recorder = new DataRecorder({
      fps: 30,
      imageWidth: 224,
      imageHeight: 224,
      robotType: 'franka_panda',
      datasetName: 'robospace_dataset',
    });
    this.demo.dataRecorder = this.recorder;
    this.exporter = new LeRobotExporter(this.recorder);

    this.isRunning = false;
    this._shouldStop = false;
    this._activeTaskKey = 'panda_pick_cube';

    this._panel = null;
    this._hfModal = null;
    this._toggleBtn = null;

    this._createUI();
    this._setupEventListeners();
  }

  show() {
    if (this._panel) {
      this._panel.style.display = 'flex';
      this._updateCameraOptions();
      if (this._toggleBtn) this._toggleBtn.classList.add('active');
    }
  }

  hide() {
    if (this._panel) {
      this._panel.style.display = 'none';
      if (this._toggleBtn) this._toggleBtn.classList.remove('active');
    }
  }

  toggle() {
    if (this._panel && this._panel.style.display !== 'none') {
      this.hide();
    } else {
      this.show();
    }
  }

  setToggleButton(btn) {
    this._toggleBtn = btn;
    if (btn) {
      btn.addEventListener('click', () => this.toggle());
    }
  }

  _createUI() {
    const panel = document.createElement('div');
    panel.id = 'dataset-pipeline-panel';
    panel.className = 'dataset-pipeline-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div class="pipeline-header">
        <div class="pipeline-title-group">
          <span class="pipeline-icon">📦</span>
          <span class="pipeline-title">Dataset Collection Pipeline</span>
          <span class="pipeline-badge">LeRobot v2.0</span>
        </div>
        <div class="pipeline-header-actions">
          <button type="button" id="pipeline-close-btn" class="pipeline-icon-btn" title="Close">✕</button>
        </div>
      </div>

      <div class="pipeline-body">
        <!-- Configuration Form -->
        <div class="pipeline-section" id="pipeline-config-section">
          <div class="pipeline-form-row">
            <label class="pipeline-label">Task / Policy</label>
            <select id="pipeline-task-select" class="pipeline-select">
              <option value="panda_pick_cube">Franka Panda — Pick Cube</option>
              <option value="panda_pick_and_place">Franka Panda — Pick & Place</option>
              <option value="panda_stack_blocks">Franka Panda — Stack Blocks</option>
              <option value="ur5e_reach_beacon">UR5e — Reach Beacon</option>
              <option value="custom_script">Current Editor Script</option>
            </select>
          </div>

          <div class="pipeline-form-grid">
            <div class="pipeline-form-col">
              <label class="pipeline-label">Episodes</label>
              <input type="number" id="pipeline-episodes-input" class="pipeline-input" min="1" max="500" value="10" />
            </div>
            <div class="pipeline-form-col">
              <label class="pipeline-label">Frequency (Hz)</label>
              <select id="pipeline-fps-select" class="pipeline-select">
                <option value="30" selected>30 Hz (Standard)</option>
                <option value="20">20 Hz</option>
                <option value="10">10 Hz</option>
              </select>
            </div>
          </div>

          <div class="pipeline-form-grid">
            <div class="pipeline-form-col">
              <label class="pipeline-label">Camera</label>
              <select id="pipeline-camera-select" class="pipeline-select">
                <option value="">Auto-detected (Gripper/Wrist)</option>
              </select>
            </div>
            <div class="pipeline-form-col">
              <label class="pipeline-label">Resolution</label>
              <select id="pipeline-resolution-select" class="pipeline-select">
                <option value="224" selected>224 × 224 (VLA/ACT)</option>
                <option value="320">320 × 240</option>
                <option value="128">128 × 128 (Fast)</option>
              </select>
            </div>
          </div>

          <div class="pipeline-checkbox-group">
            <label class="pipeline-checkbox-label">
              <input type="checkbox" id="pipeline-domain-rand-cb" checked />
              <span>Domain Randomization (Randomize object positions)</span>
            </label>
            <label class="pipeline-checkbox-label">
              <input type="checkbox" id="pipeline-fast-mode-cb" checked />
              <span>Fast-Forward (Full physics speed, 100× real-time)</span>
            </label>
          </div>

          <div class="pipeline-actions-row">
            <button type="button" id="pipeline-start-btn" class="pipeline-btn pipeline-btn-primary">
              ▶ Generate Dataset
            </button>
            <button type="button" id="pipeline-stop-btn" class="pipeline-btn pipeline-btn-danger" style="display:none">
              ⏹ Stop Generation
            </button>
          </div>
        </div>

        <!-- Live Progress & Metrics -->
        <div class="pipeline-section" id="pipeline-progress-section" style="display:none">
          <div class="pipeline-progress-header">
            <span id="pipeline-status-text">Ready</span>
            <span id="pipeline-episode-counter" class="pipeline-counter">0 / 0</span>
          </div>

          <div class="pipeline-progress-bar-bg">
            <div id="pipeline-progress-bar-fill" class="pipeline-progress-bar-fill" style="width: 0%"></div>
          </div>

          <div class="pipeline-metrics-grid">
            <div class="pipeline-metric-card">
              <div class="pipeline-metric-val" id="pipeline-metric-success">0%</div>
              <div class="pipeline-metric-label">Success Rate</div>
            </div>
            <div class="pipeline-metric-card">
              <div class="pipeline-metric-val" id="pipeline-metric-frames">0</div>
              <div class="pipeline-metric-label">Frames Logged</div>
            </div>
            <div class="pipeline-metric-card">
              <div class="pipeline-metric-val" id="pipeline-metric-size">0 MB</div>
              <div class="pipeline-metric-label">Estimated Size</div>
            </div>
          </div>

          <!-- Live Camera Preview -->
          <div class="pipeline-preview-box">
            <div class="pipeline-preview-header">
              <span>Attached Camera View</span>
              <span id="pipeline-preview-cam-name" class="pipeline-preview-tag">Camera</span>
            </div>
            <div class="pipeline-preview-canvas-wrapper">
              <canvas id="pipeline-preview-canvas" width="224" height="224"></canvas>
            </div>
          </div>
        </div>

        <!-- Export Actions -->
        <div class="pipeline-section" id="pipeline-export-section" style="display:none">
          <div class="pipeline-export-title">Dataset Ready for Export</div>
          <div class="pipeline-export-buttons">
            <button type="button" id="pipeline-download-zip-btn" class="pipeline-btn pipeline-btn-success">
              ⬇ Download LeRobot Dataset (.zip)
            </button>
            <button type="button" id="pipeline-push-hf-btn" class="pipeline-btn pipeline-btn-secondary">
              🤗 Push to Hugging Face
            </button>
          </div>
          <div id="pipeline-export-status" class="pipeline-export-status"></div>
        </div>
      </div>
    `;

    this.container.appendChild(panel);
    this._panel = panel;

    // Build Hugging Face Modal
    this._createHfModal();
  }

  _createHfModal() {
    const modal = document.createElement('div');
    modal.id = 'hf-upload-modal';
    modal.className = 'hf-upload-modal';
    modal.style.display = 'none';

    modal.innerHTML = `
      <div class="hf-modal-backdrop"></div>
      <div class="hf-modal-content">
        <div class="hf-modal-header">
          <div class="hf-modal-title">🤗 Push to Hugging Face Datasets</div>
          <button type="button" id="hf-modal-close" class="pipeline-icon-btn">✕</button>
        </div>
        <div class="hf-modal-body">
          <p class="hf-modal-desc">
            Directly upload your recorded LeRobot dataset to the Hugging Face Hub.
          </p>
          <div class="pipeline-form-row">
            <label class="pipeline-label">Repository ID</label>
            <input type="text" id="hf-repo-input" class="pipeline-input" placeholder="username/robospace-panda-pick" />
          </div>
          <div class="pipeline-form-row">
            <label class="pipeline-label">Hugging Face Access Token (Write)</label>
            <input type="password" id="hf-token-input" class="pipeline-input" placeholder="hf_..." />
          </div>
          <div class="pipeline-checkbox-group">
            <label class="pipeline-checkbox-label">
              <input type="checkbox" id="hf-private-cb" />
              <span>Private Dataset</span>
            </label>
          </div>
          <div id="hf-upload-progress-box" style="display:none" class="hf-progress-box">
            <div id="hf-upload-status">Uploading...</div>
            <div class="pipeline-progress-bar-bg">
              <div id="hf-upload-bar" class="pipeline-progress-bar-fill" style="width: 0%"></div>
            </div>
          </div>
          <div id="hf-result-link-box" style="display:none" class="hf-result-box"></div>
        </div>
        <div class="hf-modal-footer">
          <button type="button" id="hf-modal-cancel-btn" class="pipeline-btn pipeline-btn-secondary">Cancel</button>
          <button type="button" id="hf-modal-confirm-btn" class="pipeline-btn pipeline-btn-primary">Upload to Hub</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this._hfModal = modal;
  }

  _setupEventListeners() {
    const p = this._panel;
    if (!p) return;

    p.querySelector('#pipeline-close-btn').addEventListener('click', () => this.hide());

    p.querySelector('#pipeline-start-btn').addEventListener('click', () => this.startGeneration());
    p.querySelector('#pipeline-stop-btn').addEventListener('click', () => this.stopGeneration());

    p.querySelector('#pipeline-download-zip-btn').addEventListener('click', () => this.downloadZip());
    p.querySelector('#pipeline-push-hf-btn').addEventListener('click', () => this.openHfModal());

    // HF Modal wiring
    const m = this._hfModal;
    if (m) {
      m.querySelector('#hf-modal-close').addEventListener('click', () => this.closeHfModal());
      m.querySelector('#hf-modal-cancel-btn').addEventListener('click', () => this.closeHfModal());
      m.querySelector('.hf-modal-backdrop').addEventListener('click', () => this.closeHfModal());
      m.querySelector('#hf-modal-confirm-btn').addEventListener('click', () => this.confirmHfUpload());
    }

    // Task change listener
    p.querySelector('#pipeline-task-select').addEventListener('change', (e) => {
      this._activeTaskKey = e.target.value;
    });

    // Recorder frame preview hook
    this.recorder.addListener((event, data) => {
      if (event === 'frame') {
        this._updatePreviewThumbnail();
      }
    });
  }

  _updateCameraOptions() {
    const camSelect = this._panel.querySelector('#pipeline-camera-select');
    if (!camSelect) return;
    const currentVal = camSelect.value;
    camSelect.innerHTML = '<option value="">Auto-detected (Gripper/Wrist)</option>';

    if (this.demo.cameraViewer && this.demo.cameraViewer.cameras) {
      for (const cam of this.demo.cameraViewer.cameras) {
        const opt = document.createElement('option');
        opt.value = cam.name;
        opt.textContent = cam.name;
        camSelect.appendChild(opt);
      }
    }
    if (currentVal) camSelect.value = currentVal;
  }

  _updatePreviewThumbnail() {
    const lastEp = this.recorder.currentEpisodeFrames;
    if (!lastEp || lastEp.length === 0) return;
    const frame = lastEp[lastEp.length - 1];
    if (!frame || !frame.image) return;

    const canvas = this._panel.querySelector('#pipeline-preview-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = this.recorder.imageWidth;
    const h = this.recorder.imageHeight;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const imgData = ctx.createImageData(w, h);
    const d = imgData.data;
    const rgb = frame.image;
    const len = w * h;
    for (let i = 0; i < len; i++) {
      d[i * 4 + 0] = rgb[i * 3 + 0];
      d[i * 4 + 1] = rgb[i * 3 + 1];
      d[i * 4 + 2] = rgb[i * 3 + 2];
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);

    const tag = this._panel.querySelector('#pipeline-preview-cam-name');
    if (tag && frame.cameraName) tag.textContent = frame.cameraName;
  }

  async startGeneration() {
    if (this.isRunning) return;

    const p = this._panel;
    const numEpisodes = Math.max(1, parseInt(p.querySelector('#pipeline-episodes-input').value, 10) || 10);
    const fps = parseInt(p.querySelector('#pipeline-fps-select').value, 10) || 30;
    const resolution = parseInt(p.querySelector('#pipeline-resolution-select').value, 10) || 224;
    const cameraName = p.querySelector('#pipeline-camera-select').value || null;
    const domainRand = p.querySelector('#pipeline-domain-rand-cb').checked;
    const fastMode = p.querySelector('#pipeline-fast-mode-cb').checked;

    const taskSpec = TEACHER_TASKS[this._activeTaskKey];

    // Configure recorder
    this.recorder.fps = fps;
    this.recorder.imageWidth = resolution;
    this.recorder.imageHeight = resolution;
    this.recorder.cameraName = cameraName;
    this.recorder.robotType = taskSpec?.robot || 'franka_panda';
    this.recorder.datasetName = `robospace_${this._activeTaskKey}_${Date.now()}`;
    this.recorder.clear();

    this.isRunning = true;
    this._shouldStop = false;

    p.querySelector('#pipeline-start-btn').style.display = 'none';
    p.querySelector('#pipeline-stop-btn').style.display = 'inline-block';
    p.querySelector('#pipeline-progress-section').style.display = 'block';
    p.querySelector('#pipeline-export-section').style.display = 'none';

    const statusText = p.querySelector('#pipeline-status-text');
    const episodeCounter = p.querySelector('#pipeline-episode-counter');
    const progressBar = p.querySelector('#pipeline-progress-bar-fill');
    const successMetric = p.querySelector('#pipeline-metric-success');
    const framesMetric = p.querySelector('#pipeline-metric-frames');
    const sizeMetric = p.querySelector('#pipeline-metric-size');

    try {
      // 1. Prepare scene if task defines one
      if (taskSpec?.sceneXml && typeof window.robospaceLoadScene === 'function') {
        statusText.textContent = 'Loading scene and robot pack...';
        await window.robospaceLoadScene(taskSpec.sceneXml, taskSpec.robot, taskSpec.id);
        this._updateCameraOptions();
        if (!cameraName && this.demo.cameraViewer?.activeCamera) {
          this.recorder.cameraName = this.demo.cameraViewer.activeCamera.name;
        }
      }

      for (let ep = 0; ep < numEpisodes; ep++) {
        if (this._shouldStop) {
          statusText.textContent = 'Cancelled by user.';
          break;
        }

        episodeCounter.textContent = `${ep + 1} / ${numEpisodes}`;
        const pct = ((ep) / numEpisodes) * 100;
        progressBar.style.width = `${pct}%`;
        statusText.textContent = `Episode ${ep + 1}: Resetting & Domain Randomizing...`;

        // Reset simulation state
        if (typeof window.resetSimulation === 'function') {
          window.resetSimulation();
        }

        // Domain randomization
        if (domainRand && taskSpec?.domainRandomization) {
          for (const [objName, ranges] of Object.entries(taskSpec.domainRandomization)) {
            if (typeof window.simRandomizeObjectPose === 'function') {
              window.simRandomizeObjectPose(objName, ranges.x, ranges.y, ranges.z, ranges.yaw);
            }
          }
        }

        // Start episode in recorder
        this.recorder.startEpisode(ep, taskSpec?.name || this._activeTaskKey, 0);

        statusText.textContent = `Episode ${ep + 1}: Executing Teacher Macro...`;

        // Execute teacher policy Python script
        let script = taskSpec?.pythonScript;
        if (this._activeTaskKey === 'custom_script' && typeof window.getPythonScript === 'function') {
          script = window.getPythonScript();
        }

        if (window.pyodide && script) {
          try {
            await window.pyodide.runPythonAsync(script);
          } catch (err) {
            console.warn(`[DatasetPipeline] Script warning in episode ${ep}:`, err);
          }
        }

        // Fast mode skip replay
        if (fastMode && typeof window.robospaceSkipPlayback === 'function') {
          window.robospaceSkipPlayback();
        }

        // Evaluate episode success
        let success = true;
        if (taskSpec && typeof taskSpec.evaluateSuccess === 'function') {
          success = taskSpec.evaluateSuccess(this.demo.simulation, this.demo.model);
        }

        this.recorder.endEpisode(success);
        this._updatePreviewThumbnail();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Update live metrics
        const progress = this.recorder.getProgress();
        successMetric.textContent = `${Math.round(progress.successRate * 100)}%`;
        framesMetric.textContent = progress.totalFrames.toLocaleString();
        const estMB = (progress.totalFrames * (resolution * resolution * 3 * 0.05 / 1024 / 1024)).toFixed(1);
        sizeMetric.textContent = `${estMB} MB`;

        // Small pause to yield UI event loop
        await new Promise((resolve) => setTimeout(resolve, fastMode ? 30 : 200));
      }

      progressBar.style.width = '100%';
      statusText.textContent = 'Collection complete!';
      p.querySelector('#pipeline-export-section').style.display = 'block';

      // Relay completion to ParentBridge if embedded
      if (this.demo.parentBridge && typeof this.demo.parentBridge._send === 'function') {
        this.demo.parentBridge._send('DATASET_COMPLETE', this.recorder.getProgress());
      }
    } catch (err) {
      console.error('[DatasetPipeline] Generation error:', err);
      statusText.textContent = `Error: ${err.message || err}`;
    } finally {
      this.isRunning = false;
      p.querySelector('#pipeline-start-btn').style.display = 'inline-block';
      p.querySelector('#pipeline-stop-btn').style.display = 'none';
    }
  }

  stopGeneration() {
    this._shouldStop = true;
    this.recorder.isRecording = false;
    const p = this._panel;
    p.querySelector('#pipeline-status-text').textContent = 'Stopping collection...';
  }

  async downloadZip() {
    const statusEl = this._panel.querySelector('#pipeline-export-status');
    statusEl.textContent = 'Compressing LeRobot ZIP archive...';
    try {
      await this.exporter.downloadZip(null, (status) => {
        statusEl.textContent = `${status.file} (${Math.round(status.progress * 100)}%)`;
      });
      statusEl.textContent = 'Download started!';
    } catch (err) {
      statusEl.textContent = `Download failed: ${err.message || err}`;
    }
  }

  openHfModal() {
    if (this._hfModal) {
      this._hfModal.style.display = 'flex';
      const repoInput = this._hfModal.querySelector('#hf-repo-input');
      if (repoInput && !repoInput.value) {
        repoInput.value = `my-user/lerobot-${this._activeTaskKey}`;
      }
    }
  }

  closeHfModal() {
    if (this._hfModal) {
      this._hfModal.style.display = 'none';
    }
  }

  async confirmHfUpload() {
    const m = this._hfModal;
    const repoId = m.querySelector('#hf-repo-input').value.trim();
    const token = m.querySelector('#hf-token-input').value.trim();
    const isPrivate = m.querySelector('#hf-private-cb').checked;

    const progressBox = m.querySelector('#hf-upload-progress-box');
    const statusText = m.querySelector('#hf-upload-status');
    const bar = m.querySelector('#hf-upload-bar');
    const linkBox = m.querySelector('#hf-result-link-box');

    progressBox.style.display = 'block';
    linkBox.style.display = 'none';

    try {
      const res = await this.exporter.pushToHuggingFace({
        repoId,
        token,
        isPrivate,
        onProgress: (status) => {
          statusText.textContent = status.phase;
          bar.style.width = `${Math.round(status.percent * 100)}%`;
        },
      });

      statusText.textContent = 'Uploaded successfully!';
      linkBox.style.display = 'block';
      linkBox.innerHTML = `Dataset published: <a href="${res.url}" target="_blank" rel="noopener">${res.url}</a>`;
    } catch (err) {
      statusText.textContent = `Upload error: ${err.message || err}`;
    }
  }
}
