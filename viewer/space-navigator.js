/**
 * Space Navigator Controller for OpenSeadragon
 * Integrates 3Dconnexion Space Navigator 6DOF input with WSI viewer
 * Supports: WebHID API (Chrome/Edge preferred), Gamepad API (Chrome fallback)
 * @version 1.13.0
 */

const SPACEMOUSE_VERSION = '1.17.0';
console.log(`%c🎮 SpaceMouse module v${SPACEMOUSE_VERSION} loaded`, 'color: #6366f1');

// Preferences storage key
const SPACEMOUSE_PREFS_KEY = 'spacemouse_preferences';

// Global event suppression state (can be enabled before controller exists)
let _globalSuppressionEnabled = false;
let _globalSuppressionHandlers = null;

// Reference resolution for pan speed scaling (calibrated on 1920x1080 @ 125% = 1920 physical pixels)
// Larger screens will pan faster to maintain consistent physical motion
const REFERENCE_WIDTH = 1920;

// Reference frame time - calibrated on 144Hz Lenovo Legion (6.94ms per frame)
const REFERENCE_FRAME_MS = 1000 / 144;  // 6.944ms

// Log API support on load
const _webhidSupport = 'hid' in navigator;
const _gamepadSupport = 'getGamepads' in navigator;
console.log(`%c   APIs: WebHID ${_webhidSupport ? '✓' : '✗'} | 3DxWare (checking...) | Gamepad ${_gamepadSupport ? '✓' : '✗'}`, 
    'color: #888');

// 3DxWare WebSocket endpoints to try (3Dconnexion driver runs a local WebSocket server)
const TDXWARE_ENDPOINTS = [
    'wss://127.51.68.120:8181', // Official 3Dconnexion NL Server (WebSocket proxy)
    'ws://localhost:8181',
    'ws://localhost:8182',
    'ws://localhost:8080'
];
let _3dxwareAvailable = false;
let _3dxwareUrl = null;

// Check for 3DxWare on load
(async function check3DxWare() {
    for (const url of TDXWARE_ENDPOINTS) {
        try {
            const available = await new Promise((resolve) => {
                const ws = new WebSocket(url);
                const timeout = setTimeout(() => { try { ws.close(); } catch(e) {} resolve(false); }, 800);
                ws.onopen = () => { clearTimeout(timeout); try { ws.close(); } catch(e) {} resolve(true); };
                ws.onerror = () => { clearTimeout(timeout); resolve(false); };
            });
            if (available) {
                _3dxwareAvailable = true;
                _3dxwareUrl = url;
                console.log(`%c   3DxWare: ✓ (at ${url})`, 'color: #10b981');
                return;
            }
        } catch (e) {}
    }
    console.log(`%c   3DxWare: ✗ (driver not running or WebSocket disabled)`, 'color: #888');
})();

class SpaceNavigatorController {
    constructor(viewer) {
        console.log('SpaceNavigatorController: CONSTRUCTOR CALLED');
        this.viewer = viewer;
        this.device = null;
        this.connected = false;
        this.animationFrame = null;
        
        // Connection mode: 'webhid' | '3dxware' | 'gamepad' | null
        this._connectionMode = null;
        this._gamepadIndex = null;
        this._gamepadAxesMapping = null;  // Will be detected on connection
        
        // 3DxWare WebSocket connection
        this._3dxWebSocket = null;
        this._3dxClientId = null;
        
        // Accumulated input values (after deadzone/curve)
        this.input = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
        // Raw input values (before processing) for debug
        this._rawInput = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
        // Simple moving average buffer for raw input
        this._inputHistory = [];
        this._historySize = 25;  // Configurable: average last N samples for smoother diagonals
        // Smoothed output values
        this._smoothedPan = { x: 0, y: 0 };
        
        // Momentum/inertia for smooth deceleration
        this._velocity = { x: 0, y: 0 };
        this._momentumDecay = 0.96;  // Decay factor per frame at 144fps baseline (0.96 = longer glide)
        this._hasActiveInput = false;
        this._lastDecayTime = 0;     // For time-based decay (frame-rate independent)
        
        // Configurable parameters (can be adjusted via config panel)
        this._curvePower = 1.2;   // Exponential curve power (1.0=linear, 1.2=gentle, 2.0=quadratic)
        this._invertX = true;     // Invert X axis (push left = pan left)
        this._invertY = true;     // Invert Y axis (push forward = pan up)
        
        // Tilt handling mode: how to handle inadvertent tilt (RX/RY) while panning
        // 'translation_only' - ignore tilt, use only TX/TY (old behavior)
        // 'max_signal' - use stronger of translation OR tilt for each axis
        // 'tilt_assist' - tilt reinforces translation when same direction (recommended)
        this._tiltMode = 'tilt_assist';
        this._tiltWeight = 1.0;   // How much tilt contributes (0-1, 1.0 = full contribution)
        
        // Sensitivity settings - tuned for pathology viewing
        this.sensitivity = {
            pan: 0.05,        // Pan speed (divided by zoom for normalization)
            zoom: 0.002,      // Zoom speed (unused - now using snap zoom)
            rotation: 0.008   // Rotation speed
        };
        
        // Fullscreen tap gesture detection (push straight down and release)
        this._tapDownState = {
            isDown: false,          // Currently pressed down
            startTime: 0,           // When the press started
            maxTapDuration: 400,    // Max ms for a tap (longer = hold, not tap)
            threshold: 150,         // Raw TZ value threshold to detect push down
            lastTapTime: 0,         // Debounce - prevent double triggers
            tapCooldown: 500        // Min ms between taps
        };
        
        // Snap zoom cooldown - allows repeated snaps while held, but with delay
        this._lastZoomTime = 0;
        this._zoomRepeatDelay = 200;  // ms between repeated zoom snaps
        
        // Dead zone to prevent drift
        this.deadZone = 0.25;
        
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
    static isWebHIDSupported() {
        return 'hid' in navigator;
    }
    
    /**
     * Check if 3DxWare WebSocket is available
     */
    static is3DxWareAvailable() {
        return _3dxwareAvailable;
    }
    
    /**
     * Get 3DxWare URL (if available)
     */
    static get3DxWareUrl() {
        return _3dxwareUrl;
    }
    
    /**
     * Check if Gamepad API is supported
     */
    static isGamepadSupported() {
        return 'getGamepads' in navigator;
    }
    
    /**
     * Legacy alias for WebHID check
     */
    static isSupported() {
        return SpaceNavigatorController.isWebHIDSupported() || 
               SpaceNavigatorController.is3DxWareAvailable() ||
               SpaceNavigatorController.isGamepadSupported();
    }
    
    /**
     * Get current connection mode
     */
    getConnectionMode() {
        return this._connectionMode;
    }
    
    /**
     * Get connection mode display name
     */
    getConnectionModeDisplay() {
        switch (this._connectionMode) {
            case 'webhid': return 'WebHID';
            case '3dxware': return '3DxWare';
            case 'gamepad': return 'Gamepad API';
            default: return 'Not Connected';
        }
    }

    /**
     * Try to auto-connect to a previously paired SpaceMouse
     * Tries WebHID first (Chrome/Edge), then Gamepad API (Chrome)
     * Returns true if connected, false if no device found
     */
    async autoConnect() {
        console.log('%c🎮 SpaceMouse auto-connect starting...', 'color: #6366f1');
        
        // Try WebHID first (preferred - full control, Chromium only)
        if (SpaceNavigatorController.isWebHIDSupported()) {
            console.log('   Trying WebHID...');
            const webhidResult = await this._autoConnectWebHID();
            if (webhidResult) {
                console.log('%c   ✓ Connected via WebHID', 'color: #10b981');
                return true;
            }
        }
        
        // Fall back to Gamepad API (works in Chrome, may work in other browsers)
        if (SpaceNavigatorController.isGamepadSupported()) {
            console.log('   Trying Gamepad API...');
            const gamepadResult = this._autoConnectGamepad();
            if (gamepadResult) {
                console.log('%c   ✓ Connected via Gamepad API', 'color: #f59e0b');
                return true;
            }
            // Set up listener for future gamepad connections
            this._setupGamepadListeners();
        }
        
        console.log('%c   No SpaceMouse found. Move the device to detect it.', 'color: #888');
        return false;
    }
    
    /**
     * Auto-connect via WebHID API
     */
    async _autoConnectWebHID() {
        try {
            // Get devices that user has previously granted permission to
            const devices = await navigator.hid.getDevices();
            
            // Find a 3Dconnexion device
            const spaceMouse = devices.find(d => 
                this.vendorIds.includes(d.vendorId)
            );
            
            if (spaceMouse) {
                console.log('%c🎮 SpaceMouse auto-connecting via WebHID...', 'color: #10b981');
                this.device = spaceMouse;
                this._connectionMode = 'webhid';
                
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
                
                // Save preference that SpaceMouse is in use
                SpaceNavigatorController.savePreferences({
                    lastConnected: Date.now(),
                    connectionMode: 'webhid',
                    deviceName: this.device.productName
                });

                console.log('%c🎮 SpaceMouse auto-connected via WebHID!', 'color: #10b981; font-weight: bold');
                console.log(`Device: ${this.device.productName}`);
                
                // Apply debug mode if it was enabled
                if (typeof window !== 'undefined' && window._spaceMouseDebugEnabled) {
                    this.debugMode = true;
                }
                
                return true;
            }
            
            return false;
        } catch (err) {
            console.log('SpaceMouse WebHID auto-connect failed:', err.message);
            return false;
        }
    }
    
    /**
     * Auto-connect via Gamepad API (check if SpaceMouse appears as gamepad)
     */
    _autoConnectGamepad() {
        const gamepad = this._findSpaceMouseGamepad();
        
        if (gamepad) {
            return this._connectViaGamepad(gamepad);
        }
        
        return false;
    }
    
    /**
     * Connect via 3DxWare WebSocket SDK
     * Works in all browsers when 3Dconnexion driver is running
     */
    async _connectVia3DxWare() {
        if (!_3dxwareAvailable || !_3dxwareUrl) {
            console.log('3DxWare not available');
            return false;
        }
        
        return new Promise((resolve) => {
            console.log(`%c🎮 SpaceMouse connecting via 3DxWare (${_3dxwareUrl})...`, 'color: #8b5cf6');
            
            try {
                this._3dxWebSocket = new WebSocket(_3dxwareUrl);
                
                // Connection timeout
                const timeout = setTimeout(() => {
                    console.log('3DxWare connection timeout');
                    try { this._3dxWebSocket.close(); } catch(e) {}
                    resolve(false);
                }, 3000);
                
                this._3dxWebSocket.onopen = () => {
                    clearTimeout(timeout);
                    console.log('%c🎮 3DxWare WebSocket connected!', 'color: #8b5cf6; font-weight: bold');
                    
                    // Register as a client
                    this._3dxClientId = 'pathviewpro_' + Date.now();
                    this._3dxWebSocket.send(JSON.stringify({
                        type: 'register',
                        clientId: this._3dxClientId,
                        appName: 'PathView Pro'
                    }));
                    
                    this._connectionMode = '3dxware';
                    this.device = { productName: '3DxWare WebSocket' };
                    this.connected = true;
                    
                    // Start animation loop
                    this.startAnimationLoop();
                    
                    this.updateStatus('connected');
                    this.showCrosshair();
                    this.enableEventSuppression();
                    
                    // Save preference
                    SpaceNavigatorController.savePreferences({
                        lastConnected: Date.now(),
                        connectionMode: '3dxware'
                    });
                    
                    resolve(true);
                };
                
                this._3dxWebSocket.onmessage = (event) => {
                    this._handle3DxWareMessage(event.data);
                };
                
                this._3dxWebSocket.onerror = (error) => {
                    clearTimeout(timeout);
                    console.log('3DxWare WebSocket error:', error);
                    resolve(false);
                };
                
                this._3dxWebSocket.onclose = () => {
                    if (this._connectionMode === '3dxware' && this.connected) {
                        console.log('%c🎮 3DxWare WebSocket disconnected', 'color: #ef4444');
                        this.disconnect();
                    }
                };
                
            } catch (error) {
                console.error('3DxWare connection failed:', error);
                resolve(false);
            }
        });
    }
    
    /**
     * Handle messages from 3DxWare WebSocket
     * Parses motion and button data from the driver
     */
    _handle3DxWareMessage(data) {
        try {
            const msg = JSON.parse(data);
            
            // Handle different message types from 3DxWare
            if (msg.type === 'motion' || msg.motion) {
                const m = msg.motion || msg;
                
                // 3DxWare typically sends values in range -1 to 1 or similar
                // Scale to match our raw input range (~-350 to 350)
                const scale = 350;
                
                this._rawInput.tx = (m.x || m.tx || 0) * scale;
                this._rawInput.ty = (m.y || m.ty || 0) * scale;
                this._rawInput.tz = (m.z || m.tz || 0) * scale;
                this._rawInput.rx = (m.rx || m.pitch || 0) * scale;
                this._rawInput.ry = (m.ry || m.roll || 0) * scale;
                this._rawInput.rz = (m.rz || m.yaw || 0) * scale;
                
                // Apply deadzone processing (same as WebHID path)
                this.input.tx = this.applyDeadzone(this._rawInput.tx);
                this.input.ty = this.applyDeadzone(this._rawInput.ty);
                this.input.tz = this.applyDeadzone(this._rawInput.tz);
                this.input.rx = this.applyDeadzone(this._rawInput.rx);
                this.input.ry = this.applyDeadzone(this._rawInput.ry);
                this.input.rz = this.applyDeadzone(this._rawInput.rz);
            }
            
            if (msg.type === 'button' || msg.buttons !== undefined) {
                const buttons = msg.buttons || msg;
                const leftPressed = !!(buttons.left || buttons[0] || buttons.button0);
                const rightPressed = !!(buttons.right || buttons[1] || buttons.button1);
                
                if (leftPressed !== this.buttons.left) {
                    this.buttons.left = leftPressed;
                    console.log(`%c🎮 SpaceMouse LEFT button ${leftPressed ? 'PRESSED' : 'released'}`, 
                                leftPressed ? 'color: #10b981; font-weight: bold' : 'color: #666');
                    if (this.onButtonPress) {
                        this.onButtonPress({ button: 'left', pressed: leftPressed });
                    }
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
                    if (rightPressed && typeof window.nextStudy === 'function') {
                        window.nextStudy();
                    }
                }
            }
            
            // Debug logging
            if (this.debugMode && (msg.type === 'motion' || msg.motion)) {
                console.log('3DxWare:', msg);
            }
            
        } catch (e) {
            // Not JSON or parse error - might be binary or other format
            if (this.debugMode) {
                console.log('3DxWare raw message:', data);
            }
        }
    }
    
    /**
     * Find SpaceMouse in gamepad list
     * Prefers: 1) Vendor 256f (3Dconnexion), 2) 6 axes, 3) SpaceMouse in name
     */
    _findSpaceMouseGamepad() {
        const gamepads = navigator.getGamepads();
        let bestCandidate = null;
        let bestScore = 0;
        
        for (const gp of gamepads) {
            if (!gp) continue;
            
            const score = this._scoreSpaceMouseGamepad(gp);
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = gp;
            }
        }
        
        return bestCandidate;
    }
    
    /**
     * Score a gamepad on how likely it is to be a SpaceMouse
     * Higher score = more likely to be the correct device
     */
    _scoreSpaceMouseGamepad(gamepad) {
        const id = gamepad.id.toLowerCase();
        let score = 0;
        
        // Vendor 256f is definitely 3Dconnexion
        if (id.includes('256f')) score += 100;
        
        // Vendor 046d is Logitech (owns 3Dconnexion)
        if (id.includes('046d')) score += 50;
        
        // Explicit SpaceMouse naming
        if (id.includes('spacemouse')) score += 80;
        if (id.includes('spacenavigator')) score += 80;
        if (id.includes('3dconnexion')) score += 70;
        if (id.includes('space mouse')) score += 60;
        if (id.includes('space navigator')) score += 60;
        
        // Exactly 6 axes is ideal for SpaceMouse
        if (gamepad.axes.length === 6) score += 40;
        else if (gamepad.axes.length >= 6) score += 20;
        
        // 2 buttons is typical for SpaceMouse
        if (gamepad.buttons.length === 2) score += 10;
        
        // Exclude generic gamepads with 'beef' vendor (virtual devices)
        if (id.includes('beef') && !id.includes('spacemouse')) score -= 30;
        
        return score > 0 ? score : 0;
    }
    
    /**
     * Check if a gamepad looks like a SpaceMouse
     */
    _isSpaceMouseGamepad(gamepad) {
        return this._scoreSpaceMouseGamepad(gamepad) > 0;
    }
    
    /**
     * Connect via Gamepad API
     */
    _connectViaGamepad(gamepad) {
        console.log('%c🎮 SpaceMouse connecting via Gamepad API...', 'color: #f59e0b');
        console.log(`   Gamepad: ${gamepad.id}`);
        console.log(`   Axes: ${gamepad.axes.length}, Buttons: ${gamepad.buttons.length}`);
        
        this._connectionMode = 'gamepad';
        this._gamepadIndex = gamepad.index;
        this.device = { productName: gamepad.id };  // Fake device for compatibility
        
        // Detect axis mapping
        this._gamepadAxesMapping = this._detectGamepadAxesMapping(gamepad);
        console.log('   Axis mapping:', this._gamepadAxesMapping);
        
        // Start animation loop (includes gamepad polling)
        this.startAnimationLoop();
        
        this.connected = true;
        this.updateStatus('connected');
        
        // Show crosshair
        this.showCrosshair();
        
        // NOTE: No longer disabling OSD navigation - mouse and SpaceMouse can coexist
        // this._disableOSDNavigation();

        // Suppress events
        this.enableEventSuppression();
        
        // Save preference
        SpaceNavigatorController.savePreferences({
            lastConnected: Date.now(),
            connectionMode: 'gamepad'
        });

        console.log('%c🎮 SpaceMouse connected via Gamepad API!', 'color: #f59e0b; font-weight: bold');
        console.log('%c   ⚠️ Gamepad API may have limited axis support', 'color: #f59e0b');
        
        return true;
    }
    
    /**
     * Detect how the Gamepad API maps SpaceMouse axes
     * Returns an object mapping our axes (tx, ty, tz, rx, ry, rz) to gamepad axis indices
     */
    _detectGamepadAxesMapping(gamepad) {
        const numAxes = gamepad.axes.length;
        
        // Common mappings based on axis count
        if (numAxes >= 6) {
            // Full 6DOF - standard mapping
            return { tx: 0, ty: 1, tz: 2, rx: 3, ry: 4, rz: 5 };
        } else if (numAxes >= 4) {
            // 4 axes - probably TX, TY, RX, RY or TX, TY, TZ, RZ
            return { tx: 0, ty: 1, tz: -1, rx: 2, ry: 3, rz: -1 };
        } else if (numAxes >= 2) {
            // Minimal - just pan
            return { tx: 0, ty: 1, tz: -1, rx: -1, ry: -1, rz: -1 };
        }
        
        return { tx: 0, ty: 1, tz: -1, rx: -1, ry: -1, rz: -1 };
    }
    
    /**
     * Poll gamepad for input (called in animation loop when using Gamepad API)
     */
    _pollGamepad() {
        if (this._connectionMode !== 'gamepad' || this._gamepadIndex === null) return;
        
        const gamepads = navigator.getGamepads();
        const gamepad = gamepads[this._gamepadIndex];
        
        if (!gamepad) {
            // Gamepad disconnected
            console.log('%c🎮 SpaceMouse gamepad disconnected', 'color: #ef4444');
            this.disconnect();
            return;
        }
        
        const mapping = this._gamepadAxesMapping;
        const axes = gamepad.axes;
        const scale = 350;  // Scale to match WebHID raw value range
        
        // Read axes based on detected mapping
        const getRawValue = (axisIndex) => {
            if (axisIndex < 0 || axisIndex >= axes.length) return 0;
            return axes[axisIndex] * scale;
        };
        
        this._rawInput.tx = getRawValue(mapping.tx);
        this._rawInput.ty = getRawValue(mapping.ty);
        this._rawInput.tz = getRawValue(mapping.tz);
        this._rawInput.rx = getRawValue(mapping.rx);
        this._rawInput.ry = getRawValue(mapping.ry);
        this._rawInput.rz = getRawValue(mapping.rz);
        
        // Apply deadzone processing
        this.input.tx = this.applyDeadzone(this._rawInput.tx);
        this.input.ty = this.applyDeadzone(this._rawInput.ty);
        this.input.tz = this.applyDeadzone(this._rawInput.tz);
        this.input.rx = this.applyDeadzone(this._rawInput.rx);
        this.input.ry = this.applyDeadzone(this._rawInput.ry);
        this.input.rz = this.applyDeadzone(this._rawInput.rz);
        
        // Handle buttons (if available)
        if (gamepad.buttons.length >= 2) {
            const leftPressed = gamepad.buttons[0].pressed;
            const rightPressed = gamepad.buttons[1].pressed;
            
            if (leftPressed !== this.buttons.left) {
                this.buttons.left = leftPressed;
                if (this.onButtonPress) {
                    this.onButtonPress({ button: 'left', pressed: leftPressed });
                }
                if (leftPressed && typeof window.previousStudy === 'function') {
                    window.previousStudy();
                }
            }
            
            if (rightPressed !== this.buttons.right) {
                this.buttons.right = rightPressed;
                if (this.onButtonPress) {
                    this.onButtonPress({ button: 'right', pressed: rightPressed });
                }
                if (rightPressed && typeof window.nextStudy === 'function') {
                    window.nextStudy();
                }
            }
        }
    }

    /**
     * Connect to Space Navigator device (with user gesture/picker)
     * Tries WebHID first (with picker), then Gamepad API
     */
    async connect() {
        console.log('%c🎮 SpaceMouse connect requested...', 'color: #6366f1');
        
        // Try WebHID first (preferred - Chromium only, shows device picker)
        if (SpaceNavigatorController.isWebHIDSupported()) {
            console.log('   Opening WebHID device picker...');
            const result = await this._connectViaWebHID();
            if (result) return true;
            // User may have cancelled picker, try Gamepad API
        }
        
        // Fall back to Gamepad API
        if (SpaceNavigatorController.isGamepadSupported()) {
            console.log('%c🎮 Trying Gamepad API...', 'color: #f59e0b');
            console.log('%c   Move your SpaceMouse to let the browser detect it', 'color: #f59e0b');
            
            // Give user a moment to interact with device
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const gamepad = this._findSpaceMouseGamepad();
            if (gamepad) {
                return this._connectViaGamepad(gamepad);
            }
            
            // Set up listener for future gamepad connections
            this._setupGamepadListeners();
            
            // Start polling for gamepad (some browsers need this)
            this._startGamepadPolling();
            
            console.log('%c   No SpaceMouse detected yet. Keep moving it...', 'color: #f59e0b');
            this.updateStatus('waiting');
            return false;
        }
        
        console.warn('No SpaceMouse connection method available in this browser');
        this.updateStatus('unsupported');
        return false;
    }
    
    /**
     * Start polling for gamepad connections (for browsers that need it)
     */
    _startGamepadPolling() {
        if (this._gamepadPollInterval) return;
        
        this._gamepadPollInterval = setInterval(() => {
            if (this.connected) {
                clearInterval(this._gamepadPollInterval);
                this._gamepadPollInterval = null;
                return;
            }
            
            const gamepad = this._findSpaceMouseGamepad();
            if (gamepad) {
                clearInterval(this._gamepadPollInterval);
                this._gamepadPollInterval = null;
                this._connectViaGamepad(gamepad);
            }
        }, 500);
        
        // Stop polling after 30 seconds
        setTimeout(() => {
            if (this._gamepadPollInterval) {
                clearInterval(this._gamepadPollInterval);
                this._gamepadPollInterval = null;
            }
        }, 30000);
    }
    
    /**
     * Connect via WebHID API (with device picker)
     */
    async _connectViaWebHID() {
        try {
            // Request device with 3Dconnexion vendor IDs
            const filters = this.vendorIds.map(vendorId => ({ vendorId }));
            const devices = await navigator.hid.requestDevice({ filters });
            
            if (devices.length === 0) {
                console.log('No Space Navigator selected in WebHID picker');
                return false;
            }
            
            this.device = devices[0];
            this._connectionMode = 'webhid';
            await this.device.open();
            
            // Set up input handler
            this.device.addEventListener('inputreport', (e) => this.handleInput(e));
            
            // Start animation loop for smooth updates
            this.startAnimationLoop();
            
            this.connected = true;
            this.updateStatus('connected');
            console.log('%c🎮 Space Navigator connected via WebHID', 'color: #10b981; font-weight: bold');
            console.log(`   Device: ${this.device.productName}`);
            console.log(`   Vendor: 0x${this.device.vendorId.toString(16)} Product: 0x${this.device.productId.toString(16)}`);
            console.log('%c   💡 Type: spaceNavController.toggleDebug() to see live input values', 'color: #888');
            
            // Show crosshair
            this.showCrosshair();
            
            // NOTE: No longer disabling OSD navigation - mouse and SpaceMouse can coexist
            // this._disableOSDNavigation();
            
            // Suppress 3Dconnexion driver default actions (menus, shortcuts)
            this.enableEventSuppression();
            
            // Save preference
            SpaceNavigatorController.savePreferences({
                lastConnected: Date.now(),
                connectionMode: 'webhid',
                deviceName: this.device.productName
            });

            return true;
        } catch (error) {
            if (error.name === 'NotFoundError') {
                // User cancelled the picker
                console.log('WebHID picker cancelled');
                return false;
            }
            console.error('WebHID connection failed:', error);
            return false;
        }
    }
    
    /**
     * Set up Gamepad API event listeners
     */
    _setupGamepadListeners() {
        if (this._gamepadListenersSet) return;
        
        window.addEventListener('gamepadconnected', (e) => {
            console.log('%c🎮 Gamepad connected:', 'color: #f59e0b', e.gamepad.id);
            if (this._isSpaceMouseGamepad(e.gamepad) && !this.connected) {
                this._connectViaGamepad(e.gamepad);
            }
        });
        
        window.addEventListener('gamepaddisconnected', (e) => {
            console.log('%c🎮 Gamepad disconnected:', 'color: #ef4444', e.gamepad.id);
            if (this._connectionMode === 'gamepad' && e.gamepad.index === this._gamepadIndex) {
                this.disconnect();
            }
        });
        
        this._gamepadListenersSet = true;
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
        
        // NOTE: No longer disabling/enabling OSD navigation - mouse and SpaceMouse coexist
        // this._enableOSDNavigation();
        
        // Close WebHID device if applicable
        if (this._connectionMode === 'webhid' && this.device) {
            try {
                await this.device.close();
            } catch (e) {
                console.warn('Error closing WebHID device:', e);
            }
        }
        
        // Close 3DxWare WebSocket if applicable
        if (this._connectionMode === '3dxware' && this._3dxWebSocket) {
            try {
                this._3dxWebSocket.close();
            } catch (e) {
                console.warn('Error closing 3DxWare WebSocket:', e);
            }
            this._3dxWebSocket = null;
            this._3dxClientId = null;
        }
        
        // Reset state
        this.device = null;
        this._connectionMode = null;
        this._gamepadIndex = null;
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
        
        // Track button activity timing for event suppression
        if (leftPressed || rightPressed) {
            this._lastButtonActivity = Date.now();
        }
        
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
        const power = this._curvePower || 1.2;
        const curved = Math.pow(normalized, power);
        
        return sign * curved;  // Returns ~0 to ~1 (or ~-1)
    }

    /**
     * Start animation loop for smooth viewport updates
     */
    startAnimationLoop() {
        const update = () => {
            // STRICT CHECK: Must be connected and have viewer
            if (!this.connected || !this.viewer) {
                console.log('SpaceMouse: Animation loop stopped (not connected)');
                this.animationFrame = null;
                return;
            }
            
            // Poll gamepad if using Gamepad API
            if (this._connectionMode === 'gamepad') {
                this._pollGamepad();
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
        
        // Detect "tap down" gesture for fullscreen toggle
        this._detectFullscreenTap();
        
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
                
                // Calculate screen scale for debug display
                const debugContainerSize = viewport.getContainerSize();
                const debugPhysicalWidth = debugContainerSize.x * (window.devicePixelRatio || 1);
                const debugScreenScale = debugPhysicalWidth / REFERENCE_WIDTH;
                
                console.log(`%c🎮 SpaceMouse`, 'color: #10b981; font-weight: bold',
                    `TX:${rawTX.toString().padStart(4)} TY:${rawTY.toString().padStart(4)} TZ:${rawTZ.toString().padStart(4)} | ` +
                    `RX:${rawRX.toString().padStart(4)} RY:${rawRY.toString().padStart(4)} RZ:${rawRZ.toString().padStart(4)} | ` +
                    `pan:(${mapped.panX.toFixed(2)},${mapped.panY.toFixed(2)}) zoom:${mapped.zoom.toFixed(2)} | ` +
                    `screen:${debugScreenScale.toFixed(2)}x`
                );
                this._lastDebugLog = now;
            }
        }
        
        // Check if any PAN input is active (after exponential curve)
        const hasPanInput = Math.abs(mapped.panX) > 0.001 || Math.abs(mapped.panY) > 0.001;
        
        // Pan with momentum - scale by zoom level AND screen size for consistent physical motion
        const currentZoom = viewport.getZoom();
        
        // Screen resolution scaling: larger screens need faster pan to feel the same
        // Use physical pixels (CSS pixels × devicePixelRatio) to account for OS display scaling
        const containerSize = viewport.getContainerSize();
        const physicalWidth = containerSize.x * (window.devicePixelRatio || 1);
        const screenScale = physicalWidth / REFERENCE_WIDTH;
        
        const panFactor = (this.sensitivity.pan * screenScale) / currentZoom;
        
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
            // No input but we have momentum - apply TIME-BASED decay
            // This ensures consistent coast duration regardless of display refresh rate
            const now = performance.now();
            const deltaMs = this._lastDecayTime ? (now - this._lastDecayTime) : REFERENCE_FRAME_MS;
            this._lastDecayTime = now;
            
            // Normalize to 144fps baseline (6.94ms per frame) - if frame took longer, decay more
            const frameMultiplier = deltaMs / REFERENCE_FRAME_MS;
            
            // Apply screen scale + time correction
            // decay^(screenScale * frameMultiplier) handles both screen size AND frame rate
            const scaledDecay = Math.pow(this._momentumDecay, screenScale * frameMultiplier);
            this._velocity.x *= scaledDecay;
            this._velocity.y *= scaledDecay;
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
        
        if (rawRZ > 200 && (now - this._lastZoomTime) > this._zoomRepeatDelay) {
            // Twist RIGHT - zoom IN (2x)
            console.log('SpaceMouse SNAP ZOOM: 2x (in), rawRZ:', rawRZ.toFixed(0));
            viewport.zoomBy(2, viewport.getCenter(), false);
            this._lastZoomTime = now;
        } 
        else if (rawRZ < -200 && (now - this._lastZoomTime) > this._zoomRepeatDelay) {
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
     * Disable all OpenSeadragon navigation (mouse pan, scroll zoom, click zoom)
     * Called when SpaceMouse is connected
     */
    _disableOSDNavigation() {
        if (!this.viewer) return;
        
        // Save current settings
        this._savedNavSettings = {
            mouseNavEnabled: this.viewer.mouseNavEnabled,
            scrollHandler: this.viewer.innerTracker?.scrollHandler,
            clickToZoom: this.viewer.gestureSettingsMouse?.clickToZoom,
            dblClickToZoom: this.viewer.gestureSettingsMouse?.dblClickToZoom,
            scrollToZoom: this.viewer.gestureSettingsMouse?.scrollToZoom,
            dragToPan: this.viewer.gestureSettingsMouse?.dragToPan
        };
        
        // Disable all mouse navigation
        this.viewer.mouseNavEnabled = false;
        
        // Disable scroll handler
        if (this.viewer.innerTracker) {
            this.viewer.innerTracker.scrollHandler = false;
        }
        
        // Disable gesture settings
        if (this.viewer.gestureSettingsMouse) {
            this.viewer.gestureSettingsMouse.clickToZoom = false;
            this.viewer.gestureSettingsMouse.dblClickToZoom = false;
            this.viewer.gestureSettingsMouse.scrollToZoom = false;
            this.viewer.gestureSettingsMouse.dragToPan = false;
        }
        
        console.log('SpaceMouse: Disabled OSD navigation (pan/zoom/scroll)');
    }
    
    /**
     * Re-enable all OpenSeadragon navigation
     * Called when SpaceMouse is disconnected
     */
    _enableOSDNavigation() {
        if (!this.viewer || !this._savedNavSettings) return;
        
        // Restore mouse navigation
        this.viewer.mouseNavEnabled = this._savedNavSettings.mouseNavEnabled ?? true;
        
        // Restore scroll handler
        if (this.viewer.innerTracker && this._savedNavSettings.scrollHandler !== undefined) {
            this.viewer.innerTracker.scrollHandler = this._savedNavSettings.scrollHandler;
        }
        
        // Restore gesture settings
        if (this.viewer.gestureSettingsMouse) {
            this.viewer.gestureSettingsMouse.clickToZoom = this._savedNavSettings.clickToZoom ?? true;
            this.viewer.gestureSettingsMouse.dblClickToZoom = this._savedNavSettings.dblClickToZoom ?? true;
            this.viewer.gestureSettingsMouse.scrollToZoom = this._savedNavSettings.scrollToZoom ?? true;
            this.viewer.gestureSettingsMouse.dragToPan = this._savedNavSettings.dragToPan ?? true;
        }
        
        console.log('SpaceMouse: Restored OSD navigation');
    }
    
    /**
     * Update the viewer reference (for when viewer is recreated on study switch)
     */
    setViewer(newViewer) {
        this.viewer = newViewer;
        console.log('SpaceMouse: Viewer reference updated');
        
        // NOTE: No longer disabling OSD navigation - mouse and SpaceMouse coexist
        // if (this.connected) {
        //     this._disableOSDNavigation();
        // }
        
        // Re-attach crosshair to new viewer if it was visible
        if (this._crosshairVisible && this.connected) {
            // Remove old crosshair (it was attached to old viewer element)
            if (this._crosshair) {
                this._crosshair.remove();
                this._crosshair = null;
            }
            // Re-create in new viewer
            this.showCrosshair();
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
            console.log('%cConnection Mode: ' + this.getConnectionModeDisplay(), 'color: #6366f1; font-weight: bold');
            
            // Show screen resolution info
            if (this.viewer && this.viewer.viewport) {
                const cs = this.viewer.viewport.getContainerSize();
                const physW = cs.x * (window.devicePixelRatio || 1);
                const screenScale = (physW / REFERENCE_WIDTH).toFixed(2);
                console.log(`%cScreen: ${Math.round(cs.x)}×${Math.round(cs.y)} CSS px, ${Math.round(physW)}px physical, scale: ${screenScale}x (ref: ${REFERENCE_WIDTH}px)`, 'color: #6366f1');
            }
            
            console.log('%cMove the SpaceMouse to see live values. Zoom triggers when |rawRZ| > 200', 'color: #888');
            console.log('%cType: spaceNavController.toggleDebug() to turn OFF', 'color: #888');
            
            // Show gamepad mapping info if using Gamepad API
            if (this._connectionMode === 'gamepad') {
                console.log('%cGamepad axis mapping:', 'color: #f59e0b', this._gamepadAxesMapping);
            }
        } else {
            console.log('%c🎮 SpaceMouse DEBUG MODE: OFF', 'color: #ef4444; font-weight: bold');
        }
        return this.debugMode;
    }
    
    /**
     * Detect "tap down" gesture - push straight down and release quickly
     * Triggers fullscreen toggle
     */
    _detectFullscreenTap() {
        const rawTZ = this._rawInput?.tz || 0;
        const now = Date.now();
        const tap = this._tapDownState;
        
        // Check if pushing down (negative TZ = push down on most devices)
        const isPushingDown = rawTZ < -tap.threshold;
        
        // Also check for positive TZ (some devices/modes might invert)
        const isPushingDownAlt = rawTZ > tap.threshold;
        const isDown = isPushingDown || isPushingDownAlt;
        
        // Check that other axes are relatively quiet (it's a pure down push)
        const rawTX = Math.abs(this._rawInput?.tx || 0);
        const rawTY = Math.abs(this._rawInput?.ty || 0);
        const rawRZ = Math.abs(this._rawInput?.rz || 0);
        const isPureDown = rawTX < 80 && rawTY < 80 && rawRZ < 80;
        
        if (isDown && isPureDown && !tap.isDown) {
            // Started pressing down
            tap.isDown = true;
            tap.startTime = now;
        } else if (!isDown && tap.isDown) {
            // Released - check if it was a tap
            tap.isDown = false;
            const duration = now - tap.startTime;
            
            if (duration < tap.maxTapDuration && now - tap.lastTapTime > tap.tapCooldown) {
                // It's a tap! Toggle fullscreen
                tap.lastTapTime = now;
                this._toggleFullscreen();
            }
        }
    }
    
    /**
     * Toggle fullscreen mode for the viewer
     */
    _toggleFullscreen() {
        const viewerElement = this.viewer?.element || document.getElementById('osd-viewer');
        if (!viewerElement) return;
        
        if (document.fullscreenElement) {
            // Exit fullscreen
            document.exitFullscreen().then(() => {
                console.log('%c🎮 SpaceMouse: Exited fullscreen', 'color: #f59e0b');
            }).catch(err => {
                console.warn('Failed to exit fullscreen:', err);
            });
        } else {
            // Enter fullscreen
            viewerElement.requestFullscreen().then(() => {
                console.log('%c🎮 SpaceMouse: Entered fullscreen', 'color: #10b981');
            }).catch(err => {
                console.warn('Failed to enter fullscreen:', err);
            });
        }
    }
    
    /**
     * Get a summary of API support in this browser
     */
    static getAPISupport() {
        const webHID = SpaceNavigatorController.isWebHIDSupported();
        const gamepad = SpaceNavigatorController.isGamepadSupported();
        
        let recommended = 'None';
        if (webHID) recommended = 'WebHID';
        else if (gamepad) recommended = 'Gamepad API';
        
        return {
            webHID,
            gamepad,
            recommended,
            browser: navigator.userAgent.includes('Chrome') ? 'Chrome' :
                     navigator.userAgent.includes('Firefox') ? 'Firefox' :
                     navigator.userAgent.includes('Edge') ? 'Edge' : 'Other',
            note: webHID ? 'Full 6DOF support via WebHID' :
                  gamepad ? 'Gamepad API available (may need device interaction)' :
                  'No SpaceMouse support in this browser'
        };
    }
    
    /**
     * Get device info for debugging
     */
    getDeviceInfo() {
        if (!this.device) return null;
        
        const info = {
            productName: this.device.productName,
            connected: this.connected,
            connectionMode: this._connectionMode,
            connectionModeDisplay: this.getConnectionModeDisplay(),
            hasCalibration: !!this.calibration
        };
        
        // Add WebHID specific info
        if (this._connectionMode === 'webhid' && this.device.vendorId) {
            info.vendorId = '0x' + this.device.vendorId.toString(16);
            info.productId = '0x' + this.device.productId.toString(16);
        }
        
        // Add Gamepad API specific info
        if (this._connectionMode === 'gamepad') {
            info.gamepadIndex = this._gamepadIndex;
            info.axesMapping = this._gamepadAxesMapping;
        }
        
        return info;
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
                <input type="range" id="cfg-dead" min="0.05" max="0.3" step="0.01" value="${this.deadZone}">
            </div>
            
            <div class="param">
                <label>Curve Power <span id="cfg-curve-val">${this._curvePower || 1.2}</span></label>
                <input type="range" id="cfg-curve" min="1.0" max="3.0" step="0.1" value="${this._curvePower || 1.2}">
                <div style="color:#64748b; font-size:11px;">1.0=linear, 1.2=gentle, 2.0=quadratic</div>
            </div>
            
            <div class="param">
                <label>History Size (smoothing) <span id="cfg-history-val">${this._historySize}</span></label>
                <input type="range" id="cfg-history" min="5" max="40" step="1" value="${this._historySize}">
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
        if (!this._curvePower) this._curvePower = 1.2;
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
                
                // Calculate screen scale for display
                let screenScaleStr = '1.00';
                if (this.viewer && this.viewer.viewport) {
                    const cs = this.viewer.viewport.getContainerSize();
                    const physW = cs.x * (window.devicePixelRatio || 1);
                    screenScaleStr = (physW / REFERENCE_WIDTH).toFixed(2);
                }
                
                // Color code based on which signal is being used
                const txColor = Math.abs(rawTX) > Math.abs(rawRY) ? '#10b981' : '#64748b';
                const tyColor = Math.abs(rawTY) > Math.abs(rawRX) ? '#10b981' : '#64748b';
                const rxColor = Math.abs(rawRX) > Math.abs(rawTY) ? '#f59e0b' : '#64748b';
                const ryColor = Math.abs(rawRY) > Math.abs(rawTX) ? '#f59e0b' : '#64748b';
                
                live.innerHTML = 
                    `<div>Translation: <span style="color:${txColor}">TX:${rawTX.toString().padStart(4)}</span> <span style="color:${tyColor}">TY:${rawTY.toString().padStart(4)}</span></div>` +
                    `<div>Tilt: <span style="color:${ryColor}">RY:${rawRY.toString().padStart(4)}</span> <span style="color:${rxColor}">RX:${rawRX.toString().padStart(4)}</span> | RZ:${rawRZ.toString().padStart(4)}</div>` +
                    `<div>Output: panX:${panX} panY:${panY}</div>` +
                    `<div style="color:#6366f1;">Screen scale: ${screenScaleStr}x (ref: ${REFERENCE_WIDTH}px)</div>` +
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
        
        // Track recent button activity - driver events come slightly before WebHID
        this._lastButtonActivity = 0;
        
        // Block context menu ALWAYS when SpaceMouse is connected
        // The driver sends context menu events that we can't reliably time with button state
        const contextHandler = (e) => {
            // Block if there was recent button activity (within 500ms)
            // or if we're currently tracking a button press
            const recentActivity = (Date.now() - this._lastButtonActivity) < 500;
            if (this.buttons.left || this.buttons.right || recentActivity) {
                e.preventDefault();
                e.stopPropagation();
                console.log('SpaceMouse: Blocked context menu');
                return false;
            }
        };
        
        // Block certain keyboard shortcuts the driver might send
        const keyHandler = (e) => {
            const recentActivity = (Date.now() - this._lastButtonActivity) < 500;
            if (this.buttons.left || this.buttons.right || recentActivity) {
                // Allow essential keys
                if (['F5', 'F12', 'Escape'].includes(e.key)) return;
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        };
        
        // Block auxclick (middle mouse button that driver might trigger)
        const auxHandler = (e) => {
            const recentActivity = (Date.now() - this._lastButtonActivity) < 500;
            if (this.buttons.left || this.buttons.right || recentActivity) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        };
        
        // Block mousedown on middle/right buttons from driver
        const mouseDownHandler = (e) => {
            // Block right-click (button 2) and middle-click (button 1) if SpaceMouse active
            if ((e.button === 2 || e.button === 1) && this.connected) {
                const recentActivity = (Date.now() - this._lastButtonActivity) < 500;
                if (this.buttons.left || this.buttons.right || recentActivity) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            }
        };
        
        // Block wheel events from 3Dconnexion driver (zoom on tilt)
        // The driver sends wheel events when you tilt north/south
        const wheelHandler = (e) => {
            // Check if this is on the viewer
            const target = e.target;
            if (target.closest('#osd-viewer') || target.closest('#osd-viewer-2') || target.closest('.openseadragon-container')) {
                // Check if SpaceMouse has recent activity (within 100ms - driver events are fast)
                const recentActivity = (Date.now() - this._lastInputTime) < 100;
                // Also check if any axis is active (tilt happening)
                const hasAxisInput = Math.abs(this.rx) > 0.05 || Math.abs(this.ry) > 0.05 || Math.abs(this.rz) > 0.05 ||
                                     Math.abs(this.tx) > 0.05 || Math.abs(this.ty) > 0.05 || Math.abs(this.tz) > 0.05;
                
                if (recentActivity || hasAxisInput) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('SpaceMouse: Blocked driver wheel event');
                    return false;
                }
            }
        };
        
        document.addEventListener('contextmenu', contextHandler, true);
        document.addEventListener('keydown', keyHandler, true);
        document.addEventListener('auxclick', auxHandler, true);
        document.addEventListener('mousedown', mouseDownHandler, true);
        document.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
        
        this._suppressHandlers = { contextHandler, keyHandler, auxHandler, mouseDownHandler, wheelHandler };
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
        document.removeEventListener('mousedown', this._suppressHandlers.mouseDownHandler, true);
        if (this._suppressHandlers.wheelHandler) {
            document.removeEventListener('wheel', this._suppressHandlers.wheelHandler, { capture: true });
        }
        
        this._suppressHandlers = null;
        console.log('SpaceMouse: Event suppression disabled');
    }

    // ========== STATIC PREFERENCE MANAGEMENT ==========
    
    /**
     * Get stored preferences
     */
    static getPreferences() {
        try {
            const saved = localStorage.getItem(SPACEMOUSE_PREFS_KEY);
            return saved ? JSON.parse(saved) : null;
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Save preferences
     */
    static savePreferences(prefs) {
        try {
            const existing = SpaceNavigatorController.getPreferences() || {};
            const merged = { ...existing, ...prefs, lastUpdated: Date.now() };
            localStorage.setItem(SPACEMOUSE_PREFS_KEY, JSON.stringify(merged));
            console.log('SpaceMouse: Preferences saved');
        } catch (e) {
            console.warn('SpaceMouse: Failed to save preferences:', e);
        }
    }
    
    /**
     * Check if SpaceMouse was previously used (for early suppression)
     */
    static wasRecentlyUsed() {
        const prefs = SpaceNavigatorController.getPreferences();
        if (!prefs) return false;
        // Consider "recently used" if used within the last 30 days
        const thirtyDays = 30 * 24 * 60 * 60 * 1000;
        return prefs.lastConnected && (Date.now() - prefs.lastConnected) < thirtyDays;
    }
    
    /**
     * Enable global event suppression (can be called before controller exists)
     * This blocks 3Dconnexion driver menus/shortcuts
     */
    static enableGlobalSuppression() {
        if (_globalSuppressionEnabled) return;
        
        const contextHandler = (e) => {
            // Always block context menu on the viewer
            const target = e.target;
            if (target.closest('#osd-viewer') || target.closest('#osd-viewer-2') || target.closest('.openseadragon-container')) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        };
        
        const keyHandler = (e) => {
            // Block Ctrl+Shift combinations (3Dconnexion shortcuts)
            if (e.ctrlKey && e.shiftKey) {
                const blocked = ['KeyR', 'KeyF', 'KeyC', 'KeyV', 'Digit1', 'Digit2', 'Digit3'];
                if (blocked.includes(e.code)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        };
        
        const auxHandler = (e) => {
            // Block middle-click on viewer
            if (e.target.closest('#osd-viewer') || e.target.closest('.openseadragon-container')) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        
        const mouseDownHandler = (e) => {
            // Block right-click (button 2) on viewer areas
            if (e.button === 2) {
                const target = e.target;
                if (target.closest('#osd-viewer') || target.closest('#osd-viewer-2') || target.closest('.openseadragon-container')) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }
        };
        
        // Track wheel events for driver detection
        let lastWheelTime = 0;
        let wheelEventCount = 0;
        
        const wheelHandler = (e) => {
            const target = e.target;
            if (target.closest('#osd-viewer') || target.closest('#osd-viewer-2') || target.closest('.openseadragon-container')) {
                const now = Date.now();
                // 3Dconnexion driver sends rapid wheel events
                if (now - lastWheelTime < 50) {
                    wheelEventCount++;
                    // If we see 3+ rapid wheel events, it's likely the driver
                    if (wheelEventCount >= 2) {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log('SpaceMouse: Blocked driver wheel zoom');
                        return false;
                    }
                } else {
                    wheelEventCount = 0;
                }
                lastWheelTime = now;
            }
        };
        
        document.addEventListener('contextmenu', contextHandler, true);
        document.addEventListener('keydown', keyHandler, true);
        document.addEventListener('auxclick', auxHandler, true);
        document.addEventListener('mousedown', mouseDownHandler, true);
        document.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
        
        _globalSuppressionHandlers = { contextHandler, keyHandler, auxHandler, mouseDownHandler, wheelHandler };
        _globalSuppressionEnabled = true;
        console.log('%c🎮 SpaceMouse: Global event suppression enabled (including wheel)', 'color: #6366f1');
    }
    
    /**
     * Disable global event suppression
     */
    static disableGlobalSuppression() {
        if (!_globalSuppressionEnabled || !_globalSuppressionHandlers) return;
        
        document.removeEventListener('contextmenu', _globalSuppressionHandlers.contextHandler, true);
        document.removeEventListener('keydown', _globalSuppressionHandlers.keyHandler, true);
        document.removeEventListener('auxclick', _globalSuppressionHandlers.auxHandler, true);
        document.removeEventListener('mousedown', _globalSuppressionHandlers.mouseDownHandler, true);
        if (_globalSuppressionHandlers.wheelHandler) {
            document.removeEventListener('wheel', _globalSuppressionHandlers.wheelHandler, { capture: true });
        }
        
        _globalSuppressionHandlers = null;
        _globalSuppressionEnabled = false;
        console.log('SpaceMouse: Global event suppression disabled');
    }
    
    /**
     * Initialize early - call this on page load to set up suppression if needed
     */
    static initEarly() {
        if (SpaceNavigatorController.wasRecentlyUsed()) {
            console.log('%c🎮 SpaceMouse: Previously used, enabling early suppression', 'color: #6366f1');
            SpaceNavigatorController.enableGlobalSuppression();
            return true;
        }
        return false;
    }
}

// Auto-initialize early suppression on module load
SpaceNavigatorController.initEarly();

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SpaceNavigatorController;
}
