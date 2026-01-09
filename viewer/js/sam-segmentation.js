/**
 * PathView Pro - Client-side SAM Segmentation (Prototype)
 *
 * - Loads a SlimSAM/MobileSAM-class model from Hugging Face via Transformers.js
 * - Encodes the current viewport (canvas capture) and caches embedding
 * - Click/box prompts decode masks and draw an overlay
 *
 * Notes:
 * - This is a best-effort integration: Transformers.js SAM APIs have varied across versions.
 *   We use runtime feature detection and fallbacks (may run full forward pass if embedding-only
 *   decode isn't available in the loaded build).
 * - Masks are "viewport-local": if you pan/zoom, we clear and re-encode after motion settles.
 */

(function () {
  'use strict';

  const HF_MODEL_ID = 'Xenova/slimsam-77-uniform';
  // Try multiple CDNs for reliability
  const TRANSFORMERS_CDN_URLS = [
    'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
    'https://esm.sh/@xenova/transformers@2.17.2',
    'https://unpkg.com/@xenova/transformers@2.17.2'
  ];

  const DEFAULTS = {
    // Re-encode after navigation settles (ms)
    encodeDebounceMs: 250,
    // Alpha of mask overlay (0..1)
    maskAlpha: 0.35,
    // Mask color (CSS)
    maskColor: '#00d4aa',
    // Debug logging
    debug: false,
  };

  function log(...args) {
    if (DEFAULTS.debug) console.log('[SAM]', ...args);
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function getBadgeEl() {
    return document.getElementById('segment-badge');
  }

  function getPanelEl() {
    return document.getElementById('segment-panel');
  }

  function setBadgeActive(active) {
    const badge = getBadgeEl();
    if (!badge) return;
    badge.classList.toggle('active', !!active);
    badge.title = active ? 'AI segmentation: ON (click to toggle)' : 'AI segmentation: OFF (click to toggle)';
    badge.textContent = active ? '✂️ AI' : '✂️';
  }

  function showPanel(show) {
    const panel = getPanelEl();
    console.log('[SAM] showPanel:', show, 'panel found:', !!panel);
    if (!panel) return;
    panel.classList.toggle('active', !!show);
    console.log('[SAM] panel classList:', panel.classList.toString());
  }

  function safeNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // Status UI helpers
  function updateStatus(icon, text, showProgress = false, progress = 0) {
    const iconEl = document.getElementById('segment-status-icon');
    const textEl = document.getElementById('segment-status-text');
    const progressEl = document.getElementById('segment-progress');
    const progressBar = document.getElementById('segment-progress-bar');
    
    if (iconEl) iconEl.textContent = icon;
    if (textEl) textEl.textContent = text;
    if (progressEl) progressEl.style.display = showProgress ? 'block' : 'none';
    if (progressBar) progressBar.style.width = `${progress}%`;
  }

  function isViewportLocked() {
    const checkbox = document.getElementById('segment-lock-viewport');
    return checkbox && checkbox.checked;
  }

  async function loadTransformers() {
    let mod = null;
    let lastError = null;
    
    // Try each CDN until one works
    for (const url of TRANSFORMERS_CDN_URLS) {
      try {
        console.log('[SAM] Trying to load Transformers.js from:', url);
        updateStatus('📥', `Loading AI library from CDN...`, true, 15);
        mod = await import(url);
        console.log('[SAM] Successfully loaded from:', url);
        break;
      } catch (e) {
        console.warn('[SAM] Failed to load from', url, ':', e.message);
        lastError = e;
      }
    }
    
    if (!mod) {
      const errMsg = 'Could not load AI library from any CDN. Check network/firewall.';
      updateStatus('❌', errMsg, false);
      throw new Error(errMsg + ' Last error: ' + (lastError?.message || 'unknown'));
    }
    
    // Configure runtime for browser
    try {
      if (mod.env) {
        mod.env.allowLocalModels = false;
        mod.env.useBrowserCache = true;
      }
    } catch (e) {}
    return mod;
  }

  async function ensureSamLoaded(state) {
    if (state._samReady) return state._samReady;
    state._samReady = (async () => {
      updateStatus('⏳', 'Loading AI library...', true, 10);
      const transformers = await loadTransformers();
      const { SamModel, AutoProcessor, RawImage } = transformers;
      state._SamModel = SamModel;
      state._AutoProcessor = AutoProcessor;
      state._RawImage = RawImage;

      const t0 = safeNow();
      updateStatus('📥', 'Downloading SAM model (~50MB)...', true, 30);
      state.processor = await AutoProcessor.from_pretrained(HF_MODEL_ID);
      updateStatus('📥', 'Loading model weights...', true, 70);
      state.model = await SamModel.from_pretrained(HF_MODEL_ID);
      const t1 = safeNow();

      state.lastTimings.loadMs = Math.round(t1 - t0);
      updateStatus('✅', `Model ready (loaded in ${(state.lastTimings.loadMs/1000).toFixed(1)}s)`, false);
      log('Model loaded in', state.lastTimings.loadMs, 'ms');
      return true;
    })();
    return state._samReady;
  }

  function findOsdRenderCanvas(viewer, overlayCanvas) {
    try {
      // Prefer OSD's internal render canvas if present
      if (viewer && viewer.drawer && viewer.drawer.canvas) return viewer.drawer.canvas;
    } catch (e) {}

    // Fallback: first canvas under viewer element that isn't our overlay
    const el = viewer && viewer.element;
    if (!el) return null;
    const canvases = el.querySelectorAll('canvas');
    for (const c of canvases) {
      if (overlayCanvas && c === overlayCanvas) continue;
      // Skip annotation canvas if present
      if (c.id === 'annotation-canvas') continue;
      return c;
    }
    return null;
  }

  function ensureOverlayCanvas(viewer, key) {
    const el = viewer && viewer.element;
    if (!el) return null;
    let canvas = el.querySelector(`canvas.sam-mask-canvas[data-sam-key="${key}"]`);
    if (canvas) return canvas;

    canvas = document.createElement('canvas');
    canvas.className = 'sam-mask-canvas';
    canvas.dataset.samKey = key;
    canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 18;
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

  function createState() {
    return {
      enabled: false,
      model: null,
      processor: null,
      _samReady: null,
      _SamModel: null,
      _AutoProcessor: null,

      // Embedding cache (single viewport for prototype)
      cached: {
        embedding: null,
        // capture canvas snapshot used for the embedding
        captureCanvas: null,
        captureW: 0,
        captureH: 0,
        // processor metadata (best-effort)
        meta: null,
      },

      lastTimings: {
        loadMs: null,
        encodeMs: null,
        decodeMs: null,
      },

      // UI/interaction
      statusEl: null,

      // Control
      _encodeTimer: null,
      _encoding: false,
      _decoding: false,
      _navDirty: true,

      // box prompt
      _box: null,
    };
  }

  function updatePanelStats(state) {
    const el = document.getElementById('segment-stats');
    if (!el) return;
    const parts = [];
    if (state.lastTimings.loadMs != null) parts.push(`load ${state.lastTimings.loadMs}ms`);
    if (state.lastTimings.encodeMs != null) parts.push(`encode ${state.lastTimings.encodeMs}ms`);
    if (state.lastTimings.decodeMs != null) parts.push(`decode ${state.lastTimings.decodeMs}ms`);
    el.textContent = parts.length ? parts.join(' · ') : 'idle';
  }

  function clearMask(viewer, state, key) {
    const canvas = ensureOverlayCanvas(viewer, key);
    if (!canvas) return;
    resizeOverlayToViewer(viewer, canvas);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function clearEmbedding(state) {
    state.cached.embedding = null;
    state.cached.meta = null;
    state.cached.captureCanvas = null;
    state.cached.captureW = 0;
    state.cached.captureH = 0;
  }

  function getViewerPointFromOsdEvent(viewer, evt) {
    // OSD provides position in different shapes depending on event type.
    // We want viewer element pixel coordinates.
    const pos = evt && (evt.position || evt.originalEvent && evt.originalEvent.position);
    if (pos && typeof pos.x === 'number') {
      return { x: pos.x, y: pos.y };
    }

    // Fallback to originalEvent clientX/clientY
    const oe = evt && evt.originalEvent;
    if (oe && typeof oe.clientX === 'number') {
      const rect = viewer.element.getBoundingClientRect();
      return { x: oe.clientX - rect.left, y: oe.clientY - rect.top };
    }

    return null;
  }

  function shouldIgnoreInteraction(getIsAnnotationActiveFn) {
    try {
      return !!(getIsAnnotationActiveFn && getIsAnnotationActiveFn());
    } catch (e) {
      return false;
    }
  }

  async function captureViewportCanvas(viewer, state, key) {
    const overlay = ensureOverlayCanvas(viewer, key);
    if (!overlay) throw new Error('Overlay canvas missing');
    resizeOverlayToViewer(viewer, overlay);

    const renderCanvas = findOsdRenderCanvas(viewer, overlay);
    if (!renderCanvas) throw new Error('OpenSeadragon render canvas not found');

    // Draw visible viewport into an offscreen canvas (same size as overlay)
    const cap = state.cached.captureCanvas || document.createElement('canvas');
    cap.width = overlay.width;
    cap.height = overlay.height;
    const capCtx = cap.getContext('2d', { willReadFrequently: true });
    capCtx.clearRect(0, 0, cap.width, cap.height);
    capCtx.drawImage(renderCanvas, 0, 0, cap.width, cap.height);

    // Taint check (throws on getImageData if cross-origin)
    let imageData;
    try {
      imageData = capCtx.getImageData(0, 0, cap.width, cap.height);
    } catch (e) {
      throw new Error('Cannot read pixels from viewport (canvas is tainted). Check tile CORS/same-origin.');
    }

    state.cached.captureCanvas = cap;
    state.cached.captureW = cap.width;
    state.cached.captureH = cap.height;
    
    // Convert to RawImage for Transformers.js processor
    if (state._RawImage) {
      const rawImage = new state._RawImage(imageData.data, cap.width, cap.height, 4);
      state.cached.rawImage = rawImage;
      return rawImage;
    }
    
    // Fallback: return canvas (older API)
    return cap;
  }

  async function computeEmbedding(viewer, state, key) {
    if (!state.enabled) return;
    if (state._encoding) return;
    state._encoding = true;
    try {
      await ensureSamLoaded(state);

      updateStatus('🔄', 'Analyzing viewport...', true, 50);
      const t0 = safeNow();
      const cap = await captureViewportCanvas(viewer, state, key);

      // Processor call (best-effort)
      updateStatus('🧠', 'Computing embeddings...', true, 70);
      const inputs = await state.processor(cap);

      // Try explicit embedding APIs first.
      let embedding = null;
      let meta = null;

      // Some builds expose get_image_embeddings(pixel_values)
      if (state.model && typeof state.model.get_image_embeddings === 'function') {
        const out = await state.model.get_image_embeddings(inputs);
        embedding = out && (out.image_embeddings || out);
        meta = { inputs };
      } else if (state.model && typeof state.model.encode_image === 'function') {
        const out = await state.model.encode_image(inputs);
        embedding = out && (out.image_embeddings || out);
        meta = { inputs };
      } else {
        // Fallback: run full forward once and capture any embedding-like field
        const out = await state.model(inputs);
        embedding = out && (out.image_embeddings || out.encoder_last_hidden_state || null);
        meta = { inputs };
      }

      if (!embedding) {
        throw new Error('Could not compute image embedding with the loaded SAM implementation.');
      }

      state.cached.embedding = embedding;
      state.cached.meta = meta;
      state._navDirty = false;
      const t1 = safeNow();
      state.lastTimings.encodeMs = Math.round(t1 - t0);
      updateStatus('✅', `Ready! Click to segment (encode: ${state.lastTimings.encodeMs}ms)`, false);
      updatePanelStats(state);
      log('Encoded viewport in', state.lastTimings.encodeMs, 'ms');
    } finally {
      state._encoding = false;
    }
  }

  function scheduleEncode(viewer, state, key) {
    if (!state.enabled) return;
    if (state._encodeTimer) clearTimeout(state._encodeTimer);
    state._encodeTimer = setTimeout(() => {
      if (!state.enabled) return;
      computeEmbedding(viewer, state, key).catch((e) => {
        console.error('SAM encode failed:', e);
        const errEl = document.getElementById('segment-error');
        if (errEl) errEl.textContent = e.message || String(e);
        showPanel(true);
        updatePanelStats(state);
      });
    }, DEFAULTS.encodeDebounceMs);
  }

  function tryPostProcessMasks(processor, predMasks, originalSizes, reshapedInputSizes) {
    if (!processor) return null;
    if (typeof processor.post_process_masks !== 'function') return null;
    try {
      return processor.post_process_masks(predMasks, originalSizes, reshapedInputSizes);
    } catch (e) {
      return null;
    }
  }

  function pickFirstMask(masks) {
    // Expected shapes vary: [B, N, H, W] or [N, H, W] or [H, W]
    if (!masks) return null;
    // Transformers.js tensors often have .dims and .data
    const dims = masks.dims || masks.dims_;
    const data = masks.data || masks.cpuData || masks._data;
    if (!dims || !data) return { dims: null, data: masks };
    return { dims, data };
  }

  function renderMaskToOverlay(viewer, state, key, maskTensorLike, w, h) {
    const overlay = ensureOverlayCanvas(viewer, key);
    if (!overlay) return;
    resizeOverlayToViewer(viewer, overlay);
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const { dims, data } = maskTensorLike || {};
    if (!data) return;

    // Determine mask plane and shape
    let mw = w;
    let mh = h;
    let offset = 0;

    if (Array.isArray(dims) && dims.length >= 2) {
      const dd = dims.slice();
      // Common: [1, 1, H, W] or [1, H, W]
      const last2 = dd.slice(-2);
      mh = last2[0];
      mw = last2[1];
      // Choose first plane
      offset = 0;
    }

    // If mask resolution differs, scale via drawing a temporary ImageData then drawImage
    const tmp = document.createElement('canvas');
    tmp.width = mw;
    tmp.height = mh;
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(mw, mh);

    const r = parseInt(DEFAULTS.maskColor.slice(1, 3), 16);
    const g = parseInt(DEFAULTS.maskColor.slice(3, 5), 16);
    const b = parseInt(DEFAULTS.maskColor.slice(5, 7), 16);

    const alpha = Math.floor(255 * clamp(DEFAULTS.maskAlpha, 0, 1));

    const n = mw * mh;
    for (let i = 0; i < n; i++) {
      const v = data[offset + i];
      const on = (typeof v === 'number') ? (v > 0) : !!v;
      const j = i * 4;
      if (on) {
        img.data[j] = r;
        img.data[j + 1] = g;
        img.data[j + 2] = b;
        img.data[j + 3] = alpha;
      } else {
        img.data[j + 3] = 0;
      }
    }
    tctx.putImageData(img, 0, 0);

    // Draw scaled to overlay
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, overlay.width, overlay.height);
  }

  async function decodeFromPrompt(viewer, state, key, prompt) {
    if (!state.enabled) return;
    if (state._decoding) return;
    state._decoding = true;
    try {
      const errEl = document.getElementById('segment-error');
      if (errEl) errEl.textContent = '';
      
      updateStatus('✂️', 'Segmenting...', true, 80);
      await ensureSamLoaded(state);

      // Ensure embedding exists (or compute it)
      if (!state.cached.embedding || state._navDirty) {
        await computeEmbedding(viewer, state, key);
      }

      const t0 = safeNow();
      // Use cached RawImage if available, otherwise capture
      let imageForProcessor = state.cached.rawImage;
      if (!imageForProcessor) {
        imageForProcessor = await captureViewportCanvas(viewer, state, key);
      }
      const w = state.cached.captureW;
      const h = state.cached.captureH;

      // Build prompt inputs via processor
      // SAM tensor shapes: input_points 4D [batch][point_batch][points][2], input_labels 3D [batch][point_batch][points]
      // Coordinates should be normalized (0-1) relative to image dimensions
      let inputs;
      console.log('[SAM] Processing prompt:', prompt, 'image size:', w, 'x', h);
      
      if (prompt.type === 'point') {
        // Normalize coordinates to 0-1 range
        const normX = prompt.x / w;
        const normY = prompt.y / h;
        
        // NOTE: In Transformers.js SAM, AutoProcessor typically adds the image batch dimension.
        // Passing an already-batched structure here can result in a 5D tensor and shape errors.
        // Provide prompts as [point_batch][points][2] and [point_batch][points].
        const pointsArray = [[[normX, normY]]];
        const labelsArray = [[prompt.label]];
        
        console.log('[SAM] Normalized point:', normX.toFixed(3), normY.toFixed(3));
        console.log('[SAM] input_points (4D):', JSON.stringify(pointsArray));
        console.log('[SAM] input_labels (3D):', JSON.stringify(labelsArray));
        
        inputs = await state.processor(imageForProcessor, {
          input_points: pointsArray,
          input_labels: labelsArray,
        });
      } else if (prompt.type === 'box') {
        // Normalize box coordinates
        const normX0 = prompt.x0 / w;
        const normY0 = prompt.y0 / h;
        const normX1 = prompt.x1 / w;
        const normY1 = prompt.y1 / h;
        
        // 3D for boxes: [batch][boxes][coords]
        const boxArray = [[[normX0, normY0, normX1, normY1]]];
        console.log('[SAM] Normalized box:', normX0.toFixed(3), normY0.toFixed(3), normX1.toFixed(3), normY1.toFixed(3));
        console.log('[SAM] input_boxes (3D):', JSON.stringify(boxArray));
        
        inputs = await state.processor(imageForProcessor, {
          input_boxes: boxArray,
        });
      } else {
        throw new Error('Unsupported prompt type');
      }
      console.log('[SAM] Processor returned inputs:', Object.keys(inputs));
      if (DEFAULTS.debug) {
        const ip = inputs && inputs.input_points;
        const il = inputs && inputs.input_labels;
        const getDims = (t) => (t && (t.dims || t.dims_)) || null;
        console.log('[SAM][debug] input_points dims:', getDims(ip));
        console.log('[SAM][debug] input_labels dims:', getDims(il));
      }

      // Try embedding-only decode first: attach image_embeddings if accepted
      let outputs = null;
      let triedEmbeddingOnly = false;
      if (state.cached.embedding) {
        triedEmbeddingOnly = true;
        try {
          const embInputs = Object.assign({}, inputs);
          embInputs.image_embeddings = state.cached.embedding;
          // If we can omit pixel_values, do it (saves encoder work)
          if (embInputs.pixel_values) delete embInputs.pixel_values;
          outputs = await state.model(embInputs);
        } catch (e) {
          outputs = null;
        }
      }

      // Fallback: full forward (includes encoder)
      if (!outputs) {
        if (triedEmbeddingOnly) log('Embedding-only decode failed; falling back to full forward.');
        outputs = await state.model(inputs);
      }

      // Best-effort post-processing
      let masks = outputs && (outputs.pred_masks || outputs.masks || outputs.pred_masks_logits);
      if (!masks && outputs && outputs.pred_masks) masks = outputs.pred_masks;

      const pp = tryPostProcessMasks(
        state.processor,
        masks,
        inputs.original_sizes,
        inputs.reshaped_input_sizes
      );
      if (pp && Array.isArray(pp) && pp[0]) {
        masks = pp[0];
      }

      const first = pickFirstMask(masks);
      if (!first || !first.data) {
        throw new Error('Model returned no mask.');
      }

      renderMaskToOverlay(viewer, state, key, first, w, h);

      const t1 = safeNow();
      state.lastTimings.decodeMs = Math.round(t1 - t0);
      updateStatus('✅', `Mask generated (${state.lastTimings.decodeMs}ms) - click again or Clear`, false);
      updatePanelStats(state);
    } finally {
      state._decoding = false;
    }
  }

  function attachOsdHandlers(viewer, state, key, getIsAnnotationActiveFn) {
    if (!viewer) return;

    // Resize overlay on viewer resize
    viewer.addHandler('resize', () => {
      const overlay = ensureOverlayCanvas(viewer, key);
      if (overlay) resizeOverlayToViewer(viewer, overlay);
    });

    // Mark dirty on navigation and schedule encode after settle
    const onNav = () => {
      if (!state.enabled) return;
      
      // If viewport is locked, prevent navigation changes from affecting segmentation
      if (isViewportLocked()) {
        return; // Keep current mask/embedding
      }
      
      state._navDirty = true;
      clearMask(viewer, state, key);
      updateStatus('🔄', 'View changed - re-analyzing...', true, 30);
      scheduleEncode(viewer, state, key);
    };
    viewer.addHandler('pan', onNav);
    viewer.addHandler('zoom', onNav);
    viewer.addHandler('animation-finish', onNav);

    // Click prompt
    viewer.addHandler('canvas-click', (evt) => {
      if (!state.enabled) return;
      if (shouldIgnoreInteraction(getIsAnnotationActiveFn)) return;
      const oe = evt && evt.originalEvent;
      if (oe && oe.shiftKey) return; // box prompt uses shift+drag

      const p = getViewerPointFromOsdEvent(viewer, evt);
      if (!p) return;
      const x = clamp(Math.round(p.x), 0, state.cached.captureW - 1);
      const y = clamp(Math.round(p.y), 0, state.cached.captureH - 1);
      const label = (oe && oe.altKey) ? 0 : 1;
      decodeFromPrompt(viewer, state, key, { type: 'point', x, y, label }).catch((e) => {
        console.error('SAM decode failed:', e);
        const errEl = document.getElementById('segment-error');
        if (errEl) errEl.textContent = e.message || String(e);
        showPanel(true);
      });
    });

    // Box prompt (shift+drag)
    viewer.addHandler('canvas-press', (evt) => {
      if (!state.enabled) return;
      if (shouldIgnoreInteraction(getIsAnnotationActiveFn)) return;
      const oe = evt && evt.originalEvent;
      if (!oe || !oe.shiftKey) return;
      const p = getViewerPointFromOsdEvent(viewer, evt);
      if (!p) return;
      state._box = { start: p, current: p };
    });
    viewer.addHandler('canvas-drag', (evt) => {
      if (!state.enabled) return;
      if (!state._box) return;
      const p = getViewerPointFromOsdEvent(viewer, evt);
      if (!p) return;
      state._box.current = p;
    });
    viewer.addHandler('canvas-release', (evt) => {
      if (!state.enabled) return;
      if (!state._box) return;
      const b = state._box;
      state._box = null;

      const x0 = clamp(Math.round(Math.min(b.start.x, b.current.x)), 0, state.cached.captureW - 1);
      const y0 = clamp(Math.round(Math.min(b.start.y, b.current.y)), 0, state.cached.captureH - 1);
      const x1 = clamp(Math.round(Math.max(b.start.x, b.current.x)), 0, state.cached.captureW - 1);
      const y1 = clamp(Math.round(Math.max(b.start.y, b.current.y)), 0, state.cached.captureH - 1);
      if (Math.abs(x1 - x0) < 4 || Math.abs(y1 - y0) < 4) return;

      decodeFromPrompt(viewer, state, key, { type: 'box', x0, y0, x1, y1 }).catch((e) => {
        console.error('SAM box decode failed:', e);
        const errEl = document.getElementById('segment-error');
        if (errEl) errEl.textContent = e.message || String(e);
        showPanel(true);
      });
    });
  }

  const controllers = new Map(); // key -> { viewer, state }

  function attachToViewer(viewer, opts) {
    const key = (opts && opts.key) || 'v1';
    const getIsAnnotationActiveFn = (opts && opts.isAnnotationActive) || (() => false);

    // Replace previous controller for this key
    controllers.set(key, { viewer, state: controllers.get(key)?.state || createState() });

    const { state } = controllers.get(key);
    ensureOverlayCanvas(viewer, key);
    resizeOverlayToViewer(viewer, ensureOverlayCanvas(viewer, key));

    attachOsdHandlers(viewer, state, key, getIsAnnotationActiveFn);

    // Show badge once a viewer exists
    const badge = getBadgeEl();
    if (badge) badge.style.display = 'block';

    // If already enabled, schedule encode
    if (state.enabled) scheduleEncode(viewer, state, key);
  }

  function setEnabled(enabled) {
    const on = !!enabled;
    setBadgeActive(on);
    showPanel(on);

    if (on) {
      updateStatus('⏳', 'Initializing AI segmentation...', true, 5);
    } else {
      updateStatus('⏸️', 'Segmentation disabled', false);
    }

    // Apply to all controllers
    for (const [key, entry] of controllers.entries()) {
      const { viewer, state } = entry;
      state.enabled = on;
      state._navDirty = true;
      clearMask(viewer, state, key);
      if (on) scheduleEncode(viewer, state, key);
      else {
        clearEmbedding(state);
        updatePanelStats(state);
      }
    }
  }

  function toggleEnabled() {
    console.log('[SAM] toggleEnabled called, controllers:', controllers.size);
    // If no controllers yet, still toggle UI state
    if (controllers.size === 0) {
      const badge = getBadgeEl();
      const isActive = badge && badge.classList.contains('active');
      console.log('[SAM] No controllers, toggling UI only. isActive:', isActive);
      setBadgeActive(!isActive);
      showPanel(!isActive);
      return;
    }
    const any = Array.from(controllers.values()).some(x => x.state.enabled);
    console.log('[SAM] any enabled:', any, '-> setting to', !any);
    setEnabled(!any);
  }

  function clearCurrentMask() {
    for (const [key, entry] of controllers.entries()) {
      clearMask(entry.viewer, entry.state, key);
    }
  }

  function initUI() {
    const badge = getBadgeEl();
    if (badge) {
      badge.addEventListener('click', () => toggleEnabled());
    }

    const btnClear = document.getElementById('segment-clear-btn');
    if (btnClear) btnClear.addEventListener('click', () => clearCurrentMask());

    const btnHide = document.getElementById('segment-hide-btn');
    if (btnHide) btnHide.addEventListener('click', () => setEnabled(false));

    setBadgeActive(false);
    showPanel(false);
  }

  // Expose minimal API to non-module scripts
  window.SamSegmentation = {
    initUI,
    attachToViewer,
    toggleEnabled,
    setEnabled,
    clearCurrentMask,
  };

  // Convenience for inline onclick wiring if needed
  window.toggleSegmentation = toggleEnabled;

  document.addEventListener('DOMContentLoaded', () => {
    initUI();
  });
})();

