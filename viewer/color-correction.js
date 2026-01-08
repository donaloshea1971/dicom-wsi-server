/**
 * Color Correction for WSI Viewer with ICC Profile Support
 * Implements full color space transformation via WebGL
 * Includes H&E stain deconvolution (Ruifrok method)
 */

class ColorCorrectionFilter {
    constructor(viewer) {
        this.viewer = viewer;
        this.enabled = false;
        this.iccEnabled = false;
        this.iccMode = null; // 'webgl' | 'css' | null
        
        // Manual color correction parameters (user-controlled, independent of ICC)
        this.params = {
            gamma: 1.0,        // Manual gamma adjustment
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
        };
        
        // Stain deconvolution parameters
        this.stainParams = {
            stainType: 'HE',      // 'HE' or 'HDAB'
            hematoxylin: 1.0,     // H channel intensity (0-2, 1=normal)
            eosin: 1.0,           // E/DAB channel intensity (0-2, 1=normal)
            viewMode: 'combined', // 'combined' | 'hematoxylin' | 'eosin' (or 'dab')
        };
        this.stainEnabled = false;
        
        // Focus quality heatmap parameters
        this.focusParams = {
            opacity: 0.5,         // Overlay opacity (0-1)
            threshold: 0.05,      // Min gradient to show color (0-1)
            smoothing: 3.0,       // Kernel scale for smoothing (1-8)
            colormap: 'thermal',  // 'thermal' | 'viridis' | 'grayscale'
        };
        this.focusEnabled = false;
        this.focusWebGL = null;
        this.focusCanvas = null;
        
        // Ruifrok & Johnston stain vectors (optical density, normalized)
        // Reference: Quantification of histochemical staining (2001)
        this.stainMatrices = {
            // H&E staining
            HE: {
                stain1: [0.650, 0.704, 0.286],   // Hematoxylin (blue-purple)
                stain2: [0.072, 0.990, 0.105],   // Eosin (pink)
                residual: [0.268, 0.570, 0.776], // Residual/background
                label1: 'H',
                label2: 'E',
            },
            // H-DAB (Hematoxylin + DAB for IHC)
            HDAB: {
                stain1: [0.650, 0.704, 0.286],   // Hematoxylin (blue-purple)
                stain2: [0.270, 0.570, 0.780],   // DAB (brown)
                residual: [0.000, 0.000, 0.000], // Derived at runtime (needs full-rank 3x3 for inversion)
                label1: 'H',
                label2: 'DAB',
            },
        };

        // Computed residual vectors used to make stain matrices full-rank (esp. 2-stain presets like H-DAB)
        this._effectiveResiduals = {};
        
        // ICC profile gamma (separate from manual controls)
        this.iccGamma = 1.0;  // Extracted from ICC profile when enabled
        
        // ICC profile data
        this.iccData = null;
        this.iccTransform = null;
        
        // Presets
        this.presets = {
            'sRGB': { gamma: 1.0, brightness: 0, contrast: 1.0, saturation: 1.0 },
            'Hamamatsu': { gamma: 2.2, brightness: 0, contrast: 1.0, saturation: 1.0 },
            'Linear': { gamma: 1.0, brightness: 0, contrast: 1.0, saturation: 1.0 },
            'Vivid': { gamma: 1.0, brightness: 0.05, contrast: 1.1, saturation: 1.2 },
            'Muted': { gamma: 1.0, brightness: 0, contrast: 0.9, saturation: 0.8 },
        };
        
        this.currentPreset = 'sRGB';
        this.viewerElement = null;
        this.styleElement = null;
        
        // WebGL for ICC transform and deconvolution
        this.gl = null;
        this.canvas = null;
        this.program = null;
        this.webglReady = false;
        this.deconvProgram = null;  // Separate shader for stain deconvolution
    }

    _cross3(a, b) {
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
    }

    _normalize3(v) {
        const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if (!isFinite(n) || n < 1e-8) return [0, 0, 0];
        return [v[0] / n, v[1] / n, v[2] / n];
    }

    /**
     * Return a full-rank 3rd vector for the stain matrix.
     * - If a residual is provided and non-zero, use it.
     * - Otherwise derive via cross-product of stain1 and stain2 and normalize.
     * - Ensure non-negative components (OD vectors should be >= 0); flip if needed.
     */
    _getEffectiveResidualVector(stains) {
        const r = stains.residual || [0, 0, 0];
        const hasResidual = (Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2])) > 1e-6;
        if (hasResidual) return r;

        // Derive a 3rd vector from the first two (Ruifrok-style fallback)
        let v = this._normalize3(this._cross3(stains.stain1, stains.stain2));

        // If still degenerate (nearly collinear), fall back to a known safe residual
        const degenerate = (Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2])) < 1e-6;
        if (degenerate) v = [0.268, 0.570, 0.776];

        // Orient to positive OD space if needed
        const minComp = Math.min(v[0], v[1], v[2]);
        if (minComp < 0) v = [-v[0], -v[1], -v[2]];

        // Clamp tiny negatives (numerical noise) to 0
        return [Math.max(0, v[0]), Math.max(0, v[1]), Math.max(0, v[2])];
    }
    
    initialize() {
        this.viewerElement = document.getElementById('osd-viewer');
        if (!this.viewerElement) {
            console.warn('Viewer element not found');
            return false;
        }
        
        // Initialize WebGL for ICC transforms
        this._initWebGL();
        
        // Create dynamic CSS filter rules
        this.injectFilterStyles();
        
        console.log('Color correction initialized, WebGL:', this.webglReady ? 'ready' : 'not available');
        return true;
    }
    
    _initWebGL() {
        // Create offscreen canvas for WebGL processing
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'icc-transform-canvas';
        this.canvas.style.display = 'none';
        document.body.appendChild(this.canvas);
        
        this.gl = this.canvas.getContext('webgl', {
            premultipliedAlpha: false,
            preserveDrawingBuffer: true
        });
        
        if (!this.gl) {
            console.warn('WebGL not available for ICC transforms');
            return;
        }
        
        // Compile shaders
        const vertexShader = this._compileShader(this.gl.VERTEX_SHADER, this._vertexShaderSource());
        const fragmentShader = this._compileShader(this.gl.FRAGMENT_SHADER, this._fragmentShaderSource());
        
        if (!vertexShader || !fragmentShader) {
            console.error('Failed to compile ICC shaders');
            return;
        }
        
        this.program = this.gl.createProgram();
        this.gl.attachShader(this.program, vertexShader);
        this.gl.attachShader(this.program, fragmentShader);
        this.gl.linkProgram(this.program);
        
        if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
            console.error('Shader link error:', this.gl.getProgramInfoLog(this.program));
            return;
        }
        
        this._setupBuffers();
        this.webglReady = true;
    }
    
    _vertexShaderSource() {
        return `
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            varying vec2 v_texCoord;
            
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        `;
    }
    
    _fragmentShaderSource() {
        return `
            precision highp float;
            
            uniform sampler2D u_image;
            uniform vec3 u_gamma;          // Per-channel gamma from ICC
            uniform mat3 u_colorMatrix;    // Color space transformation matrix
            uniform bool u_applyMatrix;    // Whether to apply matrix transform
            uniform float u_brightness;
            uniform float u_contrast;
            uniform float u_saturation;
            
            varying vec2 v_texCoord;
            
            // Apply gamma correction (linearize)
            vec3 applyGamma(vec3 color, vec3 gamma) {
                return vec3(
                    pow(color.r, gamma.r),
                    pow(color.g, gamma.g),
                    pow(color.b, gamma.b)
                );
            }
            
            // Apply inverse gamma (de-linearize to sRGB)
            vec3 applyInverseGamma(vec3 color) {
                // sRGB gamma ~2.2 (actually piecewise but 2.2 is close enough)
                return pow(color, vec3(1.0 / 2.2));
            }
            
            // Saturation adjustment
            vec3 adjustSaturation(vec3 color, float sat) {
                float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
                return mix(vec3(luminance), color, sat);
            }
            
            void main() {
                vec4 texColor = texture2D(u_image, v_texCoord);
                vec3 color = texColor.rgb;
                
                // Step 1: Apply ICC gamma (linearize from source color space)
                color = applyGamma(color, u_gamma);
                
                // Step 2: Apply color space transformation matrix if available
                if (u_applyMatrix) {
                    color = u_colorMatrix * color;
                }
                
                // Step 3: Apply inverse gamma (convert to sRGB)
                color = applyInverseGamma(color);
                
                // Step 4: Apply user adjustments
                // Brightness
                color = color + vec3(u_brightness);
                
                // Contrast
                color = (color - 0.5) * u_contrast + 0.5;
                
                // Saturation
                color = adjustSaturation(color, u_saturation);
                
                // Clamp and output
                gl_FragColor = vec4(clamp(color, 0.0, 1.0), texColor.a);
            }
        `;
    }
    
    _compileShader(type, source) {
        const shader = this.gl.createShader(type);
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            console.error('Shader error:', this.gl.getShaderInfoLog(shader));
            return null;
        }
        return shader;
    }
    
    _setupBuffers() {
        const gl = this.gl;
        
        // Position buffer (full screen quad)
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,  1, -1,  -1, 1,  1, 1
        ]), gl.STATIC_DRAW);
        
        // Texture coordinate buffer
        this.texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 1,  1, 1,  0, 0,  1, 0
        ]), gl.STATIC_DRAW);
    }
    
    injectFilterStyles() {
        let styleEl = document.getElementById('color-correction-styles');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'color-correction-styles';
            document.head.appendChild(styleEl);
        }
        this.styleElement = styleEl;
        this.updateFilterStyles();
    }
    
    updateFilterStyles() {
        if (!this.styleElement) return;

        // If ICC is enabled in WebGL mode, all adjustments are applied in the shader.
        // Keep CSS filters disabled to avoid double-application.
        if (this.iccEnabled && this.iccMode === 'webgl') {
            this.styleElement.textContent = `
                #osd-viewer.color-corrected {
                    filter: none;
                }
            `;
            return;
        }
        
        // Build CSS filters - combine ICC gamma with manual adjustments
        const filters = [];
        
        // Brightness and contrast from manual controls
        const brightness = 1 + this.params.brightness;
        if (brightness !== 1) filters.push(`brightness(${brightness})`);
        if (this.params.contrast !== 1) filters.push(`contrast(${this.params.contrast})`);
        if (this.params.saturation !== 1) filters.push(`saturate(${this.params.saturation})`);
        
        // Combined gamma: ICC gamma (if enabled) * manual gamma adjustment
        // ICC gamma is the profile's gamma, manual gamma is user's adjustment
        const effectiveGamma = this.iccEnabled 
            ? this.iccGamma * this.params.gamma  // ICC + manual stacked
            : this.params.gamma;                  // Manual only
        
        if (effectiveGamma !== 1.0) {
            this.updateSvgGamma(effectiveGamma);
            filters.push('url(#gamma-correction)');
        }
        
        const filterString = filters.length > 0 ? filters.join(' ') : 'none';
        
        // Ensure class is set if we have any active filters
        if (this.viewerElement && filters.length > 0) {
            this.viewerElement.classList.add('color-corrected');
        }
        
        this.styleElement.textContent = `
            #osd-viewer.color-corrected {
                filter: ${filterString};
            }
        `;
    }
    
    updateSvgGamma(gamma) {
        const exponent = 1 / gamma;
        ['feFuncR', 'feFuncG', 'feFuncB'].forEach(funcName => {
            document.querySelectorAll(`#gamma-correction ${funcName}`).forEach(el => {
                el.setAttribute('exponent', exponent.toFixed(4));
            });
        });
    }
    
    // Load and apply ICC profile
    async loadICCProfile(studyId) {
        if (!this.webglReady) {
            console.warn('WebGL not available for ICC transform');
            return false;
        }
        
        try {
            const res = await fetch(`/api/studies/${studyId}/icc-profile?include_transform=true`);
            if (!res.ok) {
                console.warn('Failed to fetch ICC profile');
                return false;
            }
            
            const data = await res.json();
            
            if (!data.has_icc || !data.color_transform) {
                console.log('No ICC profile or transform data available');
                return false;
            }
            
            this.iccData = data;
            this.iccTransform = data.color_transform;
            
            console.log('ICC profile loaded:', data.profile_info);
            console.log('Color transform:', this.iccTransform);
            
            return true;
        } catch (e) {
            console.error('Error loading ICC profile:', e);
            return false;
        }
    }
    
    enableICC() {
        if (!this.iccTransform) {
            console.warn('Cannot enable ICC: no transform data');
            return false;
        }
        
        this.iccEnabled = true;
        this.enabled = true;

        // Use CSS filter mode - WebGL overlay has compatibility issues with OpenSeadragon canvas
        this.iccMode = 'css';

        // Extract gamma from ICC profile - store separately from manual controls
        const transform = this.iccTransform.transform || this.iccTransform;
        const gamma = transform.gamma || { r: 2.2, g: 2.2, b: 2.2 };

        // Use average gamma for CSS filter (CSS doesn't support per-channel gamma easily)
        this.iccGamma = (gamma.r + gamma.g + gamma.b) / 3;

        console.log(`ICC gamma extracted: R=${gamma.r.toFixed(3)}, G=${gamma.g.toFixed(3)}, B=${gamma.b.toFixed(3)}, avg=${this.iccGamma.toFixed(3)}`);
        console.log(`Manual controls remain independent: gamma=${this.params.gamma}, brightness=${this.params.brightness}`);

        if (this.viewerElement) {
            this.viewerElement.classList.add('color-corrected');
            this.viewerElement.classList.remove('gamma-correct', 'icc-transform');
        }

        this.updateFilterStyles();
        console.log('ICC color correction enabled (CSS mode)');
        return true;
    }
    
    disableICC() {
        this.iccEnabled = false;
        this.iccMode = null;

        // Stop WebGL overlay if it was running
        this._stopICCRendering();
        
        // Reset ICC gamma but keep manual adjustments intact
        this.iccGamma = 1.0;
        // Note: this.params (manual controls) remain unchanged
        
        if (this.viewerElement) {
            this.viewerElement.classList.remove('icc-transform');
            // Keep 'color-corrected' if manual adjustments are non-default
            const hasManualAdjustments = this.params.gamma !== 1.0 || 
                                          this.params.brightness !== 0 || 
                                          this.params.contrast !== 1.0 || 
                                          this.params.saturation !== 1.0;
            if (!hasManualAdjustments) {
                this.viewerElement.classList.remove('color-corrected');
            }
        }
        
        this.updateFilterStyles();
        
        console.log('ICC disabled. Manual controls preserved:', this.params);
    }
    
    _startICCRendering() {
        if (!this.viewer || !this.viewer.canvas) {
            console.warn('Viewer canvas not available');
            return;
        }
        
        // Create overlay canvas for ICC-corrected output
        this._createOverlayCanvas();
        
        // Hook into OpenSeadragon's draw events
        this._hookViewerEvents();
    }
    
    _createOverlayCanvas() {
        // Remove existing overlay
        const existing = document.getElementById('icc-overlay-canvas');
        if (existing) existing.remove();
        
        // Create overlay canvas
        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.id = 'icc-overlay-canvas';
        this.overlayCanvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1;
        `;
        
        // Insert after OSD canvas
        const container = this.viewerElement;
        if (container) {
            container.style.position = 'relative';
            container.appendChild(this.overlayCanvas);
        }
    }
    
    _hookViewerEvents() {
        if (!this.viewer) return;
        
        // Apply ICC transform after each frame
        this._updateHandler = () => {
            if (this.iccEnabled) {
                this._applyICCTransform();
            }
        };
        
        this.viewer.addHandler('update-viewport', this._updateHandler);
        this.viewer.addHandler('tile-drawn', this._updateHandler);
        
        // Initial render
        setTimeout(() => this._applyICCTransform(), 100);
    }
    
    _stopICCRendering() {
        // Remove overlay
        const overlay = document.getElementById('icc-overlay-canvas');
        if (overlay) overlay.remove();
        
        // Remove event handlers
        if (this.viewer && this._updateHandler) {
            this.viewer.removeHandler('update-viewport', this._updateHandler);
            this.viewer.removeHandler('tile-drawn', this._updateHandler);
        }
    }
    
    _applyICCTransform() {
        // WebGL transform is complex and error-prone with OpenSeadragon canvas
        // Fall back to CSS filters which work reliably
        if (!this.iccTransform) return;
        
        // Just use CSS filter mode - it's reliable and works with OpenSeadragon
        this.updateFilterStyles();
        return;
        
        /* WebGL transform disabled - OpenSeadragon canvas not compatible
        if (!this.gl || !this.program || !this.viewer || !this.viewer.canvas) return;
        if (!this.overlayCanvas || !this.iccTransform) return;
        
        const sourceCanvas = this.viewer.canvas;
        const gl = this.gl;
        
        try {
            // Resize canvases to match source
            if (this.canvas.width !== sourceCanvas.width || this.canvas.height !== sourceCanvas.height) {
                this.canvas.width = sourceCanvas.width;
                this.canvas.height = sourceCanvas.height;
                this.overlayCanvas.width = sourceCanvas.width;
                this.overlayCanvas.height = sourceCanvas.height;
            }
            
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            gl.useProgram(this.program);
            
            // Set up attributes
            const posLoc = gl.getAttribLocation(this.program, 'a_position');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
            gl.enableVertexAttribArray(posLoc);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
            
            const texLoc = gl.getAttribLocation(this.program, 'a_texCoord');
            gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
            gl.enableVertexAttribArray(texLoc);
            gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
            
            // Create texture from source canvas
            const texture = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        } catch (e) {
            console.warn('WebGL ICC transform failed, using CSS fallback:', e.message);
            this.updateFilterStyles();
            return;
        }
        */
        
        // Set uniforms
        const webglData = this.iccTransform.webgl || {};
        
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);
        
        // Gamma from ICC profile
        const gamma = webglData.u_gamma || [2.2, 2.2, 2.2];
        gl.uniform3f(gl.getUniformLocation(this.program, 'u_gamma'), gamma[0], gamma[1], gamma[2]);
        
        // Color matrix
        const hasMatrix = webglData.u_hasMatrix || false;
        gl.uniform1i(gl.getUniformLocation(this.program, 'u_applyMatrix'), hasMatrix ? 1 : 0);
        
        if (hasMatrix && webglData.u_colorMatrix) {
            gl.uniformMatrix3fv(
                gl.getUniformLocation(this.program, 'u_colorMatrix'),
                false,
                new Float32Array(webglData.u_colorMatrix)
            );
        } else {
            // Identity matrix
            gl.uniformMatrix3fv(
                gl.getUniformLocation(this.program, 'u_colorMatrix'),
                false,
                new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
            );
        }
        
        // User adjustments
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_brightness'), this.params.brightness);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_contrast'), this.params.contrast);
        gl.uniform1f(gl.getUniformLocation(this.program, 'u_saturation'), this.params.saturation);
        
        // Draw
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        
        // Copy to overlay canvas
        const ctx = this.overlayCanvas.getContext('2d');
        ctx.drawImage(this.canvas, 0, 0);
        
        // Clean up
        gl.deleteTexture(texture);
    }
    
    setPreset(presetName) {
        if (this.presets[presetName]) {
            this.params = { ...this.presets[presetName] };
            this.currentPreset = presetName;
            this.updateFilterStyles();
        }
    }
    
    setParams(params) {
        Object.assign(this.params, params);
        this.updateFilterStyles();
    }
    
    setGamma(value) {
        this.params.gamma = value;
        this.updateFilterStyles();
    }
    
    setBrightness(value) {
        this.params.brightness = value;
        this.updateFilterStyles();
    }
    
    setContrast(value) {
        this.params.contrast = value;
        this.updateFilterStyles();
    }
    
    setSaturation(value) {
        this.params.saturation = value;
        this.updateFilterStyles();
    }
    
    enable(preset = null) {
        if (preset) this.setPreset(preset);
        this.enabled = true;
        if (this.viewerElement) {
            this.viewerElement.classList.add('color-corrected');
            this.viewerElement.classList.remove('gamma-correct');
        }
        this.updateFilterStyles();
    }
    
    disable() {
        this.enabled = false;
        this.disableICC();
        if (this.viewerElement) {
            this.viewerElement.classList.remove('color-corrected', 'icc-transform');
        }
    }
    
    toggle() {
        if (this.enabled) this.disable();
        else this.enable();
        return this.enabled;
    }
    
    toggleICC() {
        if (this.iccEnabled) {
            this.disableICC();
        } else {
            this.enableICC();
        }
        return this.iccEnabled;
    }
    
    isDefault() {
        return this.params.gamma === 1.0 &&
               this.params.brightness === 0 &&
               this.params.contrast === 1.0 &&
               this.params.saturation === 1.0;
    }
    
    reset() {
        this.setPreset('sRGB');
        this.disableICC();
        this.disable();
    }
    
    getSettings() {
        return {
            enabled: this.enabled,
            iccEnabled: this.iccEnabled,
            preset: this.currentPreset,
            params: { ...this.params },
            stainParams: { ...this.stainParams },
            stainEnabled: this.stainEnabled,
            webglReady: this.webglReady,
            hasICCData: !!this.iccTransform,
        };
    }
    
    // =========================================================================
    // H&E Stain Deconvolution Methods
    // =========================================================================
    
    /**
     * Enable stain deconvolution mode
     */
    enableStainDeconvolution() {
        this.stainEnabled = true;
        this.enabled = true;
        this._initStainDeconvolution();
        this.updateFilterStyles();
        console.log('🔬 H&E stain deconvolution enabled');
        return true;
    }
    
    /**
     * Disable stain deconvolution
     */
    disableStainDeconvolution() {
        this.stainEnabled = false;
        this._stopStainRendering();
        this.updateFilterStyles();
        console.log('🔬 H&E stain deconvolution disabled');
    }
    
    /**
     * Toggle stain deconvolution on/off
     */
    toggleStainDeconvolution() {
        if (this.stainEnabled) {
            this.disableStainDeconvolution();
        } else {
            this.enableStainDeconvolution();
        }
        return this.stainEnabled;
    }
    
    /**
     * Set hematoxylin intensity (0-2, 1=normal)
     */
    setHematoxylin(value) {
        this.stainParams.hematoxylin = Math.max(0, Math.min(2, parseFloat(value)));
        if (this.stainEnabled) {
            this._applyStainAdjustment();
        }
        console.log(`🔬 Hematoxylin: ${this.stainParams.hematoxylin.toFixed(2)}`);
    }
    
    /**
     * Set eosin intensity (0-2, 1=normal)
     */
    setEosin(value) {
        this.stainParams.eosin = Math.max(0, Math.min(2, parseFloat(value)));
        if (this.stainEnabled) {
            this._applyStainAdjustment();
        }
        console.log(`🔬 Eosin: ${this.stainParams.eosin.toFixed(2)}`);
    }
    
    /**
     * Set view mode: 'combined', 'hematoxylin', 'eosin', or 'dab'
     */
    setStainViewMode(mode) {
        if (['combined', 'hematoxylin', 'eosin', 'dab'].includes(mode)) {
            this.stainParams.viewMode = mode;
            if (this.stainEnabled) {
                this._applyStainAdjustment();
            }
            console.log(`🔬 View mode: ${mode}`);
        }
    }
    
    /**
     * Set stain type: 'HE' or 'HDAB'
     */
    setStainType(type) {
        if (this.stainMatrices[type]) {
            this.stainParams.stainType = type;
            // Reset to balanced when switching
            this.stainParams.hematoxylin = 1.0;
            this.stainParams.eosin = 1.0;
            this.stainParams.viewMode = 'combined';
            if (this.stainEnabled) {
                this._applyStainAdjustment();
            }
            console.log(`🔬 Stain type: ${type} (${this.stainMatrices[type].label1}-${this.stainMatrices[type].label2})`);
        }
    }
    
    /**
     * Get current stain type info
     */
    getStainInfo() {
        const type = this.stainParams.stainType || 'HE';
        return this.stainMatrices[type] || this.stainMatrices.HE;
    }
    
    /**
     * Reset stain parameters to defaults
     */
    resetStainParams() {
        this.stainParams = {
            stainType: 'HE',
            hematoxylin: 1.0,
            eosin: 1.0,
            viewMode: 'combined',
        };
        if (this.stainEnabled) {
            this._applyStainAdjustment();
        }
    }
    
    // =========================================================================
    // Focus Quality Heatmap (Tenengrad/Sobel gradient magnitude)
    // =========================================================================
    
    /**
     * Enable focus quality heatmap overlay
     */
    enableFocusQuality() {
        this.focusEnabled = true;
        this._initFocusQuality();
        console.log('🔍 Focus quality heatmap enabled');
        return true;
    }
    
    /**
     * Disable focus quality heatmap
     */
    disableFocusQuality() {
        this.focusEnabled = false;
        this._stopFocusRendering();
        console.log('🔍 Focus quality heatmap disabled');
    }
    
    /**
     * Toggle focus quality heatmap
     */
    toggleFocusQuality() {
        if (this.focusEnabled) {
            this.disableFocusQuality();
        } else {
            this.enableFocusQuality();
        }
        return this.focusEnabled;
    }
    
    /**
     * Set focus heatmap opacity (0-1)
     */
    setFocusOpacity(value) {
        this.focusParams.opacity = Math.max(0, Math.min(1, parseFloat(value)));
        if (this.focusEnabled) {
            this._applyFocusQuality();
        }
    }
    
    /**
     * Set focus detection threshold (0-1)
     */
    setFocusThreshold(value) {
        this.focusParams.threshold = Math.max(0, Math.min(0.5, parseFloat(value)));
        if (this.focusEnabled) {
            this._applyFocusQuality();
        }
    }
    
    /**
     * Set focus smoothing kernel scale (1-8)
     */
    setFocusSmoothing(value) {
        this.focusParams.smoothing = Math.max(1, Math.min(8, parseFloat(value)));
        if (this.focusEnabled) {
            this._applyFocusQuality();
        }
    }
    
    /**
     * Initialize focus quality WebGL
     */
    _initFocusQuality() {
        // Create canvas overlay
        if (!this.focusCanvas) {
            this.focusCanvas = document.createElement('canvas');
            this.focusCanvas.id = 'focus-quality-canvas';
            this.focusCanvas.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 11;
            `;
        }
        
        if (this.viewerElement && !this.viewerElement.contains(this.focusCanvas)) {
            this.viewerElement.appendChild(this.focusCanvas);
        }
        
        // Initialize WebGL
        this._initFocusWebGL();
        
        // Hook into viewer updates
        if (this.viewer) {
            this._focusUpdateHandler = () => this._applyFocusQuality();
            this.viewer.addHandler('animation-finish', this._focusUpdateHandler);
            this.viewer.addHandler('update-viewport', this._focusUpdateHandler);
            setTimeout(() => this._applyFocusQuality(), 100);
        }
    }
    
    /**
     * Initialize WebGL shader for focus quality (Sobel/Tenengrad)
     */
    _initFocusWebGL() {
        const gl = this.focusCanvas.getContext('webgl', {
            preserveDrawingBuffer: true,
            premultipliedAlpha: false
        });
        
        if (!gl) {
            console.warn('🔍 WebGL not available for focus quality');
            this.focusWebGL = null;
            return;
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
        
        // Fragment shader: Smoothed Sobel with Gaussian pre-blur and averaging
        const fsSource = `
            precision highp float;
            
            uniform sampler2D u_image;
            uniform vec2 u_texelSize;  // 1/width, 1/height
            uniform float u_opacity;
            uniform float u_threshold;
            uniform float u_smoothing;  // 1.0-5.0 kernel scale
            
            varying vec2 v_texCoord;
            
            // Convert to grayscale luminance
            float luminance(vec3 c) {
                return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
            }
            
            // Gaussian-weighted sample (approximation)
            float gaussianSample(vec2 center, float scale) {
                vec2 ts = u_texelSize * scale;
                
                // 5x5 Gaussian kernel weights (sigma ≈ 1)
                // Simplified: sample 9 points with Gaussian weighting
                float sum = 0.0;
                float weight = 0.0;
                
                // Center (weight 4)
                sum += luminance(texture2D(u_image, center).rgb) * 4.0;
                weight += 4.0;
                
                // Adjacent (weight 2)
                sum += luminance(texture2D(u_image, center + vec2(-1.0, 0.0) * ts).rgb) * 2.0;
                sum += luminance(texture2D(u_image, center + vec2( 1.0, 0.0) * ts).rgb) * 2.0;
                sum += luminance(texture2D(u_image, center + vec2( 0.0,-1.0) * ts).rgb) * 2.0;
                sum += luminance(texture2D(u_image, center + vec2( 0.0, 1.0) * ts).rgb) * 2.0;
                weight += 8.0;
                
                // Diagonal (weight 1)
                sum += luminance(texture2D(u_image, center + vec2(-1.0,-1.0) * ts).rgb);
                sum += luminance(texture2D(u_image, center + vec2( 1.0,-1.0) * ts).rgb);
                sum += luminance(texture2D(u_image, center + vec2(-1.0, 1.0) * ts).rgb);
                sum += luminance(texture2D(u_image, center + vec2( 1.0, 1.0) * ts).rgb);
                weight += 4.0;
                
                return sum / weight;
            }
            
            // Thermal colormap: blue (cold/blur) -> red (hot/sharp)
            vec3 thermalColormap(float t) {
                vec3 c;
                if (t < 0.25) {
                    c = mix(vec3(0.0, 0.0, 0.5), vec3(0.0, 0.5, 1.0), t * 4.0);
                } else if (t < 0.5) {
                    c = mix(vec3(0.0, 0.5, 1.0), vec3(0.0, 1.0, 0.0), (t - 0.25) * 4.0);
                } else if (t < 0.75) {
                    c = mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 1.0, 0.0), (t - 0.5) * 4.0);
                } else {
                    c = mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), (t - 0.75) * 4.0);
                }
                return c;
            }
            
            void main() {
                vec2 ts = u_texelSize * u_smoothing;
                
                // Sample with Gaussian pre-blur at 3x3 positions for Sobel
                float tl = gaussianSample(v_texCoord + vec2(-1.0, -1.0) * ts, u_smoothing);
                float tm = gaussianSample(v_texCoord + vec2( 0.0, -1.0) * ts, u_smoothing);
                float tr = gaussianSample(v_texCoord + vec2( 1.0, -1.0) * ts, u_smoothing);
                float ml = gaussianSample(v_texCoord + vec2(-1.0,  0.0) * ts, u_smoothing);
                float mr = gaussianSample(v_texCoord + vec2( 1.0,  0.0) * ts, u_smoothing);
                float bl = gaussianSample(v_texCoord + vec2(-1.0,  1.0) * ts, u_smoothing);
                float bm = gaussianSample(v_texCoord + vec2( 0.0,  1.0) * ts, u_smoothing);
                float br = gaussianSample(v_texCoord + vec2( 1.0,  1.0) * ts, u_smoothing);
                
                // Sobel operators
                float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
                float gy = -tl - 2.0*tm - tr + bl + 2.0*bm + br;
                
                // Gradient magnitude (Tenengrad)
                float gradient = sqrt(gx*gx + gy*gy);
                
                // Normalize with smooth falloff
                float sharpness = smoothstep(u_threshold, u_threshold + 0.3, gradient);
                
                // Apply colormap
                vec3 heatColor = thermalColormap(sharpness);
                
                // Smooth alpha transition
                float alpha = sharpness * u_opacity;
                
                gl_FragColor = vec4(heatColor, alpha);
            }
        `;
        
        const vs = this._compileStainShader(gl, gl.VERTEX_SHADER, vsSource);
        const fs = this._compileStainShader(gl, gl.FRAGMENT_SHADER, fsSource);
        
        if (!vs || !fs) {
            console.warn('🔍 Focus shader compilation failed');
            this.focusWebGL = null;
            return;
        }
        
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('🔍 Focus program link failed:', gl.getProgramInfoLog(program));
            this.focusWebGL = null;
            return;
        }
        
        // Set up buffers (same as stain shader)
        const positions = new Float32Array([
            -1, -1,   1, -1,   -1, 1,
            -1,  1,   1, -1,    1, 1,
        ]);
        const texCoords = new Float32Array([
            0, 1,   1, 1,   0, 0,
            0, 0,   1, 1,   1, 0,
        ]);
        
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        
        const texBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
        
        this.focusWebGL = {
            gl,
            program,
            posBuffer,
            texBuffer,
            posLoc: gl.getAttribLocation(program, 'a_position'),
            texLoc: gl.getAttribLocation(program, 'a_texCoord'),
            uniforms: {
                image: gl.getUniformLocation(program, 'u_image'),
                texelSize: gl.getUniformLocation(program, 'u_texelSize'),
                opacity: gl.getUniformLocation(program, 'u_opacity'),
                threshold: gl.getUniformLocation(program, 'u_threshold'),
                smoothing: gl.getUniformLocation(program, 'u_smoothing'),
            },
            texture: gl.createTexture(),
        };
        
        console.log('🔍 Focus quality WebGL shader ready');
    }
    
    /**
     * Apply focus quality heatmap
     */
    _applyFocusQuality() {
        if (!this.focusEnabled || !this.viewer || !this.focusCanvas) return;
        
        // Get source canvas
        let sourceCanvas = null;
        if (this.viewer.drawer?.canvas && this.viewer.drawer.canvas.width > 1) {
            sourceCanvas = this.viewer.drawer.canvas;
        } else if (this.viewer.canvas) {
            const canvases = this.viewer.canvas.getElementsByTagName('canvas');
            for (const c of canvases) {
                if (c.width > 1 && c.height > 1 && c !== this.focusCanvas && c !== this.stainCanvas) {
                    sourceCanvas = c;
                    break;
                }
            }
        }
        
        if (!sourceCanvas || sourceCanvas.width <= 1) {
            setTimeout(() => this._applyFocusQuality(), 200);
            return;
        }
        
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        
        if (this.focusCanvas.width !== width || this.focusCanvas.height !== height) {
            this.focusCanvas.width = width;
            this.focusCanvas.height = height;
        }
        
        if (this.focusWebGL) {
            this._applyFocusWebGL(sourceCanvas);
            this.focusCanvas.style.display = 'block';
        }
    }
    
    /**
     * WebGL focus quality rendering
     */
    _applyFocusWebGL(sourceCanvas) {
        const { gl, program, posBuffer, texBuffer, posLoc, texLoc, uniforms, texture } = this.focusWebGL;
        
        gl.viewport(0, 0, this.focusCanvas.width, this.focusCanvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        // Enable blending for transparency
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        
        gl.useProgram(program);
        
        // Upload texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        } catch (e) {
            console.warn('🔍 Focus texture upload failed:', e.message);
            return;
        }
        
        // Set uniforms
        gl.uniform1i(uniforms.image, 0);
        gl.uniform2f(uniforms.texelSize, 1.0 / sourceCanvas.width, 1.0 / sourceCanvas.height);
        gl.uniform1f(uniforms.opacity, this.focusParams.opacity);
        gl.uniform1f(uniforms.threshold, this.focusParams.threshold);
        gl.uniform1f(uniforms.smoothing, this.focusParams.smoothing);
        
        // Draw
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.enableVertexAttribArray(texLoc);
        gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
        
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        
        gl.disableVertexAttribArray(posLoc);
        gl.disableVertexAttribArray(texLoc);
        gl.disable(gl.BLEND);
    }
    
    /**
     * Stop focus quality rendering
     */
    _stopFocusRendering() {
        if (this.focusCanvas) {
            this.focusCanvas.style.display = 'none';
        }
        if (this.viewer && this._focusUpdateHandler) {
            this.viewer.removeHandler('animation-finish', this._focusUpdateHandler);
            this.viewer.removeHandler('update-viewport', this._focusUpdateHandler);
            this._focusUpdateHandler = null;
        }
    }
    
    /**
     * Initialize stain deconvolution with GPU-accelerated WebGL
     */
    _initStainDeconvolution() {
        // Create WebGL canvas overlay
        if (!this.stainCanvas) {
            this.stainCanvas = document.createElement('canvas');
            this.stainCanvas.id = 'stain-deconv-canvas';
            this.stainCanvas.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 10;
            `;
        }
        
        if (this.viewerElement && !this.viewerElement.contains(this.stainCanvas)) {
            this.viewerElement.appendChild(this.stainCanvas);
        }
        
        // Initialize WebGL context
        this._initStainWebGL();
        
        // Hook into viewer updates
        if (this.viewer) {
            this._stainUpdateHandler = () => this._applyStainDeconvolution();
            this.viewer.addHandler('animation-finish', this._stainUpdateHandler);
            this.viewer.addHandler('open', this._stainUpdateHandler);
            this.viewer.addHandler('update-viewport', this._stainUpdateHandler);
            // Initial render
            setTimeout(() => this._applyStainDeconvolution(), 100);
        }
        
        console.log('🔬 Stain deconvolution initialized (WebGL GPU-accelerated)');
    }
    
    /**
     * Initialize WebGL for GPU-accelerated deconvolution
     */
    _initStainWebGL() {
        const gl = this.stainCanvas.getContext('webgl', { 
            preserveDrawingBuffer: true,
            premultipliedAlpha: false 
        });
        
        if (!gl) {
            console.warn('🔬 WebGL not available, falling back to CPU');
            this.stainWebGL = null;
            return;
        }
        
        // Vertex shader - simple fullscreen quad
        const vsSource = `
            attribute vec2 a_position;
            attribute vec2 a_texCoord;
            varying vec2 v_texCoord;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texCoord = a_texCoord;
            }
        `;
        
        // Fragment shader - stain deconvolution (H&E or H-DAB)
        const fsSource = `
            precision highp float;
            
            uniform sampler2D u_image;
            varying vec2 v_texCoord;
            
            // Stain parameters
            uniform float u_stain1Intensity;  // Hematoxylin
            uniform float u_stain2Intensity;  // Eosin or DAB
            uniform int u_viewMode;           // 0=combined, 1=stain1 only, 2=stain2 only
            
            // Stain vectors (passed as uniforms for flexibility)
            uniform vec3 u_stain1;    // Hematoxylin vector
            uniform vec3 u_stain2;    // Eosin or DAB vector
            uniform vec3 u_residual;  // Residual/background vector
            
            // Inverse stain matrix row vectors (precomputed on CPU)
            uniform vec3 u_invRow0;
            uniform vec3 u_invRow1;
            uniform vec3 u_invRow2;
            
            void main() {
                vec4 color = texture2D(u_image, v_texCoord);
                
                // Convert RGB to optical density: OD = -log10(I)
                vec3 rgb = max(color.rgb, 0.004);
                vec3 od = vec3(
                    -log(rgb.r) / log(10.0),
                    -log(rgb.g) / log(10.0),
                    -log(rgb.b) / log(10.0)
                );
                
                // Apply inverse stain matrix to get concentrations
                float c1 = max(0.0, dot(u_invRow0, od));  // Stain 1 (H)
                float c2 = max(0.0, dot(u_invRow1, od));  // Stain 2 (E or DAB)
                float cR = max(0.0, dot(u_invRow2, od));  // Residual
                
                // Apply user adjustments
                c1 *= u_stain1Intensity;
                c2 *= u_stain2Intensity;
                
                // Reconstruct based on view mode
                vec3 finalOD;
                if (u_viewMode == 1) {
                    finalOD = u_stain1 * c1;
                } else if (u_viewMode == 2) {
                    finalOD = u_stain2 * c2;
                } else {
                    finalOD = u_stain1 * c1 + u_stain2 * c2 + u_residual * cR;
                }
                
                // Convert back from OD to RGB: I = 10^(-OD)
                vec3 finalRGB = vec3(
                    pow(10.0, -finalOD.r),
                    pow(10.0, -finalOD.g),
                    pow(10.0, -finalOD.b)
                );
                
                gl_FragColor = vec4(clamp(finalRGB, 0.0, 1.0), color.a);
            }
        `;
        
        // Compile shaders (using _compileStainShader to avoid name collision with ICC shader)
        const vs = this._compileStainShader(gl, gl.VERTEX_SHADER, vsSource);
        const fs = this._compileStainShader(gl, gl.FRAGMENT_SHADER, fsSource);
        
        if (!vs || !fs) {
            console.warn('🔬 Shader compilation failed, falling back to CPU');
            this.stainWebGL = null;
            return;
        }
        
        // Link program
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('🔬 Program link failed:', gl.getProgramInfoLog(program));
            this.stainWebGL = null;
            return;
        }
        
        // Set up buffers
        const positions = new Float32Array([
            -1, -1,   1, -1,   -1, 1,
            -1,  1,   1, -1,    1, 1,
        ]);
        const texCoords = new Float32Array([
            0, 1,   1, 1,   0, 0,
            0, 0,   1, 1,   1, 0,
        ]);
        
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        
        const texBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
        
        // Get locations
        const posLoc = gl.getAttribLocation(program, 'a_position');
        const texLoc = gl.getAttribLocation(program, 'a_texCoord');
        
        this.stainWebGL = {
            gl,
            program,
            posBuffer,
            texBuffer,
            posLoc,
            texLoc,
            uniforms: {
                image: gl.getUniformLocation(program, 'u_image'),
                stain1Intensity: gl.getUniformLocation(program, 'u_stain1Intensity'),
                stain2Intensity: gl.getUniformLocation(program, 'u_stain2Intensity'),
                viewMode: gl.getUniformLocation(program, 'u_viewMode'),
                stain1: gl.getUniformLocation(program, 'u_stain1'),
                stain2: gl.getUniformLocation(program, 'u_stain2'),
                residual: gl.getUniformLocation(program, 'u_residual'),
                invRow0: gl.getUniformLocation(program, 'u_invRow0'),
                invRow1: gl.getUniformLocation(program, 'u_invRow1'),
                invRow2: gl.getUniformLocation(program, 'u_invRow2'),
            },
            texture: gl.createTexture(),
        };
        
        // Precompute inverse matrices for both stain types
        this._computeInverseStainMatrices();
        
        console.log('🔬 WebGL stain shader compiled successfully');
    }
    
    /**
     * Compute inverse stain matrices for all stain types
     */
    _computeInverseStainMatrices() {
        this.inverseMatrices = {};
        
        for (const [type, stains] of Object.entries(this.stainMatrices)) {
            // Build 3x3 matrix from stain vectors.
            // NOTE: we need a full-rank 3x3 here; for 2-stain presets (e.g., H-DAB) we derive a 3rd vector.
            const residual = this._getEffectiveResidualVector(stains);
            this._effectiveResiduals[type] = residual;
            const M = [
                stains.stain1,
                stains.stain2,
                residual,
            ];
            
            // Compute inverse
            this.inverseMatrices[type] = this._invertMatrix3x3(M);
        }
        
        console.log('🔬 Inverse stain matrices computed for:', Object.keys(this.inverseMatrices));
    }
    
    /**
     * Invert a 3x3 matrix
     */
    _invertMatrix3x3(m) {
        const det = 
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
            m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
            m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        
        if (Math.abs(det) < 1e-10) {
            console.warn('🔬 Stain matrix is singular, using identity');
            return [[1,0,0], [0,1,0], [0,0,1]];
        }
        
        const invDet = 1 / det;
        return [
            [
                (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
                (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
                (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet
            ],
            [
                (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
                (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
                (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet
            ],
            [
                (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
                (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
                (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet
            ]
        ];
    }
    
    /**
     * Compile a WebGL shader for stain deconvolution
     * (Named differently to avoid collision with ICC _compileShader)
     */
    _compileStainShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('🔬 Shader compile error:', gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }
    
    /**
     * Apply color deconvolution using WebGL (GPU) or fallback to CPU
     */
    _applyStainDeconvolution() {
        if (!this.stainEnabled || !this.viewer || !this.stainCanvas) {
            return;
        }
        
        // Get the actual rendered canvas from OpenSeadragon
        let sourceCanvas = null;
        let canvasSource = 'none';
        
        // Debug: log what's available
        console.log('🔬 OSD drawer type:', this.viewer.drawer?.constructor?.name);
        console.log('🔬 drawer.canvas:', this.viewer.drawer?.canvas?.width, 'x', this.viewer.drawer?.canvas?.height);
        console.log('🔬 drawer.context:', this.viewer.drawer?.context?.constructor?.name);
        
        // Method 1: drawer.canvas (works for CanvasDrawer)
        if (this.viewer.drawer?.canvas && this.viewer.drawer.canvas.width > 1) {
            sourceCanvas = this.viewer.drawer.canvas;
            canvasSource = 'drawer.canvas';
        }
        // Method 2: Get from container
        else if (this.viewer.canvas) {
            const canvases = this.viewer.canvas.getElementsByTagName('canvas');
            console.log('🔬 Found', canvases.length, 'canvases in viewer container');
            for (const c of canvases) {
                console.log('🔬   Canvas:', c.width, 'x', c.height, c.id || '(no id)');
                if (c.width > 1 && c.height > 1 && c !== this.stainCanvas) {
                    sourceCanvas = c;
                    canvasSource = 'container';
                    break;
                }
            }
        }
        // Method 3: drawer context canvas
        else if (this.viewer.drawer?.context?.canvas) {
            sourceCanvas = this.viewer.drawer.context.canvas;
            canvasSource = 'drawer.context.canvas';
        }
        
        if (!sourceCanvas || sourceCanvas.width <= 1 || sourceCanvas.height <= 1) {
            console.log('🔬 No valid source canvas found, retrying...');
            setTimeout(() => this._applyStainDeconvolution(), 200);
            return;
        }
        
        console.log('🔬 Using source canvas from:', canvasSource, sourceCanvas.width, 'x', sourceCanvas.height);
        
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        
        // Resize overlay canvas if needed
        if (this.stainCanvas.width !== width || this.stainCanvas.height !== height) {
            this.stainCanvas.width = width;
            this.stainCanvas.height = height;
            console.log('🔬 Stain overlay sized:', width, 'x', height);
            
            if (this.stainWebGL) {
                this.stainWebGL.gl.viewport(0, 0, width, height);
            }
        }
        
        // Check if canvas is tainted (CORS)
        try {
            const testCtx = sourceCanvas.getContext('2d');
            if (testCtx) {
                testCtx.getImageData(0, 0, 1, 1);
                console.log('🔬 Canvas is readable (not tainted)');
            }
        } catch (e) {
            console.error('🔬 Canvas is TAINTED (CORS issue):', e.message);
            console.log('🔬 Cannot read pixels - need crossOrigin on tile images');
            return;
        }
        
        if (this.stainWebGL) {
            if (this.stainCanvas2D) {
                this.stainCanvas2D.style.display = 'none';
            }
            this._applyStainWebGL(sourceCanvas);
            this.stainCanvas.style.display = 'block';
            console.log('🔬 WebGL render complete');
        } else {
            this._applyStainCPU(sourceCanvas);
            console.log('🔬 CPU render complete');
        }
    }
    
    /**
     * GPU-accelerated deconvolution via WebGL
     */
    _applyStainWebGL(sourceCanvas) {
        const { gl, program, posBuffer, texBuffer, posLoc, texLoc, uniforms, texture } = this.stainWebGL;
        
        // Ensure viewport matches canvas
        gl.viewport(0, 0, this.stainCanvas.width, this.stainCanvas.height);
        
        // Clear previous frame
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        
        gl.useProgram(program);
        
        // Upload source canvas as texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);  // Don't flip - canvas to canvas same coords
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        } catch (e) {
            console.warn('🔬 Cannot upload canvas texture (CORS?):', e.message);
            // Fall back to CPU
            this._applyStainCPU(sourceCanvas);
            return;
        }
        
        // Check for WebGL errors
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
            console.warn('🔬 WebGL error after texture upload:', err);
        }
        
        // Set uniforms
        gl.uniform1i(uniforms.image, 0);
        gl.uniform1f(uniforms.stain1Intensity, this.stainParams.hematoxylin);
        gl.uniform1f(uniforms.stain2Intensity, this.stainParams.eosin);
        
        // Get stain vectors for current type
        const stainType = this.stainParams.stainType || 'HE';
        const stains = this.stainMatrices[stainType];
        const invMatrix = this.inverseMatrices[stainType];
        
        if (stains && invMatrix) {
            gl.uniform3fv(uniforms.stain1, stains.stain1);
            gl.uniform3fv(uniforms.stain2, stains.stain2);
            gl.uniform3fv(uniforms.residual, stains.residual[0] === 0 ? [0.268, 0.570, 0.776] : stains.residual);
            gl.uniform3fv(uniforms.invRow0, invMatrix[0]);
            gl.uniform3fv(uniforms.invRow1, invMatrix[1]);
            gl.uniform3fv(uniforms.invRow2, invMatrix[2]);
        }
        
        const viewModeMap = { 'combined': 0, 'hematoxylin': 1, 'eosin': 2, 'dab': 2 };
        gl.uniform1i(uniforms.viewMode, viewModeMap[this.stainParams.viewMode] || 0);
        
        // Set up position attribute
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        
        // Set up texcoord attribute
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.enableVertexAttribArray(texLoc);
        gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
        
        // Draw fullscreen quad
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        
        // Disable attributes to avoid state leakage
        gl.disableVertexAttribArray(posLoc);
        gl.disableVertexAttribArray(texLoc);
    }
    
    /**
     * CPU fallback for deconvolution (slower but always works)
     * Uses a separate 2D canvas to avoid WebGL context conflict
     */
    _applyStainCPU(sourceCanvas) {
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        
        // Create separate 2D canvas for CPU fallback (can't mix 2D and WebGL contexts)
        if (!this.stainCanvas2D) {
            this.stainCanvas2D = document.createElement('canvas');
            this.stainCanvas2D.id = 'stain-deconv-canvas-2d';
            this.stainCanvas2D.style.cssText = this.stainCanvas.style.cssText;
        }
        this.stainCanvas2D.width = width;
        this.stainCanvas2D.height = height;
        
        // Hide WebGL canvas, show 2D canvas
        this.stainCanvas.style.display = 'none';
        if (!this.viewerElement.contains(this.stainCanvas2D)) {
            this.viewerElement.appendChild(this.stainCanvas2D);
        }
        this.stainCanvas2D.style.display = 'block';
        
        const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        const destCtx = this.stainCanvas2D.getContext('2d');
        
        let imageData;
        try {
            imageData = sourceCtx.getImageData(0, 0, width, height);
        } catch (e) {
            console.warn('🔬 Cannot read canvas (CORS?):', e.message);
            return;
        }
        
        const data = imageData.data;
        const H = this.stainParams.hematoxylin;
        const E = this.stainParams.eosin;
        const mode = this.stainParams.viewMode;
        
        // Inverse stain matrix (same as shader)
        const inv = [
            [1.87798274, -1.00767869, 0.14539618],
            [-0.06590806, 1.13473037, -0.13943433],
            [-0.60190736, -0.48041808, 1.57358807]
        ];
        
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i] / 255;
            const g = data[i + 1] / 255;
            const b = data[i + 2] / 255;
            
            // RGB to OD
            const odR = -Math.log10(Math.max(r, 0.004));
            const odG = -Math.log10(Math.max(g, 0.004));
            const odB = -Math.log10(Math.max(b, 0.004));
            
            // Inverse matrix
            let cH = Math.max(0, inv[0][0] * odR + inv[0][1] * odG + inv[0][2] * odB) * H;
            let cE = Math.max(0, inv[1][0] * odR + inv[1][1] * odG + inv[1][2] * odB) * E;
            let cR = Math.max(0, inv[2][0] * odR + inv[2][1] * odG + inv[2][2] * odB);
            
            // Reconstruct
            let finalR, finalG, finalB;
            if (mode === 'hematoxylin') {
                finalR = Math.pow(10, -(0.650 * cH));
                finalG = Math.pow(10, -(0.704 * cH));
                finalB = Math.pow(10, -(0.286 * cH));
            } else if (mode === 'eosin') {
                finalR = Math.pow(10, -(0.072 * cE));
                finalG = Math.pow(10, -(0.990 * cE));
                finalB = Math.pow(10, -(0.105 * cE));
            } else {
                finalR = Math.pow(10, -(0.650 * cH + 0.072 * cE + 0.268 * cR));
                finalG = Math.pow(10, -(0.704 * cH + 0.990 * cE + 0.570 * cR));
                finalB = Math.pow(10, -(0.286 * cH + 0.105 * cE + 0.776 * cR));
            }
            
            data[i] = Math.min(255, Math.max(0, finalR * 255));
            data[i + 1] = Math.min(255, Math.max(0, finalG * 255));
            data[i + 2] = Math.min(255, Math.max(0, finalB * 255));
        }
        
        destCtx.putImageData(imageData, 0, 0);
    }
    
    /**
     * Schedule stain update (debounced for performance)
     */
    _applyStainAdjustment() {
        if (!this.stainEnabled) return;
        
        // Debounce updates
        if (this._stainDebounce) {
            cancelAnimationFrame(this._stainDebounce);
        }
        this._stainDebounce = requestAnimationFrame(() => {
            this._applyStainDeconvolution();
        });
    }
    
    /**
     * Stop stain rendering (cleanup)
     */
    _stopStainRendering() {
        // Hide overlay canvases
        if (this.stainCanvas) {
            this.stainCanvas.style.display = 'none';
        }
        if (this.stainCanvas2D) {
            this.stainCanvas2D.style.display = 'none';
        }
        
        // Remove viewer handlers
        if (this.viewer && this._stainUpdateHandler) {
            this.viewer.removeHandler('animation-finish', this._stainUpdateHandler);
            this.viewer.removeHandler('open', this._stainUpdateHandler);
            this._stainUpdateHandler = null;
        }
        
        // Cancel pending updates
        if (this._stainDebounce) {
            cancelAnimationFrame(this._stainDebounce);
            this._stainDebounce = null;
        }
    }
}

window.ColorCorrectionFilter = ColorCorrectionFilter;
