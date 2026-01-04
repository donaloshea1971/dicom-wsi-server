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
     */
    handleInput(event) {
        const data = new DataView(event.data.buffer);
        const bytes = new Uint8Array(event.data.buffer);
        const reportId = event.reportId;
        const length = bytes.length;
        
        // SpaceMouse Wireless format (0x256f): Report ID 1, 12 bytes, all axes at offset 0
        if (reportId === 1 && length >= 12) {
            this.input.tx = this.readInt16LE(bytes, 0);
            this.input.ty = this.readInt16LE(bytes, 2);
            this.input.tz = this.readInt16LE(bytes, 4);
            this.input.rx = this.readInt16LE(bytes, 6);
            this.input.ry = this.readInt16LE(bytes, 8);
            this.input.rz = this.readInt16LE(bytes, 10);
        }
        // Older SpaceNavigator format: Report ID 1/2, 7 bytes, data at offset 1
        else if (reportId === 1 && length >= 7) {
            // Translation data (X, Y, Z) - starts at byte 1
            this.input.tx = this.readInt16LE(bytes, 1);
            this.input.ty = this.readInt16LE(bytes, 3);
            this.input.tz = this.readInt16LE(bytes, 5);
        } 
        else if (reportId === 2 && length >= 7) {
            // Rotation data (Rx, Ry, Rz) - starts at byte 1
            this.input.rx = this.readInt16LE(bytes, 1);
            this.input.ry = this.readInt16LE(bytes, 3);
            this.input.rz = this.readInt16LE(bytes, 5);
        }
        else if (reportId === 3) {
            // Button data - could add button support here
            // const buttons = bytes[0];
        }
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
     */
    updateViewport() {
        const { tx, ty, tz, rz } = this.input;
        const viewport = this.viewer.viewport;
        
        // Check if any input is active
        const hasInput = Math.abs(tx) > 0 || Math.abs(ty) > 0 || 
                         Math.abs(tz) > 0 || Math.abs(rz) > 0;
        
        if (!hasInput) return;
        
        // Pan (X/Y translation)
        // Note: ty is inverted for natural feel (push forward = move up)
        if (Math.abs(tx) > 0 || Math.abs(ty) > 0) {
            const currentZoom = viewport.getZoom();
            const panFactor = this.sensitivity.pan / Math.sqrt(currentZoom);
            
            const delta = new OpenSeadragon.Point(
                -tx * panFactor,
                -ty * panFactor
            );
            viewport.panBy(delta, false);
        }
        
        // Zoom (Z translation - push/pull)
        if (Math.abs(tz) > 0) {
            const zoomFactor = 1 + (tz * this.sensitivity.zoom);
            viewport.zoomBy(zoomFactor, viewport.getCenter(), false);
        }
        
        // Rotation (Z rotation - twist)
        if (Math.abs(rz) > 0 && typeof viewport.setRotation === 'function') {
            const currentRotation = viewport.getRotation();
            viewport.setRotation(currentRotation + (rz * this.sensitivity.rotation), false);
        }
        
        // Apply changes
        viewport.applyConstraints();
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
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SpaceNavigatorController;
}
