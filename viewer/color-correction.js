/**
 * Color Correction for WSI Viewer with ICC Profile Support
 * Implements full color space transformation via WebGL
 */

class ColorCorrectionFilter {
    constructor(viewer) {
        this.viewer = viewer;
        this.enabled = false;
        this.iccEnabled = false;
        this.iccMode = null; // 'webgl' | 'css' | null
        
        // Color correction parameters
        this.params = {
            gamma: 1.0,
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
        };
        
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
        
        // WebGL for ICC transform
        this.gl = null;
        this.canvas = null;
        this.program = null;
        this.webglReady = false;
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
        
        // Build CSS filters
        const filters = [];
        
        const brightness = 1 + this.params.brightness;
        if (brightness !== 1) filters.push(`brightness(${brightness})`);
        if (this.params.contrast !== 1) filters.push(`contrast(${this.params.contrast})`);
        if (this.params.saturation !== 1) filters.push(`saturate(${this.params.saturation})`);
        
        if (this.params.gamma !== 1.0) {
            this.updateSvgGamma(this.params.gamma);
            filters.push('url(#gamma-correction)');
        }
        
        const filterString = filters.length > 0 ? filters.join(' ') : 'none';
        
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

        // Prefer full ICC via WebGL overlay when possible.
        // This uses backend-provided uniforms (per-channel gamma + 3x3 matrix) and avoids CSS gamma mismatch.
        if (this.webglReady && this.iccTransform.webgl) {
            this.iccMode = 'webgl';

            if (this.viewerElement) {
                // Ensure CSS filters aren't applied while the WebGL overlay is active
                this.viewerElement.classList.remove('gamma-correct', 'color-corrected');
                this.viewerElement.classList.add('icc-transform');
            }

            this._startICCRendering();
            // Ensure first paint happens promptly
            this._applyICCTransform();

            console.log('ICC color correction enabled (WebGL transform mode)');
            return true;
        }

        // Fallback: CSS-only mode (gamma + basic adjustments) when WebGL isn't available.
        // Note: This cannot apply the ICC matrix transform accurately.
        this.iccMode = 'css';

        // Extract gamma from ICC profile
        const transform = this.iccTransform.transform || this.iccTransform;
        const gamma = transform.gamma || { r: 2.2, g: 2.2, b: 2.2 };

        // Use average gamma for CSS filter (CSS doesn't support per-channel gamma easily)
        const avgGamma = (gamma.r + gamma.g + gamma.b) / 3;
        this.params.gamma = avgGamma;

        console.log(`ICC gamma extracted (CSS fallback): R=${gamma.r}, G=${gamma.g}, B=${gamma.b}, avg=${avgGamma}`);

        if (this.viewerElement) {
            this.viewerElement.classList.add('color-corrected');
            this.viewerElement.classList.remove('gamma-correct', 'icc-transform');
        }

        this.updateFilterStyles();
        console.log('ICC color correction enabled (CSS fallback mode)');
        return true;
    }
    
    disableICC() {
        this.iccEnabled = false;
        this.iccMode = null;

        // Stop WebGL overlay if it was running
        this._stopICCRendering();
        
        // Reset gamma to default
        this.params.gamma = 1.0;
        
        if (this.viewerElement) {
            this.viewerElement.classList.remove('color-corrected', 'icc-transform');
        }
        
        this.updateFilterStyles();
        
        console.log('ICC color correction disabled');
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
        if (!this.gl || !this.program || !this.viewer || !this.viewer.canvas) return;
        if (!this.overlayCanvas || !this.iccTransform) return;
        
        const sourceCanvas = this.viewer.canvas;
        const gl = this.gl;
        
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
        // In WebGL ICC mode, gamma slider isn't expected to be used (viewer disables ICC on manual gamma changes),
        // but if called, re-render to keep output consistent.
        if (this.iccEnabled && this.iccMode === 'webgl') this._applyICCTransform();
        else this.updateFilterStyles();
    }
    
    setBrightness(value) {
        this.params.brightness = value;
        if (this.iccEnabled) this._applyICCTransform();
        else this.updateFilterStyles();
    }
    
    setContrast(value) {
        this.params.contrast = value;
        if (this.iccEnabled) this._applyICCTransform();
        else this.updateFilterStyles();
    }
    
    setSaturation(value) {
        this.params.saturation = value;
        if (this.iccEnabled) this._applyICCTransform();
        else this.updateFilterStyles();
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
            webglReady: this.webglReady,
            hasICCData: !!this.iccTransform,
        };
    }
}

window.ColorCorrectionFilter = ColorCorrectionFilter;
