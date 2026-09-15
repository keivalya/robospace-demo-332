// examples/utils/CameraViewer.js
//
// Real-time camera viewer for robot cameras and virtual views.
// Renders directly into a Picture-in-Picture (PiP) viewport using
// WebGL scissor/viewport on the main renderer for zero-allocation,
// zero-copy 60 FPS performance. Also provides offscreen render target
// capture for Python scripts and screenshots.

import * as THREE from 'three';
import { readNames, getPosition } from '../mujocoUtils.js';

export class CameraViewer {
  constructor(containerEl) {
    this._container = containerEl || document.getElementById('appbody') || document.body;
    this._visible = false;
    this._minimized = false;
    this._activeCameraIndex = 0;
    this._cameras = [];

    this._threeCamera = new THREE.PerspectiveCamera(45, 4 / 3, 0.01, 100);
    this._matrix4 = new THREE.Matrix4();
    this._tempVec2 = new THREE.Vector2();

    this._offscreenTarget = null;
    this._offscreenCanvas = null;

    this._panel = null;
    this._viewportEl = null;
    this._selectEl = null;
    this._statusEl = null;
    this._toggleBtn = null;

    this._createPanel();
    this._setupDragging();
  }

  // ── Public API ──────────────────────────────────────────────

  get visible() {
    return this._visible;
  }

  get cameras() {
    return this._cameras;
  }

  get activeCamera() {
    return this._cameras[this._activeCameraIndex] || null;
  }

  get threeCamera() {
    return this._threeCamera;
  }

  show(cameraNameOrIndex) {
    if (this._cameras.length === 0) return;
    if (cameraNameOrIndex !== undefined && cameraNameOrIndex !== null) {
      this.selectCamera(cameraNameOrIndex);
    }
    this._visible = true;
    this._panel.style.display = 'flex';
    if (this._toggleBtn) this._toggleBtn.classList.add('active');
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

  selectCamera(nameOrIndex) {
    if (typeof nameOrIndex === 'string') {
      const idx = this._cameras.findIndex((c) => c.name === nameOrIndex);
      if (idx >= 0) this._activeCameraIndex = idx;
    } else if (typeof nameOrIndex === 'number' && nameOrIndex >= 0 && nameOrIndex < this._cameras.length) {
      this._activeCameraIndex = nameOrIndex;
    }
    if (this._selectEl) {
      this._selectEl.value = String(this._activeCameraIndex);
    }
    this._updateStatus();
  }

  setToggleButton(btn) {
    if (this._toggleBtn && this._toggleBtnHandler) {
      this._toggleBtn.removeEventListener('click', this._toggleBtnHandler);
    }
    this._toggleBtn = btn;
    if (btn) {
      this._toggleBtnHandler = () => this.toggle();
      btn.addEventListener('click', this._toggleBtnHandler);
      this._updateButtonLabel();
      btn.classList.toggle('active', !!this._visible);
    }
  }

  /**
   * Called when a new model is loaded or reloaded.
   * Discovers native cameras or configures virtual fallbacks.
   */
  onModelChanged(model, simulation) {
    this._cameras = [];

    if (model && model.ncam > 0) {
      const names = readNames(model, model.name_camadr, model.ncam, 'camera');
      for (let i = 0; i < model.ncam; i++) {
        const fovy = (model.cam_fovy && model.cam_fovy[i] > 0) ? model.cam_fovy[i] : 45;
        this._cameras.push({
          id: i,
          name: names[i] || `camera_${i}`,
          isVirtual: false,
          bodyId: model.cam_bodyid ? model.cam_bodyid[i] : -1,
          fovy,
        });
      }
    }

    // If no native cameras, check if the robot has an end-effector / gripper site or link.
    // The camera is strictly an onboard robot point-of-view (what the robot sees), NOT an external observer.
    if (this._cameras.length === 0 && model) {
      let siteIdx = -1;
      let siteName = '';

      if (model.nsite > 0 && model.name_siteadr) {
        const siteNames = readNames(model, model.name_siteadr, model.nsite, 'site');
        const matchIdx = siteNames.findIndex((n) => /(attach|tool|wrist|grip|ee|tcp|pinch)/i.test(n));
        if (matchIdx >= 0) {
          siteIdx = matchIdx;
          siteName = siteNames[matchIdx];
        } else if (model.nsite === 1 && model.nbody > 1) {
          siteIdx = 0;
          siteName = siteNames[0] || 'attachment_site';
        }
      }

      if (siteIdx >= 0) {
        this._cameras.push({
          id: 'gripper_pov',
          name: `Gripper POV (${siteName})`,
          isVirtual: true,
          virtualType: 'gripper_pov',
          siteId: siteIdx,
          fovy: 75,
        });
      } else if (model.nbody > 1 && model.name_bodyadr) {
        // Fallback to end-effector body link if named
        const bodyNames = readNames(model, model.name_bodyadr, model.nbody, 'body');
        const bodyMatchIdx = bodyNames.findIndex((n) => /(gripper|hand|wrist_3|wrist3|tool|ee|end_effector)/i.test(n));
        if (bodyMatchIdx >= 0) {
          this._cameras.push({
            id: 'gripper_pov',
            name: `Gripper POV (${bodyNames[bodyMatchIdx]})`,
            isVirtual: true,
            virtualType: 'gripper_pov',
            bodyId: bodyMatchIdx,
            fovy: 75,
          });
        }
      }
    }

    // Default to first camera
    this._activeCameraIndex = 0;
    this._rebuildSelectOptions();
    this._updateButtonLabel();
    this._updateStatus();
  }

  /**
   * Updates camera pose and intrinsics from MuJoCo state.
   */
  updateCamera(simulation, model, cameraIndexOverride) {
    if (!model || !simulation || this._cameras.length === 0) return;

    const idx = cameraIndexOverride !== undefined ? cameraIndexOverride : this._activeCameraIndex;
    const cam = this._cameras[idx] || this._cameras[0];
    if (!cam) return;

    if (!cam.isVirtual && typeof cam.id === 'number' && cam.id < model.ncam) {
      const camId = cam.id;
      // MuJoCo camera position in world coordinates (Z-up, metres)
      const px = simulation.cam_xpos[3 * camId + 0];
      const py = simulation.cam_xpos[3 * camId + 1];
      const pz = simulation.cam_xpos[3 * camId + 2];

      // MuJoCo camera rotation matrix (3x3 row-major)
      const m = simulation.cam_xmat.subarray(9 * camId, 9 * camId + 9);

      // Coordinate change matrix S maps MuJoCo (x, y, z) to Three.js (x, z, -y):
      // S = [ [1,0,0], [0,0,1], [0,-1,0] ]
      // R_three = S * R_mujoco
      //
      // In Three.js, matrix4.set takes row-major elements:
      // Row 0: m[0],  m[1],  m[2],  px
      // Row 1: m[6],  m[7],  m[8],  pz
      // Row 2: -m[3], -m[4], -m[5], -py
      // Row 3: 0,     0,     0,     1
      this._matrix4.set(
        m[0],  m[1],  m[2],  px,
        m[6],  m[7],  m[8],  pz,
       -m[3], -m[4], -m[5], -py,
        0,     0,     0,     1
      );

      this._threeCamera.matrix.copy(this._matrix4);
      this._threeCamera.matrixWorld.copy(this._matrix4);
      this._threeCamera.matrixAutoUpdate = false;
      this._threeCamera.fov = cam.fovy || 45;
    } else if (cam.isVirtual) {
      this._updateVirtualCamera(cam, simulation, model);
    }
  }

  /**
   * Main render loop hook: renders the PiP into the canvas using scissor test.
   */
  render(renderer, scene, simulation, model) {
    if (!this._visible || this._minimized || !renderer || !scene || !model || !simulation) return;
    if (this._cameras.length === 0) return;

    const canvas = renderer.domElement;
    const canvasRect = canvas.getBoundingClientRect();
    const vpRect = this._viewportEl.getBoundingClientRect();

    // In Three.js, setScissor and setViewport accept logical CSS units.
    // Three.js internally multiplies them by _pixelRatio:
    //   _currentViewport.copy(_viewport).multiplyScalar(_pixelRatio).floor()
    // Do NOT multiply by pixelRatio here, or coordinates will be scaled by pixelRatio^2!
    const x = Math.round(vpRect.left - canvasRect.left);
    const y = Math.round(canvasRect.bottom - vpRect.bottom);
    const width = Math.round(vpRect.width);
    const height = Math.round(vpRect.height);

    if (width <= 2 || height <= 2) return;

    this._threeCamera.aspect = width / height;
    this._threeCamera.updateProjectionMatrix();

    this.updateCamera(simulation, model);

    // Save renderer's original CSS size for restoring the primary viewport
    renderer.getSize(this._tempVec2);
    const fullW = this._tempVec2.x;
    const fullH = this._tempVec2.y;

    // Temporarily suppress scene reflectors to avoid reflection pass overhead
    // and prevent Reflector from altering render targets or viewport state
    const hiddenReflectors = [];
    scene.traverse((obj) => {
      if (obj.isReflector && obj.visible) {
        hiddenReflectors.push(obj);
        obj.visible = false;
      }
    });

    // Scissor & Viewport render
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, width, height);
    renderer.setViewport(x, y, width, height);

    renderer.clear(true, true, true);
    renderer.render(scene, this._threeCamera);

    // Restore reflector visibility
    for (let i = 0; i < hiddenReflectors.length; i++) {
      hiddenReflectors[i].visible = true;
    }

    // Restore primary viewport, scissor, and scissor test
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, fullW, fullH);
    renderer.setScissor(0, 0, fullW, fullH);
  }

  /**
   * Captures an image from a camera into a buffer or data URL.
   * Reuses offscreen render target to avoid GPU memory leaks.
   */
  captureImage(renderer, scene, simulation, model, cameraId, width = 320, height = 240, format = 'numpy') {
    if (!renderer || !scene || !model || !simulation) return null;

    let camIdx = 0;
    if (typeof cameraId === 'string') {
      const idx = this._cameras.findIndex((c) => c.name === cameraId);
      if (idx >= 0) camIdx = idx;
    } else if (typeof cameraId === 'number' && cameraId >= 0 && cameraId < this._cameras.length) {
      camIdx = cameraId;
    }

    // Lazy init or resize offscreen target
    if (!this._offscreenTarget || this._offscreenTarget.width !== width || this._offscreenTarget.height !== height) {
      if (this._offscreenTarget) this._offscreenTarget.dispose();
      this._offscreenTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
      });
    }

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this._offscreenTarget);

    const oldAspect = this._threeCamera.aspect;
    this._threeCamera.aspect = width / height;
    this._threeCamera.updateProjectionMatrix();

    this.updateCamera(simulation, model, camIdx);

    // Temporarily suppress scene reflectors during capture pass
    const hiddenReflectors = [];
    scene.traverse((obj) => {
      if (obj.isReflector && obj.visible) {
        hiddenReflectors.push(obj);
        obj.visible = false;
      }
    });

    renderer.render(scene, this._threeCamera);

    for (let i = 0; i < hiddenReflectors.length; i++) {
      hiddenReflectors[i].visible = true;
    }

    const rawPixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(this._offscreenTarget, 0, 0, width, height, rawPixels);

    renderer.setRenderTarget(prevTarget);
    this._threeCamera.aspect = oldAspect;
    this._threeCamera.updateProjectionMatrix();

    if (format === 'base64' || format === 'data_url') {
      if (!this._offscreenCanvas) {
        this._offscreenCanvas = document.createElement('canvas');
      }
      this._offscreenCanvas.width = width;
      this._offscreenCanvas.height = height;
      const ctx = this._offscreenCanvas.getContext('2d');
      const imgData = ctx.createImageData(width, height);

      // WebGL framebuffer is bottom-to-top, flip vertically for standard images
      for (let row = 0; row < height; row++) {
        const srcRow = height - 1 - row;
        for (let col = 0; col < width; col++) {
          const srcIdx = (srcRow * width + col) * 4;
          const dstIdx = (row * width + col) * 4;
          imgData.data[dstIdx + 0] = rawPixels[srcIdx + 0];
          imgData.data[dstIdx + 1] = rawPixels[srcIdx + 1];
          imgData.data[dstIdx + 2] = rawPixels[srcIdx + 2];
          imgData.data[dstIdx + 3] = rawPixels[srcIdx + 3];
        }
      }
      ctx.putImageData(imgData, 0, 0);
      return this._offscreenCanvas.toDataURL('image/png');
    }

    // Format: 'numpy' (RGB uint8 array with vertical flip, shape: height x width x 3)
    const rgb = new Uint8Array(width * height * 3);
    for (let row = 0; row < height; row++) {
      const srcRow = height - 1 - row;
      for (let col = 0; col < width; col++) {
        const srcIdx = (srcRow * width + col) * 4;
        const dstIdx = (row * width + col) * 3;
        rgb[dstIdx + 0] = rawPixels[srcIdx + 0];
        rgb[dstIdx + 1] = rawPixels[srcIdx + 1];
        rgb[dstIdx + 2] = rawPixels[srcIdx + 2];
      }
    }
    return {
      width,
      height,
      channels: 3,
      data: rgb,
    };
  }

  dispose() {
    if (this._offscreenTarget) {
      this._offscreenTarget.dispose();
      this._offscreenTarget = null;
    }
    if (this._panel && this._panel.parentElement) {
      this._panel.parentElement.removeChild(this._panel);
    }
  }

  // ── Internal Helpers ────────────────────────────────────────

  _updateVirtualCamera(cam, simulation, model) {
    this._threeCamera.fov = cam.fovy || 75;

    let px = 0, py = 0, pz = 0;
    let m = null;

    if (cam.siteId !== undefined && simulation.site_xpos && simulation.site_xmat) {
      const siteId = cam.siteId;
      px = simulation.site_xpos[3 * siteId + 0];
      py = simulation.site_xpos[3 * siteId + 1];
      pz = simulation.site_xpos[3 * siteId + 2];
      m = simulation.site_xmat.subarray(9 * siteId, 9 * siteId + 9);
    } else if (cam.bodyId !== undefined && simulation.xpos && simulation.xmat) {
      const bodyId = cam.bodyId;
      px = simulation.xpos[3 * bodyId + 0];
      py = simulation.xpos[3 * bodyId + 1];
      pz = simulation.xpos[3 * bodyId + 2];
      m = simulation.xmat.subarray(9 * bodyId, 9 * bodyId + 9);
    }

    if (m) {
      // In MuJoCo, orientation matrix m is 3x3 row-major.
      // Column 2 (m[2], m[5], m[8]) is the tool approach/pointing direction.
      // In Three.js, camera optical axis points along -Z:
      //   z_cam_mujoco = -Column 2 = (-m[2], -m[5], -m[8])
      // Camera up (+Y) is Column 1:
      //   y_cam_mujoco = Column 1 = (m[1], m[4], m[7])
      // Camera right (+X) is -Column 0:
      //   x_cam_mujoco = (-m[0], -m[3], -m[6])
      //
      // Applying coordinate swizzle S (MuJoCo [x, y, z] -> Three.js [x, z, -y]):
      // Row 0: -m[0],  m[1], -m[2],  px
      // Row 1: -m[6],  m[7], -m[8],  pz
      // Row 2:  m[3], -m[4],  m[5], -py
      // Row 3:  0,     0,     0,     1
      this._matrix4.set(
        -m[0],  m[1], -m[2],  px,
        -m[6],  m[7], -m[8],  pz,
         m[3], -m[4],  m[5], -py,
         0,     0,     0,     1
      );

      this._threeCamera.matrix.copy(this._matrix4);
      this._threeCamera.matrixWorld.copy(this._matrix4);
      this._threeCamera.matrixAutoUpdate = false;
    }
  }

  _createPanel() {
    const panel = document.createElement('div');
    panel.id = 'camera-pip-panel';
    panel.className = 'camera-pip-panel';
    panel.style.display = 'none';

    panel.innerHTML = `
      <div id="camera-pip-header" class="camera-pip-header">
        <div class="camera-pip-title-group">
          <span class="camera-pip-icon">📷</span>
          <select id="camera-pip-select" class="camera-pip-select" title="Select camera"></select>
        </div>
        <div class="camera-pip-actions">
          <button id="camera-pip-min" class="camera-pip-btn" title="Minimize">_</button>
          <button id="camera-pip-close" class="camera-pip-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="camera-pip-body" class="camera-pip-body">
        <div id="camera-pip-viewport" class="camera-pip-viewport">
          <div class="camera-pip-crosshair"></div>
        </div>
        <div id="camera-pip-footer" class="camera-pip-footer">
          <span id="camera-pip-status" class="camera-pip-status">Initializing…</span>
        </div>
      </div>
    `;

    this._container.appendChild(panel);
    this._panel = panel;
    this._viewportEl = panel.querySelector('#camera-pip-viewport');
    this._selectEl = panel.querySelector('#camera-pip-select');
    this._statusEl = panel.querySelector('#camera-pip-status');

    panel.querySelector('#camera-pip-close').addEventListener('click', () => this.hide());
    panel.querySelector('#camera-pip-min').addEventListener('click', () => this._toggleMinimize());

    this._selectEl.addEventListener('change', (e) => {
      this.selectCamera(Number(e.target.value));
    });
  }

  _toggleMinimize() {
    this._minimized = !this._minimized;
    const body = this._panel.querySelector('#camera-pip-body');
    if (body) body.style.display = this._minimized ? 'none' : 'flex';
    const minBtn = this._panel.querySelector('#camera-pip-min');
    if (minBtn) minBtn.textContent = this._minimized ? '▢' : '_';
  }

  _rebuildSelectOptions() {
    if (!this._selectEl) return;
    this._selectEl.innerHTML = '';
    this._cameras.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${cam.name} (${Math.round(cam.fovy)}°)`;
      this._selectEl.appendChild(opt);
    });
    this._selectEl.value = String(this._activeCameraIndex);
  }

  _updateButtonLabel() {
    if (!this._toggleBtn) return;
    if (this._cameras.length === 0) {
      this._toggleBtn.style.display = 'none';
      if (this._visible) this.hide();
      return;
    }
    this._toggleBtn.style.display = '';
    const nativeCount = this._cameras.filter((c) => !c.isVirtual).length;
    if (nativeCount > 0) {
      this._toggleBtn.textContent = nativeCount > 1 ? `📷 Camera (${nativeCount})` : '📷 Camera';
    } else {
      this._toggleBtn.textContent = '📷 Camera (POV)';
    }
  }

  _updateStatus() {
    if (!this._statusEl) return;
    const cam = this.activeCamera;
    if (cam) {
      this._statusEl.textContent = `${cam.name} • ${Math.round(cam.fovy)}° FOV`;
    } else {
      this._statusEl.textContent = 'No cameras';
    }
  }

  _setupDragging() {
    const header = this._panel.querySelector('#camera-pip-header');
    if (!header) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initLeft = 0;
    let initTop = 0;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
      isDragging = true;
      header.setPointerCapture(e.pointerId);

      startX = e.clientX;
      startY = e.clientY;

      const rect = this._panel.getBoundingClientRect();
      const parentRect = this._container.getBoundingClientRect();

      initLeft = rect.left - parentRect.left;
      initTop = rect.top - parentRect.top;

      // Switch from right-anchored to left/top anchored
      this._panel.style.right = 'auto';
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
