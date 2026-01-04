/**
 * Space Navigator Controller for OpenSeadragon
 * Integrates 3Dconnexion Space Navigator 6DOF input with WSI viewer
 * Uses WebHID API (Chromium browsers only, requires HTTPS)
 */

class SpaceNavigatorController {
    constructor(viewer) {
        this.viewer = viewer;
        this.device = null;
        this.connected = false;
        this.animationFrame = null;
        
        // Accumulated input values (smoothed)
        this.input = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
        
        // Sensitivity settings - tuned for pathology viewing
        this.sensitivity = {
            pan: 0.0015,      // Pan speed
            zoom: 0.0008,     // Zoom speed
            rotation: 0.008   // Rotation speed
        };
        
        // Dead zone to prevent drift
        this.deadZone = 0.08;
        
        // Smoothing factor (0-1, higher = more responsive)
        this.smoothing = 0.3;
        
        // Debug mode for troubleshooting
        this.debugMode = false;
        
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
            console.log('Space Navigator connected:', this.device.productName);
            
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
                this.input.tx = this.readInt16LE(bytes, 0);
                this.input.ty = this.readInt16LE(bytes, 2);
                this.input.tz = this.readInt16LE(bytes, 4);
                this.input.rx = this.readInt16LE(bytes, 6);
                this.input.ry = this.readInt16LE(bytes, 8);
                this.input.rz = this.readInt16LE(bytes, 10);
            }
            
            // Some models send rotation separately even with 12+ byte reports
            if (reportId === 2) {
                this.input.rx = this.readInt16LE(bytes, 0);
                this.input.ry = this.readInt16LE(bytes, 2);
                this.input.rz = this.readInt16LE(bytes, 4);
            }

            // Some wireless models use report ID 3
            if (reportId === 3) {
                this.input.tx = this.readInt16LE(bytes, 0);
                this.input.ty = this.readInt16LE(bytes, 2);
                this.input.tz = this.readInt16LE(bytes, 4);
                this.input.rx = this.readInt16LE(bytes, 6);
                this.input.ry = this.readInt16LE(bytes, 8);
                this.input.rz = this.readInt16LE(bytes, 10);
            }
        } else if (length >= 7) {
            // Older SpaceNavigator format: data starts at byte 1
            if (reportId === 1) {
                this.input.tx = this.readInt16LE(bytes, 1);
                this.input.ty = this.readInt16LE(bytes, 3);
                this.input.tz = this.readInt16LE(bytes, 5);
            }
            
            if (reportId === 2) {
                this.input.rx = this.readInt16LE(bytes, 1);
                this.input.ry = this.readInt16LE(bytes, 3);
                this.input.rz = this.readInt16LE(bytes, 5);
            }
        }
        
        // Report ID 3 with < 12 bytes is typically button data
        // Could add button support here if needed
    }
    
    /**
     * Read little-endian signed 16-bit integer from byte array
     */
    readInt16LE(bytes, offset) {
        if (offset + 1 >= bytes.length) return 0;
        
        // Read little-endian 16-bit integer
        let value = bytes[offset] | (bytes[offset + 1] << 8);
        
        // Convert to signed integer
        if (value > 32767) {
            value = value - 65536;
        }
        
        return this.applyDeadzone(value);
    }
    
    /**
     * Apply deadzone to filter noise
     */
    applyDeadzone(value) {
        const threshold = this.deadZone * 350; // Scale to raw value range
        return Math.abs(value) < threshold ? 0 : value / 350.0; // Normalize to ~-1 to 1
    }

    /**
     * Start animation loop for smooth viewport updates
     */
    startAnimationLoop() {
        const update = () => {
            if (!this.connected || !this.viewer) {
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
        const viewport = this.viewer.viewport;
        
        // Get mapped values using calibration or defaults
        const mapped = this.getMappedInput();
        
        // Check if any input is active
        const hasInput = Math.abs(mapped.panX) > 0 || Math.abs(mapped.panY) > 0 || 
                         Math.abs(mapped.zoom) > 0;
        
        if (!hasInput) return;
        
        // Pan
        if (Math.abs(mapped.panX) > 0 || Math.abs(mapped.panY) > 0) {
            const currentZoom = viewport.getZoom();
            const panFactor = this.sensitivity.pan / Math.sqrt(currentZoom);
            
            const delta = new OpenSeadragon.Point(
                mapped.panX * panFactor,
                mapped.panY * panFactor
            );
            viewport.panBy(delta, false);
        }
        
        // Zoom (from twist)
        if (Math.abs(mapped.zoom) > 0) {
            const zoomFactor = 1 + (mapped.zoom * this.sensitivity.zoom);
            viewport.zoomBy(zoomFactor, viewport.getCenter(), false);
        }
        
        // Apply changes
        viewport.applyConstraints();
    }
    
    /**
     * Map raw input to viewport actions using calibration data
     * Returns: { panX, panY, zoom }
     */
    getMappedInput() {
        const raw = this.input;
        
        // If we have calibration, use it to determine which raw axis maps to which action
        if (this.calibration && this.calibration.mappings) {
            const mappings = this.calibration.mappings;
            
            // Helper to get axis and polarity for an action
            const getMapping = (action) => {
                const m = mappings.find(m => m.action === action);
                return m ? { axis: m.axis, sign: m.value > 0 ? 1 : -1 } : null;
            };
            
            // Get calibration for each action
            const panLeft = getMapping('PAN_LEFT');
            const panRight = getMapping('PAN_RIGHT');
            const panUp = getMapping('PAN_UP');
            const panDown = getMapping('PAN_DOWN');
            const twistLeft = getMapping('TWIST_LEFT');
            const twistRight = getMapping('TWIST_RIGHT');
            
            // Determine axes
            const panXAxis = (panLeft || panRight)?.axis || 'tx';
            const panYAxis = (panUp || panDown)?.axis || 'ty';
            const zoomAxis = (twistLeft || twistRight)?.axis || 'rz';
            
            // Get raw values
            const rawPanX = raw[panXAxis] || 0;
            const rawPanY = raw[panYAxis] || 0;
            const rawZoom = raw[zoomAxis] || 0;
            
            // Apply polarity correction based on calibration
            // PAN_LEFT should result in negative panX (move viewport left)
            // PAN_RIGHT should result in positive panX
            // If PAN_LEFT was positive during calibration, we need to invert
            const panXSign = panLeft ? -panLeft.sign : (panRight ? panRight.sign : -1);
            
            // PAN_UP should result in negative panY (move viewport up)
            // PAN_DOWN should result in positive panY
            const panYSign = panUp ? -panUp.sign : (panDown ? panDown.sign : -1);
            
            // TWIST_RIGHT (clockwise) should zoom in (positive)
            // TWIST_LEFT (counter-clockwise) should zoom out (negative)
            const zoomSign = twistRight ? twistRight.sign : (twistLeft ? -twistLeft.sign : 1);
            
            return {
                panX: rawPanX * panXSign,
                panY: rawPanY * panYSign,
                zoom: rawZoom * zoomSign
            };
        }
        
        // Default mapping (no calibration)
        return {
            panX: -raw.tx,
            panY: -raw.ty,
            zoom: raw.rz
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
     */
    toggleDebug() {
        this.debugMode = !this.debugMode;
        console.log(`SpaceMouse debug mode: ${this.debugMode ? 'ON' : 'OFF'}`);
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
