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
        
        // H&E Stain deconvolution parameters
        this.stainParams = {
            hematoxylin: 1.0,  // H channel intensity (0-2, 1=normal)
            eosin: 1.0,        // E channel intensity (0-2, 1=normal)
            viewMode: 'combined', // 'combined' | 'hematoxylin' | 'eosin'
        };
        this.stainEnabled = false;
        
        // Ruifrok & Johnston H&E stain vectors (optical density, normalized)
        // Reference: Quantification of histochemical staining (2001)
        this.stainMatrix = {
            // Each row is [R, G, B] optical density for that stain
            H: [0.650, 0.704, 0.286],   // Hematoxylin (blue-purple)
            E: [0.072, 0.990, 0.105],   // Eosin (pink)
            R: [0.268, 0.570, 0.776],   // Residual/background
        };
        
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
     * Set view mode: 'combined', 'hematoxylin', or 'eosin'
     */
    setStainViewMode(mode) {
        if (['combined', 'hematoxylin', 'eosin'].includes(mode)) {
            this.stainParams.viewMode = mode;
            if (this.stainEnabled) {
                this._applyStainAdjustment();
            }
            console.log(`🔬 View mode: ${mode}`);
        }
    }
    
    /**
     * Reset stain parameters to defaults
     */
    resetStainParams() {
        this.stainParams = {
            hematoxylin: 1.0,
            eosin: 1.0,
            viewMode: 'combined',
        };
        if (this.stainEnabled) {
            this._applyStainAdjustment();
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
        
        // Fragment shader - Ruifrok H&E deconvolution
        const fsSource = `
            precision highp float;
            
            uniform sampler2D u_image;
            varying vec2 v_texCoord;
            
            // Stain parameters
            uniform float u_hematoxylin;
            uniform float u_eosin;
            uniform int u_viewMode; // 0=combined, 1=H only, 2=E only
            
            // Inverse stain matrix (precomputed Ruifrok H&E)
            // Computed from M = [[0.650, 0.072, 0.268], [0.704, 0.990, 0.570], [0.286, 0.105, 0.776]]
            const mat3 invStainMatrix = mat3(
                1.87798274, -1.00767869,  0.14539618,
               -0.06590806,  1.13473037, -0.13943433,
               -0.60190736, -0.48041808,  1.57358807
            );
            
            // Forward stain matrix for reconstruction
            const vec3 stainH = vec3(0.650, 0.704, 0.286);
            const vec3 stainE = vec3(0.072, 0.990, 0.105);
            const vec3 stainR = vec3(0.268, 0.570, 0.776);
            
            void main() {
                vec4 color = texture2D(u_image, v_texCoord);
                
                // Convert RGB to optical density
                // OD = -log10(I), where I is normalized [0,1]
                // Use max to avoid log(0)
                vec3 od = -log(max(color.rgb, 0.004)) / log(10.0);
                
                // Apply inverse stain matrix to get concentrations
                vec3 concentrations = invStainMatrix * od;
                
                // Clamp negative concentrations
                concentrations = max(concentrations, 0.0);
                
                // Apply user adjustments
                float cH = concentrations.x * u_hematoxylin;
                float cE = concentrations.y * u_eosin;
                float cR = concentrations.z;
                
                // Reconstruct based on view mode
                vec3 finalOD;
                if (u_viewMode == 1) {
                    // Hematoxylin only
                    finalOD = stainH * cH;
                } else if (u_viewMode == 2) {
                    // Eosin only
                    finalOD = stainE * cE;
                } else {
                    // Combined
                    finalOD = stainH * cH + stainE * cE + stainR * cR;
                }
                
                // Convert back from OD to RGB
                // I = 10^(-OD)
                vec3 finalRGB = pow(vec3(10.0), -finalOD);
                
                gl_FragColor = vec4(clamp(finalRGB, 0.0, 1.0), color.a);
            }
        `;
        
        // Compile shaders
        const vs = this._compileShader(gl, gl.VERTEX_SHADER, vsSource);
        const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
        
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
                hematoxylin: gl.getUniformLocation(program, 'u_hematoxylin'),
                eosin: gl.getUniformLocation(program, 'u_eosin'),
                viewMode: gl.getUniformLocation(program, 'u_viewMode'),
            },
            texture: gl.createTexture(),
        };
        
        console.log('🔬 WebGL stain shader compiled successfully');
    }
    
    /**
     * Compile a WebGL shader
     */
    _compileShader(gl, type, source) {
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
        if (!this.stainEnabled || !this.viewer || !this.stainCanvas) return;
        
        const sourceCanvas = this.viewer.drawer.canvas;
        if (!sourceCanvas || sourceCanvas.width === 0 || sourceCanvas.height === 0) return;
        
        // Resize overlay canvas
        if (this.stainCanvas.width !== sourceCanvas.width || 
            this.stainCanvas.height !== sourceCanvas.height) {
            this.stainCanvas.width = sourceCanvas.width;
            this.stainCanvas.height = sourceCanvas.height;
        }
        
        if (this.stainWebGL) {
            this._applyStainWebGL(sourceCanvas);
        } else {
            this._applyStainCPU(sourceCanvas);
        }
        
        this.stainCanvas.style.display = 'block';
    }
    
    /**
     * GPU-accelerated deconvolution via WebGL
     */
    _applyStainWebGL(sourceCanvas) {
        const { gl, program, posBuffer, texBuffer, posLoc, texLoc, uniforms, texture } = this.stainWebGL;
        
        gl.viewport(0, 0, this.stainCanvas.width, this.stainCanvas.height);
        gl.useProgram(program);
        
        // Upload source canvas as texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        } catch (e) {
            console.warn('🔬 Cannot upload canvas texture (CORS?):', e.message);
            return;
        }
        
        // Set uniforms
        gl.uniform1i(uniforms.image, 0);
        gl.uniform1f(uniforms.hematoxylin, this.stainParams.hematoxylin);
        gl.uniform1f(uniforms.eosin, this.stainParams.eosin);
        
        const viewModeMap = { 'combined': 0, 'hematoxylin': 1, 'eosin': 2 };
        gl.uniform1i(uniforms.viewMode, viewModeMap[this.stainParams.viewMode] || 0);
        
        // Set up attributes
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        gl.enableVertexAttribArray(texLoc);
        gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
        
        // Draw
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    
    /**
     * CPU fallback for deconvolution (slower but always works)
     */
    _applyStainCPU(sourceCanvas) {
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        
        const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        const destCtx = this.stainCanvas.getContext('2d');
        
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
        // Hide overlay canvas
        if (this.stainCanvas) {
            this.stainCanvas.style.display = 'none';
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
