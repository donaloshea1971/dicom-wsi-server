/* global initAuth, authFetch */

/**
 * Performance Evaluation Page
 * - Display QA patterns (canvas)
 * - Local WSI-like pan/zoom benchmark (no network)
 * - Optional real WSI tile sampling metrics (network+server+device)
 * - Evidence export (JSON) for BYOD documentation
 */

(function() {
    const PerfEval = {};
    window.PerfEval = PerfEval;

    // -----------------------------
    // Utilities
    // -----------------------------
    function qs(sel) { return document.querySelector(sel); }
    function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
    function percentile(arr, p) {
        if (!arr || arr.length === 0) return null;
        const a = arr.slice().sort((x, y) => x - y);
        const idx = Math.max(0, Math.min(a.length - 1, Math.round((p / 100) * (a.length - 1))));
        return a[idx];
    }
    function fmtMs(x) { return (x == null || !isFinite(x)) ? '—' : `${x.toFixed(1)} ms`; }
    function fmtNum(x) { return (x == null || !isFinite(x)) ? '—' : `${x.toFixed(2)}`; }

    function safeJson(obj) {
        try { return JSON.stringify(obj, null, 2); } catch (e) { return JSON.stringify({ error: String(e) }); }
    }

    function downloadText(filename, text) {
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    // -----------------------------
    // Tabs
    // -----------------------------
    function initTabs() {
        qsa('.perf-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                qsa('.perf-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const id = btn.dataset.tab;
                qsa('.perf-panel').forEach(p => p.classList.remove('active'));
                const panel = qs(`#tab-${id}`);
                if (panel) panel.classList.add('active');
            });
        });
    }

    // -----------------------------
    // Device snapshot
    // -----------------------------
    function getDeviceSnapshot() {
        const nav = navigator || {};
        const scr = window.screen || {};
        const dpr = window.devicePixelRatio || 1;
        const vp = { w: window.innerWidth, h: window.innerHeight };
        const ua = nav.userAgent || '';
        const plat = nav.platform || '';
        const mem = nav.deviceMemory;
        const cores = nav.hardwareConcurrency;
        const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })();
        const lang = nav.language || null;

        const vis = document.visibilityState || null;
        const reducedMotion = (() => { try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return null; } })();
        const contrastPref = (() => { try { return window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches; } catch (e) { return null; } })();
        const colorScheme = (() => { try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return null; } })();

        const webgl = (() => {
            try {
                const c = document.createElement('canvas');
                return !!(c.getContext('webgl') || c.getContext('experimental-webgl') || c.getContext('webgl2'));
            } catch (e) { return false; }
        })();

        return {
            userAgent: ua,
            platform: plat,
            language: lang,
            timeZone: tz,
            deviceMemoryGB: typeof mem === 'number' ? mem : null,
            hardwareConcurrency: typeof cores === 'number' ? cores : null,
            screen: {
                width: scr.width,
                height: scr.height,
                availWidth: scr.availWidth,
                availHeight: scr.availHeight,
                colorDepth: scr.colorDepth,
                pixelDepth: scr.pixelDepth,
            },
            viewport: vp,
            devicePixelRatio: dpr,
            page: {
                url: location.href,
                referrer: document.referrer || null,
                visibilityState: vis,
            },
            prefs: {
                prefersReducedMotion: reducedMotion,
                prefersMoreContrast: contrastPref,
                prefersColorScheme: colorScheme,
            },
            capabilities: {
                webgl: webgl,
            }
        };
    }

    function renderDeviceKV(snap) {
        const kv = qs('#device-kv');
        if (!kv) return;
        kv.innerHTML = '';
        const rows = [
            ['DevicePixelRatio', String(snap.devicePixelRatio)],
            ['Screen', `${snap.screen.width}×${snap.screen.height}`],
            ['Viewport', `${snap.viewport.w}×${snap.viewport.h}`],
            ['ColorDepth', String(snap.screen.colorDepth)],
            ['Cores', snap.hardwareConcurrency != null ? String(snap.hardwareConcurrency) : '—'],
            ['Memory', snap.deviceMemoryGB != null ? `${snap.deviceMemoryGB} GB` : '—'],
            ['WebGL', snap.capabilities.webgl ? 'yes' : 'no'],
            ['Timezone', snap.timeZone || '—'],
            ['UA', snap.userAgent || '—'],
        ];
        for (const [k, v] of rows) {
            const dk = document.createElement('div');
            dk.className = 'k';
            dk.textContent = k;
            const dv = document.createElement('div');
            dv.className = 'v';
            dv.textContent = v;
            kv.appendChild(dk);
            kv.appendChild(dv);
        }
    }

    // -----------------------------
    // Display patterns
    // -----------------------------
    function drawGrayscale() {
        const canvas = qs('#canvas-grayscale');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Top: smooth ramp (left->right)
        const rampH = Math.floor(h * 0.5);
        const img = ctx.createImageData(w, rampH);
        for (let x = 0; x < w; x++) {
            const v = Math.floor(255 * (x / (w - 1)));
            for (let y = 0; y < rampH; y++) {
                const i = (y * w + x) * 4;
                img.data[i] = v; img.data[i+1] = v; img.data[i+2] = v; img.data[i+3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);

        // Middle: near-black / near-white steps
        const stepsY = rampH + 10;
        const stepsH = Math.floor(h * 0.25) - 10;
        const blocks = 16;
        const blockW = Math.floor(w / blocks);
        for (let i = 0; i < blocks; i++) {
            // pack more values near the ends
            const t = i / (blocks - 1);
            const v = t < 0.5 ? Math.floor(64 * (t * 2)) : Math.floor(255 - 64 * ((1 - t) * 2));
            ctx.fillStyle = `rgb(${v},${v},${v})`;
            ctx.fillRect(i * blockW, stepsY, blockW + 1, stepsH);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.strokeRect(0.5, stepsY + 0.5, w - 1, stepsH - 1);

        // Bottom: banding stress (very low amplitude sine)
        const bandY = stepsY + stepsH + 10;
        const bandH = h - bandY;
        const band = ctx.createImageData(w, bandH);
        for (let x = 0; x < w; x++) {
            const base = Math.floor(180 + 10 * Math.sin((x / w) * Math.PI * 8));
            for (let y = 0; y < bandH; y++) {
                const v = clamp(base + Math.floor(3 * Math.sin((y / bandH) * Math.PI * 6)), 0, 255);
                const i = (y * w + x) * 4;
                band.data[i] = v; band.data[i+1] = v; band.data[i+2] = v; band.data[i+3] = 255;
            }
        }
        ctx.putImageData(band, 0, bandY);

        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.fillText('Ramp', 12, 18);
        ctx.fillText('Near-black/near-white steps', 12, stepsY + 18);
        ctx.fillText('Banding stress', 12, bandY + 18);
    }

    function drawSharpness() {
        const canvas = qs('#canvas-sharpness');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Background mid-gray
        ctx.fillStyle = '#202020';
        ctx.fillRect(0, 0, w, h);

        // 1px checker region
        const regionW = Math.floor(w * 0.5) - 16;
        const regionH = Math.floor(h * 0.55);
        const ox = 12, oy = 12;
        const img = ctx.createImageData(regionW, regionH);
        for (let y = 0; y < regionH; y++) {
            for (let x = 0; x < regionW; x++) {
                const v = ((x ^ y) & 1) ? 255 : 0;
                const i = (y * regionW + x) * 4;
                img.data[i] = v; img.data[i+1] = v; img.data[i+2] = v; img.data[i+3] = 255;
            }
        }
        ctx.putImageData(img, ox, oy);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.strokeRect(ox + 0.5, oy + 0.5, regionW - 1, regionH - 1);

        // Line pairs with increasing frequency
        const lpX = Math.floor(w * 0.52);
        const lpY = 12;
        const lpW = w - lpX - 12;
        const lpH = regionH;
        ctx.fillStyle = '#0b0b0b';
        ctx.fillRect(lpX, lpY, lpW, lpH);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.strokeRect(lpX + 0.5, lpY + 0.5, lpW - 1, lpH - 1);
        for (let i = 0; i < 10; i++) {
            const y0 = lpY + 10 + i * Math.floor((lpH - 20) / 10);
            const freq = 1 + i; // pixels per stripe
            for (let x = 0; x < lpW; x++) {
                const on = Math.floor(x / freq) % 2 === 0;
                ctx.fillStyle = on ? '#ffffff' : '#000000';
                ctx.fillRect(lpX + x, y0, 1, Math.floor((lpH - 20) / 10) - 2);
            }
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.font = '11px "JetBrains Mono", monospace';
            ctx.fillText(`${freq}px`, lpX + 8, y0 + 14);
        }

        // Subpixel text hinting check
        const textY = Math.floor(h * 0.62);
        ctx.fillStyle = '#111827';
        ctx.fillRect(12, textY, w - 24, h - textY - 12);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.strokeRect(12.5, textY + 0.5, w - 25, h - textY - 13);
        ctx.fillStyle = '#e5e7eb';
        ctx.font = '14px Outfit, sans-serif';
        ctx.fillText('Text clarity: the quick brown fox jumps over the lazy dog 0123456789', 22, textY + 28);
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.fillText('Mono: iiiIIIIllll  O0o  1Il  | | |  — —', 22, textY + 52);
    }

    function drawUniformity() {
        const canvas = qs('#canvas-uniformity');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Full field neutral gray
        ctx.fillStyle = '#7a7a7a';
        ctx.fillRect(0, 0, w, h);

        // Corner markers
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 2;
        ctx.strokeRect(10, 10, w - 20, h - 20);

        // 3x3 grid
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo((w / 3) * i, 0);
            ctx.lineTo((w / 3) * i, h);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, (h / 3) * i);
            ctx.lineTo(w, (h / 3) * i);
            ctx.stroke();
        }

        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.fillText('Uniformity check (neutral gray field)', 14, 22);
        ctx.fillText('Look for tint shifts, vignetting, edge darkening.', 14, 40);
    }

    function drawColorPatches() {
        const canvas = qs('#canvas-color');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Background neutral
        ctx.fillStyle = '#0b1220';
        ctx.fillRect(0, 0, w, h);

        // Patch grid
        const cols = 8, rows = 3;
        const pad = 12;
        const gap = 8;
        const patchW = Math.floor((w - pad * 2 - gap * (cols - 1)) / cols);
        const patchH = Math.floor((h - pad * 2 - gap * (rows - 1)) / rows);

        // "Stain-like" colors + neutrals
        const patches = [
            '#f8fafc', '#e2e8f0', '#94a3b8', '#475569', '#0f172a', '#000000', '#ffffff', '#1f2937',
            '#ef4444', '#f97316', '#facc15', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
            '#fca5a5', '#fdba74', '#fde68a', '#86efac', '#67e8f9', '#93c5fd', '#c4b5fd', '#f9a8d4',
        ];

        let idx = 0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x = pad + c * (patchW + gap);
                const y = pad + r * (patchH + gap);
                ctx.fillStyle = patches[idx++ % patches.length];
                ctx.fillRect(x, y, patchW, patchH);
            }
        }

        // Gradient bars
        const gY = h - 40;
        const gH = 16;
        const grad = ctx.createLinearGradient(12, 0, w - 12, 0);
        grad.addColorStop(0, '#000000');
        grad.addColorStop(0.5, '#777777');
        grad.addColorStop(1, '#ffffff');
        ctx.fillStyle = grad;
        ctx.fillRect(12, gY, w - 24, gH);

        const grad2 = ctx.createLinearGradient(12, 0, w - 12, 0);
        grad2.addColorStop(0, '#1d4ed8'); // blue
        grad2.addColorStop(0.5, '#a21caf'); // purple-ish
        grad2.addColorStop(1, '#dc2626'); // red
        ctx.fillStyle = grad2;
        ctx.fillRect(12, gY - 20, w - 24, gH);

        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.fillText('Color patches + gradients (check neutrals, clipping, smoothness)', 14, 22);
    }

    function drawAllPatterns() {
        drawGrayscale();
        drawSharpness();
        drawUniformity();
        drawColorPatches();
    }

    // -----------------------------
    // Interaction benchmark (local)
    // -----------------------------
    const benchState = {
        running: false,
        raf: null,
        startT: 0,
        durationMs: 10_000,
        frameTimes: [],
        inputLatencies: [],
        dropped: 0,
        frames: 0,
        lastFrameT: 0,
        // virtual camera
        camX: 0,
        camY: 0,
        zoom: 1,
        // scripted motion
        scriptPhase: 0,
        // input tracking
        lastInputEventT: null,
        pointerDown: false,
        lastPtr: null,
    };

    function setBenchStatus(text) {
        const el = qs('#bench-status');
        if (el) el.textContent = text;
    }

    function renderBenchStats() {
        const ft = benchState.frameTimes;
        const avgFrame = ft.length ? (ft.reduce((a,b)=>a+b,0)/ft.length) : null;
        const fps = avgFrame ? (1000 / avgFrame) : null;
        const p95 = percentile(ft, 95);
        const inP95 = percentile(benchState.inputLatencies, 95);
        if (qs('#bench-fps')) qs('#bench-fps').textContent = fps ? fmtNum(fps) : '—';
        if (qs('#bench-p95')) qs('#bench-p95').textContent = p95 ? fmtMs(p95) : '—';
        if (qs('#bench-dropped')) qs('#bench-dropped').textContent = String(benchState.dropped || 0);
        if (qs('#bench-input')) qs('#bench-input').textContent = inP95 ? fmtMs(inP95) : '—';
    }

    function drawBenchFrame(ctx, w, h) {
        // Render a procedural “histology-like” field: multi-scale noise + edges.
        // Keep it moderately heavy so slow devices show drops, but bounded.
        const t = (now() - benchState.startT) / 1000;
        const z = benchState.zoom;
        const scale = 1 / z;
        const baseX = benchState.camX;
        const baseY = benchState.camY;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // Background
        ctx.fillStyle = '#070b16';
        ctx.fillRect(0, 0, w, h);

        // Draw “tiles” in view
        const tile = 128;
        const worldW = 16384;
        const worldH = 16384;
        const viewW = w * scale;
        const viewH = h * scale;
        const left = clamp(baseX, 0, worldW - viewW);
        const top = clamp(baseY, 0, worldH - viewH);

        const tileX0 = Math.floor(left / tile);
        const tileY0 = Math.floor(top / tile);
        const tileX1 = Math.ceil((left + viewW) / tile);
        const tileY1 = Math.ceil((top + viewH) / tile);

        // Transform to camera
        ctx.setTransform(z, 0, 0, z, -left * z, -top * z);

        for (let ty = tileY0; ty < tileY1; ty++) {
            for (let tx = tileX0; tx < tileX1; tx++) {
                const x = tx * tile;
                const y = ty * tile;

                // Pseudo-random but deterministic per tile
                const seed = (tx * 73856093) ^ (ty * 19349663);
                const r = (seed & 255);
                const g = ((seed >> 8) & 255);
                const b = ((seed >> 16) & 255);

                // Base “tissue” tone: pink/purple-ish
                const baseR = 180 + (r % 40) - 20;
                const baseG = 120 + (g % 30) - 15;
                const baseB = 150 + (b % 50) - 25;

                ctx.fillStyle = `rgb(${clamp(baseR, 0, 255)},${clamp(baseG, 0, 255)},${clamp(baseB, 0, 255)})`;
                ctx.fillRect(x, y, tile, tile);

                // “Nuclei”: small circles
                const count = 8 + (seed % 12);
                ctx.fillStyle = 'rgba(60,30,110,0.55)';
                for (let i = 0; i < count; i++) {
                    const px = x + ((seed * (i + 3)) % tile);
                    const py = y + ((seed * (i + 7)) % tile);
                    const rad = 2 + ((seed + i) % 4);
                    ctx.beginPath();
                    ctx.arc(px, py, rad, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Edge texture
                ctx.strokeStyle = 'rgba(255,255,255,0.06)';
                ctx.strokeRect(x + 0.5, y + 0.5, tile - 1, tile - 1);
            }
        }

        // HUD
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = 'rgba(15,23,42,0.78)';
        ctx.fillRect(12, 12, 280, 72);
        ctx.strokeStyle = 'rgba(148,163,184,0.25)';
        ctx.strokeRect(12.5, 12.5, 280, 72);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '12px "JetBrains Mono", monospace';
        ctx.fillText(`zoom: ${z.toFixed(2)}x`, 22, 34);
        ctx.fillText(`cam: ${Math.floor(left)},${Math.floor(top)}`, 22, 54);
        ctx.fillText(`t: ${t.toFixed(1)}s`, 22, 74);
    }

    function benchLoop() {
        const canvas = qs('#canvas-bench');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;

        const t = now();
        const dt = benchState.lastFrameT ? (t - benchState.lastFrameT) : 0;
        benchState.lastFrameT = t;
        if (dt > 0) {
            benchState.frameTimes.push(dt);
            benchState.frames++;
            if (dt >= 33) benchState.dropped++;
        }

        // Input latency approximation: time between last input event and this frame draw.
        if (benchState.lastInputEventT != null) {
            benchState.inputLatencies.push(t - benchState.lastInputEventT);
            benchState.lastInputEventT = null; // count once per frame
        }

        // Scripted path to be repeatable
        const prog = (t - benchState.startT) / benchState.durationMs;
        const phase = prog * Math.PI * 2;
        benchState.zoom = clamp(1.0 + 2.5 * (0.5 + 0.5 * Math.sin(phase * 0.7)), 1.0, 3.5);
        benchState.camX = clamp(6000 + 4200 * Math.sin(phase * 0.9), 0, 16384);
        benchState.camY = clamp(6000 + 4200 * Math.cos(phase * 1.1), 0, 16384);

        // If user is actively dragging, bias camera (interactive feel)
        if (benchState.pointerDown && benchState.lastPtr) {
            benchState.camX = clamp(benchState.camX + benchState.lastPtr.dx * 2, 0, 16384);
            benchState.camY = clamp(benchState.camY + benchState.lastPtr.dy * 2, 0, 16384);
        }

        drawBenchFrame(ctx, w, h);
        renderBenchStats();

        if ((t - benchState.startT) >= benchState.durationMs) {
            benchState.running = false;
            setBenchStatus('done');
            benchState.raf = null;
            return;
        }

        benchState.raf = requestAnimationFrame(benchLoop);
    }

    function initBenchInteractions() {
        const canvas = qs('#canvas-bench');
        if (!canvas) return;

        const onWheel = (e) => {
            e.preventDefault();
            benchState.lastInputEventT = now();
            // Smooth zoom based on wheel delta
            const dz = Math.exp(-e.deltaY * 0.0015);
            benchState.zoom = clamp(benchState.zoom * dz, 1.0, 6.0);
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });

        const onPointerDown = (e) => {
            benchState.pointerDown = true;
            benchState.lastInputEventT = now();
            canvas.setPointerCapture?.(e.pointerId);
            benchState.lastPtr = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
        };
        const onPointerMove = (e) => {
            if (!benchState.pointerDown || !benchState.lastPtr) return;
            benchState.lastInputEventT = now();
            const dx = e.clientX - benchState.lastPtr.x;
            const dy = e.clientY - benchState.lastPtr.y;
            benchState.lastPtr = { x: e.clientX, y: e.clientY, dx, dy };
            // Camera update happens in the loop to keep measurement consistent.
        };
        const onPointerUp = (e) => {
            benchState.pointerDown = false;
            benchState.lastInputEventT = now();
            benchState.lastPtr = null;
            canvas.releasePointerCapture?.(e.pointerId);
        };
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerUp);
        canvas.addEventListener('pointerleave', () => { benchState.pointerDown = false; benchState.lastPtr = null; });
    }

    PerfEval.startInteractionBench = function() {
        if (benchState.running) return;
        benchState.running = true;
        benchState.startT = now();
        benchState.lastFrameT = 0;
        benchState.frameTimes = [];
        benchState.inputLatencies = [];
        benchState.dropped = 0;
        benchState.frames = 0;
        setBenchStatus('running');
        benchLoop();
        updateEvidencePreview();
    };

    PerfEval.resetInteractionBench = function() {
        if (benchState.raf) cancelAnimationFrame(benchState.raf);
        benchState.running = false;
        benchState.raf = null;
        benchState.frameTimes = [];
        benchState.inputLatencies = [];
        benchState.dropped = 0;
        benchState.frames = 0;
        benchState.lastFrameT = 0;
        setBenchStatus('idle');
        renderBenchStats();
        const canvas = qs('#canvas-bench');
        if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        updateEvidencePreview();
    };

    function getBenchEvidence() {
        const ft = benchState.frameTimes;
        const avgFrame = ft.length ? (ft.reduce((a,b)=>a+b,0)/ft.length) : null;
        const fps = avgFrame ? (1000 / avgFrame) : null;
        return {
            durationMs: benchState.durationMs,
            frames: benchState.frames,
            fpsAvg: fps,
            frameTimeMs: {
                avg: avgFrame,
                p50: percentile(ft, 50),
                p95: percentile(ft, 95),
                p99: percentile(ft, 99),
            },
            droppedFramesOver33ms: benchState.dropped,
            inputToDrawMs: {
                p50: percentile(benchState.inputLatencies, 50),
                p95: percentile(benchState.inputLatencies, 95),
                p99: percentile(benchState.inputLatencies, 99),
            }
        };
    }

    // -----------------------------
    // Real WSI tile sampling (optional)
    // -----------------------------
    const wsiState = {
        studyId: null,
        seriesId: null,
        tileLatMs: [],
        tilesSampled: 0,
        notes: '',
        lastRunAt: null,
    };

    function setWsiStatus(text) {
        const el = qs('#wsi-status');
        if (el) el.textContent = text;
    }

    function readQueryParams() {
        const p = new URLSearchParams(window.location.search);
        return {
            study: p.get('study') || null,
            series: p.get('series') || null,
        };
    }

    async function resolveSeriesIdFromStudy(studyId) {
        const res = await authFetch(`/api/studies/${studyId}`);
        if (!res.ok) throw new Error(`study lookup failed (${res.status})`);
        const data = await res.json();
        const series = data?.Series?.[0];
        if (!series) throw new Error('study has no series');
        return series;
    }

    async function fetchPyramid(seriesId) {
        const res = await fetch(`/wsi/pyramids/${seriesId}`);
        if (!res.ok) throw new Error(`pyramid fetch failed (${res.status})`);
        return await res.json();
    }

    async function sampleTiles(seriesId, pyramid, count = 16) {
        // Sample a handful of base-level tiles near the center-ish region.
        // Use no auth for /wsi/tiles (it might still be behind auth; we just time fetch).
        const lvl = 0;
        const tilesX = pyramid?.TilesCount?.[lvl]?.[0];
        const tilesY = pyramid?.TilesCount?.[lvl]?.[1];
        if (!tilesX || !tilesY) throw new Error('pyramid missing TilesCount');

        const xs = Math.max(0, Math.floor(tilesX / 2) - 2);
        const ys = Math.max(0, Math.floor(tilesY / 2) - 2);

        const coords = [];
        for (let i = 0; i < count; i++) {
            coords.push({ x: (xs + (i % 4)) % tilesX, y: (ys + Math.floor(i / 4)) % tilesY });
        }

        const lat = [];
        for (const c of coords) {
            const url = `/wsi/tiles/${seriesId}/${lvl}/${c.x}/${c.y}?_=${Date.now()}`;
            const t0 = now();
            const resp = await fetch(url, { cache: 'no-store' });
            if (!resp.ok) throw new Error(`tile fetch failed (${resp.status})`);
            // Force decode cost: blob->ImageBitmap if possible
            const blob = await resp.blob();
            if (typeof createImageBitmap === 'function') {
                try { await createImageBitmap(blob); } catch (e) {}
            }
            lat.push(now() - t0);
        }
        return lat;
    }

    PerfEval.runWsiTileCheck = async function() {
        setWsiStatus('running');
        wsiState.tileLatMs = [];
        wsiState.tilesSampled = 0;
        wsiState.notes = '';
        wsiState.lastRunAt = new Date().toISOString();
        updateWsiUI();

        const params = readQueryParams();
        wsiState.studyId = params.study;
        wsiState.seriesId = params.series;
        try {
            const isAuthed = await initAuth();
            if (!isAuthed) {
                wsiState.notes = 'Not authenticated (cannot call /api).';
                setWsiStatus('needs auth');
                updateWsiUI();
                updateEvidencePreview();
                return;
            }

            if (!wsiState.seriesId) {
                if (!wsiState.studyId) {
                    wsiState.notes = 'No study/series provided. Open from viewer to pass ?study=<id>.';
                    setWsiStatus('missing id');
                    updateWsiUI();
                    updateEvidencePreview();
                    return;
                }
                wsiState.seriesId = await resolveSeriesIdFromStudy(wsiState.studyId);
            }

            const pyramid = await fetchPyramid(wsiState.seriesId);
            const lat = await sampleTiles(wsiState.seriesId, pyramid, 16);
            wsiState.tileLatMs = lat;
            wsiState.tilesSampled = lat.length;
            setWsiStatus('done');
            updateWsiUI();
            updateEvidencePreview();
        } catch (e) {
            wsiState.notes = String(e?.message || e);
            setWsiStatus('failed');
            updateWsiUI();
            updateEvidencePreview();
        }
    };

    PerfEval.clearWsiTileCheck = function() {
        wsiState.tileLatMs = [];
        wsiState.tilesSampled = 0;
        wsiState.notes = '';
        wsiState.lastRunAt = null;
        setWsiStatus('idle');
        updateWsiUI();
        updateEvidencePreview();
    };

    function getWsiEvidence() {
        return {
            studyId: wsiState.studyId,
            seriesId: wsiState.seriesId,
            tilesSampled: wsiState.tilesSampled,
            tileLatencyMs: {
                p50: percentile(wsiState.tileLatMs, 50),
                p95: percentile(wsiState.tileLatMs, 95),
                p99: percentile(wsiState.tileLatMs, 99),
            },
            lastRunAt: wsiState.lastRunAt,
            notes: wsiState.notes || null,
        };
    }

    function updateWsiUI() {
        if (qs('#wsi-study')) qs('#wsi-study').textContent = wsiState.studyId || '—';
        if (qs('#wsi-series')) qs('#wsi-series').textContent = wsiState.seriesId || '—';
        const p50 = percentile(wsiState.tileLatMs, 50);
        const p95 = percentile(wsiState.tileLatMs, 95);
        if (qs('#wsi-lat')) qs('#wsi-lat').textContent = (p50 == null) ? '—' : `${fmtMs(p50)} / ${fmtMs(p95)}`;
        if (qs('#wsi-count')) qs('#wsi-count').textContent = String(wsiState.tilesSampled || 0);
        if (qs('#wsi-notes')) qs('#wsi-notes').textContent = wsiState.notes || '—';
    }

    // -----------------------------
    // Evidence export
    // -----------------------------
    function getAttestation() {
        return {
            ambientLighting: qs('#att-ambient')?.value || null,
            nightMode: qs('#att-night')?.value || null,
            browserZoom: qs('#att-zoom')?.value || null,
            calibration: qs('#att-cal')?.value || null,
            notes: qs('#att-notes')?.value?.trim() || null,
        };
    }

    function getEvidence() {
        const snap = getDeviceSnapshot();
        const params = readQueryParams();
        return {
            schema: 'pathviewpro.byod_evidence.v1',
            createdAt: new Date().toISOString(),
            app: {
                page: 'performance-eval',
            },
            context: {
                query: params,
            },
            device: snap,
            attestation: getAttestation(),
            results: {
                interactionBenchmark: getBenchEvidence(),
                wsiTileCheck: getWsiEvidence(),
            }
        };
    }

    function updateEvidencePreview() {
        const el = qs('#evidence-preview');
        if (!el) return;
        el.value = safeJson(getEvidence());
    }

    PerfEval.copySummary = async function() {
        const ev = getEvidence();
        const snap = ev.device;
        const bench = ev.results.interactionBenchmark;
        const wsi = ev.results.wsiTileCheck;

        const lines = [];
        lines.push(`PathView Pro - BYOD Evidence`);
        lines.push(`Created: ${ev.createdAt}`);
        lines.push(`DevicePixelRatio: ${snap.devicePixelRatio}`);
        lines.push(`Screen: ${snap.screen.width}x${snap.screen.height} | Viewport: ${snap.viewport.w}x${snap.viewport.h}`);
        lines.push(`WebGL: ${snap.capabilities.webgl ? 'yes' : 'no'}`);
        if (bench?.fpsAvg != null) lines.push(`Bench FPS avg: ${bench.fpsAvg.toFixed(2)} | p95 frame: ${bench.frameTimeMs.p95?.toFixed(1) ?? '—'} ms | dropped(>33ms): ${bench.droppedFramesOver33ms}`);
        if (wsi?.tilesSampled) lines.push(`WSI tiles: ${wsi.tilesSampled} | p50/p95: ${wsi.tileLatencyMs.p50?.toFixed(1) ?? '—'}/${wsi.tileLatencyMs.p95?.toFixed(1) ?? '—'} ms`);
        lines.push(`Attestation: ambient=${ev.attestation.ambientLighting}, nightMode=${ev.attestation.nightMode}, zoom=${ev.attestation.browserZoom}, calibration=${ev.attestation.calibration}`);

        const text = lines.join('\n');
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            // Fallback
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
    };

    PerfEval.exportEvidence = function() {
        const ev = getEvidence();
        const safeDate = ev.createdAt.replace(/[:.]/g, '-');
        downloadText(`byod-evidence-${safeDate}.json`, safeJson(ev));
    };

    // -----------------------------
    // Navigation
    // -----------------------------
    PerfEval.goBack = function() {
        const params = readQueryParams();
        const url = new URL('/index.html', window.location.origin);
        if (params.study) url.searchParams.set('study', params.study);
        window.location.href = url.toString();
    };

    // -----------------------------
    // Boot
    // -----------------------------
    async function boot() {
        initTabs();
        drawAllPatterns();
        initBenchInteractions();

        const snap = getDeviceSnapshot();
        renderDeviceKV(snap);

        const p = readQueryParams();
        if (qs('#perf-topline')) qs('#perf-topline').textContent = `dpr=${snap.devicePixelRatio} | ${snap.viewport.w}×${snap.viewport.h} | ${p.study ? `study=${p.study.substring(0, 8)}…` : 'no study'}`;

        // Keep evidence preview current as user changes attestations.
        ['#att-ambient', '#att-night', '#att-zoom', '#att-cal', '#att-notes'].forEach(sel => {
            const el = qs(sel);
            if (el) el.addEventListener('change', updateEvidencePreview);
            if (el) el.addEventListener('input', updateEvidencePreview);
        });

        // Initialize WSI UI with whatever params we have.
        wsiState.studyId = p.study;
        wsiState.seriesId = p.series;
        updateWsiUI();
        updateEvidencePreview();
    }

    document.addEventListener('DOMContentLoaded', boot);
})();

