/**
 * Annotation and Measurement Tools for OpenSeadragon WSI Viewer
 * Pure Canvas implementation (no Fabric.js dependency)
 */

class AnnotationManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.canvas = null;
        this.ctx = null;
        this.currentTool = null;
        this.isDrawing = false;
        this.annotations = [];
        this.studyId = null;
        
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
        
        // Styles
        this.styles = {
            line: { stroke: '#00d4aa', strokeWidth: 2 },
            rectangle: { stroke: '#ff6b6b', strokeWidth: 2, fill: 'rgba(255,107,107,0.1)' },
            polygon: { stroke: '#ffd93d', strokeWidth: 2, fill: 'rgba(255,217,61,0.1)' },
            point: { fill: '#00d4aa', radius: 6 },
            arrow: { stroke: '#00d4aa', strokeWidth: 2 }
        };
        
        this.init();
    }
    
    init() {
        this.createOverlay();
        
        // Bind viewport events for redrawing
        this.viewer.addHandler('animation', () => this.render());
        this.viewer.addHandler('animation-finish', () => this.render());
        this.viewer.addHandler('resize', () => this.resizeCanvas());
        
        // Initial resize
        setTimeout(() => this.resizeCanvas(), 100);
        
        console.log('AnnotationManager initialized');
    }
    
    createOverlay() {
        // Create canvas element
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'annotation-canvas';
        this.canvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 10;
        `;
        
        // Find the OSD canvas container and append our canvas
        const osdCanvas = this.viewer.element.querySelector('.openseadragon-canvas');
        if (osdCanvas) {
            osdCanvas.appendChild(this.canvas);
        } else {
            this.viewer.element.appendChild(this.canvas);
        }
        
        this.ctx = this.canvas.getContext('2d');
        console.log('Annotation canvas created');
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
            // Enable interaction
            this.canvas.style.pointerEvents = 'auto';
            this.canvas.style.cursor = 'crosshair';
            this.viewer.setMouseNavEnabled(false);
            
            // Add event listeners
            this.canvas.addEventListener('mousedown', this._onMouseDown);
            this.canvas.addEventListener('mousemove', this._onMouseMove);
            this.canvas.addEventListener('mouseup', this._onMouseUp);
            this.canvas.addEventListener('dblclick', this._onDblClick);
            
            console.log('Tool enabled:', tool);
        } else {
            // Disable interaction (pan mode)
            this.canvas.style.pointerEvents = 'none';
            this.canvas.style.cursor = 'default';
            this.viewer.setMouseNavEnabled(true);
            console.log('Pan mode enabled');
        }
        
        this.render();
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
    
    onMouseUp(e) {
        if (!this.isDrawing) return;
        
        const canvasPoint = this.getCanvasPoint(e);
        const imagePoint = this.canvasToImage(canvasPoint);
        
        console.log('MouseUp:', this.currentTool, imagePoint);
        
        this.isDrawing = false;
        
        // Check minimum distance to avoid accidental clicks
        if (this.startPoint) {
            const dx = Math.abs(imagePoint.x - this.startPoint.x);
            const dy = Math.abs(imagePoint.y - this.startPoint.y);
            
            if (dx < 5 && dy < 5) {
                console.log('Too small, ignoring');
                this.startPoint = null;
                this.currentEndPoint = null;
                this.render();
                return;
            }
        }
        
        switch (this.currentTool) {
            case 'line':
                this.createLineAnnotation(this.startPoint, imagePoint);
                break;
            case 'arrow':
                this.createArrowAnnotation(this.startPoint, imagePoint);
                break;
            case 'rectangle':
                this.createRectangleAnnotation(this.startPoint, imagePoint);
                break;
        }
        
        this.startPoint = null;
        this.currentEndPoint = null;
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
            const response = await fetch(`/api/studies/${studyId}/calibration`);
            if (response.ok) {
                const data = await response.json();
                this.pixelSpacing = data.pixel_spacing_um;
                this.calibrationSource = data.source;
                console.log(`Calibration: ${this.pixelSpacing[0]} µm/px (${this.calibrationSource})`);
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
            const response = await fetch(`/api/studies/${studyId}/annotations`);
            if (response.ok) {
                const data = await response.json();
                this.annotations = data.annotations || [];
                console.log(`Loaded ${this.annotations.length} annotations`);
                this.render();
            }
        } catch (e) {
            console.warn('Failed to load annotations:', e);
        }
    }
    
    // Save annotation
    async saveAnnotation(annotation) {
        if (!this.studyId) return null;
        
        try {
            const response = await fetch(`/api/studies/${this.studyId}/annotations`, {
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
            }
        } catch (e) {
            console.error('Failed to save:', e);
        }
        return null;
    }
    
    // Delete annotation
    async deleteAnnotation(annotationId) {
        if (!this.studyId) return;
        
        try {
            await fetch(`/api/studies/${this.studyId}/annotations/${annotationId}`, {
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
    
    // Create annotations
    async createLineAnnotation(start, end) {
        const measurement = this.calculateDistance(start, end);
        await this.saveAnnotation({
            type: 'measurement',
            tool: 'line',
            geometry: { type: 'LineString', coordinates: [[start.x, start.y], [end.x, end.y]] },
            properties: { color: this.styles.line.stroke, measurement }
        });
    }
    
    async createRectangleAnnotation(start, end) {
        const measurement = this.calculateArea(start, end);
        await this.saveAnnotation({
            type: 'measurement',
            tool: 'rectangle',
            geometry: { type: 'Rectangle', coordinates: [[start.x, start.y], [end.x, end.y]] },
            properties: { color: this.styles.rectangle.stroke, measurement }
        });
    }
    
    async createPolygonAnnotation(points) {
        const measurement = this.calculatePolygonArea(points);
        await this.saveAnnotation({
            type: 'region',
            tool: 'polygon',
            geometry: { type: 'Polygon', coordinates: points.map(p => [p.x, p.y]) },
            properties: { color: this.styles.polygon.stroke, measurement }
        });
    }
    
    async createPointAnnotation(point) {
        await this.saveAnnotation({
            type: 'marker',
            tool: 'point',
            geometry: { type: 'Point', coordinates: [point.x, point.y] },
            properties: { color: this.styles.point.fill, label: `Point ${this.annotations.length + 1}` }
        });
    }
    
    async createArrowAnnotation(start, end) {
        await this.saveAnnotation({
            type: 'marker',
            tool: 'arrow',
            geometry: { type: 'LineString', coordinates: [[start.x, start.y], [end.x, end.y]] },
            properties: { color: this.styles.arrow.stroke }
        });
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
        if (coords.length < 3) return;
        
        const canvasCoords = coords.map(c => this.imageToCanvas({ x: c[0], y: c[1] }));
        
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
        
        // Label
        if (props.label) {
            ctx.font = '11px JetBrains Mono, monospace';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(props.label, point.x + 12, point.y + 4);
        }
    }
    
    renderArrow(ctx, coords, props) {
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
            label: a.properties?.label || null
        }));
    }
}

// Export
window.AnnotationManager = AnnotationManager;
