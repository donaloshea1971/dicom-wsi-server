/**
 * PathView Pro - StarDist Nuclei Segmentation (Prototype)
 *
 * MVP goals:
 * - Load ONNX Runtime Web from CDN
 * - Load a StarDist-style ONNX model from a configurable URL (Hugging Face resolve URL works)
 * - Capture viewport pixels from OpenSeadragon canvas (or stain deconvolution canvas if visible)
 * - Run inference (WebGL EP) + postprocess in a Web Worker (simple local-max + greedy NMS)
 * - Render polygons in a canvas overlay + compute basic "positivity" from intensity inside polygons
 *
 * Notes:
 * - This is intentionally pragmatic: StarDist postprocess is approximated for speed and simplicity.
 * - If canvas pixels are not readable (CORS taint), we show a clear error in UI.
 */
(function () {
  'use strict';

  // ========= Config defaults =========
  const ORT_CDN_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js';

  // Default to local model served by nginx (deployed via viewer/Dockerfile)
  // Fallback: Hugging Face pattern: https://huggingface.co/<org>/<repo>/resolve/main/<file>.onnx
  const DEFAULT_MODEL_URL = '/models/stardist_2D_versatile_he_256.onnx';

  const DEFAULTS = {
    enabled: false,
    debug: false,
    // Navigation debounce (ms)
    debounceMs: 350,
    // Zoom gate (OSD zoom label is like "20.0x" in this app)
    minZoomX: 15,
    maxZoomX: 45,
    // Inference input resolution
    inputSize: 256,
    // Postprocess
    probThreshold: 0.45,
    nmsDistPx: 8, // on model input grid
    maxDetections: 512,
    // Rendering
    strokeWidth: 1.25,
    nucleusColor: '#00d4aa',
    posColor: '#ff4d4d',
    negColor: '#2ecc71',
    alpha: 0.85,
    // Positivity scoring (simple luminance threshold on captured image)
    positivityEnabled: true,
    positiveIfDarkerThan: 0.55, // 0..1, where 0=black, 1=white
    // Prefer stain deconvolution canvas (when enabled) as inference source
    preferStainCanvas: true,
  };

  // ========= Small helpers =========
  function safeNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function log(state, ...args) {
    if (state && state.debug) console.log('[StarDist]', ...args);
  }

  function getBadgeEl() { return document.getElementById('stardist-badge'); }
  function getPanelEl() { return document.getElementById('stardist-panel'); }

  function updateStatus(icon, text, showProgress = false, progress = 0) {
    const iconEl = document.getElementById('stardist-status-icon');
    const textEl = document.getElementById('stardist-status-text');
    const progressEl = document.getElementById('stardist-progress');
    const progressBar = document.getElementById('stardist-progress-bar');
    if (iconEl) iconEl.textContent = icon;
    if (textEl) textEl.textContent = text;
    if (progressEl) progressEl.style.display = showProgress ? 'block' : 'none';
    if (progressBar) progressBar.style.width = `${progress}%`;
  }

  function setError(msg) {
    const el = document.getElementById('stardist-error');
    if (el) el.textContent = msg || '';
  }

  function setStats(text) {
    const el = document.getElementById('stardist-stats');
    if (el) el.textContent = text || '';
  }

  function showPanel(show) {
    const p = getPanelEl();
    if (!p) return;
    p.classList.toggle('active', !!show);
  }

  function setBadgeActive(active) {
    const b = getBadgeEl();
    if (!b) return;
    b.classList.toggle('active', !!active);
    b.title = active ? 'Nuclei AI: ON (click to toggle)' : 'Nuclei AI: OFF (click to toggle)';
    b.textContent = active ? '🧬 AI' : '🧬';
  }

  function getZoomX(viewer) {
    // In this app, zoom label is updated in viewer-main to "20.0x"
    const z = document.getElementById('zoom-level');
    if (z && typeof z.textContent === 'string' && z.textContent.includes('x')) {
      const v = parseFloat(z.textContent.replace('x', '').trim());
      if (isFinite(v)) return v;
    }
    // Fallback: attempt viewer viewport zoom (not calibrated to "x" but still monotonic)
    try {
      const zz = viewer.viewport && viewer.viewport.getZoom && viewer.viewport.getZoom(true);
      if (typeof zz === 'number' && isFinite(zz)) return zz;
    } catch (e) {}
    return null;
  }

  // ========= Overlay canvas =========
  function ensureOverlayCanvas(viewer, key) {
    const el = viewer && viewer.element;
    if (!el) return null;
    let canvas = el.querySelector(`canvas.stardist-overlay-canvas[data-stardist-key="${key}"]`);
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.className = 'stardist-overlay-canvas';
    canvas.dataset.stardistKey = key;
    canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 19;
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
    const canvas = ensureOverlayCanvas(viewer, key);
    if (!canvas) return;
    resizeOverlayToViewer(viewer, canvas);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ========= Source capture =========
  function findOsdRenderCanvas(viewer, overlayCanvas) {
    try {
      if (viewer && viewer.drawer && viewer.drawer.canvas) return viewer.drawer.canvas;
    } catch (e) {}
    const el = viewer && viewer.element;
    if (!el) return null;
    const canvases = el.querySelectorAll('canvas');
    for (const c of canvases) {
      if (overlayCanvas && c === overlayCanvas) continue;
      if (c.classList && c.classList.contains('stardist-overlay-canvas')) continue;
      if (c.classList && c.classList.contains('stain-seg-mask-canvas')) continue;
      if (c.classList && c.classList.contains('watershed-overlay-canvas')) continue;
      if (c.id === 'annotation-canvas') continue;
      // Prefer actual render canvas (OSD drawer canvas)
      return c;
    }
    return null;
  }

  function findPreferredSourceCanvas(viewer, key, state) {
    const overlay = ensureOverlayCanvas(viewer, key);
    if (!overlay) return null;
    // If stain deconvolution is enabled, it renders to one of these overlay canvases.
    if (state.preferStainCanvas) {
      const el = viewer && viewer.element;
      const stain = el && (el.querySelector('#stain-deconv-canvas-2d') || el.querySelector('#stain-deconv-canvas'));
      if (stain && stain.width > 1 && stain.height > 1 && stain.style.display !== 'none') {
        return stain;
      }
    }
    return findOsdRenderCanvas(viewer, overlay);
  }

  function captureViewport(viewer, key, state) {
    const overlay = ensureOverlayCanvas(viewer, key);
    if (!overlay) throw new Error('Overlay canvas missing');
    resizeOverlayToViewer(viewer, overlay);

    const sourceCanvas = findPreferredSourceCanvas(viewer, key, state);
    if (!sourceCanvas) throw new Error('OpenSeadragon render canvas not found');

    const input = clamp(parseInt(state.inputSize, 10) || DEFAULTS.inputSize, 128, 768);
    const cap = document.createElement('canvas');
    cap.width = input;
    cap.height = input;

    const ctx = cap.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(sourceCanvas, 0, 0, input, input);

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, input, input);
    } catch (e) {
      throw new Error('Cannot read pixels from viewport (canvas is tainted). Check tile CORS/same-origin.');
    }

    return {
      imageData,
      inputW: input,
      inputH: input,
      overlayW: overlay.width,
      overlayH: overlay.height,
      sourceLabel: (sourceCanvas && sourceCanvas.id) ? `#${sourceCanvas.id}` : 'canvas',
    };
  }

  // ========= ORT loading =========
  let _ortPromise = null;
  function loadOrt(state) {
    if (window.ort) return Promise.resolve(window.ort);
    if (_ortPromise) return _ortPromise;

    _ortPromise = new Promise((resolve, reject) => {
      updateStatus('📥', 'Loading ONNX Runtime...', true, 10);
      const existing = document.querySelector('script[data-ort]');
      if (existing && window.ort) return resolve(window.ort);

      const s = document.createElement('script');
      s.src = ORT_CDN_URL;
      s.async = true;
      s.dataset.ort = '1';
      s.onload = () => {
        if (!window.ort) return reject(new Error('ONNX Runtime loaded but window.ort missing'));
        try {
          // Helps ORT find wasm files when it needs them.
          if (window.ort.env && window.ort.env.wasm) {
            window.ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/';
          }
        } catch (e) {}
        resolve(window.ort);
      };
      s.onerror = () => reject(new Error('Failed to load ONNX Runtime from CDN (network/firewall?)'));
      document.head.appendChild(s);
    });

    return _ortPromise;
  }

  async function createSession(modelUrl, state) {
    const ort = await loadOrt(state);
    if (!modelUrl) throw new Error('No model URL configured. Paste a Hugging Face resolve URL to a .onnx file.');
    updateStatus('📦', 'Loading model...', true, 25);
    const t0 = safeNow();

    async function fetchModelBytes(url) {
      // Preflight fetch so we can surface clean HTTP errors (e.g., 401 gated HF repos)
      // and avoid ORT trying to parse an HTML error page as an ONNX model.
      let res;
      try {
        res = await fetch(url, { method: 'GET', mode: 'cors', redirect: 'follow', cache: 'default' });
      } catch (e) {
        // Network/CORS failures - let caller decide whether to fall back
        const msg = e && e.message ? e.message : String(e);
        throw new Error('Failed to fetch model (network/CORS): ' + msg);
      }
      if (!res.ok) {
        const hint =
          res.status === 401 ? ' (unauthorized / gated repo - you must use a public file or host it yourself)' :
          res.status === 403 ? ' (forbidden - gated repo or blocked by policy)' :
          '';
        throw new Error(`Failed to fetch model: HTTP ${res.status} ${res.statusText}${hint}`);
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      // HF sometimes serves as application/octet-stream; that's fine. If it's html, it's almost certainly an error page.
      if (ct.includes('text/html')) {
        throw new Error('Model URL returned HTML (not an ONNX file). Check the URL (use /resolve/main/<file>.onnx) and access permissions.');
      }
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength < 1024) {
        throw new Error(`Model download too small (${buf ? buf.byteLength : 0} bytes). Check URL/permissions.`);
      }
      return new Uint8Array(buf);
    }

    let sess;
    // Prefer bytes-based load for clearer errors; if ORT build doesn't accept bytes, fall back to URL.
    // Add cache-busting param to avoid stale browser cache (especially after initial 404/HTML responses)
    const bustUrl = modelUrl + (modelUrl.includes('?') ? '&' : '?') + '_cb=' + Date.now();
    try {
      const bytes = await fetchModelBytes(bustUrl);
      sess = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgl', 'wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      // If the error is our fetch error, propagate it. Otherwise try URL-based load as a fallback.
      if (msg.startsWith('Failed to fetch model:') || msg.startsWith('Model URL returned HTML') || msg.startsWith('Model download too small')) {
        throw e;
      }
      log(state, 'Byte-load failed, falling back to URL load:', msg);
      sess = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['webgl', 'wasm'],
        graphOptimizationLevel: 'all',
      });
    }

    const ms = Math.round(safeNow() - t0);
    log(state, 'Model loaded in', ms, 'ms', 'inputs:', sess.inputNames, 'outputs:', sess.outputNames);
    return sess;
  }

  function rgbaToCHWFloat(imageData, w, h) {
    const data = imageData.data;
    const out = new Float32Array(1 * 3 * w * h);
    const hw = w * h;
    for (let i = 0; i < hw; i++) {
      const j = i * 4;
      out[i] = data[j] / 255;           // R
      out[hw + i] = data[j + 1] / 255;  // G
      out[2 * hw + i] = data[j + 2] / 255; // B
    }
    return out;
  }

  function rgbaToHWCFloat(imageData, w, h) {
    const data = imageData.data;
    const out = new Float32Array(1 * w * h * 3);
    const hw = w * h;
    for (let i = 0; i < hw; i++) {
      const j = i * 4;
      const k = i * 3;
      out[k] = data[j] / 255;       // R
      out[k + 1] = data[j + 1] / 255; // G
      out[k + 2] = data[j + 2] / 255; // B
    }
    return out;
  }

  // ========= Worker (postprocess) =========
  function makePostprocessWorker() {
    const src = `
      self.onmessage = function (evt) {
        const msg = evt.data || {};
        if (msg.type !== 'postprocess') return;
        const { prob, dist, w, h, nRays, probThreshold, nmsDistPx, maxDetections } = msg;
        try {
          const points = [];
          // Local maxima in 8-neighborhood
          for (let y = 1; y < h - 1; y++) {
            const row = y * w;
            for (let x = 1; x < w - 1; x++) {
              const p = prob[row + x];
              if (p < probThreshold) continue;
              const p00 = prob[(y - 1) * w + (x - 1)];
              const p01 = prob[(y - 1) * w + (x)];
              const p02 = prob[(y - 1) * w + (x + 1)];
              const p10 = prob[(y) * w + (x - 1)];
              const p12 = prob[(y) * w + (x + 1)];
              const p20 = prob[(y + 1) * w + (x - 1)];
              const p21 = prob[(y + 1) * w + (x)];
              const p22 = prob[(y + 1) * w + (x + 1)];
              if (p >= p00 && p >= p01 && p >= p02 && p >= p10 && p >= p12 && p >= p20 && p >= p21 && p >= p22) {
                points.push({ x, y, p });
              }
            }
          }
          points.sort((a, b) => b.p - a.p);

          const kept = [];
          const nms2 = nmsDistPx * nmsDistPx;

          function isFarEnough(x, y) {
            for (let i = 0; i < kept.length; i++) {
              const dx = kept[i].x - x;
              const dy = kept[i].y - y;
              if (dx * dx + dy * dy < nms2) return false;
            }
            return true;
          }

          const maxK = Math.max(1, maxDetections | 0);
          for (let i = 0; i < points.length && kept.length < maxK; i++) {
            const pt = points[i];
            if (!isFarEnough(pt.x, pt.y)) continue;
            kept.push(pt);
          }

          const polys = [];
          const TWO_PI = Math.PI * 2;

          // dist is laid out as [nRays, h, w] flattened in C-order: ray-major
          const rayStride = w * h;
          for (let k = 0; k < kept.length; k++) {
            const { x, y, p } = kept[k];
            const verts = new Array(nRays);
            for (let r = 0; r < nRays; r++) {
              const rr = dist[r * rayStride + y * w + x] || 0;
              const ang = TWO_PI * (r / nRays);
              verts[r] = { x: x + rr * Math.cos(ang), y: y + rr * Math.sin(ang) };
            }
            polys.push({ x, y, p, verts });
          }

          self.postMessage({ type: 'postprocess-result', polys });
        } catch (e) {
          self.postMessage({ type: 'postprocess-error', error: (e && e.message) ? e.message : String(e) });
        }
      };
    `;
    const blob = new Blob([src], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    return new Worker(url);
  }

  function pointInPoly(x, y, verts) {
    // Ray casting
    let inside = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const xi = verts[i].x, yi = verts[i].y;
      const xj = verts[j].x, yj = verts[j].y;
      const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function meanLuminanceInPoly(imageData, w, h, verts, step) {
    // verts are in input-grid coords
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of verts) {
      minX = Math.min(minX, v.x);
      minY = Math.min(minY, v.y);
      maxX = Math.max(maxX, v.x);
      maxY = Math.max(maxY, v.y);
    }
    minX = clamp(Math.floor(minX), 0, w - 1);
    minY = clamp(Math.floor(minY), 0, h - 1);
    maxX = clamp(Math.ceil(maxX), 0, w - 1);
    maxY = clamp(Math.ceil(maxY), 0, h - 1);

    const data = imageData.data;
    let sum = 0;
    let cnt = 0;
    const s = Math.max(1, step | 0);
    for (let y = minY; y <= maxY; y += s) {
      for (let x = minX; x <= maxX; x += s) {
        if (!pointInPoly(x + 0.5, y + 0.5, verts)) continue;
        const idx = (y * w + x) * 4;
        const r = data[idx] / 255;
        const g = data[idx + 1] / 255;
        const b = data[idx + 2] / 255;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += lum;
        cnt++;
      }
    }
    return cnt > 0 ? (sum / cnt) : 1.0;
  }

  // ========= Controller =========
  function createState() {
    return {
      enabled: DEFAULTS.enabled,
      debug: DEFAULTS.debug,
      debounceMs: DEFAULTS.debounceMs,
      minZoomX: DEFAULTS.minZoomX,
      maxZoomX: DEFAULTS.maxZoomX,
      inputSize: DEFAULTS.inputSize,
      probThreshold: DEFAULTS.probThreshold,
      nmsDistPx: DEFAULTS.nmsDistPx,
      maxDetections: DEFAULTS.maxDetections,
      strokeWidth: DEFAULTS.strokeWidth,
      nucleusColor: DEFAULTS.nucleusColor,
      posColor: DEFAULTS.posColor,
      negColor: DEFAULTS.negColor,
      alpha: DEFAULTS.alpha,
      positivityEnabled: DEFAULTS.positivityEnabled,
      positiveIfDarkerThan: DEFAULTS.positiveIfDarkerThan,
      preferStainCanvas: DEFAULTS.preferStainCanvas,

      modelUrl: DEFAULT_MODEL_URL,
      session: null,
      sessionLoading: false,
      worker: null,

      _runTimer: null,
      _running: false,
      _runSeq: 0,
      _lastResult: null,
    };
  }

  const controllers = new Map(); // key -> { viewer, state }

  function scheduleRun(entry) {
    const { viewer, key, state } = entry;
    if (!state.enabled) return;
    if (state._runTimer) clearTimeout(state._runTimer);
    state._runTimer = setTimeout(() => {
      runOnce(viewer, key, state).catch((e) => {
        console.error('[StarDist] run failed:', e);
        setError(e && e.message ? e.message : String(e));
        updateStatus('❌', 'Failed', false);
      });
    }, clamp(state.debounceMs, 50, 2000));
  }

  async function ensureSession(state) {
    if (state.session) return state.session;
    if (state.sessionLoading) {
      // Wait for a single session build to complete
      while (state.sessionLoading) await new Promise(r => setTimeout(r, 50));
      if (state.session) return state.session;
    }
    state.sessionLoading = true;
    try {
      state.session = await createSession(state.modelUrl, state);
      updateStatus('✅', 'Model ready', false);
      return state.session;
    } finally {
      state.sessionLoading = false;
    }
  }

  function pickProbAndDist(outputs, inputW, inputH) {
    // outputs: name -> ort.Tensor
    // Heuristic: prob tensor has channel 1, dist tensor has channel > 1 (e.g., 32)
    let probT = null;
    let distT = null;
    for (const k of Object.keys(outputs)) {
      const t = outputs[k];
      const dims = t.dims || [];
      if (dims.length !== 4) continue;
      const c = dims[1];
      const h = dims[2];
      const w = dims[3];
      if (h !== inputH || w !== inputW) continue;
      if (c === 1) probT = t;
      if (c > 1) distT = t;
    }
    if (!probT || !distT) {
      // fallback: take first two 4D tensors matching spatial dims
      const candidates = Object.values(outputs).filter(t => (t.dims || []).length === 4 && t.dims[2] === inputH && t.dims[3] === inputW);
      if (candidates.length >= 2) {
        candidates.sort((a, b) => (a.dims[1] || 0) - (b.dims[1] || 0));
        probT = probT || candidates[0];
        distT = distT || candidates[candidates.length - 1];
      }
    }
    if (!probT || !distT) throw new Error('Unexpected model outputs. Need prob (C=1) + dist (C>1) tensors.');
    return { probT, distT };
  }

  function renderPolys(viewer, key, state, polys, cap) {
    const overlay = ensureOverlayCanvas(viewer, key);
    if (!overlay) return;
    resizeOverlayToViewer(viewer, overlay);
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const sx = overlay.width / cap.inputW;
    const sy = overlay.height / cap.inputH;

    ctx.lineWidth = state.strokeWidth;
    ctx.globalAlpha = clamp(state.alpha, 0.05, 1.0);
    ctx.lineJoin = 'round';

    let pos = 0;
    let neg = 0;
    const posEnabled = !!state.positivityEnabled;
    const posThresh = clamp(parseFloat(state.positiveIfDarkerThan), 0, 1);

    for (const poly of polys) {
      const verts = poly.verts;
      let isPos = false;
      if (posEnabled) {
        const lum = meanLuminanceInPoly(cap.imageData, cap.inputW, cap.inputH, verts, 2);
        // For DAB-like views: stained nuclei tend to be darker.
        isPos = lum < posThresh;
      }
      if (posEnabled) {
        if (isPos) pos++; else neg++;
        ctx.strokeStyle = isPos ? state.posColor : state.negColor;
      } else {
        ctx.strokeStyle = state.nucleusColor;
      }

      ctx.beginPath();
      for (let i = 0; i < verts.length; i++) {
        const vx = verts[i].x * sx;
        const vy = verts[i].y * sy;
        if (i === 0) ctx.moveTo(vx, vy);
        else ctx.lineTo(vx, vy);
      }
      ctx.closePath();
      ctx.stroke();
    }

    const total = polys.length;
    if (posEnabled) {
      const pct = total > 0 ? Math.round((pos / total) * 100) : 0;
      setStats(`${total} nuclei · ${pos} pos / ${neg} neg (${pct}%) · src ${cap.sourceLabel}`);
    } else {
      setStats(`${total} nuclei · src ${cap.sourceLabel}`);
    }
  }

  async function runOnce(viewer, key, state) {
    if (!state.enabled) return;
    if (state._running) return;

    const zx = getZoomX(viewer);
    if (zx != null && (zx < state.minZoomX || zx > state.maxZoomX)) {
      clearOverlay(viewer, key);
      setStats('');
      setError('');
      updateStatus('🔎', `Zoom to ${state.minZoomX}x–${state.maxZoomX}x for nuclei AI`, false);
      return;
    }

    state._running = true;
    const runId = ++state._runSeq;

    try {
      setError('');
      updateStatus('🧠', 'Running nuclei AI...', true, 55);
      const t0 = safeNow();

      const cap = captureViewport(viewer, key, state);
      const sess = await ensureSession(state);

      const inputName = (sess.inputNames && sess.inputNames[0]) ? sess.inputNames[0] : 'input';
      const ort = window.ort;
      // StarDist 2D models expect NHWC format [batch, height, width, channels]
      // ORT-Web doesn't reliably expose inputMetadata, so we default to NHWC for StarDist
      const modelExpectsNHWC = true;

      const inputData = modelExpectsNHWC
        ? rgbaToHWCFloat(cap.imageData, cap.inputW, cap.inputH)
        : rgbaToCHWFloat(cap.imageData, cap.inputW, cap.inputH);

      const inputTensor = modelExpectsNHWC
        ? new ort.Tensor('float32', inputData, [1, cap.inputH, cap.inputW, 3])
        : new ort.Tensor('float32', inputData, [1, 3, cap.inputH, cap.inputW]);

      const outputs = await sess.run({ [inputName]: inputTensor });
      if (runId !== state._runSeq) return; // stale

      // Extract prob + dist into a normalized layout for worker:
      // - prob: Float32Array [H*W] row-major
      // - distRayMajor: Float32Array [nRays*H*W] where each ray is a plane
      const extracted = (function extract(outputsMap, H, W) {
        const outs = outputsMap || {};
        const tensors = Object.keys(outs).map(k => ({ name: k, t: outs[k] }));

        // Debug: log what the model actually outputs
        console.log('[StarDist] Model outputs:', tensors.map(({ name, t }) => ({
          name,
          dims: t?.dims,
          size: t?.data?.length
        })));
        console.log('[StarDist] Expected spatial dims:', H, 'x', W);

        // Find candidates with spatial dims matching (allow some flex for padding)
        const spatial = tensors.filter(({ t }) => {
          const d = t && t.dims;
          if (!d || d.length < 3) return false;
          // 4D: NCHW [1,C,H,W] or NHWC [1,H,W,C]
          if (d.length === 4) {
            if (d[2] === H && d[3] === W) return true;
            if (d[1] === H && d[2] === W) return true;
          }
          // 3D: CHW [C,H,W] or HWC [H,W,C]
          if (d.length === 3) {
            if (d[1] === H && d[2] === W) return true;
            if (d[0] === H && d[1] === W) return true;
          }
          return false;
        });
        console.log('[StarDist] Spatial candidates:', spatial.length);
        if (spatial.length < 2) throw new Error('Unexpected model outputs (need prob + dist). Got: ' + 
          tensors.map(({name, t}) => `${name}:${t?.dims?.join('x')}`).join(', '));

        // Heuristic: prob has channel=1, dist has channel>1.
        function getChannelCount(d) {
          if (!d || d.length !== 4) return null;
          // NCHW
          if (d[2] === H && d[3] === W) return d[1];
          // NHWC
          if (d[1] === H && d[2] === W) return d[3];
          return null;
        }

        let probT = null, distT = null;
        for (const { t } of spatial) {
          const c = getChannelCount(t.dims);
          if (c === 1) probT = t;
          else if (typeof c === 'number' && c > 1) distT = t;
        }
        // Fallback: pick smallest C as prob, largest C as dist
        if (!probT || !distT) {
          const sorted = spatial.slice().sort((a, b) => (getChannelCount(a.t.dims) || 0) - (getChannelCount(b.t.dims) || 0));
          probT = probT || sorted[0].t;
          distT = distT || sorted[sorted.length - 1].t;
        }
        if (!probT || !distT) throw new Error('Could not identify prob/dist outputs.');

        const probDims = probT.dims;
        const distDims = distT.dims;
        const probIsNCHW = (probDims[2] === H && probDims[3] === W);
        const distIsNCHW = (distDims[2] === H && distDims[3] === W);
        const nRays = distIsNCHW ? (distDims[1] | 0) : (distDims[3] | 0);
        const hw = H * W;

        // prob -> [H*W]
        const prob = new Float32Array(hw);
        const probData = probT.data;
        if (probIsNCHW) {
          // [1,1,H,W] flattened => direct copy
          for (let i = 0; i < hw; i++) prob[i] = probData[i];
        } else {
          // [1,H,W,1]
          for (let i = 0; i < hw; i++) prob[i] = probData[i];
        }

        // dist -> ray-major [nRays, H, W]
        const distRayMajor = new Float32Array(nRays * hw);
        const distData = distT.data;
        if (distIsNCHW) {
          // [1,nRays,H,W] already ray-major planes
          for (let i = 0; i < distRayMajor.length; i++) distRayMajor[i] = distData[i];
        } else {
          // [1,H,W,nRays] => transpose to ray-major
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const base = ((y * W + x) * nRays);
              const idx = y * W + x;
              for (let r = 0; r < nRays; r++) {
                distRayMajor[r * hw + idx] = distData[base + r];
              }
            }
          }
        }

        return { prob, distRayMajor, nRays };
      })(outputs, cap.inputH, cap.inputW);

      if (!state.worker) state.worker = makePostprocessWorker();
      const worker = state.worker;

      const postRes = await new Promise((resolve, reject) => {
        const onMsg = (evt) => {
          const m = evt.data || {};
          if (m.type === 'postprocess-result') {
            worker.removeEventListener('message', onMsg);
            resolve(m.polys || []);
          } else if (m.type === 'postprocess-error') {
            worker.removeEventListener('message', onMsg);
            reject(new Error(m.error || 'postprocess error'));
          }
        };
        worker.addEventListener('message', onMsg);

        // Copy to transferable ArrayBuffers to reduce overhead
        const probCopy = new Float32Array(extracted.prob.length);
        probCopy.set(extracted.prob);
        const distCopy = new Float32Array(extracted.distRayMajor.length);
        distCopy.set(extracted.distRayMajor);

        worker.postMessage({
          type: 'postprocess',
          prob: probCopy,
          dist: distCopy,
          w: cap.inputW,
          h: cap.inputH,
          nRays: extracted.nRays,
          probThreshold: clamp(parseFloat(state.probThreshold), 0, 1),
          nmsDistPx: Math.max(1, parseInt(state.nmsDistPx, 10) || 8),
          maxDetections: Math.max(1, parseInt(state.maxDetections, 10) || 512),
        }, [probCopy.buffer, distCopy.buffer]);
      });

      if (runId !== state._runSeq) return; // stale

      renderPolys(viewer, key, state, postRes, cap);
      const ms = Math.round(safeNow() - t0);
      updateStatus('✅', `Done (${ms}ms)`, false);
      state._lastResult = { ms, count: postRes.length, ts: Date.now() };
    } finally {
      state._running = false;
    }
  }

  function attachToViewer(viewer, opts) {
    const key = (opts && opts.key) || 'v1';
    if (!viewer) return;
    const entry = controllers.get(key) || { viewer, state: createState() };
    entry.viewer = viewer;
    controllers.set(key, entry);

    ensureOverlayCanvas(viewer, key);
    resizeOverlayToViewer(viewer, ensureOverlayCanvas(viewer, key));

    // Show badge once a viewer exists
    const badge = getBadgeEl();
    if (badge) badge.style.display = 'block';

    // Nav handlers
    if (viewer && typeof viewer.addHandler === 'function') {
      const onNav = () => scheduleRun({ viewer, key, state: entry.state });
      viewer.addHandler('animation-finish', onNav);
      viewer.addHandler('resize', () => {
        const overlay = ensureOverlayCanvas(viewer, key);
        if (overlay) resizeOverlayToViewer(viewer, overlay);
      });
    }

    // If already enabled, schedule a run
    if (entry.state.enabled) scheduleRun({ viewer, key, state: entry.state });
  }

  function setEnabled(enabled) {
    const on = !!enabled;
    setBadgeActive(on);
    showPanel(on);
    setError('');
    setStats('');

    if (on) updateStatus('⏳', 'Initializing nuclei AI...', true, 5);
    else updateStatus('⏸️', 'Nuclei AI disabled', false);

    for (const [key, entry] of controllers.entries()) {
      entry.state.enabled = on;
      entry.state._runSeq++; // cancel stale
      clearOverlay(entry.viewer, key);
      if (on) scheduleRun({ viewer: entry.viewer, key, state: entry.state });
    }
  }

  function toggleEnabled() {
    if (controllers.size === 0) {
      const b = getBadgeEl();
      const isActive = b && b.classList.contains('active');
      setBadgeActive(!isActive);
      showPanel(!isActive);
      return;
    }
    const any = Array.from(controllers.values()).some(x => x.state.enabled);
    setEnabled(!any);
  }

  function clear() {
    for (const [key, entry] of controllers.entries()) {
      clearOverlay(entry.viewer, key);
      entry.state._lastResult = null;
    }
    setStats('');
    setError('');
    updateStatus('🧹', 'Cleared', false);
  }

  function run() {
    const first = controllers.get('v1') || Array.from(controllers.values())[0];
    if (!first) return;
    scheduleRun({ viewer: first.viewer, key: 'v1', state: first.state });
    // force immediate
    if (first.state._runTimer) clearTimeout(first.state._runTimer);
    runOnce(first.viewer, 'v1', first.state).catch((e) => setError(e.message || String(e)));
  }

  function setModelUrl(url) {
    const u = String(url || '').trim();
    for (const entry of controllers.values()) {
      entry.state.modelUrl = u;
      entry.state.session = null; // force reload
    }
    const inp = document.getElementById('stardist-model-url');
    if (inp) inp.value = u;
    updateStatus('🔧', u ? 'Model URL set (will reload on next run)' : 'Model URL cleared', false);
  }

  function setProbThreshold(v) {
    const num = clamp(parseFloat(v), 0, 1);
    for (const entry of controllers.values()) entry.state.probThreshold = isFinite(num) ? num : entry.state.probThreshold;
    const el = document.getElementById('stardist-prob-threshold-value');
    if (el) el.textContent = num.toFixed(2);
  }

  function setPositiveThreshold(v) {
    const num = clamp(parseFloat(v), 0, 1);
    for (const entry of controllers.values()) entry.state.positiveIfDarkerThan = isFinite(num) ? num : entry.state.positiveIfDarkerThan;
    const el = document.getElementById('stardist-pos-threshold-value');
    if (el) el.textContent = num.toFixed(2);
  }

  function initUI() {
    const badge = getBadgeEl();
    if (badge) badge.addEventListener('click', () => toggleEnabled());
    const btnClear = document.getElementById('stardist-clear-btn');
    if (btnClear) btnClear.addEventListener('click', () => clear());
    const btnDone = document.getElementById('stardist-hide-btn');
    if (btnDone) btnDone.addEventListener('click', () => setEnabled(false));
    const btnRun = document.getElementById('stardist-run-btn');
    if (btnRun) btnRun.addEventListener('click', () => run());

    const modelInp = document.getElementById('stardist-model-url');
    if (modelInp) {
      modelInp.value = DEFAULT_MODEL_URL;
      modelInp.addEventListener('change', () => setModelUrl(modelInp.value));
    }

    const probSlider = document.getElementById('stardist-prob-threshold');
    if (probSlider) probSlider.addEventListener('input', () => setProbThreshold(probSlider.value));
    const posSlider = document.getElementById('stardist-pos-threshold');
    if (posSlider) posSlider.addEventListener('input', () => setPositiveThreshold(posSlider.value));

    setBadgeActive(false);
    showPanel(false);
    updateStatus('⏸️', 'Click 🧬 badge to enable', false);
  }

  // Expose minimal API
  window.StarDistSegmentation = {
    attachToViewer,
    setEnabled,
    toggleEnabled,
    run,
    clear,
    setModelUrl,
    setProbThreshold,
    setPositiveThreshold,
  };
  window.toggleStarDist = toggleEnabled;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }
})();

