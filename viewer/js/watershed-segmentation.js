/**
 * PathView Pro - WebGL Watershed Pipeline for Nuclear Separation
 * 
 * Pipeline: Binary mask → Distance transform → Find seeds → Watershed → Labeled output
 * 
 * Uses Jump Flooding Algorithm (JFA) for fast GPU distance transform
 */
(function() {
  'use strict';

  const WATERSHED_VERSION = 2;

  // ============== SHADER SOURCES ==============

  // Vertex shader (shared by all passes)
  const VS_QUAD = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    varying vec2 v_texCoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texCoord = a_texCoord;
    }
  `;

  // Distance Transform - Initialize pass
  const FS_DISTANCE_INIT = `
    precision highp float;
    uniform sampler2D u_mask;
    uniform vec2 u_resolution;
    varying vec2 v_texCoord;
    
    void main() {
      float mask = texture2D(u_mask, v_texCoord).r;
      
      if (mask > 0.5) {
        // Foreground: store own coordinates (as normalized 0-1)
        gl_FragColor = vec4(v_texCoord.x, v_texCoord.y, 0.0, 1.0);
      } else {
        // Background: invalid marker (large distance)
        gl_FragColor = vec4(-1.0, -1.0, 99999.0, 0.0);
      }
    }
  `;

  // Distance Transform - Jump Flooding pass
  const FS_DISTANCE_JFA = `
    precision highp float;
    uniform sampler2D u_coords;
    uniform vec2 u_resolution;
    uniform float u_step;
    varying vec2 v_texCoord;
    
    void main() {
      vec4 best = texture2D(u_coords, v_texCoord);
      vec2 myPixel = v_texCoord * u_resolution;
      
      // 8 directions + self
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          vec2 offset = vec2(float(dx), float(dy)) * u_step / u_resolution;
          vec2 sampleUV = v_texCoord + offset;
          
          if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) continue;
          
          vec4 candidate = texture2D(u_coords, sampleUV);
          
          if (candidate.a > 0.5) {
            vec2 seedPixel = candidate.xy * u_resolution;
            float dist = length(seedPixel - myPixel);
            
            if (dist < best.z || best.a < 0.5) {
              best = vec4(candidate.xy, dist, 1.0);
            }
          }
        }
      }
      
      gl_FragColor = best;
    }
  `;

  // Find seeds (local maxima in distance transform)
  // Note: WebGL 1.0 requires constant loop bounds, so we use fixed max radius
  const FS_FIND_SEEDS = `
    precision highp float;
    uniform sampler2D u_distance;
    uniform vec2 u_resolution;
    uniform float u_minSeedDistance;
    varying vec2 v_texCoord;
    
    void main() {
      vec4 center = texture2D(u_distance, v_texCoord);
      float centerDist = center.z;
      
      // Must be inside mask (has valid distance)
      if (center.a < 0.5 || centerDist < 1.0) {
        gl_FragColor = vec4(0.0);
        return;
      }
      
      // Check if local maximum in neighborhood
      // Use fixed loop bounds (max 30 pixels radius)
      bool isMax = true;
      
      for (int iy = -30; iy <= 30; iy++) {
        if (!isMax) break;
        float dy = float(iy);
        if (abs(dy) > u_minSeedDistance) continue;
        
        for (int ix = -30; ix <= 30; ix++) {
          float dx = float(ix);
          if (abs(dx) > u_minSeedDistance) continue;
          if (ix == 0 && iy == 0) continue;
          
          vec2 neighborUV = v_texCoord + vec2(dx, dy) / u_resolution;
          if (neighborUV.x < 0.0 || neighborUV.x > 1.0 || neighborUV.y < 0.0 || neighborUV.y > 1.0) continue;
          
          vec4 neighbor = texture2D(u_distance, neighborUV);
          if (neighbor.a > 0.5 && neighbor.z > centerDist) {
            isMax = false;
            break;
          }
        }
      }
      
      // Also require minimum distance value (filters tiny fragments)
      if (isMax && centerDist > u_minSeedDistance * 0.3) {
        // Encode seed with unique ID based on position
        float seedId = floor(v_texCoord.y * u_resolution.y) * u_resolution.x + floor(v_texCoord.x * u_resolution.x) + 1.0;
        gl_FragColor = vec4(seedId / 65535.0, centerDist / 255.0, 0.0, 1.0);
      } else {
        gl_FragColor = vec4(0.0);
      }
    }
  `;

  // Watershed propagation pass
  const FS_WATERSHED = `
    precision highp float;
    uniform sampler2D u_labels;
    uniform sampler2D u_distance;
    uniform sampler2D u_mask;
    uniform vec2 u_resolution;
    varying vec2 v_texCoord;
    
    void main() {
      // Not in mask = background
      float maskVal = texture2D(u_mask, v_texCoord).r;
      if (maskVal < 0.5) {
        gl_FragColor = vec4(0.0);
        return;
      }
      
      vec4 current = texture2D(u_labels, v_texCoord);
      vec4 myDist = texture2D(u_distance, v_texCoord);
      
      // Already labeled - keep it
      if (current.a > 0.5) {
        gl_FragColor = current;
        return;
      }
      
      // Find best neighboring label (highest distance value wins)
      float bestLabel = 0.0;
      float bestScore = -1.0;
      
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) continue;
          
          vec2 neighborUV = v_texCoord + vec2(float(dx), float(dy)) / u_resolution;
          if (neighborUV.x < 0.0 || neighborUV.x > 1.0 || neighborUV.y < 0.0 || neighborUV.y > 1.0) continue;
          
          vec4 neighborLabel = texture2D(u_labels, neighborUV);
          vec4 neighborDist = texture2D(u_distance, neighborUV);
          
          // Propagate from labeled neighbors, prefer those with higher distance
          if (neighborLabel.a > 0.5 && neighborDist.z > bestScore) {
            bestLabel = neighborLabel.r;
            bestScore = neighborDist.z;
          }
        }
      }
      
      if (bestScore > 0.0) {
        gl_FragColor = vec4(bestLabel, myDist.z / 255.0, 0.0, 1.0);
      } else {
        gl_FragColor = vec4(0.0);
      }
    }
  `;

  // Colorize labels for visualization
  const FS_COLORIZE = `
    precision highp float;
    uniform sampler2D u_labels;
    uniform float u_opacity;
    varying vec2 v_texCoord;
    
    // Hash for pseudo-random colors
    vec3 hashColor(float id) {
      return vec3(
        fract(sin(id * 12.9898) * 43758.5453),
        fract(sin(id * 78.233 + 1.0) * 43758.5453),
        fract(sin(id * 45.164 + 2.0) * 43758.5453)
      );
    }
    
    void main() {
      vec4 label = texture2D(u_labels, v_texCoord);
      
      if (label.a > 0.5 && label.r > 0.0) {
        float id = label.r * 65535.0;
        vec3 color = hashColor(id);
        // Boost saturation
        color = mix(vec3(0.5), color, 1.5);
        color = clamp(color, 0.0, 1.0);
        gl_FragColor = vec4(color, u_opacity);
      } else {
        gl_FragColor = vec4(0.0);
      }
    }
  `;

  // ============== WebGL HELPERS ==============

  let gl = null;
  let programs = {};
  let framebuffers = [];
  let textures = [];
  let quadBuffer = null;
  let texCoordBuffer = null;

  function initWebGL(canvas) {
    gl = canvas.getContext('webgl', { preserveDrawingBuffer: true }) || 
         canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
    
    if (!gl) {
      console.error('[Watershed] WebGL not available');
      return false;
    }

    // Check for float texture support
    const floatExt = gl.getExtension('OES_texture_float');
    if (!floatExt) {
      console.warn('[Watershed] OES_texture_float not available, using UNSIGNED_BYTE');
    }

    // Compile shaders
    programs.distanceInit = compileProgram(VS_QUAD, FS_DISTANCE_INIT);
    programs.distanceJFA = compileProgram(VS_QUAD, FS_DISTANCE_JFA);
    programs.findSeeds = compileProgram(VS_QUAD, FS_FIND_SEEDS);
    programs.watershed = compileProgram(VS_QUAD, FS_WATERSHED);
    programs.colorize = compileProgram(VS_QUAD, FS_COLORIZE);

    if (!programs.distanceInit || !programs.distanceJFA || !programs.findSeeds || 
        !programs.watershed || !programs.colorize) {
      console.error('[Watershed] Failed to compile shaders');
      return false;
    }

    // Setup quad geometry
    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1, 1,   1, -1,   1, 1,
    ]), gl.STATIC_DRAW);

    texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ]), gl.STATIC_DRAW);

    console.log('[Watershed] WebGL initialized (v' + WATERSHED_VERSION + ')');
    return true;
  }

  function compileProgram(vsSource, fsSource) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('[Watershed] VS error:', gl.getShaderInfoLog(vs));
      return null;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('[Watershed] FS error:', gl.getShaderInfoLog(fs));
      return null;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[Watershed] Link error:', gl.getProgramInfoLog(program));
      return null;
    }

    return program;
  }

  function createTexture(width, height, data) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    
    if (data) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    
    return tex;
  }

  function createFramebuffer(texture) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return fb;
  }

  function renderPass(program, uniforms, outputFB) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFB);
    gl.useProgram(program);

    // Setup attributes
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const texLoc = gl.getAttribLocation(program, 'a_texCoord');
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.enableVertexAttribArray(texLoc);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

    // Set uniforms
    let texUnit = 0;
    for (const [name, value] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(program, name);
      if (loc === null) continue;

      if (value instanceof WebGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, value);
        gl.uniform1i(loc, texUnit);
        texUnit++;
      } else if (Array.isArray(value)) {
        if (value.length === 2) gl.uniform2fv(loc, value);
        else if (value.length === 3) gl.uniform3fv(loc, value);
        else if (value.length === 4) gl.uniform4fv(loc, value);
      } else {
        gl.uniform1f(loc, value);
      }
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ============== MAIN PIPELINE ==============

  function runWatershedPipeline(binaryMask, width, height, options = {}) {
    const {
      minSeedDistance = 8,
      maxWatershedIterations = null,
      minCircularity = 0.3,
      minArea = 30,
      maxArea = 10000,
      maxEccentricity = 0.95,
    } = options;

    const t0 = performance.now();

    // Create canvas for WebGL
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    if (!initWebGL(canvas)) {
      console.error('[Watershed] WebGL init failed');
      return null;
    }

    gl.viewport(0, 0, width, height);

    // Convert binary mask to texture
    const maskData = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const v = binaryMask[i] ? 255 : 0;
      maskData[i * 4] = v;
      maskData[i * 4 + 1] = v;
      maskData[i * 4 + 2] = v;
      maskData[i * 4 + 3] = 255;
    }
    const maskTex = createTexture(width, height, maskData);

    // Ping-pong buffers
    const texA = createTexture(width, height, null);
    const texB = createTexture(width, height, null);
    const fbA = createFramebuffer(texA);
    const fbB = createFramebuffer(texB);

    let current = texA, currentFB = fbA;
    let next = texB, nextFB = fbB;

    function swap() {
      [current, next] = [next, current];
      [currentFB, nextFB] = [nextFB, currentFB];
    }

    // 1. Distance Transform Init
    renderPass(programs.distanceInit, {
      u_mask: maskTex,
      u_resolution: [width, height],
    }, currentFB);

    // 2. Distance Transform JFA passes
    const maxDim = Math.max(width, height);
    let step = Math.pow(2, Math.ceil(Math.log2(maxDim)) - 1);
    
    while (step >= 1) {
      renderPass(programs.distanceJFA, {
        u_coords: current,
        u_resolution: [width, height],
        u_step: step,
      }, nextFB);
      swap();
      step = Math.floor(step / 2);
    }

    const distanceTex = current;
    const distanceFB = currentFB;

    // 3. Find Seeds
    const seedTex = createTexture(width, height, null);
    const seedFB = createFramebuffer(seedTex);
    
    renderPass(programs.findSeeds, {
      u_distance: distanceTex,
      u_resolution: [width, height],
      u_minSeedDistance: minSeedDistance,
    }, seedFB);

    // 4. Watershed propagation
    let labelTex = seedTex;
    let labelFB = seedFB;
    
    const labelTexB = createTexture(width, height, null);
    const labelFBB = createFramebuffer(labelTexB);
    
    const iterations = maxWatershedIterations || Math.ceil(maxDim / 2);
    
    for (let i = 0; i < iterations; i++) {
      const outFB = (i % 2 === 0) ? labelFBB : seedFB;
      const outTex = (i % 2 === 0) ? labelTexB : seedTex;
      
      renderPass(programs.watershed, {
        u_labels: labelTex,
        u_distance: distanceTex,
        u_mask: maskTex,
        u_resolution: [width, height],
      }, outFB);
      
      labelTex = outTex;
      labelFB = outFB;
    }

    // 5. Read back labels
    gl.bindFramebuffer(gl.FRAMEBUFFER, labelFB);
    const labelData = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, labelData);

    // 6. Extract metrics (CPU)
    const blobs = extractBlobMetrics(labelData, width, height);

    // 7. Filter by shape
    const filtered = blobs.filter(b => 
      b.circularity >= minCircularity &&
      b.area >= minArea &&
      b.area <= maxArea &&
      b.eccentricity <= maxEccentricity
    );

    const t1 = performance.now();

    // Cleanup
    gl.deleteTexture(maskTex);
    gl.deleteTexture(texA);
    gl.deleteTexture(texB);
    gl.deleteTexture(seedTex);
    gl.deleteTexture(labelTexB);
    gl.deleteFramebuffer(fbA);
    gl.deleteFramebuffer(fbB);
    gl.deleteFramebuffer(seedFB);
    gl.deleteFramebuffer(labelFBB);

    return {
      count: filtered.length,
      totalDetected: blobs.length,
      blobs: filtered,
      labelData: labelData,
      width: width,
      height: height,
      timeMs: Math.round(t1 - t0),
    };
  }

  function extractBlobMetrics(labelData, width, height) {
    const blobs = new Map();

    // First pass: accumulate per-label stats
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Flip Y for canvas coordinates
        const srcY = height - 1 - y;
        const idx = (srcY * width + x) * 4;
        const labelVal = labelData[idx];
        
        if (labelVal === 0) continue;
        
        const label = labelVal; // Use raw value as label ID

        if (!blobs.has(label)) {
          blobs.set(label, {
            label: label,
            area: 0,
            sumX: 0,
            sumY: 0,
            minX: Infinity, maxX: -Infinity,
            minY: Infinity, maxY: -Infinity,
            boundaryPixels: 0,
            pixels: [],
          });
        }

        const b = blobs.get(label);
        b.area++;
        b.sumX += x;
        b.sumY += y;
        b.minX = Math.min(b.minX, x);
        b.maxX = Math.max(b.maxX, x);
        b.minY = Math.min(b.minY, y);
        b.maxY = Math.max(b.maxY, y);
        b.pixels.push({ x, y });
      }
    }

    // Second pass: compute derived metrics
    const results = [];
    
    for (const [label, b] of blobs) {
      if (b.area < 5) continue; // Skip tiny noise

      const centroidX = b.sumX / b.area;
      const centroidY = b.sumY / b.area;
      
      // Compute boundary pixels
      let boundaryCount = 0;
      for (const p of b.pixels) {
        if (isOnBoundary(blobs, p.x, p.y, label, width, height, labelData)) {
          boundaryCount++;
        }
      }
      const perimeter = boundaryCount || 1;
      
      // Circularity: 4πA/P²
      const circularity = (4 * Math.PI * b.area) / (perimeter * perimeter);

      // Compute second moments for eccentricity
      let mu20 = 0, mu02 = 0, mu11 = 0;
      for (const p of b.pixels) {
        const dx = p.x - centroidX;
        const dy = p.y - centroidY;
        mu20 += dx * dx;
        mu02 += dy * dy;
        mu11 += dx * dy;
      }

      // Eccentricity from eigenvalues of covariance matrix
      const delta = Math.sqrt((mu20 - mu02) ** 2 + 4 * mu11 ** 2);
      const lambda1 = (mu20 + mu02 + delta) / 2;
      const lambda2 = (mu20 + mu02 - delta) / 2;
      const eccentricity = lambda1 > 0 ? Math.sqrt(1 - Math.min(lambda2 / lambda1, 1)) : 0;

      results.push({
        label,
        area: b.area,
        centroid: { x: centroidX, y: centroidY },
        boundingBox: { 
          minX: b.minX, maxX: b.maxX, 
          minY: b.minY, maxY: b.maxY,
          width: b.maxX - b.minX + 1,
          height: b.maxY - b.minY + 1,
        },
        perimeter,
        circularity: Math.min(circularity, 1), // Cap at 1
        eccentricity,
      });
    }

    return results;
  }

  function isOnBoundary(blobs, x, y, label, width, height, labelData) {
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) return true;
      
      const srcY = height - 1 - ny;
      const idx = (srcY * width + nx) * 4;
      if (labelData[idx] !== label) return true;
    }
    return false;
  }

  // ============== VISUALIZATION ==============

  function renderLabelsToCanvas(result, canvas, opacity = 0.6) {
    if (!result || !result.labelData) return;
    
    const { labelData, width, height } = result;
    
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);

    // Simple hash for colors
    function hashColor(id) {
      const r = Math.floor((Math.sin(id * 12.9898) * 43758.5453 % 1) * 255);
      const g = Math.floor((Math.sin(id * 78.233 + 1) * 43758.5453 % 1) * 255);
      const b = Math.floor((Math.sin(id * 45.164 + 2) * 43758.5453 % 1) * 255);
      return [Math.abs(r), Math.abs(g), Math.abs(b)];
    }

    const a = Math.floor(opacity * 255);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Flip Y
        const srcY = height - 1 - y;
        const srcIdx = (srcY * width + x) * 4;
        const dstIdx = (y * width + x) * 4;
        
        const label = labelData[srcIdx];
        
        if (label > 0) {
          const [r, g, b] = hashColor(label);
          imgData.data[dstIdx] = r;
          imgData.data[dstIdx + 1] = g;
          imgData.data[dstIdx + 2] = b;
          imgData.data[dstIdx + 3] = a;
        } else {
          imgData.data[dstIdx + 3] = 0;
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  // ============== PUBLIC API ==============

  window.WatershedSegmentation = {
    run: runWatershedPipeline,
    renderToCanvas: renderLabelsToCanvas,
    version: WATERSHED_VERSION,
  };

  console.log('[Watershed] Module loaded (v' + WATERSHED_VERSION + ')');
})();
