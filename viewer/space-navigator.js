/**
 * Space Navigator Controller for OpenSeadragon
 * Integrates 3Dconnexion Space Navigator 6DOF input with WSI viewer
 * Uses WebHID API (Chromium browsers only, requires HTTPS)
 * @version 1.1.0
 */

const SPACEMOUSE_VERSION = '1.9.3';
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
        // Simple moving average buffer for raw input
        this._inputHistory = [];
        this._historySize = 15;  // Configurable: average last N samples
        // Smoothed output values
        this._smoothedPan = { x: 0, y: 0 };
        
        // Momentum/inertia for smooth deceleration
        this._velocity = { x: 0, y: 0 };
        this._momentumDecay = 0.92;  // Decay factor per frame (~60fps = ~1 second to stop)
        this._hasActiveInput = false;
        
        // Configurable parameters (can be adjusted via config panel)
        this._curvePower = 2.0;   // Exponential curve power
        this._invertX = true;     // Invert X axis (push left = pan left)
        this._invertY = true;     // Invert Y axis (push forward = pan up)
        
        // Tilt handling mode: how to handle inadvertent tilt (RX/RY) while panning
        // 'translation_only' - ignore tilt, use only TX/TY (old behavior)
        // 'max_signal' - use stronger of translation OR tilt for each axis
        // 'tilt_assist' - tilt reinforces translation when same direction (recommended)
        this._tiltMode = 'tilt_assist';
        this._tiltWeight = 0.6;   // How much tilt contributes (0-1, for max_signal blending)
        
        // Sensitivity settings - tuned for pathology viewing
        this.sensitivity = {
            pan: 0.1,         // Pan speed (divided by zoom for normalization)
            zoom: 0.002,      // Zoom speed (unused - now using snap zoom)
            rotation: 0.008   // Rotation speed
        };
        
        // Snap zoom cooldown - allows repeated snaps while held, but with delay
        this._lastZoomTime = 0;
        this._zoomRepeatDelay = 200;  // ms between repeated zoom snaps
        
        // Dead zone to prevent drift
        this.deadZone = 0.15;
        
        // Smoothing factor (0-1, higher = more responsive, lower = smoother)
        this.smoothing = 0.1;  // Output smoothing (in addition to history averaging)
        
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
        
        // Crosshair element
        this._crosshair = null;
        this._crosshairVisible = true;  // Show by default when connected
        
        // Button states
        this.buttons = {
            left: false,
            right: false
        };
        this._lastButtonState = 0;
        
        // Button callbacks
        this.onButtonPress = null;   // Called with { button: 'left'|'right', pressed: true|false }
        
        // Event suppression handlers (to block 3Dconnexion driver popups)
        this._suppressHandlers = null;
    }

    /**
     * Check if WebHID is supported
     */
    static isSupported() {
        return 'hid' in navigator;
    }

    /**
     * Try to auto-connect to a previously paired SpaceMouse
     * Returns true if connected, false if no device found
     */
    async autoConnect() {
        if (!SpaceNavigatorController.isSupported()) {
            return false;
        }

        try {
            // Get devices that user has previously granted permission to
            const devices = await navigator.hid.getDevices();
            
            // Find a 3Dconnexion device
            const spaceMouse = devices.find(d => 
                this.vendorIds.includes(d.vendorId)
            );
            
            if (spaceMouse) {
                console.log('%c🎮 SpaceMouse auto-connecting...', 'color: #10b981');
                this.device = spaceMouse;
                
                if (!this.device.opened) {
                    await this.device.open();
                }
                
                // Set up input handler
                this.device.addEventListener('inputreport', (e) => this.handleInput(e));
                
                // Start animation loop
                this.startAnimationLoop();
                
                this.connected = true;
                this.updateStatus('connected');
                
                // Disable OSD scroll-to-zoom when SpaceMouse is active
                if (this.viewer) {
                    this.viewer.mouseNavEnabled = false;
                }
                
                // Show crosshair
                this.showCrosshair();
                
                // Suppress 3Dconnexion driver default actions
                this.enableEventSuppression();
                
                console.log('%c🎮 SpaceMouse auto-connected!', 'color: #10b981; font-weight: bold');
                console.log(`Device: ${this.device.productName}`);
                
                // Apply debug mode if it was enabled
                if (typeof window !== 'undefined' && window._spaceMouseDebugEnabled) {
                    this.debugMode = true;
                }
                
                return true;
            }
            
            return false;
        } catch (err) {
            console.log('SpaceMouse auto-connect failed:', err.message);
            return false;
        }
    }

    /**
     * Connect to Space Navigator device (with user gesture/picker)
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
            
            // Show crosshair
            this.showCrosshair();
            
            // DISABLE OpenSeadragon scroll-to-zoom to prevent 3Dconnexion driver conflict
            if (this.viewer && this.viewer.innerTracker) {
                this._savedScrollHandler = this.viewer.innerTracker.scrollHandler;
                this.viewer.innerTracker.scrollHandler = false;
                console.log('SpaceMouse: Disabled OSD scroll-to-zoom');
            }
            
            // Suppress 3Dconnexion driver default actions (menus, shortcuts)
            this.enableEventSuppression();
            
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
        
        // Hide crosshair
        this.hideCrosshair();
        
        // Remove event suppression
        this.disableEventSuppression();
        
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
        
        // Button handling - SpaceMouse Wireless sends buttons on Report 3 with 12 bytes
        // where byte[0] is button state and rest are zeros
        // Detect: if Report 3, length 12, and bytes 1-11 are all zero, it's a button report
        if (reportId === 3 && length === 12) {
            let isButtonReport = true;
            for (let i = 1; i < 12; i++) {
                if (bytes[i] !== 0) {
                    isButtonReport = false;
                    break;
                }
            }
            if (isButtonReport && bytes[0] <= 3) {  // Button values: 0, 1, 2, or 3 (both)
                this.handleButtons(bytes[0]);
            }
        }
        
        // Short button reports (other models)
        if ((reportId === 3 && length < 12) || reportId === 0) {
            this.handleButtons(bytes[0]);
        }
        
        // Some devices send buttons on report ID 21 or others
        if (reportId === 21 || reportId === 22 || reportId === 23) {
            this.handleButtons(bytes[0]);
        }
    }
    
    /**
     * Handle button state changes
     */
    handleButtons(buttonByte) {
        const leftPressed = (buttonByte & 0x01) !== 0;
        const rightPressed = (buttonByte & 0x02) !== 0;
        
        // Detect changes
        if (leftPressed !== this.buttons.left) {
            this.buttons.left = leftPressed;
            console.log(`%c🎮 SpaceMouse LEFT button ${leftPressed ? 'PRESSED' : 'released'}`, 
                        leftPressed ? 'color: #10b981; font-weight: bold' : 'color: #666');
            
            if (this.onButtonPress) {
                this.onButtonPress({ button: 'left', pressed: leftPressed });
            }
            
            // Default action: Previous study on left button press
            if (leftPressed && typeof window.previousStudy === 'function') {
                window.previousStudy();
            }
        }
        
        if (rightPressed !== this.buttons.right) {
            this.buttons.right = rightPressed;
            console.log(`%c🎮 SpaceMouse RIGHT button ${rightPressed ? 'PRESSED' : 'released'}`, 
                        rightPressed ? 'color: #10b981; font-weight: bold' : 'color: #666');
            
            if (this.onButtonPress) {
                this.onButtonPress({ button: 'right', pressed: rightPressed });
            }
            
            // Default action: Next study on right button press
            if (rightPressed && typeof window.nextStudy === 'function') {
                window.nextStudy();
            }
        }
        
        this._lastButtonState = buttonByte;
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
        
        // Steep exponential curve (configurable power)
        // This makes subtle inputs nearly imperceptible, 
        // while hard pushes accelerate dramatically
        const power = this._curvePower || 3.0;
        const curved = Math.pow(normalized, power);
        
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
        
        // Check if any PAN input is active (after exponential curve)
        const hasPanInput = Math.abs(mapped.panX) > 0.001 || Math.abs(mapped.panY) > 0.001;
        
        // Pan with momentum - scale by zoom level for consistent apparent speed
        const currentZoom = viewport.getZoom();
        const panFactor = this.sensitivity.pan / currentZoom;
        
        if (hasPanInput) {
            // Active input: calculate target and smooth
            const targetX = mapped.panX * panFactor;
            const targetY = mapped.panY * panFactor;
            
            // Apply smoothing (exponential moving average) for fluid diagonal motion
            this._smoothedPan.x = this._smoothedPan.x * (1 - this.smoothing) + targetX * this.smoothing;
            this._smoothedPan.y = this._smoothedPan.y * (1 - this.smoothing) + targetY * this.smoothing;
            
            // Store velocity for momentum
            this._velocity.x = this._smoothedPan.x;
            this._velocity.y = this._smoothedPan.y;
            this._hasActiveInput = true;
            
        } else if (this._hasActiveInput || Math.abs(this._velocity.x) > 0.0001 || Math.abs(this._velocity.y) > 0.0001) {
            // No input but we have momentum - apply decay
            this._velocity.x *= this._momentumDecay;
            this._velocity.y *= this._momentumDecay;
            this._smoothedPan.x = this._velocity.x;
            this._smoothedPan.y = this._velocity.y;
            this._hasActiveInput = false;
            
            // Stop when velocity is negligible
            if (Math.abs(this._velocity.x) < 0.0001 && Math.abs(this._velocity.y) < 0.0001) {
                this._velocity.x = 0;
                this._velocity.y = 0;
                this._smoothedPan.x = 0;
                this._smoothedPan.y = 0;
            }
        }
        
        // Apply pan if there's any motion
        if (Math.abs(this._smoothedPan.x) > 0.00001 || Math.abs(this._smoothedPan.y) > 0.00001) {
            const delta = new OpenSeadragon.Point(this._smoothedPan.x, this._smoothedPan.y);
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
     * Map raw input to viewport actions with smart tilt handling
     * 
     * Translation axes (TX/TY): Primary pan input from pushing/pulling the puck
     * Rotation axes (RX/RY): Tilt input - often happens inadvertently while panning
     * 
     * Tilt modes:
     *   - 'translation_only': Ignore tilt, use only TX/TY (cleanest but loses input)
     *   - 'max_signal': Use stronger of translation OR tilt for each axis
     *   - 'tilt_assist': Tilt reinforces translation when same direction (recommended)
     * 
     * Returns: { panX, panY, zoom }
     */
    getMappedInput() {
        const raw = this.input;
        
        // Add current sample to history (now including tilt values)
        this._inputHistory.push({ 
            tx: raw.tx, ty: raw.ty,
            rx: raw.rx, ry: raw.ry 
        });
        if (this._inputHistory.length > this._historySize) {
            this._inputHistory.shift();
        }
        
        // Simple moving average of last N samples (for all axes we care about)
        let avgTx = 0, avgTy = 0, avgRx = 0, avgRy = 0;
        for (const sample of this._inputHistory) {
            avgTx += sample.tx;
            avgTy += sample.ty;
            avgRx += sample.rx || 0;
            avgRy += sample.ry || 0;
        }
        const n = this._inputHistory.length;
        avgTx /= n;
        avgTy /= n;
        avgRx /= n;
        avgRy /= n;
        
        // Apply inversion settings FIRST so tilt and translation are in same coordinate space
        const invertX = this._invertX !== undefined ? this._invertX : true;
        const invertY = this._invertY !== undefined ? this._invertY : true;
        
        // Invert all axes consistently so they align physically
        const tx = invertX ? -avgTx : avgTx;
        const ty = invertY ? -avgTy : avgTy;
        const ry = invertX ? -avgRy : avgRy;  // RY affects X axis, so use invertX
        const rx = invertY ? -avgRx : avgRx;  // RX affects Y axis, so use invertY
        
        // Smart tilt handling - combine translation and tilt intelligently
        let panX, panY;
        
        const tiltMode = this._tiltMode || 'tilt_assist';
        
        if (tiltMode === 'translation_only') {
            // Original behavior: ignore tilt completely
            panX = tx;
            panY = ty;
            
        } else if (tiltMode === 'max_signal') {
            // Use whichever signal is stronger (translation or tilt)
            // RY maps to X movement (tilt left/right), RX maps to Y movement (tilt forward/back)
            panX = Math.abs(tx) > Math.abs(ry) ? tx : ry;
            panY = Math.abs(ty) > Math.abs(rx) ? ty : rx;
            
        } else if (tiltMode === 'tilt_assist') {
            // Smart combination: tilt reinforces translation when in same direction
            // Now that both are inverted consistently, same sign = same physical direction
            
            // For X axis: translation TX and tilt RY
            if (tx !== 0 && ry !== 0 && Math.sign(tx) === Math.sign(ry)) {
                // Same direction: use the stronger signal
                panX = Math.abs(tx) > Math.abs(ry) ? tx : ry;
            } else if (tx !== 0) {
                // Translation only, or conflicting signals: use translation
                panX = tx;
            } else {
                // No translation: allow tilt to drive (scaled down slightly)
                panX = ry * (this._tiltWeight || 0.6);
            }
            
            // For Y axis: translation TY and tilt RX
            if (ty !== 0 && rx !== 0 && Math.sign(ty) === Math.sign(rx)) {
                // Same direction: use the stronger signal
                panY = Math.abs(ty) > Math.abs(rx) ? ty : rx;
            } else if (ty !== 0) {
                // Translation only, or conflicting signals: use translation
                panY = ty;
            } else {
                // No translation: allow tilt to drive (scaled down slightly)
                panY = rx * (this._tiltWeight || 0.6);
            }
        } else {
            // Fallback
            panX = tx;
            panY = ty;
        }
        const zoom = raw.rz;  // Twist ONLY
        
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
    
    /**
     * Create real-time configuration panel
     */
    createConfigPanel() {
        // Remove existing panel if any
        const existing = document.getElementById('spacemouse-config-panel');
        if (existing) existing.remove();
        
        const panel = document.createElement('div');
        panel.id = 'spacemouse-config-panel';
        panel.innerHTML = `
            <style>
                #spacemouse-config-panel {
                    position: fixed;
                    top: 80px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(15, 23, 42, 0.97);
                    border: 1px solid #334155;
                    border-radius: 12px;
                    padding: 0;
                    width: 340px;
                    font-family: system-ui, sans-serif;
                    font-size: 13px;
                    color: #e2e8f0;
                    z-index: 10000;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                    resize: both;
                    overflow: hidden;
                }
                #spacemouse-config-panel .drag-handle {
                    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
                    padding: 12px 16px;
                    cursor: move;
                    user-select: none;
                    border-bottom: 1px solid #334155;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                #spacemouse-config-panel .drag-handle h3 {
                    margin: 0;
                    color: #10b981;
                    font-size: 14px;
                }
                #spacemouse-config-panel .panel-body {
                    padding: 16px;
                    max-height: 70vh;
                    overflow-y: auto;
                }
                #spacemouse-config-panel .close-btn {
                    background: none;
                    border: none;
                    color: #94a3b8;
                    font-size: 20px;
                    cursor: pointer;
                    padding: 0;
                    line-height: 1;
                }
                #spacemouse-config-panel .close-btn:hover { color: #fff; }
                #spacemouse-config-panel .param {
                    margin-bottom: 14px;
                }
                #spacemouse-config-panel label {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 4px;
                    color: #94a3b8;
                }
                #spacemouse-config-panel label span {
                    color: #10b981;
                    font-family: monospace;
                }
                #spacemouse-config-panel input[type="range"] {
                    width: 100%;
                    height: 6px;
                    -webkit-appearance: none;
                    background: #1e293b;
                    border-radius: 3px;
                    outline: none;
                }
                #spacemouse-config-panel input[type="range"]::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    width: 16px;
                    height: 16px;
                    background: #10b981;
                    border-radius: 50%;
                    cursor: pointer;
                }
                #spacemouse-config-panel .live-values {
                    background: #1e293b;
                    border-radius: 8px;
                    padding: 10px;
                    font-family: monospace;
                    font-size: 11px;
                    margin-top: 16px;
                }
                #spacemouse-config-panel .export-btn {
                    width: 100%;
                    margin-top: 12px;
                    padding: 8px;
                    background: #10b981;
                    border: none;
                    border-radius: 6px;
                    color: #fff;
                    cursor: pointer;
                    font-weight: 500;
                }
                #spacemouse-config-panel .export-btn:hover { background: #059669; }
            </style>
            <div class="drag-handle" id="cfg-drag-handle">
                <h3>🎮 SpaceMouse Config</h3>
                <button class="close-btn" onclick="this.closest('#spacemouse-config-panel').remove()">×</button>
            </div>
            <div class="panel-body">
            <div class="param">
                <label>Pan Sensitivity <span id="cfg-pan-val">${this.sensitivity.pan}</span></label>
                <input type="range" id="cfg-pan" min="0.1" max="2.0" step="0.1" value="${this.sensitivity.pan}">
            </div>
            
            <div class="param">
                <label>Deadzone <span id="cfg-dead-val">${this.deadZone}</span></label>
                <input type="range" id="cfg-dead" min="0.02" max="0.2" step="0.01" value="${this.deadZone}">
            </div>
            
            <div class="param">
                <label>Curve Power <span id="cfg-curve-val">${this._curvePower || 3.0}</span></label>
                <input type="range" id="cfg-curve" min="1.0" max="5.0" step="0.5" value="${this._curvePower || 3.0}">
            </div>
            
            <div class="param">
                <label>History Size (smoothing) <span id="cfg-history-val">${this._historySize}</span></label>
                <input type="range" id="cfg-history" min="1" max="20" step="1" value="${this._historySize}">
            </div>
            
            <div class="param">
                <label>Output Smoothing <span id="cfg-smooth-val">${this.smoothing}</span></label>
                <input type="range" id="cfg-smooth" min="0.1" max="1.0" step="0.1" value="${this.smoothing}">
            </div>
            
            <div class="param">
                <label>Momentum (0=off, 0.95=long) <span id="cfg-momentum-val">${this._momentumDecay}</span></label>
                <input type="range" id="cfg-momentum" min="0" max="0.96" step="0.02" value="${this._momentumDecay}">
            </div>
            
            <div class="param">
                <label>Tilt Mode</label>
                <select id="cfg-tilt-mode" style="width:100%; padding:6px; background:#1e293b; border:1px solid #334155; color:#e2e8f0; border-radius:4px; margin-top:4px;">
                    <option value="translation_only" ${this._tiltMode === 'translation_only' ? 'selected' : ''}>Translation Only (TX/TY)</option>
                    <option value="max_signal" ${this._tiltMode === 'max_signal' ? 'selected' : ''}>Max Signal (stronger wins)</option>
                    <option value="tilt_assist" ${this._tiltMode === 'tilt_assist' ? 'selected' : ''}>Tilt Assist (recommended)</option>
                </select>
                <div style="color:#64748b; font-size:11px; margin-top:4px;">
                    Tilt Assist: tilt reinforces translation when moving same direction
                </div>
            </div>
            
            <div class="param">
                <label>Tilt Weight <span id="cfg-tilt-weight-val">${this._tiltWeight || 0.6}</span></label>
                <input type="range" id="cfg-tilt-weight" min="0.1" max="1.0" step="0.1" value="${this._tiltWeight || 0.6}">
                <div style="color:#64748b; font-size:11px;">How much pure tilt (no translation) contributes</div>
            </div>
            
            <div class="param">
                <label>Invert X <input type="checkbox" id="cfg-invert-x" ${this._invertX ? 'checked' : ''}></label>
            </div>
            
            <div class="param">
                <label>Invert Y <input type="checkbox" id="cfg-invert-y" ${this._invertY ? 'checked' : ''}></label>
            </div>
            
            <div class="param">
                <label>Show Crosshair <input type="checkbox" id="cfg-crosshair" ${this._crosshairVisible ? 'checked' : ''}></label>
            </div>
            
            <div class="live-values" id="cfg-live">
                TX: 0 | TY: 0 | panX: 0 | panY: 0
            </div>
            
            <button class="export-btn" id="cfg-export">📋 Copy Settings to Console</button>
            </div>
        `;
        
        document.body.appendChild(panel);
        
        // Make panel draggable
        const dragHandle = document.getElementById('cfg-drag-handle');
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;
        
        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            panel.style.transform = 'none';  // Remove center transform once dragging
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = (e.clientX - dragOffsetX) + 'px';
            panel.style.top = (e.clientY - dragOffsetY) + 'px';
        });
        
        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        // Initialize curve power if not set
        if (!this._curvePower) this._curvePower = 3.0;
        if (this._invertX === undefined) this._invertX = true;
        if (this._invertY === undefined) this._invertY = true;
        
        // Wire up controls
        const self = this;
        
        document.getElementById('cfg-pan').oninput = function() {
            self.sensitivity.pan = parseFloat(this.value);
            document.getElementById('cfg-pan-val').textContent = this.value;
        };
        
        document.getElementById('cfg-dead').oninput = function() {
            self.deadZone = parseFloat(this.value);
            document.getElementById('cfg-dead-val').textContent = this.value;
        };
        
        document.getElementById('cfg-curve').oninput = function() {
            self._curvePower = parseFloat(this.value);
            document.getElementById('cfg-curve-val').textContent = this.value;
        };
        
        document.getElementById('cfg-history').oninput = function() {
            self._historySize = parseInt(this.value);
            self._inputHistory = [];  // Clear history on resize
            document.getElementById('cfg-history-val').textContent = this.value;
        };
        
        document.getElementById('cfg-smooth').oninput = function() {
            self.smoothing = parseFloat(this.value);
            document.getElementById('cfg-smooth-val').textContent = this.value;
        };
        
        document.getElementById('cfg-momentum').oninput = function() {
            self._momentumDecay = parseFloat(this.value);
            document.getElementById('cfg-momentum-val').textContent = this.value;
        };
        
        document.getElementById('cfg-tilt-mode').onchange = function() {
            self._tiltMode = this.value;
            self._inputHistory = [];  // Clear history when changing mode
            console.log('SpaceMouse tilt mode:', this.value);
        };
        
        document.getElementById('cfg-tilt-weight').oninput = function() {
            self._tiltWeight = parseFloat(this.value);
            document.getElementById('cfg-tilt-weight-val').textContent = this.value;
        };
        
        document.getElementById('cfg-invert-x').onchange = function() {
            self._invertX = this.checked;
        };
        
        document.getElementById('cfg-invert-y').onchange = function() {
            self._invertY = this.checked;
        };
        
        document.getElementById('cfg-crosshair').onchange = function() {
            if (this.checked) {
                self.showCrosshair();
            } else {
                self.hideCrosshair();
            }
        };
        
        document.getElementById('cfg-export').onclick = function() {
            const settings = {
                pan: self.sensitivity.pan,
                deadZone: self.deadZone,
                curvePower: self._curvePower,
                historySize: self._historySize,
                smoothing: self.smoothing,
                momentum: self._momentumDecay,
                tiltMode: self._tiltMode,
                tiltWeight: self._tiltWeight,
                invertX: self._invertX,
                invertY: self._invertY
            };
            console.log('SpaceMouse Settings:', JSON.stringify(settings, null, 2));
            alert('Settings copied to console!');
        };
        
        // Update live values
        this._configPanelInterval = setInterval(() => {
            const live = document.getElementById('cfg-live');
            if (live && this._rawInput) {
                const r = this._rawInput;
                const rawTX = Math.round(r.tx * 350);
                const rawTY = Math.round(r.ty * 350);
                const rawRX = Math.round(r.rx * 350);
                const rawRY = Math.round(r.ry * 350);
                const rawRZ = Math.round(r.rz * 350);
                const panX = this._smoothedPan?.x?.toFixed(3) || '0.000';
                const panY = this._smoothedPan?.y?.toFixed(3) || '0.000';
                
                // Color code based on which signal is being used
                const txColor = Math.abs(rawTX) > Math.abs(rawRY) ? '#10b981' : '#64748b';
                const tyColor = Math.abs(rawTY) > Math.abs(rawRX) ? '#10b981' : '#64748b';
                const rxColor = Math.abs(rawRX) > Math.abs(rawTY) ? '#f59e0b' : '#64748b';
                const ryColor = Math.abs(rawRY) > Math.abs(rawTX) ? '#f59e0b' : '#64748b';
                
                live.innerHTML = 
                    `<div>Translation: <span style="color:${txColor}">TX:${rawTX.toString().padStart(4)}</span> <span style="color:${tyColor}">TY:${rawTY.toString().padStart(4)}</span></div>` +
                    `<div>Tilt: <span style="color:${ryColor}">RY:${rawRY.toString().padStart(4)}</span> <span style="color:${rxColor}">RX:${rawRX.toString().padStart(4)}</span> | RZ:${rawRZ.toString().padStart(4)}</div>` +
                    `<div>Output: panX:${panX} panY:${panY}</div>` +
                    `<div style="color:#64748b; font-size:10px;">Green=translation, Orange=tilt winning</div>`;
            }
        }, 100);
        
        console.log('SpaceMouse config panel opened. Adjust settings in real-time!');
    }
    
    /**
     * Close config panel
     */
    closeConfigPanel() {
        const panel = document.getElementById('spacemouse-config-panel');
        if (panel) panel.remove();
        if (this._configPanelInterval) {
            clearInterval(this._configPanelInterval);
            this._configPanelInterval = null;
        }
    }
    
    /**
     * Show crosshair in center of viewer
     */
    showCrosshair() {
        if (this._crosshair) {
            this._crosshair.style.display = 'flex';
            this._crosshairVisible = true;
            return;
        }
        
        // Find the viewer container - attach to it so crosshair stays centered in fullscreen
        const viewerContainer = this.viewer?.element || document.getElementById('viewer') || document.body;
        
        // Create crosshair element
        const crosshair = document.createElement('div');
        crosshair.id = 'spacemouse-crosshair';
        crosshair.innerHTML = `
            <style>
                #spacemouse-crosshair {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    pointer-events: none;
                    z-index: 9999;
                }
                #spacemouse-crosshair svg {
                    width: 32px;
                    height: 32px;
                    filter: drop-shadow(0 0 2px rgba(0,0,0,0.8));
                }
            </style>
            <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <!-- Outer circle -->
                <circle cx="16" cy="16" r="12" stroke="#10b981" stroke-width="1.5" stroke-opacity="0.7"/>
                <!-- Horizontal line -->
                <line x1="0" y1="16" x2="10" y2="16" stroke="#10b981" stroke-width="1.5" stroke-opacity="0.9"/>
                <line x1="22" y1="16" x2="32" y2="16" stroke="#10b981" stroke-width="1.5" stroke-opacity="0.9"/>
                <!-- Vertical line -->
                <line x1="16" y1="0" x2="16" y2="10" stroke="#10b981" stroke-width="1.5" stroke-opacity="0.9"/>
                <line x1="16" y1="22" x2="16" y2="32" stroke="#10b981" stroke-width="1.5" stroke-opacity="0.9"/>
                <!-- Center dot -->
                <circle cx="16" cy="16" r="2" fill="#10b981"/>
            </svg>
        `;
        
        // Make sure viewer container has position relative for absolute positioning
        if (viewerContainer !== document.body) {
            const style = window.getComputedStyle(viewerContainer);
            if (style.position === 'static') {
                viewerContainer.style.position = 'relative';
            }
        }
        
        viewerContainer.appendChild(crosshair);
        this._crosshair = crosshair;
        this._crosshairVisible = true;
        
        console.log('🎯 Crosshair enabled');
    }
    
    /**
     * Hide crosshair
     */
    hideCrosshair() {
        if (this._crosshair) {
            this._crosshair.style.display = 'none';
            this._crosshairVisible = false;
            console.log('🎯 Crosshair hidden');
        }
    }
    
    /**
     * Toggle crosshair visibility
     */
    toggleCrosshair() {
        if (this._crosshairVisible) {
            this.hideCrosshair();
        } else {
            this.showCrosshair();
        }
        return this._crosshairVisible;
    }
    
    /**
     * Enable event suppression to block 3Dconnexion driver menus/shortcuts
     */
    enableEventSuppression() {
        if (this._suppressHandlers) return;  // Already enabled
        
        // Block context menu (right-click menu that driver might trigger)
        const contextHandler = (e) => {
            // Only suppress if SpaceMouse button was just pressed
            if (this.buttons.left || this.buttons.right) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        };
        
        // Block certain keyboard shortcuts the driver might send
        const keyHandler = (e) => {
            // 3Dconnexion driver often sends F-keys or other shortcuts
            // Block if a SpaceMouse button is currently pressed
            if (this.buttons.left || this.buttons.right) {
                // Allow essential keys
                if (['F5', 'F12', 'Escape'].includes(e.key)) return;
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        };
        
        // Block auxclick (middle mouse button that driver might trigger)
        const auxHandler = (e) => {
            if (this.buttons.left || this.buttons.right) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        };
        
        document.addEventListener('contextmenu', contextHandler, true);
        document.addEventListener('keydown', keyHandler, true);
        document.addEventListener('auxclick', auxHandler, true);
        
        this._suppressHandlers = { contextHandler, keyHandler, auxHandler };
        console.log('SpaceMouse: Event suppression enabled (blocking driver menus)');
    }
    
    /**
     * Disable event suppression
     */
    disableEventSuppression() {
        if (!this._suppressHandlers) return;
        
        document.removeEventListener('contextmenu', this._suppressHandlers.contextHandler, true);
        document.removeEventListener('keydown', this._suppressHandlers.keyHandler, true);
        document.removeEventListener('auxclick', this._suppressHandlers.auxHandler, true);
        
        this._suppressHandlers = null;
        console.log('SpaceMouse: Event suppression disabled');
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SpaceNavigatorController;
}
