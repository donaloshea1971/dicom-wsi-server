/**
 * Annotation and Measurement Tools for OpenSeadragon WSI Viewer
 * Pure Canvas implementation (no Fabric.js dependency)
 */

class AnnotationManager {
    constructor(viewer, options = {}) {
        this.viewer = viewer;
        this.canvas = null;
        this.ctx = null;
        this.currentTool = null;
        this.isDrawing = false;
        this.annotations = [];
        this.studyId = null;
        this.initialized = false;
        
        // Auth function for API calls (optional, set via setAuthFunction)
        this.authFetch = options.authFetch || null;
        
        // Calibration: µm per pixel (default 0.25 for ~40x objective)
        this.pixelSpacing = [0.25, 0.25];
        this.calibrationSource = 'default';
        
        // Drawing state
        this.points = [];
        this.startPoint = null;
        this.currentEndPoint = null;
        
        // Bound event handlers (for removal)
        this._onMouseDown = this.onMouseDown.bind(this);
        this._onMouseMove = this.onMouseMove.bind(this);
        this._onMouseUp = this.onMouseUp.bind(this);
        this._onDblClick = this.onDblClick.bind(this);
        this._onAnimation = () => this.render();
        this._onResize = () => this.resizeCanvas();
        
        // Styles
        this.styles = {
            line: { stroke: '#00d4aa', strokeWidth: 2 },
            rectangle: { stroke: '#ff6b6b', strokeWidth: 2, fill: 'rgba(255,107,107,0.1)' },
            polygon: { stroke: '#ffd93d', strokeWidth: 2, fill: 'rgba(255,217,61,0.1)' },
            point: { fill: '#00d4aa', radius: 6 },
            arrow: { stroke: '#00d4aa', strokeWidth: 2 }
        };
    }
    
    /**
     * Set the auth fetch function for authenticated API calls
     */
    setAuthFunction(authFetchFn) {
        this.authFetch = authFetchFn;
    }
    
    /**
     * Make an authenticated fetch request, falling back to regular fetch if no auth function
     */
    async _fetch(url, options = {}) {
        if (this.authFetch) {
            return this.authFetch(url, options);
        }
        return fetch(url, options);
    }
    
    init() {
        if (this.initialized) {
            console.log('AnnotationManager already initialized, resetting...');
            this.reset();
        }
        
        this.createOverlay();
        
        // Bind viewport events for redrawing
        this.viewer.addHandler('animation', this._onAnimation);
        this.viewer.addHandler('animation-finish', this._onAnimation);
        this.viewer.addHandler('resize', this._onResize);
        
        // Initial resize
        setTimeout(() => this.resizeCanvas(), 100);
        
        this.initialized = true;
        console.log('AnnotationManager initialized');
    }
    
    reset() {
        // Remove old canvas if exists
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        
        // Clear state
        this.annotations = [];
        this.points = [];
        this.startPoint = null;
        this.currentEndPoint = null;
        this.isDrawing = false;
        this.currentTool = null;
        this.studyId = null;
        
        // Remove event handlers from canvas
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', this._onMouseDown);
            this.canvas.removeEventListener('mousemove', this._onMouseMove);
            this.canvas.removeEventListener('mouseup', this._onMouseUp);
            this.canvas.removeEventListener('dblclick', this._onDblClick);
        }
        
        this.canvas = null;
        this.ctx = null;
    }
    
    destroy() {
        // Remove viewer event handlers
        if (this.viewer) {
            this.viewer.removeHandler('animation', this._onAnimation);
            this.viewer.removeHandler('animation-finish', this._onAnimation);
            this.viewer.removeHandler('resize', this._onResize);
        }
        
        this.reset();
        this.initialized = false;
        console.log('AnnotationManager destroyed');
    }
    
    createOverlay() {
        // Remove ALL existing annotation canvases
        document.querySelectorAll('#annotation-canvas').forEach(el => el.remove());
        
        // Create canvas element
        // z-index must be below toolbar (50) but above OSD canvas
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'annotation-canvas';
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 20;
        `;
        
        // Append directly to the viewer element (more reliable than finding .openseadragon-canvas)
        this.viewer.element.appendChild(this.canvas);
        
        this.ctx = this.canvas.getContext('2d');
        console.log('Annotation canvas created and attached to viewer');
    }
    
    resizeCanvas() {
        const rect = this.viewer.element.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.render();
    }
    
    // Convert image coordinates to canvas coordinates
    imageToCanvas(imagePoint) {
        const viewportPoint = this.viewer.viewport.imageToViewportCoordinates(
            new OpenSeadragon.Point(imagePoint.x, imagePoint.y)
        );
        const webPoint = this.viewer.viewport.viewportToViewerElementCoordinates(viewportPoint);
        return { x: webPoint.x, y: webPoint.y };
    }
    
    // Convert canvas coordinates to image coordinates
    canvasToImage(canvasPoint) {
        const viewportPoint = this.viewer.viewport.viewerElementToViewportCoordinates(
            new OpenSeadragon.Point(canvasPoint.x, canvasPoint.y)
        );
        const imagePoint = this.viewer.viewport.viewportToImageCoordinates(viewportPoint);
        return { x: imagePoint.x, y: imagePoint.y };
    }
    
    // Set active tool
    setTool(tool) {
        if (!this.canvas) {
            console.error('setTool: canvas not ready');
            return;
        }
        
        this.currentTool = tool;
        this.isDrawing = false;
        this.points = [];
        this.startPoint = null;
        this.currentEndPoint = null;
        
        // Remove existing handlers
        this.canvas.removeEventListener('mousedown', this._onMouseDown);
        this.canvas.removeEventListener('mousemove', this._onMouseMove);
        this.canvas.removeEventListener('mouseup', this._onMouseUp);
        this.canvas.removeEventListener('dblclick', this._onDblClick);
        
        if (tool) {
            // Enable interaction - pointer-events:auto makes canvas receive clicks
            // OSD will still get events that pass through (when not on canvas)
            this.canvas.style.pointerEvents = 'auto';
            this.canvas.style.cursor = 'crosshair';
            
            // Add event listeners
            this.canvas.addEventListener('mousedown', this._onMouseDown);
            this.canvas.addEventListener('mousemove', this._onMouseMove);
            this.canvas.addEventListener('mouseup', this._onMouseUp);
            this.canvas.addEventListener('dblclick', this._onDblClick);
            
            console.log('Tool enabled:', tool);
        } else {
            // Disable interaction (pan mode) - pointer-events:none lets clicks pass through to OSD
            this.canvas.style.pointerEvents = 'none';
            this.canvas.style.cursor = 'default';
            
            console.log('Pan mode enabled');
        }
        
        this.render();
    }
    
    // Check if manager is ready for interaction
    isReady() {
        return this.initialized && this.canvas && this.ctx;
    }
    
    getCanvasPoint(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }
    
    onMouseDown(e) {
        const canvasPoint = this.getCanvasPoint(e);
        const imagePoint = this.canvasToImage(canvasPoint);
        
        console.log('MouseDown:', this.currentTool, canvasPoint, imagePoint);
        
        switch (this.currentTool) {
            case 'line':
            case 'arrow':
            case 'rectangle':
                this.isDrawing = true;
                this.startPoint = imagePoint;
                break;
            case 'polygon':
                this.points.push(imagePoint);
                this.render();
                break;
            case 'point':
                this.createPointAnnotation(imagePoint);
                break;
        }
    }
    
    onMouseMove(e) {
        if (!this.isDrawing && this.currentTool !== 'polygon') return;
        
        const canvasPoint = this.getCanvasPoint(e);
        const imagePoint = this.canvasToImage(canvasPoint);
        
        if (this.isDrawing) {
            this.currentEndPoint = imagePoint;
            this.render();
        } else if (this.currentTool === 'polygon' && this.points.length > 0) {
            this.currentEndPoint = imagePoint;
            this.render();
        }
    }
    
    async onMouseUp(e) {
        if (!this.isDrawing) return;
        
        const canvasPoint = this.getCanvasPoint(e);
        const imagePoint = this.canvasToImage(canvasPoint);
        
        console.log('MouseUp:', this.currentTool, imagePoint);
        
        // Reset drawing state immediately
        this.isDrawing = false;
        const start = this.startPoint;
        const tool = this.currentTool;
        
        // Clear points
        this.startPoint = null;
        this.currentEndPoint = null;
        
        // Check minimum distance to avoid accidental clicks
        if (start) {
            const dx = Math.abs(imagePoint.x - start.x);
            const dy = Math.abs(imagePoint.y - start.y);
            
            if (dx < 5 && dy < 5) {
                console.log('Too small, ignoring');
                this.render();
                return;
            }
        }
        
        // Create annotation (async but don't block)
        try {
            switch (tool) {
                case 'line':
                    await this.createLineAnnotation(start, imagePoint);
                    break;
                case 'arrow':
                    await this.createArrowAnnotation(start, imagePoint);
                    break;
                case 'rectangle':
                    await this.createRectangleAnnotation(start, imagePoint);
                    break;
            }
        } catch (err) {
            console.error('Failed to create annotation:', err);
        }
        
        // Ensure render happens
        this.render();
        console.log('Ready for next annotation');
    }
    
    onDblClick(e) {
        if (this.currentTool === 'polygon' && this.points.length >= 3) {
            this.createPolygonAnnotation([...this.points]);
            this.points = [];
            this.currentEndPoint = null;
            this.render();
        }
    }
    
    // Load calibration
    async loadCalibration(studyId) {
        this.studyId = studyId;
        
        try {
            const response = await this._fetch(`/api/studies/${studyId}/calibration`);
            if (response.ok) {
                const data = await response.json();
                this.pixelSpacing = data.pixel_spacing_um;
                this.calibrationSource = data.source;
                console.log(`Calibration: ${this.pixelSpacing[0]} µm/px (${this.calibrationSource})`);
            } else if (response.status === 401) {
                console.warn('Authentication required for calibration data - using defaults');
                // Keep default calibration values
            } else {
                console.warn('Failed to load calibration:', response.status, response.statusText);
            }
        } catch (e) {
            console.warn('Failed to load calibration:', e);
        }
    }
    
    // Load annotations
    async loadAnnotations(studyId) {
        this.studyId = studyId;
        this.annotations = [];
        
        try {
            const response = await this._fetch(`/api/studies/${studyId}/annotations`);
            if (response.ok) {
                const data = await response.json();
                this.annotations = data.annotations || [];
                console.log(`Loaded ${this.annotations.length} annotations`);
                this.render();
            } else if (response.status === 401) {
                console.warn('Authentication required to load annotations - starting with empty state');
                // User can still create annotations if they authenticate
            } else {
                console.warn('Failed to load annotations:', response.status, response.statusText);
            }
        } catch (e) {
            console.warn('Failed to load annotations:', e);
        }
    }
    
    // Save annotation
    async saveAnnotation(annotation) {
        if (!this.studyId) return null;
        
        try {
            const response = await this._fetch(`/api/studies/${this.studyId}/annotations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(annotation)
            });
            
            if (response.ok) {
                const saved = await response.json();
                this.annotations.push(saved);
                console.log('Saved annotation:', saved.id);
                this.render();
                
                // Update panel if visible
                if (typeof updateAnnotationsList === 'function') {
                    updateAnnotationsList();
                }
                
                return saved;
            } else if (response.status === 401) {
                console.error('Authentication required to save annotations');
                alert('You must be logged in to save annotations. Please refresh the page and log in.');
                return null;
            } else {
                console.error('Failed to save annotation:', response.status, response.statusText);
                const errorText = await response.text().catch(() => 'Unknown error');
                console.error('Error details:', errorText);
                alert(`Failed to save annotation: ${response.statusText}`);
                return null;
            }
        } catch (e) {
            console.error('Failed to save:', e);
            alert('Network error: Unable to save annotation');
        }
        return null;
    }
    
    // Delete annotation
    async deleteAnnotation(annotationId) {
        if (!this.studyId) return;
        
        try {
            await this._fetch(`/api/studies/${this.studyId}/annotations/${annotationId}`, {
                method: 'DELETE'
            });
            this.annotations = this.annotations.filter(a => a.id !== annotationId);
            this.render();
        } catch (e) {
            console.error('Failed to delete:', e);
        }
    }
    
    // Calculate distance
    calculateDistance(p1, p2) {
        const dx = (p2.x - p1.x) * this.pixelSpacing[0];
        const dy = (p2.y - p1.y) * this.pixelSpacing[1];
        const distUm = Math.sqrt(dx * dx + dy * dy);
        
        if (distUm >= 1000) {
            return { value: distUm / 1000, unit: 'mm', display: `${(distUm / 1000).toFixed(2)} mm` };
        }
        return { value: distUm, unit: 'µm', display: `${distUm.toFixed(1)} µm` };
    }
    
    // Calculate rectangle area
    calculateArea(p1, p2) {
        const width = Math.abs(p2.x - p1.x) * this.pixelSpacing[0];
        const height = Math.abs(p2.y - p1.y) * this.pixelSpacing[1];
        const areaUm2 = width * height;
        
        if (areaUm2 >= 1000000) {
            return { value: areaUm2 / 1000000, unit: 'mm²', display: `${(areaUm2 / 1000000).toFixed(3)} mm²` };
        }
        return { value: areaUm2, unit: 'µm²', display: `${areaUm2.toFixed(0)} µm²` };
    }
    
    // Calculate polygon area (shoelace formula)
    calculatePolygonArea(points) {
        let area = 0;
        const n = points.length;
        
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            area += points[i].x * points[j].y;
            area -= points[j].x * points[i].y;
        }
        
        area = Math.abs(area) / 2;
        const areaUm2 = area * this.pixelSpacing[0] * this.pixelSpacing[1];
        
        if (areaUm2 >= 1000000) {
            return { value: areaUm2 / 1000000, unit: 'mm²', display: `${(areaUm2 / 1000000).toFixed(3)} mm²` };
        }
        return { value: areaUm2, unit: 'µm²', display: `${areaUm2.toFixed(0)} µm²` };
    }
    
    // Get current zoom level for storing with annotation
    getCurrentZoom() {
        try {
            return this.viewer.viewport.getZoom();
        } catch (e) {
            return 1;
        }
    }
    
    // Create annotations (with zoom level capture)
    async createLineAnnotation(start, end) {
        const measurement = this.calculateDistance(start, end);
        await this.saveAnnotation({
            type: 'measurement',
            tool: 'line',
            geometry: { type: 'LineString', coordinates: [[start.x, start.y], [end.x, end.y]] },
            properties: { 
                color: this.styles.line.stroke, 
                measurement,
                zoom: this.getCurrentZoom()
            }
        });
    }
    
    async createRectangleAnnotation(start, end) {
        const measurement = this.calculateArea(start, end);
        await this.saveAnnotation({
            type: 'measurement',
            tool: 'rectangle',
            geometry: { type: 'Rectangle', coordinates: [[start.x, start.y], [end.x, end.y]] },
            properties: { 
                color: this.styles.rectangle.stroke, 
                measurement,
                zoom: this.getCurrentZoom()
            }
        });
    }
    
    async createPolygonAnnotation(points) {
        const measurement = this.calculatePolygonArea(points);
        await this.saveAnnotation({
            type: 'region',
            tool: 'polygon',
            geometry: { type: 'Polygon', coordinates: points.map(p => [p.x, p.y]) },
            properties: { 
                color: this.styles.polygon.stroke, 
                measurement,
                zoom: this.getCurrentZoom()
            }
        });
    }
    
    async createPointAnnotation(point) {
        await this.saveAnnotation({
            type: 'marker',
            tool: 'point',
            geometry: { type: 'Point', coordinates: [point.x, point.y] },
            properties: { 
                color: this.styles.point.fill, 
                label: `Point ${this.annotations.length + 1}`,
                zoom: this.getCurrentZoom()
            }
        });
    }
    
    async createArrowAnnotation(start, end) {
        await this.saveAnnotation({
            type: 'marker',
            tool: 'arrow',
            geometry: { type: 'LineString', coordinates: [[start.x, start.y], [end.x, end.y]] },
            properties: { 
                color: this.styles.arrow.stroke,
                zoom: this.getCurrentZoom()
            }
        });
    }
    
    // Navigate to an annotation
    goToAnnotation(annotationId) {
        const annotation = this.annotations.find(a => a.id === annotationId);
        if (!annotation) {
            console.warn('Annotation not found:', annotationId);
            return;
        }
        
        const geom = annotation.geometry;
        const props = annotation.properties || {};
        
        // Calculate center and bounds based on geometry type
        let centerX, centerY;
        
        switch (geom.type) {
            case 'Point':
                centerX = geom.coordinates[0];
                centerY = geom.coordinates[1];
                break;
            case 'LineString':
            case 'Rectangle':
                // Center of two points
                centerX = (geom.coordinates[0][0] + geom.coordinates[1][0]) / 2;
                centerY = (geom.coordinates[0][1] + geom.coordinates[1][1]) / 2;
                break;
            case 'Polygon':
                // Centroid
                centerX = geom.coordinates.reduce((sum, c) => sum + c[0], 0) / geom.coordinates.length;
                centerY = geom.coordinates.reduce((sum, c) => sum + c[1], 0) / geom.coordinates.length;
                break;
            default:
                console.warn('Unknown geometry type:', geom.type);
                return;
        }
        
        // Convert image coordinates to viewport coordinates
        const viewportPoint = this.viewer.viewport.imageToViewportCoordinates(
            new OpenSeadragon.Point(centerX, centerY)
        );
        
        // Use stored zoom or calculate appropriate zoom
        const zoom = props.zoom || this.viewer.viewport.getZoom();
        
        // Animate to the annotation
        this.viewer.viewport.panTo(viewportPoint, false);
        this.viewer.viewport.zoomTo(zoom, null, false);
        
        console.log('Navigated to annotation:', annotationId, 'at zoom:', zoom);
        
        // Flash the annotation briefly
        this.highlightAnnotation(annotationId);
    }
    
    // Highlight an annotation (for hover or flash)
    // If highlight is boolean: true = highlight on, false = highlight off
    // If highlight is undefined: flash briefly
    highlightAnnotation(annotationId, highlight) {
        const annotation = this.annotations.find(a => a.id === annotationId);
        if (!annotation) return;
        
        if (!annotation.properties) annotation.properties = {};
        
        if (highlight === true) {
            // Persistent highlight on
            if (!annotation.properties._originalColor) {
                annotation.properties._originalColor = annotation.properties.color;
            }
            annotation.properties.color = '#00ffaa';
            annotation.properties._highlighted = true;
            this.render();
        } else if (highlight === false) {
            // Highlight off
            if (annotation.properties._highlighted) {
                annotation.properties.color = annotation.properties._originalColor;
                delete annotation.properties._originalColor;
                delete annotation.properties._highlighted;
            }
            this.render();
        } else {
            // Brief flash (original behavior)
            const originalColor = annotation.properties.color;
            annotation.properties._originalColor = originalColor;
            annotation.properties.color = '#ffff00';
            this.render();
            
            setTimeout(() => {
                if (annotation.properties && !annotation.properties._highlighted) {
                    annotation.properties.color = annotation.properties._originalColor || originalColor;
                    delete annotation.properties._originalColor;
                }
                this.render();
            }, 500);
        }
    }
    
    // Render all annotations
    render() {
        if (!this.ctx) return;
        
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Render saved annotations
        for (const annotation of this.annotations) {
            this.renderAnnotation(ctx, annotation);
        }
        
        // Render current drawing preview
        if (this.isDrawing && this.startPoint && this.currentEndPoint) {
            this.renderPreview(ctx);
        }
        
        // Render polygon in progress
        if (this.currentTool === 'polygon' && this.points.length > 0) {
            this.renderPolygonPreview(ctx);
        }
    }
    
    renderPreview(ctx) {
        const start = this.imageToCanvas(this.startPoint);
        const end = this.imageToCanvas(this.currentEndPoint);
        
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 2;
        
        switch (this.currentTool) {
            case 'line':
            case 'arrow':
                ctx.strokeStyle = this.styles.line.stroke;
                ctx.beginPath();
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
                ctx.stroke();
                
                // Preview measurement
                const dist = this.calculateDistance(this.startPoint, this.currentEndPoint);
                this.drawLabel(ctx, (start.x + end.x) / 2, (start.y + end.y) / 2 - 15, dist.display);
                break;
                
            case 'rectangle':
                ctx.strokeStyle = this.styles.rectangle.stroke;
                const x = Math.min(start.x, end.x);
                const y = Math.min(start.y, end.y);
                const w = Math.abs(end.x - start.x);
                const h = Math.abs(end.y - start.y);
                ctx.strokeRect(x, y, w, h);
                
                // Preview area
                const area = this.calculateArea(this.startPoint, this.currentEndPoint);
                this.drawLabel(ctx, x + w/2, y + h/2, area.display);
                break;
        }
        
        ctx.restore();
    }
    
    renderPolygonPreview(ctx) {
        if (this.points.length === 0) return;
        
        const canvasPoints = this.points.map(p => this.imageToCanvas(p));
        
        ctx.save();
        ctx.strokeStyle = this.styles.polygon.stroke;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        
        ctx.beginPath();
        ctx.moveTo(canvasPoints[0].x, canvasPoints[0].y);
        
        for (let i = 1; i < canvasPoints.length; i++) {
            ctx.lineTo(canvasPoints[i].x, canvasPoints[i].y);
        }
        
        // Line to cursor
        if (this.currentEndPoint) {
            const cursorPoint = this.imageToCanvas(this.currentEndPoint);
            ctx.lineTo(cursorPoint.x, cursorPoint.y);
        }
        
        ctx.stroke();
        
        // Draw points
        ctx.fillStyle = this.styles.polygon.stroke;
        for (const p of canvasPoints) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.restore();
    }
    
    renderAnnotation(ctx, annotation) {
        const props = annotation.properties || {};
        const geom = annotation.geometry;
        
        ctx.save();
        
        switch (annotation.tool) {
            case 'line':
                this.renderLine(ctx, geom.coordinates, props);
                break;
            case 'rectangle':
                this.renderRectangle(ctx, geom.coordinates, props);
                break;
            case 'polygon':
                this.renderPolygon(ctx, geom.coordinates, props);
                break;
            case 'point':
                this.renderPoint(ctx, geom.coordinates, props);
                break;
            case 'arrow':
                this.renderArrow(ctx, geom.coordinates, props);
                break;
        }
        
        ctx.restore();
    }
    
    renderLine(ctx, coords, props) {
        // Validate coords format
        if (!coords || !Array.isArray(coords) || coords.length < 2 ||
            !coords[0] || !coords[1] || coords[0].length < 2 || coords[1].length < 2) {
            console.warn('Invalid line coords:', coords);
            return;
        }
        
        const start = this.imageToCanvas({ x: coords[0][0], y: coords[0][1] });
        const end = this.imageToCanvas({ x: coords[1][0], y: coords[1][1] });
        
        ctx.strokeStyle = props.color || this.styles.line.stroke;
        ctx.lineWidth = 2;
        
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        
        // End markers
        ctx.fillStyle = props.color || this.styles.line.stroke;
        ctx.beginPath();
        ctx.arc(start.x, start.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Label
        if (props.measurement) {
            this.drawLabel(ctx, (start.x + end.x) / 2, (start.y + end.y) / 2 - 15, props.measurement.display);
        }
    }
    
    renderRectangle(ctx, coords, props) {
        // Validate coords format
        if (!coords || !Array.isArray(coords) || coords.length < 2 ||
            !coords[0] || !coords[1] || coords[0].length < 2 || coords[1].length < 2) {
            console.warn('Invalid rectangle coords:', coords);
            return;
        }
        
        const start = this.imageToCanvas({ x: coords[0][0], y: coords[0][1] });
        const end = this.imageToCanvas({ x: coords[1][0], y: coords[1][1] });
        
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        
        ctx.fillStyle = 'rgba(255, 107, 107, 0.1)';
        ctx.fillRect(x, y, w, h);
        
        ctx.strokeStyle = props.color || this.styles.rectangle.stroke;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        
        if (props.measurement) {
            this.drawLabel(ctx, x + w/2, y + h/2, props.measurement.display);
        }
    }
    
    renderPolygon(ctx, coords, props) {
        // Validate coords format
        if (!coords || !Array.isArray(coords) || coords.length < 3) {
            console.warn('Invalid polygon coords:', coords);
            return;
        }
        
        const canvasCoords = coords.map(c => {
            if (!c || c.length < 2) return { x: 0, y: 0 };
            return this.imageToCanvas({ x: c[0], y: c[1] });
        });
        
        ctx.beginPath();
        ctx.moveTo(canvasCoords[0].x, canvasCoords[0].y);
        for (let i = 1; i < canvasCoords.length; i++) {
            ctx.lineTo(canvasCoords[i].x, canvasCoords[i].y);
        }
        ctx.closePath();
        
        ctx.fillStyle = 'rgba(255, 217, 61, 0.15)';
        ctx.fill();
        
        ctx.strokeStyle = props.color || this.styles.polygon.stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Centroid
        const cx = canvasCoords.reduce((sum, p) => sum + p.x, 0) / canvasCoords.length;
        const cy = canvasCoords.reduce((sum, p) => sum + p.y, 0) / canvasCoords.length;
        
        if (props.measurement) {
            this.drawLabel(ctx, cx, cy, props.measurement.display);
        }
    }
    
    renderPoint(ctx, coords, props) {
        // Validate coords format (point is [x, y] not [[x, y]])
        if (!coords || coords.length < 2) {
            console.warn('Invalid point coords:', coords);
            return;
        }
        
        const point = this.imageToCanvas({ x: coords[0], y: coords[1] });
        
        // Outer ring
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
        ctx.stroke();
        
        // Inner dot
        ctx.fillStyle = props.color || this.styles.point.fill;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.fill();
        
        // Label (custom or default)
        const label = props.label;
        if (label) {
            ctx.font = '11px JetBrains Mono, monospace';
            // Background for better readability
            const metrics = ctx.measureText(label);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(point.x + 10, point.y - 6, metrics.width + 6, 14);
            // Text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, point.x + 13, point.y + 4);
        }
    }
    
    renderArrow(ctx, coords, props) {
        // Validate coords format
        if (!coords || !Array.isArray(coords) || coords.length < 2 ||
            !coords[0] || !coords[1] || coords[0].length < 2 || coords[1].length < 2) {
            console.warn('Invalid arrow coords:', coords);
            return;
        }
        
        const start = this.imageToCanvas({ x: coords[0][0], y: coords[0][1] });
        const end = this.imageToCanvas({ x: coords[1][0], y: coords[1][1] });
        
        ctx.strokeStyle = props.color || this.styles.arrow.stroke;
        ctx.lineWidth = 2;
        
        // Line
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        
        // Arrowhead
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const headLength = 12;
        
        ctx.beginPath();
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(
            end.x - headLength * Math.cos(angle - Math.PI / 6),
            end.y - headLength * Math.sin(angle - Math.PI / 6)
        );
        ctx.moveTo(end.x, end.y);
        ctx.lineTo(
            end.x - headLength * Math.cos(angle + Math.PI / 6),
            end.y - headLength * Math.sin(angle + Math.PI / 6)
        );
        ctx.stroke();
    }
    
    drawLabel(ctx, x, y, text) {
        ctx.font = '12px JetBrains Mono, monospace';
        const metrics = ctx.measureText(text);
        const padding = 4;
        
        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(
            x - metrics.width / 2 - padding,
            y - 7 - padding,
            metrics.width + padding * 2,
            14 + padding * 2
        );
        
        // Text
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y);
    }
    
    clearAll() {
        this.annotations = [];
        this.points = [];
        this.render();
    }
    
    getAnnotationList() {
        return this.annotations.map(a => ({
            id: a.id,
            tool: a.tool,
            type: a.type,
            measurement: a.properties?.measurement?.display || null,
            label: a.properties?.label || null,
            description: a.properties?.description || null
        }));
    }
}

// Export
window.AnnotationManager = AnnotationManager;
