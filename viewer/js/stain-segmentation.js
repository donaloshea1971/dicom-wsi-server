/**
 * PathView Pro - Classic (non-AI) segmentation for WSI viewer
 *
 * Segments the current viewport using simple image processing:
 * - intensity threshold -> binary mask
 * - connected components -> blob size filtering
 *
 * Designed to work nicely with stain deconvolution:
 * switch view to H-only / E-only / DAB-only and threshold the resulting intensity.
 */
(function () {
  'use strict';

  const DEFAULTS = {
    enabled: false,
    thresholdMin: 0.0,  // 0..1 (on luminance) - lower bound
    thresholdMax: 0.5,  // 0..1 (on luminance) - upper bound (dark pixels)
    minArea: 50,        // in analysis pixels (downsampled)
    maxArea: 50000,     // in analysis pixels (downsampled); 0 means no max
    autoUpdate: true,
    // Downsample factor for analysis (bigger = faster, less accurate)
    downsample: 2,
    maskColor: '#00d4aa',
    maskAlpha: 0.35,
    useWebGL: true,     // Try WebGL for threshold step
  };

  // WebGL threshold shader
  let webglCtx = null;
  let webglProgram = null;
  let webglTexture = null;
  const WEBGL_VERSION = 3; // Increment to force shader recompilation

  function initWebGL() {
    if (webglCtx && webglCtx.version === WEBGL_VERSION) return webglCtx;
    
    // Reset if version changed
    if (webglCtx) {
      webglCtx = null;
      webglProgram = null;
    }
    
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      console.log('[StainSeg] WebGL not available, using CPU fallback');
      return null;
    }

    const vsSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;

    const fsSource = `
      precision mediump float;
      uniform sampler2D u_image;
      uniform float u_thresholdMin;
      uniform float u_thresholdMax;
      varying vec2 v_texCoord;
      void main() {
        vec4 c = texture2D(u_image, v_texCoord);
        float lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        // Mask pixels where luminance is within [min, max] range
        float mask = step(u_thresholdMin, lum) * (1.0 - step(u_thresholdMax, lum));
        gl_FragColor = vec4(mask, mask, mask, 1.0);
      }
    `;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.warn('[StainSeg] VS compile error:', gl.getShaderInfoLog(vs));
      return null;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.warn('[StainSeg] FS compile error:', gl.getShaderInfoLog(fs));
      return null;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[StainSeg] Program link error:', gl.getProgramInfoLog(program));
      return null;
    }

    webglProgram = program;
    webglCtx = { gl, canvas, program, version: WEBGL_VERSION };
    console.log('[StainSeg] WebGL threshold shader initialized (v' + WEBGL_VERSION + ')');
    return webglCtx;
  }

  function thresholdWebGL(imageData, thresholdMin, thresholdMax, w, h) {
    const ctx = initWebGL();
    if (!ctx) return null;
    
    const { gl, canvas, program } = ctx;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);

    gl.useProgram(program);

    // Setup geometry
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1, 1,   1, -1,   1, 1,
    ]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    // Flip Y in tex coords: canvas Y=0 at top, but we render bottom-to-top
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 1,  1, 1,  0, 0,
      0, 0,  1, 1,  1, 0,
    ]), gl.STATIC_DRAW);
    const texCoordLoc = gl.getAttribLocation(program, 'a_texCoord');
    gl.enableVertexAttribArray(texCoordLoc);
    gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0);

    // Upload texture (no flip - we handle orientation via tex coords)
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);

    // Set uniforms for range threshold
    gl.uniform1f(gl.getUniformLocation(program, 'u_thresholdMin'), thresholdMin);
    gl.uniform1f(gl.getUniformLocation(program, 'u_thresholdMax'), thresholdMax);

    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Read back
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Convert to binary array (orientation handled via tex coords)
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      out[i] = pixels[i * 4] > 127 ? 1 : 0;
    }

    // Cleanup
    gl.deleteTexture(texture);
    gl.deleteBuffer(posBuffer);
    gl.deleteBuffer(texCoordBuffer);

    return out;
  }

  const controllers = new Map(); // key -> { viewer, state }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function safeNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function getAnalysisPanelEl() {
    return document.getElementById('analysis-panel');
  }

  function getStatsEl() {
    return document.getElementById('stain-seg-stats');
  }

  function getErrorEl() {
    return document.getElementById('stain-seg-error');
  }

  function clearError() {
    const el = getErrorEl();
    if (el) el.textContent = '';
  }

  function setError(msg) {
    const el = getErrorEl();
    if (el) el.textContent = msg || '';
  }

  function parseHexColor(hex) {
    const h = (hex || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return { r: 0, g: 212, b: 170 };
    return {
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16),
    };
  }

  function findOsdRenderCanvas(viewer, overlayCanvas) {
    try {
      if (viewer && viewer.drawer && viewer.drawer.canvas) return viewer.drawer.canvas;
    } catch (e) {}

    const el = viewer && viewer.element;
    if (!el) return null;
    const canvases = el.querySelectorAll('canvas');
    for (const c of canvases) {
      if (overlayCanvas && c === overlayCanvas) continue;
      if (c.id === 'annotation-canvas') continue;
      return c;
    }
    return null;
  }

  function ensureOverlayCanvas(viewer, key) {
    const el = viewer && viewer.element;
    if (!el) return null;
    let canvas = el.querySelector(`canvas.stain-seg-mask-canvas[data-stain-seg-key="${key}"]`);
    if (canvas) return canvas;

    canvas = document.createElement('canvas');
    canvas.className = 'stain-seg-mask-canvas';
    canvas.dataset.stainSegKey = key;
    canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 17;
    `;
    el.appendChild(canvas);
    return canvas;
  }

  function resizeOverlayToViewer(viewer, canvas) {
    if (!viewer || !canvas) return;
    const rect = viewer.element.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function clearOverlay(viewer, key) {
    const overlay = ensureOverlayCanvas(viewer, key);
    if (!overlay) return;
    resizeOverlayToViewer(viewer, overlay);
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function createState() {
    return {
      enabled: DEFAULTS.enabled,
      thresholdMin: DEFAULTS.thresholdMin,
      thresholdMax: DEFAULTS.thresholdMax,
      minArea: DEFAULTS.minArea,
      maxArea: DEFAULTS.maxArea,
      autoUpdate: DEFAULTS.autoUpdate,
      downsample: DEFAULTS.downsample,
      _runTimer: null,
      _running: false,
      last: { ms: null, blobs: null, analyzedW: null, analyzedH: null },
    };
  }

  function scheduleRun(entry) {
    const { viewer, key, state } = entry;
    if (!state.enabled) return;
    if (!state.autoUpdate) return;
    if (state._runTimer) clearTimeout(state._runTimer);
    state._runTimer = setTimeout(() => {
      runOnce(viewer, key, state).catch((e) => {
        console.error('StainSegmentation run failed:', e);
        setError(e && e.message ? e.message : String(e));
      });
    }, 180);
  }

  function captureViewportImageData(viewer, key, state) {
    const overlay = ensureOverlayCanvas(viewer, key);
    if (!overlay) throw new Error('Overlay canvas missing');
    resizeOverlayToViewer(viewer, overlay);

    const renderCanvas = findOsdRenderCanvas(viewer, overlay);
    if (!renderCanvas) throw new Error('OpenSeadragon render canvas not found');

    const factor = clamp(parseInt(state.downsample, 10) || 1, 1, 8);
    const aw = Math.max(1, Math.floor(overlay.width / factor));
    const ah = Math.max(1, Math.floor(overlay.height / factor));

    const cap = document.createElement('canvas');
    cap.width = aw;
    cap.height = ah;
    const ctx = cap.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(renderCanvas, 0, 0, aw, ah);

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, aw, ah);
    } catch (e) {
      throw new Error('Cannot read pixels from viewport (canvas is tainted). Check tile CORS/same-origin.');
    }

    return { imageData, analyzedW: aw, analyzedH: ah, overlayW: overlay.width, overlayH: overlay.height };
  }

  function thresholdToBinary(imageData, thresholdMin, thresholdMax) {
    const data = imageData.data;
    const n = (data.length / 4) | 0;
    const out = new Uint8Array(n);
    const tMin = clamp(parseFloat(thresholdMin), 0, 1) * 255;
    const tMax = clamp(parseFloat(thresholdMax), 0, 1) * 255;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      // Luminance - mask pixels within range [min, max]
      const lum = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
      out[i] = (lum >= tMin && lum < tMax) ? 1 : 0;
    }
    return out;
  }

  function connectedComponentsFilter(bin, w, h, minArea, maxArea) {
    const n = w * h;
    const labels = new Int32Array(n);
    let current = 0;

    const qx = new Int32Array(n);
    const qy = new Int32Array(n);

    const keep = [];
    const areas = [];

    const minA = Math.max(0, parseInt(minArea, 10) || 0);
    const maxA = parseInt(maxArea, 10) || 0;
    const hasMax = maxA > 0;

    function idx(x, y) { return y * w + x; }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = idx(x, y);
        if (!bin[i] || labels[i] !== 0) continue;

        current++;
        let head = 0;
        let tail = 0;
        qx[tail] = x; qy[tail] = y; tail++;
        labels[i] = current;
        let area = 0;

        while (head < tail) {
          const cx = qx[head];
          const cy = qy[head];
          head++;
          area++;

          // 4-neighborhood
          if (cx > 0) {
            const ni = idx(cx - 1, cy);
            if (bin[ni] && labels[ni] === 0) { labels[ni] = current; qx[tail] = cx - 1; qy[tail] = cy; tail++; }
          }
          if (cx + 1 < w) {
            const ni = idx(cx + 1, cy);
            if (bin[ni] && labels[ni] === 0) { labels[ni] = current; qx[tail] = cx + 1; qy[tail] = cy; tail++; }
          }
          if (cy > 0) {
            const ni = idx(cx, cy - 1);
            if (bin[ni] && labels[ni] === 0) { labels[ni] = current; qx[tail] = cx; qy[tail] = cy - 1; tail++; }
          }
          if (cy + 1 < h) {
            const ni = idx(cx, cy + 1);
            if (bin[ni] && labels[ni] === 0) { labels[ni] = current; qx[tail] = cx; qy[tail] = cy + 1; tail++; }
          }
        }

        areas[current] = area;
        const ok = area >= minA && (!hasMax || area <= maxA);
        keep[current] = ok ? 1 : 0;
      }
    }

    // Build filtered binary
    const out = new Uint8Array(n);
    let keptCount = 0;
    for (let i = 0; i < n; i++) {
      const lab = labels[i];
      if (lab > 0 && keep[lab]) out[i] = 1;
    }
    for (let lab = 1; lab <= current; lab++) if (keep[lab]) keptCount++;
    return { out, blobs: keptCount, total: current };
  }

  function renderBinaryToOverlay(viewer, key, bin, w, h, overlayW, overlayH, colorHex, alpha01) {
    const overlay = ensureOverlayCanvas(viewer, key);
    if (!overlay) return;
    resizeOverlayToViewer(viewer, overlay);
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(w, h);

    const { r, g, b } = parseHexColor(colorHex);
    const a = Math.floor(255 * clamp(alpha01, 0, 1));

    const n = w * h;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      if (bin[i]) {
        img.data[j] = r;
        img.data[j + 1] = g;
        img.data[j + 2] = b;
        img.data[j + 3] = a;
      } else {
        img.data[j + 3] = 0;
      }
    }
    tctx.putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, overlayW, overlayH);
  }

  async function runOnce(viewer, key, state) {
    if (!state.enabled) return;
    if (state._running) return;
    state._running = true;
    clearError();
    try {
      const t0 = safeNow();
      const cap = captureViewportImageData(viewer, key, state);
      const { imageData, analyzedW, analyzedH, overlayW, overlayH } = cap;

      // Try WebGL threshold first, fall back to CPU
      let bin = null;
      if (DEFAULTS.useWebGL) {
        bin = thresholdWebGL(imageData, state.thresholdMin, state.thresholdMax, analyzedW, analyzedH);
      }
      if (!bin) {
        bin = thresholdToBinary(imageData, state.thresholdMin, state.thresholdMax);
      }
      
      const { out, blobs, total } = connectedComponentsFilter(bin, analyzedW, analyzedH, state.minArea, state.maxArea);

      renderBinaryToOverlay(viewer, key, out, analyzedW, analyzedH, overlayW, overlayH, DEFAULTS.maskColor, DEFAULTS.maskAlpha);

      const t1 = safeNow();
      state.last.ms = Math.round(t1 - t0);
      state.last.blobs = blobs;
      state.last.analyzedW = analyzedW;
      state.last.analyzedH = analyzedH;

      const statsEl = getStatsEl();
      if (statsEl) {
        statsEl.textContent = `analyze ${analyzedW}x${analyzedH} · blobs ${blobs}/${total} · ${state.last.ms}ms`;
      }
    } finally {
      state._running = false;
    }
  }

  function updateUIFromState(state) {
    const toggleBtn = document.getElementById('stain-seg-toggle-btn');
    const controls = document.getElementById('stain-seg-controls');
    if (toggleBtn) {
      toggleBtn.textContent = state.enabled ? 'ON' : 'OFF';
      toggleBtn.classList.toggle('btn-primary', state.enabled);
    }
    if (controls) {
      controls.style.opacity = state.enabled ? '1' : '0.5';
      controls.style.pointerEvents = state.enabled ? 'auto' : 'none';
    }

    // Threshold range sliders
    const thMin = document.getElementById('stain-seg-threshold-min-slider');
    const thMinV = document.getElementById('stain-seg-threshold-min-value');
    if (thMin) thMin.value = String(state.thresholdMin);
    if (thMinV) thMinV.textContent = Number(state.thresholdMin).toFixed(2);

    const thMax = document.getElementById('stain-seg-threshold-max-slider');
    const thMaxV = document.getElementById('stain-seg-threshold-max-value');
    if (thMax) thMax.value = String(state.thresholdMax);
    if (thMaxV) thMaxV.textContent = Number(state.thresholdMax).toFixed(2);

    // Update range display
    const rangeDisplay = document.getElementById('stain-seg-threshold-range');
    if (rangeDisplay) {
      rangeDisplay.textContent = `${Number(state.thresholdMin).toFixed(2)} – ${Number(state.thresholdMax).toFixed(2)}`;
    }

    const min = document.getElementById('stain-seg-min-area-slider');
    const minv = document.getElementById('stain-seg-min-area-value');
    if (min) min.value = String(state.minArea);
    if (minv) minv.textContent = String(state.minArea);

    const max = document.getElementById('stain-seg-max-area-slider');
    const maxv = document.getElementById('stain-seg-max-area-value');
    if (max) max.value = String(state.maxArea);
    if (maxv) maxv.textContent = String(state.maxArea);

    const au = document.getElementById('stain-seg-auto-update');
    if (au) au.checked = !!state.autoUpdate;
  }

  function getPrimaryController() {
    // Single-viewer default
    return controllers.get('v1') || Array.from(controllers.values())[0] || null;
  }

  function attachToViewer(viewer, opts) {
    const key = (opts && opts.key) || 'v1';
    console.log('[StainSeg] attachToViewer called, key:', key, 'viewer:', !!viewer);
    
    if (!viewer) {
      console.warn('[StainSeg] attachToViewer called with null viewer');
      return;
    }
    
    const entry = controllers.get(key) || { viewer, key, state: createState() };
    entry.viewer = viewer;
    entry.key = key;
    controllers.set(key, entry);
    
    console.log('[StainSeg] Controller registered, controllers.size:', controllers.size);

    ensureOverlayCanvas(viewer, key);
    resizeOverlayToViewer(viewer, ensureOverlayCanvas(viewer, key));
    
    // Clear any previous "load a slide first" error since we now have a viewer
    clearError();
    updateUIFromState(entry.state);

    // React to nav changes if enabled
    if (viewer && typeof viewer.addHandler === 'function') {
      const onNav = () => scheduleRun(entry);
      viewer.addHandler('pan', onNav);
      viewer.addHandler('zoom', onNav);
      viewer.addHandler('animation-finish', onNav);
      viewer.addHandler('resize', () => {
        const overlay = ensureOverlayCanvas(viewer, key);
        if (overlay) resizeOverlayToViewer(viewer, overlay);
      });
    }

    updateUIFromState(entry.state);
  }

  function setEnabled(enabled) {
    const entry = getPrimaryController();
    if (!entry) return;
    entry.state.enabled = !!enabled;
    updateUIFromState(entry.state);
    if (!entry.state.enabled) {
      clearOverlay(entry.viewer, entry.key);
      setError('');
    } else {
      if (getAnalysisPanelEl() && getAnalysisPanelEl().style.display !== 'none') {
        // auto run immediately when enabling
        runOnce(entry.viewer, entry.key, entry.state).catch((e) => setError(e.message || String(e)));
      }
    }
  }

  function toggleEnabled() {
    console.log('[StainSeg] toggleEnabled called, controllers.size:', controllers.size);
    const entry = getPrimaryController();
    if (!entry) {
      console.warn('[StainSeg] No viewer attached - load a slide first. Controllers:', Array.from(controllers.keys()));
      setError('Load a slide first');
      return;
    }
    console.log('[StainSeg] Toggle enabled:', !entry.state.enabled, 'viewer:', !!entry.viewer);
    setEnabled(!entry.state.enabled);
  }

  function setThresholdMin(v) {
    const entry = getPrimaryController();
    if (!entry) return;
    const num = clamp(parseFloat(v), 0, 1);
    entry.state.thresholdMin = isFinite(num) ? num : entry.state.thresholdMin;
    // Ensure min <= max
    if (entry.state.thresholdMin > entry.state.thresholdMax) {
      entry.state.thresholdMax = entry.state.thresholdMin;
    }
    updateUIFromState(entry.state);
    if (entry.state.enabled) scheduleRun(entry);
  }

  function setThresholdMax(v) {
    const entry = getPrimaryController();
    if (!entry) return;
    const num = clamp(parseFloat(v), 0, 1);
    entry.state.thresholdMax = isFinite(num) ? num : entry.state.thresholdMax;
    // Ensure max >= min
    if (entry.state.thresholdMax < entry.state.thresholdMin) {
      entry.state.thresholdMin = entry.state.thresholdMax;
    }
    updateUIFromState(entry.state);
    if (entry.state.enabled) scheduleRun(entry);
  }

  function setMinArea(v) {
    const entry = getPrimaryController();
    if (!entry) return;
    const num = Math.max(0, parseInt(v, 10) || 0);
    entry.state.minArea = num;
    updateUIFromState(entry.state);
    if (entry.state.enabled) scheduleRun(entry);
  }

  function setMaxArea(v) {
    const entry = getPrimaryController();
    if (!entry) return;
    const num = Math.max(0, parseInt(v, 10) || 0);
    entry.state.maxArea = num;
    updateUIFromState(entry.state);
    if (entry.state.enabled) scheduleRun(entry);
  }

  function setAutoUpdate(on) {
    const entry = getPrimaryController();
    if (!entry) return;
    entry.state.autoUpdate = !!on;
    updateUIFromState(entry.state);
  }

  function run() {
    const entry = getPrimaryController();
    if (!entry) return;
    if (!entry.state.enabled) setEnabled(true);
    runOnce(entry.viewer, entry.key, entry.state).catch((e) => setError(e.message || String(e)));
  }

  function clear() {
    const entry = getPrimaryController();
    if (!entry) return;
    clearOverlay(entry.viewer, entry.key);
    const statsEl = getStatsEl();
    if (statsEl) statsEl.textContent = '';
    setError('');
  }

  function updateUI() {
    const entry = getPrimaryController();
    if (!entry) return;
    updateUIFromState(entry.state);
  }

  // Expose minimal API
  window.StainSegmentation = {
    attachToViewer,
    setEnabled,
    toggleEnabled,
    setThresholdMin,
    setThresholdMax,
    setMinArea,
    setMaxArea,
    setAutoUpdate,
    run,
    clear,
    updateUI,
  };

  document.addEventListener('DOMContentLoaded', () => {
    // Initialize UI defaults (viewer may not be attached yet)
    updateUI();
  });
})();

