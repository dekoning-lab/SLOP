/**
 * Adapter layer between SLOP's existing engine and the WebGL renderer
 * Converts data formats and manages renderer selection
 */

import { WebGLRenderer } from './webgl-renderer.js';
import { WebGLRendererOptimized } from './webgl-renderer-optimized.js';
import { TextureAtlas, getColor } from './texture-atlas.js';

export class RendererAdapter {
    constructor(canvas, engine, options = {}) {
        this.canvas = canvas;
        this.engine = engine;
        this.options = {
            useWebGL: true,
            cellWidth: 10,
            cellHeight: 20,
            labelWidth: 150,  // Increased to provide proper spacing from taxon labels
            headerHeight: 32,
            columnPadding: 2,
            ...options
        };

        this.columnPixelFn = options.getColumnPixelPosition || ((col) => col * this.options.cellWidth);
        this.viewportSizeProvider = options.getViewportSize || (() => ({
            width: this.canvas?.clientWidth || 0,
            height: this.canvas?.clientHeight || 0
        }));
        this.codonModeProvider = {
            isEnabled: options.isCodonMode || (() => false),
            getDisplayMode: options.getCodonDisplayMode || (() => 'nucleotide'),
            getPhase: options.getCodonPhase || (() => 1)
        };

        // Color palette provider - allows dynamic color schemes
        this.paletteColorProvider = options.getPaletteColor || null;

        this.webglRenderer = null;
        this.canvas2dContext = null;
        this.textureAtlas = null;
        this.renderMode = 'webgl'; // 'webgl' or 'canvas2d'

        // Performance stats
        this.stats = {
            fps: 0,
            renderTime: 0,
            cellCount: 0
        };

        // Cache for cell data to avoid rebuilding on every scroll
        this.cellCache = {
            cells: null,
            rowStart: -1,
            rowEnd: -1,
            colStart: -1,
            colEnd: -1,
            lastRenderData: null
        };

        this.init();
    }

    init() {
        if (this.options.useWebGL && this.checkWebGLSupport()) {
            try {
                this.initWebGL();
                this.renderMode = 'webgl';
                console.log('Using WebGL renderer');
            } catch (error) {
                console.warn('WebGL initialization failed, falling back to Canvas2D:', error);
                this.initCanvas2D();
                this.renderMode = 'canvas2d';
            }
        } else {
            this.initCanvas2D();
            this.renderMode = 'canvas2d';
        }
    }

    checkWebGLSupport() {
        try {
            const testCanvas = document.createElement('canvas');
            return !!(testCanvas.getContext('webgl2') || testCanvas.getContext('webgl'));
        } catch (e) {
            return false;
        }
    }

    initWebGL() {
        // Create texture atlas with maximum quality settings
        this.textureAtlas = new TextureAtlas({
            fontSize: 64, // Larger font for better quality when scaled
            fontFamily: 'Helvetica, Arial, sans-serif',  // Clean font
            fontWeight: '900',  // Very bold for readability
            atlasSize: 4096,  // Maximum texture size for better quality
            highDPI: true,  // Enable DPI scaling for crisp text
            padding: 8  // More padding to prevent bleeding
        });

        // Initialize optimized WebGL renderer for Stage 3 performance
        this.webglRenderer = new WebGLRendererOptimized(this.canvas, {
            onFPSUpdate: (fps, renderTime) => {
                this.stats.fps = fps;
                this.stats.renderTime = renderTime;
            },
            maxInstances: 500000,  // Support very large alignments
            enableLOD: true,       // Enable LOD for zoomed out views
            lodThreshold: 0.5      // Zoom level to switch to LOD
        });

        // Pass texture atlas to WebGL renderer
        this.webglRenderer.setTextureAtlas(this.textureAtlas);

        console.log('Using optimized WebGL renderer with GPU instancing and viewport culling');
    }

    initCanvas2D() {
        this.canvas2dContext = this.canvas.getContext('2d', {
            alpha: false,
            desynchronized: true
        });
    }

    render(visibleStartRow, visibleEndRow, visibleStartCol, visibleEndCol, scrollX, scrollY, scrollVelocity = null, draggedRow = -1) {
        if (this.renderMode === 'webgl') {
            this.renderWebGL(visibleStartRow, visibleEndRow, visibleStartCol, visibleEndCol, scrollX, scrollY, scrollVelocity, draggedRow);
        } else {
            this.renderCanvas2D(visibleStartRow, visibleEndRow, visibleStartCol, visibleEndCol, scrollX, scrollY);
        }
    }

    renderWebGL(visibleStartRow, visibleEndRow, visibleStartCol, visibleEndCol, scrollX, scrollY, scrollVelocity = null, draggedRow = -1) {
        if (!this.webglRenderer || !this.engine) {
            console.warn('Cannot render WebGL: missing', !this.webglRenderer ? 'webglRenderer' : 'engine');
            return;
        }

        // Store last render parameters for export
        this.lastRenderParams = {
            visibleStartRow,
            visibleEndRow,
            visibleStartCol,
            visibleEndCol,
            scrollX,
            scrollY,
            scrollVelocity,
            draggedRow
        };

        const startTime = performance.now();
        const seqCount = this.engine.getSequenceCount();
        const maxLength = this.engine.getMaxLength();
        if (seqCount === 0 || maxLength === 0) {
            this.stats.cellCount = 0;
            this.stats.renderTime = performance.now() - startTime;
            return;
        }

        const rowStart = Math.max(0, visibleStartRow);
        const rowEndExclusive = Math.min(seqCount, visibleEndRow + 1);
        const colStart = Math.max(0, visibleStartCol - this.options.columnPadding);
        const colEnd = Math.min(maxLength, visibleEndCol + this.options.columnPadding);

        if (rowEndExclusive <= rowStart || colEnd <= colStart) {
            this.stats.cellCount = 0;
            this.stats.renderTime = performance.now() - startTime;
            return;
        }

        // Check if we need to rebuild cells (only if data range changed)
        let cells;
        let needsDataUpdate = false;
        if (this.cellCache.rowStart !== rowStart ||
            this.cellCache.rowEnd !== rowEndExclusive ||
            this.cellCache.colStart !== colStart ||
            this.cellCache.colEnd !== colEnd) {

            // Data range changed, need to rebuild
            // Check if we're in amino acid display mode
            const codonDisplayMode = this.codonModeProvider.getDisplayMode();
            const isAminoMode = codonDisplayMode === 'amino' && this.engine.getCodonMode();

            if (rowStart === 0 && window.SLOP_DEBUG) {
                console.log(`renderer-adapter: codonDisplayMode='${codonDisplayMode}', codonMode=${this.engine.getCodonMode()}, isAminoMode=${isAminoMode}`);
            }

            const renderData = this.engine.getRenderData(rowStart, rowEndExclusive, colStart, colEnd, isAminoMode);
            const selection = this.engine.getSelectionBounds();

            cells = this.buildCells({
                renderData,
                rowStart,
                rowEnd: rowEndExclusive,
                colStart,
                colEnd,
                scrollX: 0,  // Build cells at origin, scroll handled by uniform
                scrollY: 0,
                selection,
                seqCount,
                visibleEndRow,
                draggedRow  // Pass dragged row for highlighting
            });

            // Update cache
            this.cellCache.cells = cells;
            this.cellCache.rowStart = rowStart;
            this.cellCache.rowEnd = rowEndExclusive;
            this.cellCache.colStart = colStart;
            this.cellCache.colEnd = colEnd;
            needsDataUpdate = true;
        } else {
            // Use cached cells - no position update needed!
            // Scroll is now handled by GPU uniform
            cells = this.cellCache.cells;
        }

        if (!cells || cells.length === 0) {
            this.stats.cellCount = 0;
            this.stats.renderTime = performance.now() - startTime;
            return;
        }

        const selection = this.engine.getSelectionBounds();
        const viewport = this.viewportSizeProvider();

        // Calculate zoom level based on cell size (smaller cells = zoomed out)
        const defaultCellWidth = 10;
        const defaultCellHeight = 20;
        const zoomLevel = Math.min(
            this.options.cellWidth / defaultCellWidth,
            this.options.cellHeight / defaultCellHeight
        );

        this.webglRenderer.render({
            cells,
            selection,
            needsDataUpdate,  // Tell renderer if buffers need updating
            draggedRow  // Pass dragged row for highlighting
        }, {
            cellWidth: this.options.cellWidth,
            cellHeight: this.options.cellHeight,
            labelWidth: this.options.labelWidth,
            headerHeight: this.options.headerHeight,
            scrollX,  // Pass scroll position to be used as uniform
            scrollY,
            scrollVelocity: scrollVelocity || [0, 0],
            zoomLevel,  // Pass zoom level for LOD
            viewport: {
                minX: 0,
                maxX: viewport?.width || this.canvas.width,
                minY: 0,
                maxY: viewport?.height || this.canvas.height
            }
        });

        this.stats.cellCount = cells.length;
        this.stats.renderTime = performance.now() - startTime;
    }

    buildCells({
        renderData,
        rowStart,
        colStart,
        colEnd,
        scrollX,
        scrollY,
        selection,
        seqCount,
        visibleEndRow,
        draggedRow = -1
    }) {
        const rows = renderData?.rows || [];
        const viewport = this.viewportSizeProvider();
        const viewportWidth = viewport?.width || this.canvas?.clientWidth || this.canvas?.width || Number.POSITIVE_INFINITY;
        const viewportHeight = viewport?.height || this.canvas?.clientHeight || this.canvas?.height || Number.POSITIVE_INFINITY;
        const cellWidth = this.options.cellWidth;
        const cellHeight = this.options.cellHeight;
        const labelWidth = this.options.labelWidth;
        const headerHeight = this.options.headerHeight;
        const hasSelection = selection && selection.minRow >= 0;
        const codonModeEnabled = this.codonModeProvider.isEnabled();
        const codonDisplayMode = codonModeEnabled ? this.codonModeProvider.getDisplayMode() : 'codon';
        const codonPhase = codonModeEnabled ? (this.codonModeProvider.getPhase?.() || 1) - 1 : 0;
        const isAminoDisplay = codonModeEnabled && codonDisplayMode === 'amino';
        const isAnnotatedDisplay = codonModeEnabled && codonDisplayMode === 'annotated';
        const cells = [];

        // Calculate zoom level - when cells are very small, we need to sample
        const zoomLevel = cellWidth / 10; // Default cell width is 10

        // DISABLED: Sampling routine blocked per user request - always render full detail
        // if (zoomLevel < 0.3) {
        //     return this.buildSampledCells({
        //         rows, rowStart, colStart, colEnd, scrollX, scrollY,
        //         selection, seqCount, visibleEndRow, draggedRow,
        //         cellWidth, cellHeight, labelWidth, headerHeight,
        //         hasSelection, viewport: { width: viewportWidth, height: viewportHeight }
        //     });
        // }

        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
            const rowData = rows[rowIdx];
            const actualRow = rowStart + rowIdx;
            // Build cells at their world positions (not viewport-relative)
            // Scroll will be applied via GPU uniform
            const baseY = headerHeight + actualRow * cellHeight;

            // Don't skip rows - GPU will handle culling

            const chars = rowData?.chars || '';
            const colors = rowData?.colors || [];

            for (let colOffset = 0; colOffset < chars.length; colOffset++) {
                const col = colStart + colOffset;
                const char = chars[colOffset];
                if (!char || char === ' ') continue;

                // Build cells at world positions
                let baseX = labelWidth + this.columnPixelFn(col);
                // Don't skip columns - GPU will handle culling

                // Use palette provider for colors if available, otherwise use engine colors
                let color;
                if (this.paletteColorProvider && !codonModeEnabled) {
                    // Use dynamic palette colors for nucleotides
                    color = this.getColorForChar(char, false);
                } else {
                    // Use engine colors
                    const colorInt = colors[colOffset];
                    color = this.colorFromInt(colorInt);
                }

                // In codon mode, override with amino acid colors from JavaScript palette
                // All three positions in a codon should have the same color
                // SKIP in amino acid display mode - colors already come from C++ via pre-translated data
                if (codonModeEnabled && this.paletteColorProvider && !isAminoDisplay) {
                    const phase = this.engine.getCodonPhase() - 1;
                    const adjusted = col - phase;

                    if (adjusted >= 0) {
                        // Find the start of the codon this position belongs to
                        const codonIndex = Math.floor(adjusted / 3);
                        const codonStart = phase + (codonIndex * 3);

                        // Get the amino acid for this codon from pre-translated sequences
                        // Use the amino_acid_sequences storage to avoid repeated translation
                        const aminoAcid = this.getAminoAcidChar(actualRow, codonStart);
                        if (aminoAcid && aminoAcid !== ' ' && aminoAcid !== '-') {
                            color = this.getColorForChar(aminoAcid, true); // true = use amino acid palette
                        }
                    }
                }

                // Mark the entire dragged row as selected to get white text on dark background
                const selected = (hasSelection && this.isCellSelected(actualRow, col, selection)) ||
                                (actualRow === draggedRow);

                let displayChar = char;
                let scale = 1.0;
                let offsetX = 0;
                let offsetY = 0;
                const extraCells = [];

                if (codonModeEnabled) {
                    const adjusted = col - codonPhase;
                    if (isAminoDisplay) {
                        // Only render at the first position of each codon
                        if (adjusted < 0 || adjusted % 3 !== 0) {
                            continue;
                        }

                        // Try to use pre-translated amino acid from renderData
                        // If char is a nucleotide (A,C,G,T), fall back to calling getAminoAcidChar
                        let aminoAcid = char;
                        if (char === 'A' || char === 'C' || char === 'G' || char === 'T' || char === 'U') {
                            // Pre-translation not available, fall back to on-demand translation
                            if (actualRow === 0 && col >= 0 && col <= 15) {
                                console.log(`Fallback at row ${actualRow} col ${col}: char='${char}'`);
                            }
                            aminoAcid = this.getAminoAcidChar(actualRow, col) || '-';
                        } else if (actualRow === 0 && col >= 0 && col <= 15) {
                            console.log(`Using pre-translated at row ${actualRow} col ${col}: char='${char}'`);
                        }
                        displayChar = aminoAcid;

                        // Update color to amino acid color
                        if (aminoAcid && aminoAcid !== '-' && aminoAcid !== ' ') {
                            color = this.getColorForChar(aminoAcid, true); // true = codon/amino acid mode
                        }
                        // Render at full cell size - texture atlas characters are pre-centered
                        scale = 1.0;
                        offsetX = 0;
                        offsetY = 0;

                        // Use columnPixelFn for consistent positioning with nucleotides
                        baseX = labelWidth + this.columnPixelFn(col);
                    } else if (isAnnotatedDisplay) {
                        if (adjusted >= 0 && adjusted % 3 === 0) {
                            // Get amino acid once and cache for both display and color
                            const aminoAcid = this.getAminoAcidChar(actualRow, col) || '-';
                            displayChar = aminoAcid;

                            // Update color to amino acid color for annotated mode
                            if (aminoAcid && aminoAcid !== '-') {
                                color = this.getColorForChar(aminoAcid, true); // true = codon/amino acid mode
                            }
                            // Render at full cell size - texture atlas characters are pre-centered
                            scale = 1.0;
                            offsetX = 0;
                            offsetY = 0;

                            // Calculate visual position for amino acid annotation
                            const codonNumber = Math.floor(adjusted / 3);
                            const aminoBaseX = labelWidth + (codonNumber * cellWidth);

                            extraCells.push(this.createAnnotationCell({
                                x: aminoBaseX,
                                y: baseY,
                                char,
                                selected,
                                cellWidth,
                                cellHeight
                            }));
                        } else {
                            const nucleotideScale = 0.7;
                            scale = nucleotideScale;
                            offsetX = this.centerWithinCell(cellWidth, nucleotideScale);
                            offsetY = this.centerWithinCell(cellHeight, nucleotideScale);
                        }
                    }
                }

                cells.push({
                    x: baseX,
                    y: baseY,
                    char: displayChar,
                    color,
                    selected,
                    offsetX,
                    offsetY,
                    scale
                });

                if (extraCells.length > 0) {
                    extraCells.forEach(extra => cells.push(extra));
                }
            }
        }

        if (visibleEndRow >= seqCount) {
            this.appendConsensusCells({
                cells,
                colStart,
                colEnd,
                scrollX,
                scrollY,
                selection,
                viewportWidth,
                viewportHeight,
                cellWidth,
                cellHeight,
                labelWidth,
                headerHeight,
                seqCount
            });
        }

        return cells;
    }

    appendConsensusCells({
        cells,
        colStart,
        colEnd,
        scrollX,
        scrollY,
        selection,
        viewportWidth,
        viewportHeight,
        cellWidth,
        cellHeight,
        labelWidth,
        headerHeight,
        seqCount
    }) {
        const codonModeEnabled = this.codonModeProvider.isEnabled();
        const displayMode = codonModeEnabled ? this.codonModeProvider.getDisplayMode() : 'codon';
        const codonPhase = codonModeEnabled ? (this.codonModeProvider.getPhase?.() || 1) - 1 : 0;

        const consensus = (codonModeEnabled && displayMode === 'amino')
            ? this.engine.getAminoAcidConsensusRange(colStart, colEnd)
            : this.engine.getConsensusRange(colStart, colEnd);
        if (!consensus) return;

        const consensusRow = seqCount;
        const baseY = headerHeight + consensusRow * cellHeight;
        // Don't skip consensus row - GPU will handle culling

        const hasSelection = selection && selection.minRow >= 0;

        for (let i = 0; i < consensus.length; i++) {
            const col = colStart + i;
            const char = consensus[i];
            if (!char || char === ' ') continue;

            if (codonModeEnabled && displayMode === 'amino') {
                const adjusted = col - codonPhase;
                if (adjusted < 0 || adjusted % 3 !== 0) {
                    continue;
                }
            }

            const baseX = labelWidth + this.columnPixelFn(col);
            // Don't skip consensus columns - GPU will handle culling

            // Get conservation level for this position (0-100 percentage)
            const conservation = this.engine.getConservation(col);
            const conservationNorm = conservation / 100.0; // Normalize to 0-1

            // Get base color using the palette provider to match the alignment
            const baseColor = this.getColorForChar(char, false);

            // Modify color based on conservation level
            // High conservation = brighter/more saturated
            // Low conservation = darker/less saturated
            const brightness = 0.4 + (conservationNorm * 0.6); // Range from 0.4 to 1.0
            const saturation = 0.3 + (conservationNorm * 0.7); // Range from 0.3 to 1.0

            // Apply brightness and saturation adjustments
            const color = {
                r: Math.floor(baseColor.r * brightness + (255 - baseColor.r) * (1 - saturation) * 0.3),
                g: Math.floor(baseColor.g * brightness + (255 - baseColor.g) * (1 - saturation) * 0.3),
                b: Math.floor(baseColor.b * brightness + (255 - baseColor.b) * (1 - saturation) * 0.3),
                a: 0.8 + (conservationNorm * 0.2) // More opaque for highly conserved
            };

            const selected = hasSelection && this.isCellSelected(consensusRow, col, selection);

            let scale = 1.0;
            let offsetX = 0;
            let offsetY = 0;

            if (codonModeEnabled && displayMode === 'amino') {
                scale = 0.95;
                offsetX = this.centerWithinCell(cellWidth, scale);
                offsetY = this.centerWithinCell(cellHeight, scale);
            }

            cells.push({
                x: baseX,
                y: baseY,
                char,
                color,
                selected,
                offsetX,
                offsetY,
                scale
            });
        }
    }

    renderCanvas2D(visibleStartRow, visibleEndRow, visibleStartCol, visibleEndCol, scrollX, scrollY) {
        // Fallback to original Canvas2D rendering
        // This would call the existing renderVisible function
        if (window.renderVisibleCanvas2D) {
            window.renderVisibleCanvas2D();
        }
    }

    // Draw UI elements that aren't part of the cell grid
    renderOverlay(ctx) {
        // This can be used for rulers, labels, etc. that might still use Canvas2D
        // even when WebGL is rendering the main grid
    }

    switchRenderer(mode) {
        if (mode === this.renderMode) return;

        if (mode === 'webgl' && !this.webglRenderer) {
            this.initWebGL();
        } else if (mode === 'canvas2d' && !this.canvas2dContext) {
            this.initCanvas2D();
        }

        this.renderMode = mode;
        console.log(`Switched to ${mode} renderer`);
    }

    updateCellDimensions(cellWidth, cellHeight) {
        this.options.cellWidth = cellWidth;
        this.options.cellHeight = cellHeight;

        // Regenerate texture atlas if cell height changed significantly
        if (this.textureAtlas && Math.abs(this.textureAtlas.options.fontSize - cellHeight * 0.7) > 2) {
            this.textureAtlas = new TextureAtlas({
                fontSize: Math.floor(cellHeight * 0.7),
                fontFamily: 'JetBrains Mono, monospace'
            });

            if (this.webglRenderer) {
                const gl = this.webglRenderer.gl;
                const texture = this.textureAtlas.createGLTexture(gl);
                this.webglRenderer.textures.atlas = texture;
            }
        }
    }

    buildSampledCells(params) {
        const {
            rows, rowStart, colStart, colEnd, cellWidth, cellHeight,
            labelWidth, headerHeight, hasSelection, selection, draggedRow, viewport
        } = params;

        const cells = [];

        // Calculate sampling rate based on zoom level AND viewport
        const zoomLevel = cellWidth / 10;

        // At extreme zoom, we want roughly one sample per N pixels
        const pixelsPerSample = Math.max(2, Math.floor(10 / zoomLevel)); // More aggressive sampling
        const rowSampleRate = Math.max(1, Math.ceil(pixelsPerSample / cellHeight));
        const colSampleRate = Math.max(1, Math.ceil(pixelsPerSample / cellWidth));

        // Also limit total cells based on viewport
        const maxCellsX = Math.ceil(viewport.width / pixelsPerSample);
        const maxCellsY = Math.ceil(viewport.height / pixelsPerSample);
        const maxTotalCells = maxCellsX * maxCellsY * 2; // 2x for safety

        let cellCount = 0;

        // Sample rows - but stop if we hit max cells
        for (let rowIdx = 0; rowIdx < rows.length && cellCount < maxTotalCells; rowIdx += rowSampleRate) {
            const rowData = rows[rowIdx];
            if (!rowData) continue;

            const actualRow = rowStart + rowIdx;
            const baseY = headerHeight + actualRow * cellHeight;
            const chars = rowData?.chars || '';
            const colors = rowData?.colors || [];

            // Sample columns
            for (let colOffset = 0; colOffset < chars.length && cellCount < maxTotalCells; colOffset += colSampleRate) {
                const col = colStart + colOffset;
                const char = chars[colOffset];

                // Skip gaps but include everything else for color overview
                if (!char) continue;

                const baseX = labelWidth + this.columnPixelFn(col);

                // For very small cells, just use the dominant color in the region
                const colorIdx = colOffset < colors.length ? colors[colOffset] : 0;
                const color = getColor(colorIdx);

                // Scale cells to approximately fill the sampled space
                const scale = Math.max(rowSampleRate, colSampleRate);

                cells.push({
                    x: baseX,
                    y: baseY,
                    char: char === '-' ? ' ' : char, // Don't render gap characters at extreme zoom
                    color,
                    selected: hasSelection && this.isCellSelected(actualRow, col, selection) ||
                              actualRow === draggedRow,
                    scale: scale,
                    offsetX: 0,
                    offsetY: 0
                });

                cellCount++;
            }
        }

        console.log(`Sampled ${cells.length} cells from ${rows.length} rows at zoom ${Math.round(zoomLevel * 100)}%`);
        return cells;
    }

    getStats() {
        return {
            mode: this.renderMode,
            fps: this.stats.fps,
            renderTime: this.stats.renderTime.toFixed(2),
            cellCount: this.stats.cellCount,
            gpuMemory: this.estimateGPUMemory()
        };
    }

    clearCache() {
        // Clear the cell cache to force rebuild on next render
        this.cellCache = {
            cells: null,
            rowStart: -1,
            rowEnd: -1,
            colStart: -1,
            colEnd: -1,
            scrollX: 0,
            scrollY: 0
        };
    }

    updateCellSize(cellWidth, cellHeight) {
        // Update the cell dimensions
        this.options.cellWidth = cellWidth;
        this.options.cellHeight = cellHeight;

        // Clear cache to force rebuild with new sizes
        this.clearCache();

        // Update WebGL renderer if active
        if (this.webglRenderer) {
            // The renderer will use the new dimensions from this.options on next render
            this.webglRenderer.clearCache();
        }
    }

    updateLabelWidth(labelWidth) {
        // Update the label width
        this.options.labelWidth = labelWidth;

        // Clear cache to force rebuild with new label width
        this.clearCache();

        // Update WebGL renderer if active
        if (this.webglRenderer) {
            this.webglRenderer.clearCache();
        }
    }

    estimateGPUMemory() {
        if (!this.webglRenderer) return 0;

        // Estimate GPU memory usage
        const textureMemory = 512 * 512 * 4; // Atlas texture (RGBA)
        const bufferMemory = this.stats.cellCount * 32; // Approximate per-cell buffer data
        return ((textureMemory + bufferMemory) / 1048576).toFixed(2); // Convert to MB
    }

    destroy() {
        if (this.webglRenderer) {
            this.webglRenderer.destroy();
            this.webglRenderer = null;
        }

        if (this.textureAtlas) {
            this.textureAtlas.destroy();
            this.textureAtlas = null;
        }

        this.canvas2dContext = null;
    }

    isRowVisible(y, cellHeight, viewportHeight) {
        return !(y + cellHeight < 0 || y > viewportHeight);
    }

    isColumnVisible(x, cellWidth, viewportWidth) {
        return !(x + cellWidth < 0 || x > viewportWidth);
    }

    isCellSelected(row, col, selection) {
        if (!selection) return false;
        return row >= selection.minRow && row <= selection.maxRow &&
            col >= selection.minCol && col <= selection.maxCol;
    }

    centerWithinCell(size, scale) {
        return (size - size * scale) / 2;
    }

    createAnnotationCell({ x, y, char, selected, cellWidth, cellHeight }) {
        const scale = 0.55;
        const offsetX = cellWidth - cellWidth * scale - 2;
        const offsetY = 2;
        return {
            x,
            y,
            char,
            color: { r: 0, g: 0, b: 0, a: 0 },
            selected,
            offsetX,
            offsetY,
            scale
        };
    }

    getAminoAcidChar(row, col) {
        if (!this.engine || !this.engine.getAminoAcidAt) return '';
        const aa = this.engine.getAminoAcidAt(row, col);
        if (typeof aa === 'string' && aa.length > 0) {
            return aa[0];
        }
        if (typeof aa === 'number') {
            return String.fromCharCode(aa);
        }
        return '';
    }

    colorFromInt(colorInt) {
        if (typeof colorInt !== 'number') {
            return { r: 128, g: 128, b: 128, a: 1.0 };
        }

        const value = colorInt >>> 0;
        const r = (value >>> 24) & 0xFF;
        const g = (value >>> 16) & 0xFF;
        const b = (value >>> 8) & 0xFF;
        let a = (value & 0xFF) / 255;
        if (a === 0) a = 1.0;

        return { r, g, b, a };
    }

    /**
     * Get color for a character using the palette provider if available,
     * otherwise fall back to engine colors
     */
    getColorForChar(char, isCodonMode = false) {
        if (this.paletteColorProvider) {
            // Use dynamic palette colors
            const colorInt = this.paletteColorProvider(char, isCodonMode);
            return this.colorFromInt(colorInt);
        } else {
            // Fall back to engine colors
            const colorInt = this.engine.getColorForCharacter(char.charCodeAt(0));
            return this.colorFromInt(colorInt);
        }
    }

    colorFromChar(char, scheme = 'nucleotide') {
        const base = getColor(char, scheme) || getColor(char, 'nucleotide');
        return {
            r: base.r,
            g: base.g,
            b: base.b,
            a: 1.0
        };
    }

    // Get render data for export (uses last render parameters)
    getRenderDataForExport() {
        if (!this.lastRenderParams || !this.engine) {
            console.warn('No render parameters stored or engine not available');
            return null;
        }

        const p = this.lastRenderParams;
        const seqCount = this.engine.getSequenceCount();
        const maxLength = this.engine.getMaxLength();

        if (seqCount === 0 || maxLength === 0) {
            return null;
        }

        const rowStart = Math.max(0, p.visibleStartRow);
        const rowEndExclusive = Math.min(seqCount, p.visibleEndRow + 1);
        const colStart = Math.max(0, p.visibleStartCol - this.options.columnPadding);
        const colEnd = Math.min(maxLength, p.visibleEndCol + this.options.columnPadding);

        if (rowEndExclusive <= rowStart || colEnd <= colStart) {
            return null;
        }

        // Check if we're in amino acid display mode
        const codonDisplayMode = this.codonModeProvider.getDisplayMode();
        const isAminoMode = codonDisplayMode === 'amino' && this.engine.getCodonMode();

        // Get the render data from the engine
        const renderData = this.engine.getRenderData(rowStart, rowEndExclusive, colStart, colEnd, isAminoMode);
        const selection = this.engine.getSelectionBounds();

        // Build cells for the export
        const cells = this.buildCells({
            renderData,
            rowStart,
            rowEnd: rowEndExclusive,
            colStart,
            colEnd,
            scrollX: 0,  // Export at origin
            scrollY: 0,
            selection,
            seqCount,
            visibleEndRow: p.visibleEndRow,
            draggedRow: p.draggedRow
        });

        // Return in the format expected by WebGL renderer
        return {
            cells,
            selection,
            needsDataUpdate: true,  // Force buffer update
            draggedRow: p.draggedRow
        };
    }
}

// Export a global function that can be called from the main HTML
export function createRenderer(canvas, engine, options) {
    return new RendererAdapter(canvas, engine, options);
}
