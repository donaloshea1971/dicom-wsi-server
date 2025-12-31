/**
 * DICOMweb TileSource for OpenSeadragon
 * 
 * Loads DICOM WSI pyramid images via WADO-RS frame retrieval
 * 
 * Usage:
 *   const tileSource = new DicomWebTileSource({
 *     baseUrl: '/dicom-web',
 *     studyUID: '1.2.3...',
 *     seriesUID: '1.2.3...',
 *     instanceUID: '1.2.3...',
 *     pyramidMetadata: { ... }
 *   });
 *   viewer.addTiledImage({ tileSource });
 */

(function() {
    'use strict';

    /**
     * Parse DICOM WSI metadata to extract pyramid structure
     */
    function parsePyramidMetadata(instances) {
        const levels = [];
        
        // Sort instances by TotalPixelMatrixColumns (descending = highest res first)
        const sorted = [...instances].sort((a, b) => {
            const aWidth = a['00480006']?.Value?.[0] || 0; // TotalPixelMatrixColumns
            const bWidth = b['00480006']?.Value?.[0] || 0;
            return bWidth - aWidth;
        });

        let frameOffset = 0;

        for (const instance of sorted) {
            const width = instance['00480006']?.Value?.[0];   // TotalPixelMatrixColumns
            const height = instance['00480007']?.Value?.[0];  // TotalPixelMatrixRows
            const tileWidth = instance['00280011']?.Value?.[0];  // Columns
            const tileHeight = instance['00280010']?.Value?.[0]; // Rows
            const numberOfFrames = instance['00280008']?.Value?.[0] || 1;
            const instanceUID = instance['00080018']?.Value?.[0]; // SOPInstanceUID

            if (!width || !height) continue;

            const tilesPerRow = Math.ceil(width / tileWidth);
            const tilesPerColumn = Math.ceil(height / tileHeight);

            levels.push({
                width,
                height,
                tileWidth,
                tileHeight,
                tilesPerRow,
                tilesPerColumn,
                numberOfFrames,
                instanceUID,
                frameOffset
            });

            frameOffset += numberOfFrames;
        }

        return {
            width: levels[0]?.width || 0,
            height: levels[0]?.height || 0,
            tileSize: levels[0]?.tileWidth || 256,
            levels,
            maxLevel: levels.length - 1
        };
    }

    /**
     * DICOMweb TileSource class for OpenSeadragon
     */
    class DicomWebTileSource extends OpenSeadragon.TileSource {
        constructor(options) {
            super(options);

            this.baseUrl = options.baseUrl || '/dicom-web';
            this.studyUID = options.studyUID;
            this.seriesUID = options.seriesUID;
            this.instanceUID = options.instanceUID;
            this.authToken = options.authToken || null;

            // Pyramid metadata (parsed or provided)
            this.pyramid = options.pyramidMetadata || null;

            // Initialize dimensions
            if (this.pyramid) {
                this.width = this.pyramid.width;
                this.height = this.pyramid.height;
                this.tileSize = this.pyramid.tileSize;
                this.minLevel = 0;
                this.maxLevel = this.pyramid.maxLevel;
                this.aspectRatio = this.width / this.height;
            }
        }

        /**
         * Fetch metadata for the series and parse pyramid structure
         */
        async configure() {
            try {
                // Fetch series metadata via WADO-RS
                const metadataUrl = `${this.baseUrl}/studies/${this.studyUID}/series/${this.seriesUID}/metadata`;
                
                const response = await fetch(metadataUrl, {
                    headers: this.getHeaders()
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch metadata: ${response.status}`);
                }

                const instances = await response.json();
                this.pyramid = parsePyramidMetadata(instances);

                // Update TileSource properties
                this.width = this.pyramid.width;
                this.height = this.pyramid.height;
                this.tileSize = this.pyramid.tileSize;
                this.minLevel = 0;
                this.maxLevel = this.pyramid.maxLevel;
                this.aspectRatio = this.width / this.height;

                return this;
            } catch (error) {
                console.error('DicomWebTileSource configure error:', error);
                throw error;
            }
        }

        /**
         * Get authorization headers
         */
        getHeaders() {
            const headers = {
                'Accept': 'application/dicom+json'
            };

            if (this.authToken) {
                headers['Authorization'] = `Bearer ${this.authToken}`;
            }

            return headers;
        }

        /**
         * Calculate DICOM frame number from OSD tile coordinates
         * 
         * OpenSeadragon uses level 0 = lowest resolution
         * DICOM WSI uses level 0 = highest resolution (typically)
         * 
         * We need to reverse the level indexing
         */
        calculateFrameNumber(level, x, y) {
            // Reverse level: OSD level 0 = DICOM max level
            const dicomLevel = this.pyramid.maxLevel - level;
            
            if (dicomLevel < 0 || dicomLevel >= this.pyramid.levels.length) {
                return null;
            }

            const levelInfo = this.pyramid.levels[dicomLevel];
            
            // Check bounds
            if (x < 0 || x >= levelInfo.tilesPerRow || 
                y < 0 || y >= levelInfo.tilesPerColumn) {
                return null;
            }

            // Calculate frame number (1-based for DICOM)
            // Frame layout is typically row-major
            const frameNumber = levelInfo.frameOffset + (y * levelInfo.tilesPerRow) + x + 1;
            
            return {
                frameNumber,
                instanceUID: levelInfo.instanceUID
            };
        }

        /**
         * Get tile URL for WADO-RS frame retrieval
         */
        getTileUrl(level, x, y) {
            const frameInfo = this.calculateFrameNumber(level, x, y);
            
            if (!frameInfo) {
                return null;
            }

            // WADO-RS URL for frame retrieval
            return `${this.baseUrl}/studies/${this.studyUID}` +
                   `/series/${this.seriesUID}` +
                   `/instances/${frameInfo.instanceUID}` +
                   `/frames/${frameInfo.frameNumber}`;
        }

        /**
         * Get headers for tile requests
         */
        getTileAjaxHeaders(level, x, y) {
            const headers = {
                'Accept': 'image/jpeg, image/png, image/jp2'
            };

            if (this.authToken) {
                headers['Authorization'] = `Bearer ${this.authToken}`;
            }

            return headers;
        }

        /**
         * Check if a tile exists
         */
        getTileCacheKey(level, x, y) {
            return `${this.studyUID}/${this.seriesUID}/${level}/${x}/${y}`;
        }

        /**
         * Get number of tiles at a given level
         */
        getNumTiles(level) {
            const dicomLevel = this.pyramid.maxLevel - level;
            
            if (dicomLevel < 0 || dicomLevel >= this.pyramid.levels.length) {
                return new OpenSeadragon.Point(0, 0);
            }

            const levelInfo = this.pyramid.levels[dicomLevel];
            return new OpenSeadragon.Point(levelInfo.tilesPerRow, levelInfo.tilesPerColumn);
        }

        /**
         * Get tile dimensions at a given level
         */
        getTileWidth(level) {
            const dicomLevel = this.pyramid.maxLevel - level;
            const levelInfo = this.pyramid.levels[dicomLevel];
            return levelInfo?.tileWidth || this.tileSize;
        }

        getTileHeight(level) {
            const dicomLevel = this.pyramid.maxLevel - level;
            const levelInfo = this.pyramid.levels[dicomLevel];
            return levelInfo?.tileHeight || this.tileSize;
        }

        /**
         * Get level scale factor
         */
        getLevelScale(level) {
            const dicomLevel = this.pyramid.maxLevel - level;
            const levelInfo = this.pyramid.levels[dicomLevel];
            
            if (!levelInfo) {
                return 1;
            }

            return levelInfo.width / this.pyramid.width;
        }
    }

    /**
     * Factory function to create and configure a DicomWebTileSource
     */
    async function createDicomWebTileSource(options) {
        const tileSource = new DicomWebTileSource(options);
        await tileSource.configure();
        return tileSource;
    }

    // Export to global scope
    if (typeof window !== 'undefined') {
        window.DicomWebTileSource = DicomWebTileSource;
        window.createDicomWebTileSource = createDicomWebTileSource;
        window.parsePyramidMetadata = parsePyramidMetadata;
    }

    // Export for module systems
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            DicomWebTileSource,
            createDicomWebTileSource,
            parsePyramidMetadata
        };
    }
})();

