/**
 * Annotation and Measurement Tools for OpenSeadragon WSI Viewer
 * 
 * Features:
 * - Line measurement (distance in µm/mm)
 * - Rectangle measurement (area)
 * - Polygon annotation
 * - Point markers
 * - Arrow annotations
 * - Text labels
 * - Save/Load to server
 */

class AnnotationManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.canvas = null;
        this.fabricCanvas = null;
        this.currentTool = null;
        this.isDrawing = false;
        this.currentShape = null;
        this.annotations = [];
        this.studyId = null;
        
        // Calibration: µm per pixel (default 0.25 for ~40x objective)
        this.pixelSpacing = [0.25, 0.25];
        this.calibrationSource = 'default';
        
        // Drawing state
        this.points = [];
        this.startPoint = null;
        
        // Styles
        this.styles = {
            line: { stroke: '#00d4aa', strokeWidth: 2 },
            rectangle: { stroke: '#ff6b6b', strokeWidth: 2, fill: 'rgba(255,107,107,0.1)' },
            polygon: { stroke: '#ffd93d', strokeWidth: 2, fill: 'rgba(255,217,61,0.1)' },
            point: { fill: '#00d4aa', radius: 6 },
            arrow: { stroke: '#00d4aa', strokeWidth: 2 },
            text: { fill: '#ffffff', fontSize: 14, fontFamily: 'JetBrains Mono, monospace' }
        };
        
        this.init();
    }
    
    init() {
        // Create overlay canvas
        this.createOverlay();
        
        // Bind viewport events for coordinate transformation
        this.viewer.addHandler('zoom', () => this.updateOverlay());
        this.viewer.addHandler('pan', () => this.updateOverlay());
        this.viewer.addHandler('resize', () => this.resizeOverlay());
        this.viewer.addHandler('open', () => {
            this.resizeOverlay();
            this.updateOverlay();
        });
        
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
        
        // Insert into viewer
        const viewerElement = this.viewer.element;
        viewerElement.appendChild(this.canvas);
        
        // Initialize Fabric.js canvas
        this.fabricCanvas = new fabric.Canvas(this.canvas, {
            selection: false,
            renderOnAddRemove: true
        });
        
        // Initially disable interaction
        this.setInteractive(false);
    }
    
    resizeOverlay() {
        const container = this.viewer.element;
        const rect = container.getBoundingClientRect();
        
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.fabricCanvas.setDimensions({ width: rect.width, height: rect.height });
        
        this.updateOverlay();
    }
    
    setInteractive(interactive) {
        this.canvas.style.pointerEvents = interactive ? 'auto' : 'none';
        this.fabricCanvas.selection = interactive;
    }
    
    // Convert image coordinates to canvas coordinates
    imageToCanvas(imagePoint) {
        const viewportPoint = this.viewer.viewport.imageToViewportCoordinates(imagePoint.x, imagePoint.y);
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
    
    // Load calibration from DICOM metadata
    async loadCalibration(studyId) {
        this.studyId = studyId;
        
        try {
            const response = await fetch(`/api/studies/${studyId}/calibration`);
            if (response.ok) {
                const data = await response.json();
                this.pixelSpacing = data.pixel_spacing_um;
                this.calibrationSource = data.source;
                console.log(`Calibration loaded: ${this.pixelSpacing[0]} µm/pixel (${this.calibrationSource})`);
            }
        } catch (e) {
            console.warn('Failed to load calibration, using default:', e);
        }
    }
    
    // Load annotations from server
    async loadAnnotations(studyId) {
        this.studyId = studyId;
        this.clearAll();
        
        try {
            const response = await fetch(`/api/studies/${studyId}/annotations`);
            if (response.ok) {
                const data = await response.json();
                this.annotations = data.annotations || [];
                
                // Render each annotation
                for (const annotation of this.annotations) {
                    this.renderAnnotation(annotation);
                }
                
                console.log(`Loaded ${this.annotations.length} annotations`);
            }
        } catch (e) {
            console.warn('Failed to load annotations:', e);
        }
    }
    
    // Save annotation to server
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
                console.log('Annotation saved:', saved.id);
                return saved;
            }
        } catch (e) {
            console.error('Failed to save annotation:', e);
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
            this.updateOverlay();
            console.log('Annotation deleted:', annotationId);
        } catch (e) {
            console.error('Failed to delete annotation:', e);
        }
    }
    
    // Set active tool
    setTool(tool) {
        this.currentTool = tool;
        this.isDrawing = false;
        this.points = [];
        this.startPoint = null;
        
        // Enable/disable pan based on tool
        if (tool) {
            this.setInteractive(true);
            this.viewer.setMouseNavEnabled(false);
            this.setupToolHandlers();
        } else {
            this.setInteractive(false);
            this.viewer.setMouseNavEnabled(true);
            this.removeToolHandlers();
        }
        
        // Update cursor
        this.canvas.style.cursor = tool ? 'crosshair' : 'default';
        
        console.log('Tool set:', tool || 'pan');
    }
    
    setupToolHandlers() {
        this.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.canvas.addEventListener('dblclick', this.handleDoubleClick);
    }
    
    removeToolHandlers() {
        this.canvas.removeEventListener('mousedown', this.handleMouseDown);
        this.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.canvas.removeEventListener('mouseup', this.handleMouseUp);
        this.canvas.removeEventListener('dblclick', this.handleDoubleClick);
    }
    
    handleMouseDown = (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const canvasPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const imagePoint = this.canvasToImage(canvasPoint);
        
        switch (this.currentTool) {
            case 'line':
            case 'arrow':
            case 'rectangle':
                this.isDrawing = true;
                this.startPoint = imagePoint;
                break;
            case 'polygon':
                this.points.push(imagePoint);
                this.updateOverlay();
                break;
            case 'point':
                this.createPointAnnotation(imagePoint);
                break;
        }
    }
    
    handleMouseMove = (e) => {
        if (!this.isDrawing) return;
        
        const rect = this.canvas.getBoundingClientRect();
        const canvasPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const imagePoint = this.canvasToImage(canvasPoint);
        
        // Preview current shape
        this.previewShape(imagePoint);
    }
    
    handleMouseUp = (e) => {
        if (!this.isDrawing) return;
        
        const rect = this.canvas.getBoundingClientRect();
        const canvasPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const imagePoint = this.canvasToImage(canvasPoint);
        
        this.isDrawing = false;
        
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
    }
    
    handleDoubleClick = (e) => {
        if (this.currentTool === 'polygon' && this.points.length >= 3) {
            this.createPolygonAnnotation(this.points);
            this.points = [];
        }
    }
    
    // Preview shape while drawing
    previewShape(currentPoint) {
        this.updateOverlay();
        
        const ctx = this.canvas.getContext('2d');
        const start = this.imageToCanvas(this.startPoint);
        const end = this.imageToCanvas(currentPoint);
        
        ctx.save();
        ctx.strokeStyle = this.styles[this.currentTool]?.stroke || '#00d4aa';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        
        switch (this.currentTool) {
            case 'line':
            case 'arrow':
                ctx.beginPath();
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(end.x, end.y);
                ctx.stroke();
                
                // Show distance preview
                const dist = this.calculateDistance(this.startPoint, currentPoint);
                this.drawMeasurementLabel(ctx, (start.x + end.x) / 2, (start.y + end.y) / 2, dist);
                break;
                
            case 'rectangle':
                const width = end.x - start.x;
                const height = end.y - start.y;
                ctx.strokeRect(start.x, start.y, width, height);
                
                // Show area preview
                const area = this.calculateArea(this.startPoint, currentPoint);
                this.drawMeasurementLabel(ctx, start.x + width/2, start.y + height/2, area);
                break;
        }
        
        ctx.restore();
    }
    
    // Create line measurement annotation
    async createLineAnnotation(start, end) {
        const distance = this.calculateDistance(start, end);
        
        const annotation = {
            type: 'measurement',
            tool: 'line',
            geometry: {
                type: 'LineString',
                coordinates: [[start.x, start.y], [end.x, end.y]]
            },
            properties: {
                color: this.styles.line.stroke,
                measurement: distance,
                unit: distance.unit
            }
        };
        
        const saved = await this.saveAnnotation(annotation);
        if (saved) {
            this.renderAnnotation(saved);
        }
    }
    
    // Create rectangle annotation
    async createRectangleAnnotation(start, end) {
        const area = this.calculateArea(start, end);
        
        const annotation = {
            type: 'measurement',
            tool: 'rectangle',
            geometry: {
                type: 'Rectangle',
                coordinates: [[start.x, start.y], [end.x, end.y]]
            },
            properties: {
                color: this.styles.rectangle.stroke,
                measurement: area,
                unit: area.unit
            }
        };
        
        const saved = await this.saveAnnotation(annotation);
        if (saved) {
            this.renderAnnotation(saved);
        }
    }
    
    // Create polygon annotation
    async createPolygonAnnotation(points) {
        const area = this.calculatePolygonArea(points);
        
        const annotation = {
            type: 'region',
            tool: 'polygon',
            geometry: {
                type: 'Polygon',
                coordinates: points.map(p => [p.x, p.y])
            },
            properties: {
                color: this.styles.polygon.stroke,
                measurement: area,
                unit: area.unit
            }
        };
        
        const saved = await this.saveAnnotation(annotation);
        if (saved) {
            this.renderAnnotation(saved);
        }
    }
    
    // Create point marker
    async createPointAnnotation(point) {
        const annotation = {
            type: 'marker',
            tool: 'point',
            geometry: {
                type: 'Point',
                coordinates: [point.x, point.y]
            },
            properties: {
                color: this.styles.point.fill,
                label: `Point ${this.annotations.length + 1}`
            }
        };
        
        const saved = await this.saveAnnotation(annotation);
        if (saved) {
            this.renderAnnotation(saved);
        }
    }
    
    // Create arrow annotation
    async createArrowAnnotation(start, end) {
        const annotation = {
            type: 'marker',
            tool: 'arrow',
            geometry: {
                type: 'LineString',
                coordinates: [[start.x, start.y], [end.x, end.y]]
            },
            properties: {
                color: this.styles.arrow.stroke
            }
        };
        
        const saved = await this.saveAnnotation(annotation);
        if (saved) {
            this.renderAnnotation(saved);
        }
    }
    
    // Calculate distance in µm or mm
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
    
    // Calculate polygon area using shoelace formula
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
    
    // Draw measurement label on canvas
    drawMeasurementLabel(ctx, x, y, measurement) {
        const text = measurement.display || measurement;
        
        ctx.font = '12px JetBrains Mono, monospace';
        const metrics = ctx.measureText(text);
        const padding = 4;
        
        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(
            x - metrics.width / 2 - padding,
            y - 8 - padding,
            metrics.width + padding * 2,
            16 + padding * 2
        );
        
        // Text
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y);
    }
    
    // Render a single annotation
    renderAnnotation(annotation) {
        const ctx = this.canvas.getContext('2d');
        const props = annotation.properties || {};
        const geom = annotation.geometry;
        
        ctx.save();
        ctx.strokeStyle = props.color || '#00d4aa';
        ctx.fillStyle = props.fill || 'rgba(0, 212, 170, 0.1)';
        ctx.lineWidth = 2;
        
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
        
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        
        // End markers
        ctx.fillStyle = props.color || '#00d4aa';
        ctx.beginPath();
        ctx.arc(start.x, start.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Measurement label
        if (props.measurement) {
            this.drawMeasurementLabel(ctx, (start.x + end.x) / 2, (start.y + end.y) / 2 - 15, props.measurement);
        }
    }
    
    renderRectangle(ctx, coords, props) {
        const start = this.imageToCanvas({ x: coords[0][0], y: coords[0][1] });
        const end = this.imageToCanvas({ x: coords[1][0], y: coords[1][1] });
        
        const x = Math.min(start.x, end.x);
        const y = Math.min(start.y, end.y);
        const width = Math.abs(end.x - start.x);
        const height = Math.abs(end.y - start.y);
        
        ctx.fillStyle = props.fill || 'rgba(255, 107, 107, 0.1)';
        ctx.fillRect(x, y, width, height);
        ctx.strokeRect(x, y, width, height);
        
        // Measurement label
        if (props.measurement) {
            this.drawMeasurementLabel(ctx, x + width / 2, y + height / 2, props.measurement);
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
        
        ctx.fillStyle = props.fill || 'rgba(255, 217, 61, 0.1)';
        ctx.fill();
        ctx.stroke();
        
        // Calculate centroid for label
        const cx = canvasCoords.reduce((sum, p) => sum + p.x, 0) / canvasCoords.length;
        const cy = canvasCoords.reduce((sum, p) => sum + p.y, 0) / canvasCoords.length;
        
        if (props.measurement) {
            this.drawMeasurementLabel(ctx, cx, cy, props.measurement);
        }
    }
    
    renderPoint(ctx, coords, props) {
        const point = this.imageToCanvas({ x: coords[0], y: coords[1] });
        
        ctx.fillStyle = props.color || '#00d4aa';
        ctx.beginPath();
        ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
        ctx.fill();
        
        // Outer ring
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
        ctx.stroke();
        
        // Label
        if (props.label) {
            ctx.font = '11px JetBrains Mono';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'left';
            ctx.fillText(props.label, point.x + 12, point.y + 4);
        }
    }
    
    renderArrow(ctx, coords, props) {
        const start = this.imageToCanvas({ x: coords[0][0], y: coords[0][1] });
        const end = this.imageToCanvas({ x: coords[1][0], y: coords[1][1] });
        
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
    
    // Update overlay (redraw all annotations)
    updateOverlay() {
        const ctx = this.canvas.getContext('2d');
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Render all annotations
        for (const annotation of this.annotations) {
            this.renderAnnotation(annotation);
        }
        
        // Render polygon in progress
        if (this.currentTool === 'polygon' && this.points.length > 0) {
            ctx.save();
            ctx.strokeStyle = this.styles.polygon.stroke;
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            
            const canvasPoints = this.points.map(p => this.imageToCanvas(p));
            
            ctx.beginPath();
            ctx.moveTo(canvasPoints[0].x, canvasPoints[0].y);
            for (let i = 1; i < canvasPoints.length; i++) {
                ctx.lineTo(canvasPoints[i].x, canvasPoints[i].y);
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
    }
    
    // Clear all annotations (local only)
    clearAll() {
        this.annotations = [];
        this.points = [];
        this.updateOverlay();
    }
    
    // Get annotation list for UI
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

// Export for use in viewer
window.AnnotationManager = AnnotationManager;
