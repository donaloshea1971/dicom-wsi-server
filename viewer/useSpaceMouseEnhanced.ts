import { useEffect, useState, useCallback, useRef } from 'react';

export interface SpaceMouseCoordinates {
  x: number;
  y: number;
  z: number;
  rx: number; // rotation x (pitch)
  ry: number; // rotation y (yaw)
  rz: number; // rotation z (roll)
}

export interface SpaceMouseState {
  isConnected: boolean;
  coordinates: SpaceMouseCoordinates;        // Raw coordinates (with deadzone)
  smoothedCoordinates: SpaceMouseCoordinates; // Smoothed with momentum
  deviceInfo?: {
    id: string;
    index: number;
    displayName?: string;
  };
}

// =====================================================
// PHYSICS CONFIGURATION
// Compare at: http://localhost:8080/spacemouse-physics-compare.html
// =====================================================
const PHYSICS_CONFIG = {
  // Deadzone - eliminates drift/jitter near center (0.08 = 8% of range)
  deadzone: 0.08,
  
  // Exponential curve power - makes fine control easier
  // 1.0 = linear, 1.2 = gentle curve, 2.0 = quadratic (very gentle near center)
  curvePower: 1.2,
  
  // Smoothing factor - how fast output follows input (0.15 = fairly responsive)
  // Higher = more responsive, Lower = smoother but laggy
  smoothing: 0.15,
  
  // History size for moving average (25 samples ~0.4s at 60fps)
  historySize: 25,
  
  // Momentum decay - how long the glide continues after you let go
  // 0.96 = long smooth glide, 0.9 = quick stop, 0 = no momentum
  momentumDecay: 0.96,
};

// =====================================================
// DEVICE DETECTION
// =====================================================
const SPACE_MOUSE_VENDOR_IDS = [
  '3Dconnexion',
  '046d', // Logitech (owns 3Dconnexion)
  '256f', // 3Dconnexion direct vendor ID
];

/**
 * Score a gamepad to determine if it's likely a SpaceMouse
 * Higher score = more likely to be a real SpaceMouse
 */
const scoreSpaceMouseGamepad = (gamepad: Gamepad): number => {
  let score = 0;
  const id = gamepad.id.toLowerCase();

  // Brand name matching
  if (id.includes('3dconnexion') || id.includes('spacemouse') || id.includes('spacenavigator')) {
    score += 50;
  }
  if (id.includes('space mouse') || id.includes('space navigator')) {
    score += 40;
  }

  // Vendor ID scoring
  if (id.includes('256f')) score += 100;  // 3Dconnexion direct
  else if (id.includes('046d')) score += 80;  // Logitech
  else if (id.includes('beef')) score += 20;  // Generic Linux mapping

  // 6 axes is the hallmark of a 6DOF device
  if (gamepad.axes.length === 6) {
    score += 100;
  } else if (gamepad.axes.length > 6) {
    score -= (gamepad.axes.length - 6) * 5;  // Probably a regular gamepad
  } else if (gamepad.axes.length >= 2) {
    score += gamepad.axes.length * 5;
  }

  // SpaceMouse typically has 2 buttons
  if (gamepad.buttons.length === 2) {
    score += 20;
  } else if (gamepad.buttons.length > 2) {
    score -= (gamepad.buttons.length - 2) * 2;
  }

  return score;
};

const findSpaceMouse = (): Gamepad | null => {
  const gamepads = navigator.getGamepads();
  let bestGamepad: Gamepad | null = null;
  let highestScore = 0;

  for (const gp of gamepads) {
    if (gp) {
      const score = scoreSpaceMouseGamepad(gp);
      if (score > highestScore) {
        highestScore = score;
        bestGamepad = gp;
      }
    }
  }

  return bestGamepad;
};

// =====================================================
// PHYSICS FUNCTIONS
// =====================================================
const createEmptyCoordinates = (): SpaceMouseCoordinates => ({
  x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0,
});

/**
 * Apply deadzone and exponential curve
 * This eliminates jitter and makes fine control easier
 */
const applyDeadzoneAndCurve = (value: number): number => {
  const { deadzone, curvePower } = PHYSICS_CONFIG;
  
  if (Math.abs(value) < deadzone) {
    return 0;
  }
  
  const sign = value > 0 ? 1 : -1;
  const absValue = Math.abs(value);
  
  // Normalize: map [deadzone, 1] -> [0, 1]
  const normalized = (absValue - deadzone) / (1 - deadzone);
  
  // Apply exponential curve
  const curved = Math.pow(normalized, curvePower);
  
  return sign * curved;
};

// =====================================================
// MAIN HOOK
// =====================================================
export const useSpaceMouse = () => {
  const [state, setState] = useState<SpaceMouseState>({
    isConnected: false,
    coordinates: createEmptyCoordinates(),
    smoothedCoordinates: createEmptyCoordinates(),
  });

  // Physics state (using refs to avoid re-renders on every frame)
  const smoothedRef = useRef<SpaceMouseCoordinates>(createEmptyCoordinates());
  const velocityRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const historyRef = useRef<Array<{ x: number; y: number }>>([]);
  const hasActiveInputRef = useRef(false);

  const updateCoordinates = useCallback(() => {
    const gamepad = findSpaceMouse();
    
    if (!gamepad) {
      // No device - but keep momentum going
      if (hasActiveInputRef.current || 
          Math.abs(velocityRef.current.x) > 0.0001 || 
          Math.abs(velocityRef.current.y) > 0.0001) {
        
        velocityRef.current.x *= PHYSICS_CONFIG.momentumDecay;
        velocityRef.current.y *= PHYSICS_CONFIG.momentumDecay;
        smoothedRef.current.x = velocityRef.current.x;
        smoothedRef.current.y = velocityRef.current.y;
        hasActiveInputRef.current = false;
        
        if (Math.abs(velocityRef.current.x) < 0.0001) velocityRef.current.x = 0;
        if (Math.abs(velocityRef.current.y) < 0.0001) velocityRef.current.y = 0;
        
        setState(prev => ({
          ...prev,
          smoothedCoordinates: { ...smoothedRef.current },
        }));
      }
      
      setState(prev => ({
        ...prev,
        isConnected: false,
        coordinates: createEmptyCoordinates(),
        deviceInfo: undefined,
      }));
      return;
    }

    // Read raw values and apply deadzone + curve
    const coordinates: SpaceMouseCoordinates = {
      x: applyDeadzoneAndCurve(gamepad.axes[0] || 0),
      y: applyDeadzoneAndCurve(gamepad.axes[1] || 0),
      z: applyDeadzoneAndCurve(gamepad.axes[2] || 0),
      rx: applyDeadzoneAndCurve(gamepad.axes[3] || 0),
      ry: applyDeadzoneAndCurve(gamepad.axes[4] || 0),
      rz: applyDeadzoneAndCurve(gamepad.axes[5] || 0),
    };

    // Add to history for moving average
    historyRef.current.push({ x: coordinates.x, y: coordinates.y });
    if (historyRef.current.length > PHYSICS_CONFIG.historySize) {
      historyRef.current.shift();
    }

    // Calculate moving average
    let avgX = 0, avgY = 0;
    for (const sample of historyRef.current) {
      avgX += sample.x;
      avgY += sample.y;
    }
    avgX /= historyRef.current.length;
    avgY /= historyRef.current.length;

    // Check for active input
    const hasInput = Math.abs(coordinates.x) > 0.001 || Math.abs(coordinates.y) > 0.001;

    if (hasInput) {
      // Active input: smooth towards target
      smoothedRef.current.x = 
        smoothedRef.current.x * (1 - PHYSICS_CONFIG.smoothing) + 
        avgX * PHYSICS_CONFIG.smoothing;
      smoothedRef.current.y = 
        smoothedRef.current.y * (1 - PHYSICS_CONFIG.smoothing) + 
        avgY * PHYSICS_CONFIG.smoothing;
      
      // Store velocity for momentum
      velocityRef.current.x = smoothedRef.current.x;
      velocityRef.current.y = smoothedRef.current.y;
      hasActiveInputRef.current = true;
    } else {
      // No input: apply momentum decay
      velocityRef.current.x *= PHYSICS_CONFIG.momentumDecay;
      velocityRef.current.y *= PHYSICS_CONFIG.momentumDecay;
      smoothedRef.current.x = velocityRef.current.x;
      smoothedRef.current.y = velocityRef.current.y;
      hasActiveInputRef.current = false;
      
      // Stop when negligible
      if (Math.abs(velocityRef.current.x) < 0.0001) velocityRef.current.x = 0;
      if (Math.abs(velocityRef.current.y) < 0.0001) velocityRef.current.y = 0;
    }

    // For Z and rotations, just use deadzone output (no smoothing needed)
    smoothedRef.current.z = coordinates.z;
    smoothedRef.current.rx = coordinates.rx;
    smoothedRef.current.ry = coordinates.ry;
    smoothedRef.current.rz = coordinates.rz;

    // Handle button presses
    const pressedButtons = gamepad.buttons
      .map((button, index) => button.pressed ? index : null)
      .filter((index): index is number => index !== null);

    if (pressedButtons.length > 0) {
      console.log('SpaceMouse buttons pressed:', pressedButtons);
    }

    setState({
      isConnected: true,
      coordinates,
      smoothedCoordinates: { ...smoothedRef.current },
      deviceInfo: {
        id: gamepad.id,
        index: gamepad.index,
        displayName: gamepad.id,
      },
    });
  }, []);

  useEffect(() => {
    let animationFrameId: number;
    let isActive = true;

    const pollGamepads = () => {
      if (isActive) {
        updateCoordinates();
        animationFrameId = requestAnimationFrame(pollGamepads);
      }
    };

    const handleGamepadConnected = (event: GamepadEvent) => {
      const score = scoreSpaceMouseGamepad(event.gamepad);
      if (score > 50) {
        console.log('SpaceMouse connected:', event.gamepad.id, `(score: ${score})`);
        updateCoordinates();
      }
    };

    const handleGamepadDisconnected = (event: GamepadEvent) => {
      const score = scoreSpaceMouseGamepad(event.gamepad);
      if (score > 50) {
        console.log('SpaceMouse disconnected:', event.gamepad.id);
        setState(prev => ({
          ...prev,
          isConnected: false,
          coordinates: createEmptyCoordinates(),
          smoothedCoordinates: createEmptyCoordinates(),
          deviceInfo: undefined,
        }));
      }
    };

    // Start polling
    pollGamepads();

    // Listen for gamepad events
    window.addEventListener('gamepadconnected', handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', handleGamepadDisconnected);

    return () => {
      isActive = false;
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      window.removeEventListener('gamepadconnected', handleGamepadConnected);
      window.removeEventListener('gamepaddisconnected', handleGamepadDisconnected);
    };
  }, [updateCoordinates]);

  return state;
};

export default useSpaceMouse;
