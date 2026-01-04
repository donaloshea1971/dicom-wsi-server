/**
 * Space Navigator Controller for OpenSeadragon
 * Integrates 3Dconnexion Space Navigator 6DOF input with WSI viewer
 * Uses WebHID API (Chromium browsers only, requires HTTPS)
 * @version 1.1.0
 */

const SPACEMOUSE_VERSION = '1.3.2';
console.log(`%c🎮 SpaceMouse module v${SPACEMOUSE_VERSION} loaded`, 'color: #6366f1');

class SpaceNavigatorController {
    constructor(viewer) {
        console.log('SpaceNavigatorController: CONSTRUCTOR CALLED');
        this.viewer = viewer;
        this.device = null;
        this.connected = false;
        this.animationFrame = null;
        
        // Accumulated input values (after deadzone/curve)
        this.input = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
        // Raw input values (before processing) for debug
        this._rawInput = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
        
        // Sensitivity settings - tuned for pathology viewing
        this.sensitivity = {
            pan: 0.8,         // Pan speed (divided by zoom for normalization) - increased to compensate for steep curve
            zoom: 0.002,      // Zoom speed (unused - now using snap zoom)
            rotation: 0.008   // Rotation speed
        };
        
        // Snap zoom cooldown - allows repeated snaps while held, but with delay
        this._lastZoomTime = 0;
        this._zoomRepeatDelay = 200;  // ms between repeated zoom snaps
        
        // Dead zone to prevent drift
        this.deadZone = 0.08;
        
        // Smoothing factor (0-1, higher = more responsive)
        this.smoothing = 0.3;
        
        // Debug mode for troubleshooting
        this.debugMode = false;
        this._debugLogInterval = null;
        this._lastDebugLog = 0;
        
        // Calibration data from localStorage
        this.calibration = this.loadCalibration();
        
        // Known 3Dconnexion vendor IDs
        this.vendorIds = [
            0x046d,  // Logitech (3Dconnexion)
            0x256f   // 3Dconnexion direct
        ];
        
        // Status callback
        this.onStatusChange = null;
    }

    /**
     * Check if WebHID is supported
     */
    static isSupported() {
        return 'hid' in navigator;
    }

    /**
     * Connect to Space Navigator device
     */
    async connect() {
        if (!SpaceNavigatorController.isSupported()) {
            console.warn('WebHID not supported in this browser');
            this.updateStatus('unsupported');
            return false;
        }

        try {
            // Request device with 3Dconnexion vendor IDs
            const filters = this.vendorIds.map(vendorId => ({ vendorId }));
            const devices = await navigator.hid.requestDevice({ filters });
            
            if (devices.length === 0) {
                console.log('No Space Navigator selected');
                this.updateStatus('cancelled');
                return false;
            }
            
            this.device = devices[0];
            await this.device.open();
            
            // Set up input handler
            this.device.addEventListener('inputreport', (e) => this.handleInput(e));
            
            // Start animation loop for smooth updates
            this.startAnimationLoop();
            
            this.connected = true;
            this.updateStatus('connected');
            console.log('%c🎮 Space Navigator connected', 'color: #10b981; font-weight: bold');
            console.log(`   Device: ${this.device.productName}`);
            console.log(`   Vendor: 0x${this.device.vendorId.toString(16)} Product: 0x${this.device.productId.toString(16)}`);
            console.log('%c   💡 Type: spaceNavController.toggleDebug() to see live input values', 'color: #888');
            
            // DISABLE OpenSeadragon scroll-to-zoom to prevent 3Dconnexion driver conflict
            if (this.viewer && this.viewer.innerTracker) {
                this._savedScrollHandler = this.viewer.innerTracker.scrollHandler;
                this.viewer.innerTracker.scrollHandler = false;
                console.log('SpaceMouse: Disabled OSD scroll-to-zoom');
            }
            
            return true;
        } catch (error) {
            console.error('Space Navigator connection failed:', error);
            this.updateStatus('error');
            return false;
        }
    }

    /**
     * Disconnect device
     */
    async disconnect() {
        this.stopAnimationLoop();
        
        // RE-ENABLE OpenSeadragon scroll-to-zoom
        if (this.viewer && this.viewer.innerTracker && this._savedScrollHandler !== undefined) {
            this.viewer.innerTracker.scrollHandler = this._savedScrollHandler;
            console.log('SpaceMouse: Restored OSD scroll-to-zoom');
        }
        
        if (this.device) {
            try {
                await this.device.close();
            } catch (e) {
                console.warn('Error closing device:', e);
            }
            this.device = null;
        }
        
        this.connected = false;
        this.updateStatus('disconnected');
    }

    /**
     * Handle raw input from device
     * Parsing logic based on tested implementation from Deciphex SpaceMouse demo
     */
    handleInput(event) {
        const bytes = new Uint8Array(event.data.buffer);
        const reportId = event.reportId;
        const length = bytes.length;
        
        // Debug logging if enabled
        if (this.debugMode) {
            console.log(`SpaceMouse Report ${reportId} (${length} bytes):`, 
                Array.from(bytes).map((b, i) => `[${i}]:${b.toString(16).padStart(2, '0')}`).join(' '));
        }
        
        if (length >= 12) {
            // SpaceMouse Wireless format: 6 int16 values starting at byte 0
            if (reportId === 1) {
                this._rawInput.tx = this.readInt16LEraw(bytes, 0);
                this._rawInput.ty = this.readInt16LEraw(bytes, 2);
                this._rawInput.tz = this.readInt16LEraw(bytes, 4);
                this._rawInput.rx = this.readInt16LEraw(bytes, 6);
                this._rawInput.ry = this.readInt16LEraw(bytes, 8);
                this._rawInput.rz = this.readInt16LEraw(bytes, 10);
                
                this.input.tx = this.applyDeadzone(this._rawInput.tx);
                this.input.ty = this.applyDeadzone(this._rawInput.ty);
                this.input.tz = this.applyDeadzone(this._rawInput.tz);
                this.input.rx = this.applyDeadzone(this._rawInput.rx);
                this.input.ry = this.applyDeadzone(this._rawInput.ry);
                this.input.rz = this.applyDeadzone(this._rawInput.rz);
            }
            
            // Some models send rotation separately even with 12+ byte reports
            if (reportId === 2) {
                this._rawInput.rx = this.readInt16LEraw(bytes, 0);
                this._rawInput.ry = this.readInt16LEraw(bytes, 2);
                this._rawInput.rz = this.readInt16LEraw(bytes, 4);
                
                this.input.rx = this.applyDeadzone(this._rawInput.rx);
                this.input.ry = this.applyDeadzone(this._rawInput.ry);
                this.input.rz = this.applyDeadzone(this._rawInput.rz);
            }

            // Some wireless models use report ID 3
            if (reportId === 3) {
                this._rawInput.tx = this.readInt16LEraw(bytes, 0);
                this._rawInput.ty = this.readInt16LEraw(bytes, 2);
                this._rawInput.tz = this.readInt16LEraw(bytes, 4);
                this._rawInput.rx = this.readInt16LEraw(bytes, 6);
                this._rawInput.ry = this.readInt16LEraw(bytes, 8);
                this._rawInput.rz = this.readInt16LEraw(bytes, 10);
                
                this.input.tx = this.applyDeadzone(this._rawInput.tx);
                this.input.ty = this.applyDeadzone(this._rawInput.ty);
                this.input.tz = this.applyDeadzone(this._rawInput.tz);
                this.input.rx = this.applyDeadzone(this._rawInput.rx);
                this.input.ry = this.applyDeadzone(this._rawInput.ry);
                this.input.rz = this.applyDeadzone(this._rawInput.rz);
            }
        } else if (length >= 7) {
            // Older SpaceNavigator format: data starts at byte 1
            if (reportId === 1) {
                this._rawInput.tx = this.readInt16LEraw(bytes, 1);
                this._rawInput.ty = this.readInt16LEraw(bytes, 3);
                this._rawInput.tz = this.readInt16LEraw(bytes, 5);
                
                this.input.tx = this.applyDeadzone(this._rawInput.tx);
                this.input.ty = this.applyDeadzone(this._rawInput.ty);
                this.input.tz = this.applyDeadzone(this._rawInput.tz);
            }
            
            if (reportId === 2) {
                this._rawInput.rx = this.readInt16LEraw(bytes, 1);
                this._rawInput.ry = this.readInt16LEraw(bytes, 3);
                this._rawInput.rz = this.readInt16LEraw(bytes, 5);
                
                this.input.rx = this.applyDeadzone(this._rawInput.rx);
                this.input.ry = this.applyDeadzone(this._rawInput.ry);
                this.input.rz = this.applyDeadzone(this._rawInput.rz);
            }
        }
        
        // Report ID 3 with < 12 bytes is typically button data
        // Could add button support here if needed
    }
    
    /**
     * Read little-endian signed 16-bit integer from byte array (RAW - no processing)
     */
    readInt16LEraw(bytes, offset) {
        if (offset + 1 >= bytes.length) return 0;
        
        // Read little-endian 16-bit integer
        let value = bytes[offset] | (bytes[offset + 1] << 8);
        
        // Convert to signed integer
        if (value > 32767) {
            value = value - 65536;
        }
        
        return value;
    }
    
    /**
     * Apply deadzone and steep exponential curve
     * Subtle inputs = almost no movement, hard push = rapid acceleration to max
     */
    applyDeadzone(value) {
        const threshold = this.deadZone * 350; // Scale to raw value range (~28 with 0.08 deadzone)
        
        if (Math.abs(value) < threshold) {
            return 0;  // Dead zone - no movement
        }
        
        // Normalize to 0-1 range (after removing deadzone)
        const maxValue = 350;
        const sign = value > 0 ? 1 : -1;
        const absValue = Math.abs(value);
        
        // Map from deadzone-maxValue to 0-1
        const normalized = (absValue - threshold) / (maxValue - threshold);
        
        // Steep exponential curve: power 3.0
        // This makes subtle inputs nearly imperceptible, 
        // while hard pushes accelerate dramatically
        // Input 25% → Output ~1.5%
        // Input 50% → Output ~12.5%
        // Input 75% → Output ~42%
        // Input 100% → Output 100%
        const curved = Math.pow(normalized, 3.0);
        
        return sign * curved;  // Returns ~0 to ~1 (or ~-1)
    }

    /**
     * Start animation loop for smooth viewport updates
     */
    startAnimationLoop() {
        const update = () => {
            // STRICT CHECK: Must have device, be connected, and have viewer
            if (!this.device || !this.connected || !this.viewer) {
                console.log('SpaceMouse: Animation loop stopped (not connected)');
                this.animationFrame = null;
                return;
            }
            
            this.updateViewport();
            this.animationFrame = requestAnimationFrame(update);
        };
        
        this.animationFrame = requestAnimationFrame(update);
    }

    /**
     * Stop animation loop
     */
    stopAnimationLoop() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    /**
     * Apply input to OpenSeadragon viewport
     * Uses calibration data if available, otherwise uses defaults:
     *   TX/TY (pan left/right/up/down) → Viewport pan
     *   TZ (push/pull) → Reserved for MFP/Z-stack (not used in 2D)
     *   RZ (twist left/right) → Zoom in/out
     */
    updateViewport() {
        // GUARD: Only run if fully connected
        if (!this.device || !this.connected || !this.viewer) {
            return;
        }
        
        const viewport = this.viewer.viewport;
        
        // Get mapped values using calibration or defaults
        const mapped = this.getMappedInput();
        const raw = this.input;
        
        // Check if any input is active (using raw values to catch any signal)
        const hasRawInput = Math.abs(raw.tx) > 0.01 || Math.abs(raw.ty) > 0.01 || 
                            Math.abs(raw.tz) > 0.01 || Math.abs(raw.rx) > 0.01 || 
                            Math.abs(raw.ry) > 0.01 || Math.abs(raw.rz) > 0.01;
        
        // Debug logging (throttled to every 300ms) - ALWAYS logs when debug on
        if (this.debugMode) {
            const now = Date.now();
            if (now - this._lastDebugLog > 300) {
                // Show raw values before any processing
                const rawTX = this._rawInput?.tx || 0;
                const rawTY = this._rawInput?.ty || 0;
                const rawTZ = this._rawInput?.tz || 0;
                const rawRX = this._rawInput?.rx || 0;
                const rawRY = this._rawInput?.ry || 0;
                const rawRZ = this._rawInput?.rz || 0;
                
                console.log(`%c🎮 SpaceMouse`, 'color: #10b981; font-weight: bold',
                    `TX:${rawTX.toString().padStart(4)} TY:${rawTY.toString().padStart(4)} TZ:${rawTZ.toString().padStart(4)} | ` +
                    `RX:${rawRX.toString().padStart(4)} RY:${rawRY.toString().padStart(4)} RZ:${rawRZ.toString().padStart(4)} | ` +
                    `pan:(${mapped.panX.toFixed(2)},${mapped.panY.toFixed(2)}) zoom:${mapped.zoom.toFixed(2)}`
                );
                this._lastDebugLog = now;
            }
        }
        
        // Check if any MAPPED input is active (after exponential curve)
        const hasInput = Math.abs(mapped.panX) > 0 || Math.abs(mapped.panY) > 0 || 
                         Math.abs(mapped.zoom) > 0;
        
        if (!hasInput) return;
        
        // Pan - scale by zoom level for consistent apparent speed
        if (Math.abs(mapped.panX) > 0 || Math.abs(mapped.panY) > 0) {
            const currentZoom = viewport.getZoom();
            // Divide by zoom so panning feels the same at all magnifications
            const panFactor = this.sensitivity.pan / currentZoom;
            
            const delta = new OpenSeadragon.Point(
                mapped.panX * panFactor,
                mapped.panY * panFactor
            );
            viewport.panBy(delta, false);
        }
        
        // Zoom - SNAP mode using RAW RZ value
        // RZ > 300 = zoom in 2x, RZ < -300 = zoom out 0.5x
        // Allows repeated snaps while held (with small delay)
        const rawRZ = raw.rz * 350;  // Convert back to raw scale (~-350 to +350)
        const now = Date.now();
        
        if (rawRZ > 300 && (now - this._lastZoomTime) > this._zoomRepeatDelay) {
            // Twist RIGHT - zoom IN (2x)
            console.log('SpaceMouse SNAP ZOOM: 2x (in), rawRZ:', rawRZ.toFixed(0));
            viewport.zoomBy(2, viewport.getCenter(), false);
            this._lastZoomTime = now;
        } 
        else if (rawRZ < -300 && (now - this._lastZoomTime) > this._zoomRepeatDelay) {
            // Twist LEFT - zoom OUT (0.5x)
            console.log('SpaceMouse SNAP ZOOM: 0.5x (out), rawRZ:', rawRZ.toFixed(0));
            viewport.zoomBy(0.5, viewport.getCenter(), false);
            this._lastZoomTime = now;
        }
        
        // Apply changes
        viewport.applyConstraints();
    }
    
    /**
     * Map raw input to viewport actions
     * Uses ONLY translation axes for panning (RX/RY are tilt artifacts):
     *   - TX → Pan X (left/right) - horizontal puck movement
     *   - TY → Pan Y (forward/back) - vertical puck movement  
     *   - RZ → Zoom (twist ONLY)
     *   - TZ, RX, RY → Ignored (TZ reserved for MFP, RX/RY are tilt noise)
     * Returns: { panX, panY, zoom }
     */
    getMappedInput() {
        const raw = this.input;
        
        // Use ONLY translation axes - RX/RY are tilt that accompanies translation
        // and causes unwanted diagonal movement
        let panX = raw.tx;   // Horizontal puck movement
        let panY = raw.ty;   // Forward/back puck movement
        const zoom = raw.rz; // Twist ONLY
        
        // Apply polarity from calibration if available
        if (this.calibration && this.calibration.mappings) {
            const mappings = this.calibration.mappings;
            
            const getSign = (action) => {
                const m = mappings.find(m => m.action === action);
                return m ? (m.value > 0 ? 1 : -1) : 0;
            };
            
            const panLeftSign = getSign('PAN_LEFT');
            const pushAwaySign = getSign('PUSH_AWAY');
            const twistRightSign = getSign('TWIST_RIGHT');
            
            // Apply direction corrections
            panX = panX * (panLeftSign ? -panLeftSign : -1);
            panY = panY * (pushAwaySign ? -pushAwaySign : -1);
            
            return {
                panX,
                panY,
                zoom: zoom * (twistRightSign ? twistRightSign : 1)
            };
        }
        
        // Default polarities (no calibration)
        return {
            panX: -panX,
            panY: -panY,
            zoom
        };
    }

    /**
     * Update status callback
     */
    updateStatus(status) {
        if (this.onStatusChange) {
            this.onStatusChange(status);
        }
    }

    /**
     * Update the viewer reference (for when viewer is recreated on study switch)
     */
    setViewer(newViewer) {
        this.viewer = newViewer;
        console.log('SpaceMouse: Viewer reference updated');
        
        // Re-disable scroll-to-zoom on new viewer
        if (this.connected && this.viewer && this.viewer.innerTracker) {
            this.viewer.innerTracker.scrollHandler = false;
        }
    }
    
    /**
     * Adjust sensitivity
     */
    setSensitivity(type, value) {
        if (this.sensitivity.hasOwnProperty(type)) {
            this.sensitivity[type] = value;
        }
    }

    /**
     * Get current settings
     */
    getSettings() {
        return {
            sensitivity: { ...this.sensitivity },
            deadZone: this.deadZone,
            smoothing: this.smoothing
        };
    }

    /**
     * Apply settings
     */
    applySettings(settings) {
        if (settings.sensitivity) {
            Object.assign(this.sensitivity, settings.sensitivity);
        }
        if (settings.deadZone !== undefined) {
            this.deadZone = settings.deadZone;
        }
        if (settings.smoothing !== undefined) {
            this.smoothing = settings.smoothing;
        }
    }
    
    /**
     * Toggle debug mode for troubleshooting
     * When ON: Shows raw inputs, mapped values, and zoom threshold status
     */
    toggleDebug() {
        this.debugMode = !this.debugMode;
        if (this.debugMode) {
            console.log('%c🎮 SpaceMouse DEBUG MODE: ON', 'color: #10b981; font-weight: bold; font-size: 14px');
            console.log('%cMove the SpaceMouse to see live values. Zoom triggers when |rawRZ| > 300', 'color: #888');
            console.log('%cType: spaceNavController.toggleDebug() to turn OFF', 'color: #888');
        } else {
            console.log('%c🎮 SpaceMouse DEBUG MODE: OFF', 'color: #ef4444; font-weight: bold');
        }
        return this.debugMode;
    }
    
    /**
     * Get device info for debugging
     */
    getDeviceInfo() {
        if (!this.device) return null;
        return {
            productName: this.device.productName,
            vendorId: '0x' + this.device.vendorId.toString(16),
            productId: '0x' + this.device.productId.toString(16),
            connected: this.connected,
            hasCalibration: !!this.calibration
        };
    }
    
    /**
     * Load calibration data from localStorage
     */
    loadCalibration() {
        try {
            const saved = localStorage.getItem('spacemouse_calibration');
            if (saved) {
                const config = JSON.parse(saved);
                console.log('SpaceMouse calibration loaded:', config.deviceName, new Date(config.timestamp).toLocaleDateString());
                return config;
            }
        } catch (e) {
            console.warn('Failed to load SpaceMouse calibration:', e);
        }
        return null;
    }
    
    /**
     * Check if device is calibrated
     */
    isCalibrated() {
        return !!this.calibration;
    }
    
    /**
     * Get calibration info
     */
    getCalibrationInfo() {
        if (!this.calibration) return null;
        return {
            deviceName: this.calibration.deviceName,
            timestamp: this.calibration.timestamp,
            mappings: this.calibration.mappings
        };
    }
    
    /**
     * Open calibration page
     */
    static openCalibrationPage() {
        window.open('/spacemouse-calibration.html', '_blank');
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SpaceNavigatorController;
}
