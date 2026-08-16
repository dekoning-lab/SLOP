/**
 * Optimized WebGL Renderer for SLOP MSA Viewer - Stage 3 Performance
 * Implements full GPU instancing, viewport culling, and efficient buffer management
 */

export class WebGLRendererOptimized {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.textureAtlas = null;
        this.options = {
            antialias: true,
            alpha: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
            desynchronized: true,
            maxInstances: 500000,  // Support very large alignments
            enableLOD: true,        // Level of detail for zoomed out views
            lodThreshold: 0.5,      // Zoom level to switch to LOD
            ...options
        };

        this.gl = null;
        this.program = null;
        this.textures = {};
        this.buffers = {};
        this.uniforms = {};
        this.attributes = {};

        // Rendering state
        this.viewMatrix = new Float32Array(16);
        this.projectionMatrix = new Float32Array(16);
        this.instanceCount = 0;
        this.maxAllocatedInstances = 0; // Will be calculated and preallocated
        this.MAX_SAFE_INSTANCES = 50000; // Conservative limit - buffer bug is now fixed

        // Device pixel ratio for proper scaling
        this.dpr = window.devicePixelRatio || 1;

        // Track canvas size to avoid unnecessary resize calls
        this.lastCanvasWidth = 0;
        this.lastCanvasHeight = 0;

        // Cache for faster rendering
        this.lastCellCount = 0;

        // Performance tracking
        this.frameCount = 0;
        this.lastFrameTime = 0;
        this.fps = 0;

        // Dirty tracking for efficient updates
        this.dirtyRegions = new Set();
        this.lastViewport = { startRow: -1, endRow: -1, startCol: -1, endCol: -1 };
        this.bufferVersion = 0;
        this.lastBufferVersion = -1;

        // LOD state
        this.currentLOD = 'full';
        this.zoomLevel = 1.0;

        // Instance data - will be allocated after we know viewport size
        this.instanceData = null;

        // Viewport culling bounds
        this.viewportBounds = {
            minX: 0, maxX: 0,
            minY: 0, maxY: 0
        };

        this.init();
    }

    allocateInstanceBuffers(size) {
        return {
            positions: new Float32Array(size * 2),
            offsets: new Float32Array(size * 2),
            colors: new Float32Array(size * 4),
            characters: new Float32Array(size),
            selected: new Float32Array(size),
            scales: new Float32Array(size * 2),
            // Add visibility flag for culling
            visible: new Uint8Array(size)
        };
    }

    init() {
        // Get WebGL context with optimal settings
        this.gl = this.canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
            desynchronized: true,
            depth: false,
            stencil: false,
            failIfMajorPerformanceCaveat: false
        }) || this.canvas.getContext('webgl', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: false,
            preserveDrawingBuffer: false,
            desynchronized: true
        });

        if (!this.gl) {
            throw new Error('WebGL not supported');
        }

        // Check WebGL version
        this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
        console.log('WebGL version:', this.isWebGL2 ? 'WebGL2' : 'WebGL1');

        // Get instancing extension for WebGL1
        if (!this.isWebGL2) {
            this.ext = this.gl.getExtension('ANGLE_instanced_arrays');
            if (!this.ext) {
                console.warn('ANGLE_instanced_arrays not supported, falling back to non-instanced rendering');
            }
        }

        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0.06, 0.09, 0.16, 1.0);  // Use opaque background to prevent flickering

        // Initialize shaders with optimizations
        this.initOptimizedShaders();
        this.initPersistentBuffers();
        this.initTextureAtlas();
        this.handleResize();

        // Preallocate buffers immediately after initialization
        // This ensures we never need to grow buffers during rendering/zooming
        this.preallocateBuffers(0.15); // MIN_ZOOM
    }

    initOptimizedShaders() {
        const gl = this.gl;

        // Vertex shader with viewport culling
        const vertexShaderSource = this.isWebGL2 ? `#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_texCoord;
in vec2 a_instancePosition;
in vec2 a_instanceOffset;
in vec4 a_instanceColor;
in float a_characterIndex;
in float a_selected;
in vec2 a_instanceScale;

uniform mat4 u_projection;
uniform vec2 u_cellSize;
uniform vec2 u_scroll;       // Scroll offset
uniform vec2 u_viewMin;     // (minX, minY)
uniform vec2 u_viewMax;     // (maxX, maxY)
uniform float u_atlasGridCols;
uniform float u_atlasGridRows;
uniform float u_lodLevel; // Add LOD uniform to vertex shader

out vec2 v_texCoord;
out vec4 v_color;
out float v_selected;
out float v_visible;

void main() {
    vec2 worldPos = a_instancePosition + a_instanceOffset - u_scroll;

    // Determine culling without .z/.w
    bool culled =
        (worldPos.x < u_viewMin.x) || (worldPos.x > u_viewMax.x) ||
        (worldPos.y < u_viewMin.y) || (worldPos.y > u_viewMax.y);

    v_visible = culled ? 0.0 : 1.0;

    // Texture coordinates
    float row = floor(a_characterIndex / u_atlasGridCols);
    float col = mod(a_characterIndex, u_atlasGridCols);
    float cellWidth = 1.0 / u_atlasGridCols;
    float cellHeight = 1.0 / u_atlasGridRows;
    vec2 charOffset = vec2(col * cellWidth, row * cellHeight);
    v_texCoord = charOffset + a_texCoord * vec2(cellWidth, cellHeight);

    // Scale & position with minimum size enforcement for simplified LOD
    vec2 effectiveCellSize = u_cellSize;
    if (u_lodLevel > 0.5) {
        // In simplified mode, enforce minimum cell size for visibility
        effectiveCellSize = max(u_cellSize, vec2(1.0, 1.0));
    }
    vec2 scaledPos = a_position * effectiveCellSize * a_instanceScale;
    vec2 finalPos = scaledPos + worldPos;

    // Always write a position; push culled instances offscreen
    vec4 pos = u_projection * vec4(finalPos, 0.0, 1.0);
    gl_Position = culled ? vec4(-10.0, -10.0, 0.0, 1.0) : pos;

    v_color = a_instanceColor;
    v_selected = a_selected;
}` : `// WebGL1 vertex shader
attribute vec2 a_position;
attribute vec2 a_texCoord;
attribute vec2 a_instancePosition;
attribute vec2 a_instanceOffset;
attribute vec4 a_instanceColor;
attribute float a_characterIndex;
attribute float a_selected;
attribute vec2 a_instanceScale;

uniform mat4 u_projection;
uniform vec2 u_cellSize;
uniform vec2 u_scroll;     // Scroll offset
uniform vec2 u_viewMin;   // (minX, minY)
uniform vec2 u_viewMax;   // (maxX, maxY)
uniform float u_atlasGridCols;
uniform float u_atlasGridRows;

varying vec2 v_texCoord;
varying vec4 v_color;
varying float v_selected;

void main() {
    vec2 worldPos = a_instancePosition + a_instanceOffset - u_scroll;

    // Texture coordinates
    float row = floor(a_characterIndex / u_atlasGridCols);
    float col = mod(a_characterIndex, u_atlasGridCols);
    float cellWidth = 1.0 / u_atlasGridCols;
    float cellHeight = 1.0 / u_atlasGridRows;
    vec2 charOffset = vec2(col * cellWidth, row * cellHeight);
    v_texCoord = charOffset + a_texCoord * vec2(cellWidth, cellHeight);

    vec2 scaledPos = a_position * u_cellSize * a_instanceScale;
    vec2 finalPos = scaledPos + worldPos;

    // "Cull" by pushing offscreen; fragment shader will just draw v_color
    bool culled =
        (worldPos.x < u_viewMin.x) || (worldPos.x > u_viewMax.x) ||
        (worldPos.y < u_viewMin.y) || (worldPos.y > u_viewMax.y);

    gl_Position = culled
      ? vec4(-10.0, -10.0, 0.0, 1.0)
      : (u_projection * vec4(finalPos, 0.0, 1.0));

    v_color = a_instanceColor;
    v_selected = a_selected;
}`;

        // Optimized fragment shader
        const fragmentShaderSource = this.isWebGL2 ? `#version 300 es
precision highp float;

uniform sampler2D u_texture;
uniform float u_time;
uniform float u_lodLevel; // 0 = full detail, 1 = simplified

in vec2 v_texCoord;
in vec4 v_color;
in float v_selected;
in float v_visible;

out vec4 fragColor;

void main() {
    if (v_visible < 0.5) discard;

    vec4 texColor = texture(u_texture, v_texCoord);
    float textAlpha = texColor.a;

    // LOD-based rendering
    if (u_lodLevel > 0.5) {
        // Simplified rendering for zoomed out view - just solid color blocks
        // Force alpha to 1.0 to ensure visibility
        fragColor = vec4(v_color.rgb, 1.0);
    } else {
        // Full quality rendering
        float smoothAlpha = smoothstep(0.3, 0.7, textAlpha);

        vec3 finalColor;
        float finalAlpha;

        if (v_color.a > 0.0) {
            if (smoothAlpha > 0.01) {
                finalColor = mix(v_color.rgb, vec3(0.0), smoothAlpha);
                finalAlpha = max(v_color.a, smoothAlpha);
            } else {
                finalColor = v_color.rgb;
                finalAlpha = v_color.a;
            }
        } else if (smoothAlpha > 0.01) {
            finalColor = vec3(0.0);
            finalAlpha = smoothAlpha;
        } else {
            discard;
        }

        if (v_selected > 0.5) {
            if (smoothAlpha > 0.3) {
                finalColor = vec3(1.0);
            } else {
                finalColor = finalColor * 0.3 + vec3(0.05, 0.05, 0.1);
            }
            finalAlpha = 1.0;
        }

        fragColor = vec4(finalColor, finalAlpha);
    }
}` : `// WebGL1 fragment shader
precision highp float;

uniform sampler2D u_texture;
uniform float u_time;
uniform float u_lodLevel;

varying vec2 v_texCoord;
varying vec4 v_color;
varying float v_selected;

void main() {
    vec4 texColor = texture2D(u_texture, v_texCoord);
    float textAlpha = texColor.a;

    if (u_lodLevel > 0.5) {
        gl_FragColor = v_color;
    } else {
        float smoothAlpha = smoothstep(0.3, 0.7, textAlpha);

        vec3 finalColor;
        float finalAlpha;

        if (v_color.a > 0.0) {
            if (smoothAlpha > 0.01) {
                finalColor = mix(v_color.rgb, vec3(0.0), smoothAlpha);
                finalAlpha = max(v_color.a, smoothAlpha);
            } else {
                finalColor = v_color.rgb;
                finalAlpha = v_color.a;
            }
        } else if (smoothAlpha > 0.01) {
            finalColor = vec3(0.0);
            finalAlpha = smoothAlpha;
        } else {
            discard;
        }

        if (v_selected > 0.5) {
            if (smoothAlpha > 0.3) {
                finalColor = vec3(1.0);
            } else {
                finalColor = finalColor * 0.3 + vec3(0.05, 0.05, 0.1);
            }
            finalAlpha = 1.0;
        }

        gl_FragColor = vec4(finalColor, finalAlpha);
    }
}`;

        // Compile shaders
        this.program = this.createShaderProgram(vertexShaderSource, fragmentShaderSource);
        if (!this.program) {
            throw new Error('Failed to create shader program');
        }
        gl.useProgram(this.program);

        // Get locations
        this.attributes = {
            position: gl.getAttribLocation(this.program, 'a_position'),
            texCoord: gl.getAttribLocation(this.program, 'a_texCoord'),
            instancePosition: gl.getAttribLocation(this.program, 'a_instancePosition'),
            instanceOffset: gl.getAttribLocation(this.program, 'a_instanceOffset'),
            instanceColor: gl.getAttribLocation(this.program, 'a_instanceColor'),
            characterIndex: gl.getAttribLocation(this.program, 'a_characterIndex'),
            selected: gl.getAttribLocation(this.program, 'a_selected'),
            instanceScale: gl.getAttribLocation(this.program, 'a_instanceScale')
        };

        this.uniforms = {
            projection: gl.getUniformLocation(this.program, 'u_projection'),
            cellSize: gl.getUniformLocation(this.program, 'u_cellSize'),
            scroll: gl.getUniformLocation(this.program, 'u_scroll'),
            viewMin: gl.getUniformLocation(this.program, 'u_viewMin'),
            viewMax: gl.getUniformLocation(this.program, 'u_viewMax'),
            atlasGridCols: gl.getUniformLocation(this.program, 'u_atlasGridCols'),
            atlasGridRows: gl.getUniformLocation(this.program, 'u_atlasGridRows'),
            texture: gl.getUniformLocation(this.program, 'u_texture'),
            time: gl.getUniformLocation(this.program, 'u_time'),
            lodLevel: gl.getUniformLocation(this.program, 'u_lodLevel')
        };
    }

    initPersistentBuffers() {
        const gl = this.gl;

        // Create persistent buffers with initial allocation
        this.buffers = {
            // Quad geometry (shared across all instances)
            positions: this.createBuffer(new Float32Array([0,0, 1,0, 1,1, 0,1])),
            texCoords: this.createBuffer(new Float32Array([0,0, 1,0, 1,1, 0,1])),
            indices: this.createBuffer(new Uint16Array([0,1,2, 0,2,3]), gl.ELEMENT_ARRAY_BUFFER),

            // Instance buffers (pre-allocated)
            instancePositions: this.createBuffer(null, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW, this.maxAllocatedInstances * 2 * 4),
            instanceOffsets: this.createBuffer(null, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW, this.maxAllocatedInstances * 2 * 4),
            instanceColors: this.createBuffer(null, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW, this.maxAllocatedInstances * 4 * 4),
            characterIndices: this.createBuffer(null, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW, this.maxAllocatedInstances * 4),
            selected: this.createBuffer(null, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW, this.maxAllocatedInstances * 4),
            instanceScales: this.createBuffer(null, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW, this.maxAllocatedInstances * 2 * 4)
        };
    }

    createBuffer(data, target = null, usage = null, size = null) {
        const gl = this.gl;
        target = target || gl.ARRAY_BUFFER;
        usage = usage || gl.STATIC_DRAW;

        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);

        if (data) {
            gl.bufferData(target, data, usage);
        } else if (size) {
            // Allocate empty buffer of specific size
            gl.bufferData(target, size, usage);
        }

        return buffer;
    }

    render(renderData, options = {}) {
        if (!renderData || !renderData.cells) return;

        const startTime = performance.now();
        const gl = this.gl;

        // Ensure projection matrix is up to date only if canvas size changed
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (width !== this.lastCanvasWidth || height !== this.lastCanvasHeight) {
            this.handleResize();
            this.lastCanvasWidth = width;
            this.lastCanvasHeight = height;
        }

        // Update LOD based on zoom
        this.updateLOD(options.zoomLevel || 1.0);

        // Clear once for all batches
        gl.clear(gl.COLOR_BUFFER_BIT);

        let cellsToRender = renderData.cells;

        // Debug at extreme zoom
        const zoom = options.zoomLevel || 1.0;
        if (zoom <= 0.12) {
            console.log(`=== RENDER DEBUG at ${(zoom*100).toFixed(1)}% ===`);
            console.log(`  Total cells: ${renderData.cells.length}`);
            console.log(`  options.cellWidth: ${options.cellWidth}`);
            console.log(`  options.cellHeight: ${options.cellHeight}`);
            console.log(`  currentLOD: ${this.currentLOD}`);

            // Check colors in source data
            if (renderData.cells.length > 0) {
                const firstFew = renderData.cells.slice(0, 5);
                console.log(`  First 5 cell colors:`, firstFew.map(c => c.color));
            }
        }

        // At extreme zoom, the shader enforces minimum 1px size
        // No downsampling needed - just render all visible cells
        // The minimum size enforcement prevents overlap

        this.prepareOptimizedInstanceData(cellsToRender, options);

        // Debug: At extreme zoom, log what we're rendering
        const zoomPercent = (options.zoomLevel || 1.0) * 100;
        if (zoomPercent <= 10.5) {
            console.log(`=== EXTREME ZOOM DEBUG ===`);
            console.log(`Rendering ${this.instanceCount} cells at ${zoomPercent.toFixed(1)}% zoom`);
            console.log(`Cell size: ${options.cellWidth}px × ${options.cellHeight}px`);
            console.log(`LOD mode: ${this.currentLOD}, LOD uniform: ${this.currentLOD === 'simplified' ? 1.0 : 0.0}`);
            if (renderData.cells.length > 0) {
                const sample = renderData.cells[0];
                console.log(`First cell:`, sample);
                // Check a few cells to see their colors
                console.log(`First 5 cells colors:`, renderData.cells.slice(0, 5).map(c => c.color));
            }
            // Check what's actually in the color buffer
            console.log(`Instance color data (first 20 values):`, Array.from(this.instanceData.colors.slice(0, 20)));
        }

        // Set uniforms
        this.setUniforms(options);

        // Bind buffers and draw
        this.setupAttributes();

        // Single instanced draw call
        if (this.isWebGL2) {
            gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.instanceCount);
        } else if (this.ext) {
            this.ext.drawElementsInstancedANGLE(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.instanceCount);
        } else {
            // Fallback for WebGL1 without extension
            for (let i = 0; i < this.instanceCount; i++) {
                gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
            }
        }

        this.updatePerformance(startTime);
    }

    renderBatched(renderData, options) {
        const gl = this.gl;
        const cells = renderData.cells;
        const batchSize = this.MAX_SAFE_INSTANCES;
        const numBatches = Math.ceil(cells.length / batchSize);

        // Process each batch
        for (let batch = 0; batch < numBatches; batch++) {
            const start = batch * batchSize;
            const end = Math.min(start + batchSize, cells.length);
            const batchCells = cells.slice(start, end);

            // Prepare and render this batch
            this.prepareOptimizedInstanceData(batchCells, options);

            // Set uniforms
            this.setUniforms(options);

            // Bind buffers and draw
            this.setupAttributes();

            // Draw this batch
            if (this.isWebGL2) {
                gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.instanceCount);
            } else if (this.ext) {
                this.ext.drawElementsInstancedANGLE(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.instanceCount);
            }
        }
    }

    cullCells(cells, options) {
        // Fast viewport culling with CSS dimensions
        const viewport = options.viewport || {
            minX: 0,
            maxX: this.canvas.clientWidth || (this.canvas.width / this.dpr),
            minY: 0,
            maxY: this.canvas.clientHeight || (this.canvas.height / this.dpr)
        };

        // Add margin for smooth scrolling
        const margin = 100;
        const minX = viewport.minX - margin;
        const maxX = viewport.maxX + margin;
        const minY = viewport.minY - margin;
        const maxY = viewport.maxY + margin;

        // Filter cells in viewport
        return cells.filter(cell => {
            return cell.x >= minX && cell.x <= maxX &&
                   cell.y >= minY && cell.y <= maxY;
        });
    }

    hasDataChanged(cells, options) {
        // Simple change detection
        const viewport = options.viewport || {};

        if (cells.length !== this.lastCellCount ||
            viewport.startRow !== this.lastViewport.startRow ||
            viewport.endRow !== this.lastViewport.endRow ||
            viewport.startCol !== this.lastViewport.startCol ||
            viewport.endCol !== this.lastViewport.endCol) {

            this.lastCellCount = cells.length;
            this.lastViewport = { ...viewport };
            return true;
        }

        return false;
    }

    prepareOptimizedInstanceData(cells, options) {
        // Simple, foolproof approach: use exactly what we're given, no complex calculations
        const requestedInstances = cells.length;

        // Grow buffers if needed (with hard cap)
        if (requestedInstances > this.maxAllocatedInstances) {
            this.growBuffers(requestedInstances);
        }

        // Set instance count - should never exceed what we allocated
        this.instanceCount = Math.min(requestedInstances, this.maxAllocatedInstances);

        // Safety check - this should NEVER trigger if downsampling is working correctly
        if (this.instanceCount !== requestedInstances) {
            console.error(`Buffer size mismatch! Requested: ${requestedInstances}, Allocated: ${this.maxAllocatedInstances}, Using: ${this.instanceCount}`);
        }

        // Fill instance data
        for (let i = 0; i < this.instanceCount; i++) {
            const cell = cells[i];
            const idx2 = i * 2;
            const idx4 = i * 4;

            this.instanceData.positions[idx2] = cell.x;
            this.instanceData.positions[idx2 + 1] = cell.y;

            this.instanceData.offsets[idx2] = cell.offsetX || 0;
            this.instanceData.offsets[idx2 + 1] = cell.offsetY || 0;

            const color = cell.color || {};
            this.instanceData.colors[idx4] = (color.r || 0) / 255;
            this.instanceData.colors[idx4 + 1] = (color.g || 0) / 255;
            this.instanceData.colors[idx4 + 2] = (color.b || 0) / 255;
            this.instanceData.colors[idx4 + 3] = color.a !== undefined ? color.a : 1.0;

            this.instanceData.characters[i] = this.getCharacterIndex(cell.char);
            this.instanceData.selected[i] = cell.selected ? 1.0 : 0.0;
            this.instanceData.scales[idx2] = cell.scale || 1.0;
            this.instanceData.scales[idx2 + 1] = cell.scale || 1.0;
        }

        // Update GPU buffers efficiently
        this.updateBuffersOptimized();
    }

    updateBuffersOptimized() {
        const gl = this.gl;

        // CRITICAL: Never write beyond allocated buffer size
        const safeInstanceCount = Math.min(this.instanceCount, this.maxAllocatedInstances);

        // Safety check - log if we're trying to exceed buffer
        if (this.instanceCount > this.maxAllocatedInstances) {
            console.warn(`Instance count ${this.instanceCount} exceeds allocated buffer ${this.maxAllocatedInstances}`);
            this.instanceCount = safeInstanceCount; // Force cap
        }

        // Use bufferSubData for partial updates when possible
        const bytesPerInstance = {
            positions: 8,  // 2 floats
            offsets: 8,
            colors: 16,   // 4 floats
            characters: 4, // 1 float
            selected: 4,
            scales: 8
        };

        // Update only the used portion of buffers with safety checks
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instancePositions);
        const posSize = Math.min(safeInstanceCount * 2, this.instanceData.positions.length);
        if (posSize > 0) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.positions.subarray(0, posSize));
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceOffsets);
        const offSize = Math.min(safeInstanceCount * 2, this.instanceData.offsets.length);
        if (offSize > 0) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.offsets.subarray(0, offSize));
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceColors);
        const colSize = Math.min(safeInstanceCount * 4, this.instanceData.colors.length);
        if (colSize > 0) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.colors.subarray(0, colSize));
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.characterIndices);
        const charSize = Math.min(safeInstanceCount, this.instanceData.characters.length);
        if (charSize > 0) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.characters.subarray(0, charSize));
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.selected);
        const selSize = Math.min(safeInstanceCount, this.instanceData.selected.length);
        if (selSize > 0) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.selected.subarray(0, selSize));
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceScales);
        const scaleSize = Math.min(safeInstanceCount * 2, this.instanceData.scales.length);
        if (scaleSize > 0) {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.scales.subarray(0, scaleSize));
        }
    }

    growBuffers(newSize) {
        const gl = this.gl;
        // Cap at safe maximum to avoid GPU memory issues
        const requestedSize = Math.ceil(newSize);
        this.maxAllocatedInstances = Math.min(requestedSize, this.MAX_SAFE_INSTANCES);

        if (requestedSize > this.MAX_SAFE_INSTANCES) {
            console.warn(`growBuffers: Requested ${requestedSize} but capping at ${this.MAX_SAFE_INSTANCES}`);
        }
        console.log(`Growing buffers to ${this.maxAllocatedInstances} instances`);

        // Reallocate instance data arrays
        const newData = this.allocateInstanceBuffers(this.maxAllocatedInstances);

        // Copy existing data if it exists
        if (this.instanceData) {
            newData.positions.set(this.instanceData.positions.subarray(0, Math.min(this.instanceData.positions.length, newData.positions.length)));
            newData.offsets.set(this.instanceData.offsets.subarray(0, Math.min(this.instanceData.offsets.length, newData.offsets.length)));
            newData.colors.set(this.instanceData.colors.subarray(0, Math.min(this.instanceData.colors.length, newData.colors.length)));
            newData.characters.set(this.instanceData.characters.subarray(0, Math.min(this.instanceData.characters.length, newData.characters.length)));
            newData.selected.set(this.instanceData.selected.subarray(0, Math.min(this.instanceData.selected.length, newData.selected.length)));
            newData.scales.set(this.instanceData.scales.subarray(0, Math.min(this.instanceData.scales.length, newData.scales.length)));
        }

        this.instanceData = newData;

        // Recreate GPU buffers with new size
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instancePositions);
        gl.bufferData(gl.ARRAY_BUFFER, this.maxAllocatedInstances * 2 * 4, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceOffsets);
        gl.bufferData(gl.ARRAY_BUFFER, this.maxAllocatedInstances * 2 * 4, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceColors);
        gl.bufferData(gl.ARRAY_BUFFER, this.maxAllocatedInstances * 4 * 4, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.characterIndices);
        gl.bufferData(gl.ARRAY_BUFFER, this.maxAllocatedInstances * 4, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.selected);
        gl.bufferData(gl.ARRAY_BUFFER, this.maxAllocatedInstances * 4, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceScales);
        gl.bufferData(gl.ARRAY_BUFFER, this.maxAllocatedInstances * 2 * 4, gl.DYNAMIC_DRAW); // FIX: scales has 2 floats per instance
    }

    updateLOD(zoomLevel) {
        this.zoomLevel = zoomLevel;

        // Always use full rendering mode - the shader handles text visibility automatically
        // based on cell size. Text won't render when cells are too small anyway.
        this.currentLOD = 'full';
    }

    setUniforms(options) {
        const gl = this.gl;

        gl.uniformMatrix4fv(this.uniforms.projection, false, this.projectionMatrix);
        gl.uniform2f(this.uniforms.cellSize, options.cellWidth || 10, options.cellHeight || 20);

        // Scroll uniform - this is the key optimization!
        gl.uniform2f(this.uniforms.scroll, options.scrollX || 0, options.scrollY || 0);

        // Viewport bounds for culling - now as two vec2s
        const viewport = options.viewport || {};
        gl.uniform2f(this.uniforms.viewMin,
            viewport.minX || 0,
            viewport.minY || 0
        );
        gl.uniform2f(this.uniforms.viewMax,
            viewport.maxX || this.canvas.width,
            viewport.maxY || this.canvas.height
        );

        // Atlas properties
        const atlasGridCols = this.textureAtlas ? this.textureAtlas.gridCols : 16;
        const atlasGridRows = this.textureAtlas ? this.textureAtlas.gridRows : 16;
        gl.uniform1f(this.uniforms.atlasGridCols, atlasGridCols);
        gl.uniform1f(this.uniforms.atlasGridRows, atlasGridRows);

        // Time and LOD
        gl.uniform1f(this.uniforms.time, performance.now() / 1000);
        gl.uniform1f(this.uniforms.lodLevel, this.currentLOD === 'simplified' ? 1.0 : 0.0);

        // Bind texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures.atlas);
        gl.uniform1i(this.uniforms.texture, 0);
    }

    // ... Rest of helper methods (setupAttributes, createShaderProgram, etc.) ...
    // These remain similar to the original implementation

    getCharacterIndex(char) {
        if (this.textureAtlas) {
            return this.textureAtlas.getCharacterIndex(char);
        }

        const charMap = {
            'A': 0, 'C': 1, 'G': 2, 'T': 3, 'U': 4,
            '-': 5, '.': 6, 'N': 7,
            'R': 8, 'K': 9, 'D': 10, 'E': 11,
            'Q': 12, 'H': 13, 'S': 14, 'Y': 15,
            'W': 16, 'F': 17, 'P': 18, 'M': 19,
            'I': 20, 'L': 21, 'V': 22, '*': 23
        };
        return charMap[char] || 7;
    }

    setTextureAtlas(textureAtlas) {
        this.textureAtlas = textureAtlas;
        if (textureAtlas && this.gl) {
            const texture = textureAtlas.createGLTexture(this.gl);
            this.textures.atlas = texture;
        }
    }

    // Preallocate buffers based on viewport and minimum zoom
    preallocateBuffers(minZoom = 0.15) {
        const dpr = this.dpr;
        const viewportWidth = this.canvas.width / dpr;
        const viewportHeight = this.canvas.height / dpr;

        // Calculate maximum cells that could be visible at minimum zoom
        // At minimum zoom, cells are smallest, so most cells fit in viewport
        const cellWidthAtMin = 24 * minZoom;  // DEFAULT_CELL_WIDTH * minZoom
        const cellHeightAtMin = 30 * minZoom; // DEFAULT_CELL_HEIGHT * minZoom

        const maxVisibleCols = Math.ceil(viewportWidth / cellWidthAtMin) + 2; // +2 buffer
        const maxVisibleRows = Math.ceil(viewportHeight / cellHeightAtMin) + 2;
        const maxInstances = maxVisibleCols * maxVisibleRows;

        // Cap at safe limit and add 20% headroom
        const targetSize = Math.min(Math.ceil(maxInstances * 1.2), this.MAX_SAFE_INSTANCES);

        console.log(`Preallocating buffers: viewport ${Math.round(viewportWidth)}×${Math.round(viewportHeight)}, ` +
                    `min zoom ${Math.round(minZoom * 100)}%, max instances: ${targetSize}`);

        this.growBuffers(targetSize);
    }

    // Simplified versions of other required methods
    initTextureAtlas() {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        const pixel = new Uint8Array([255, 255, 255, 255]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        this.textures.atlas = texture;
    }

    handleResize() {
        // Get the actual canvas dimensions
        const width = this.canvas.width;
        const height = this.canvas.height;

        // Use the actual pixel dimensions for viewport
        this.gl.viewport(0, 0, width, height);

        // For projection, we need to use CSS dimensions to match the coordinate system
        // The cells are positioned based on CSS pixels, not physical pixels
        const cssWidth = this.canvas.clientWidth || (width / this.dpr);
        const cssHeight = this.canvas.clientHeight || (height / this.dpr);

        // Update projection matrix (orthographic) - using CSS dimensions
        const left = 0;
        const right = cssWidth;
        const bottom = cssHeight;
        const top = 0;
        const near = -1;
        const far = 1;

        // Initialize identity matrix first
        for (let i = 0; i < 16; i++) {
            this.projectionMatrix[i] = 0;
        }

        this.projectionMatrix[0] = 2 / (right - left);
        this.projectionMatrix[5] = 2 / (top - bottom);
        this.projectionMatrix[10] = -2 / (far - near);
        this.projectionMatrix[12] = -(right + left) / (right - left);
        this.projectionMatrix[13] = -(top + bottom) / (top - bottom);
        this.projectionMatrix[14] = -(far + near) / (far - near);
        this.projectionMatrix[15] = 1;
    }

    setupAttributes() {
        const gl = this.gl;

        // Quad vertices
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.positions);
        gl.enableVertexAttribArray(this.attributes.position);
        gl.vertexAttribPointer(this.attributes.position, 2, gl.FLOAT, false, 0, 0);

        // Texture coords
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.texCoords);
        gl.enableVertexAttribArray(this.attributes.texCoord);
        gl.vertexAttribPointer(this.attributes.texCoord, 2, gl.FLOAT, false, 0, 0);

        // Instance attributes
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instancePositions);
        gl.enableVertexAttribArray(this.attributes.instancePosition);
        gl.vertexAttribPointer(this.attributes.instancePosition, 2, gl.FLOAT, false, 0, 0);
        if (this.isWebGL2) {
            gl.vertexAttribDivisor(this.attributes.instancePosition, 1);
        } else if (this.ext) {
            this.ext.vertexAttribDivisorANGLE(this.attributes.instancePosition, 1);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceOffsets);
        gl.enableVertexAttribArray(this.attributes.instanceOffset);
        gl.vertexAttribPointer(this.attributes.instanceOffset, 2, gl.FLOAT, false, 0, 0);
        if (this.isWebGL2) {
            gl.vertexAttribDivisor(this.attributes.instanceOffset, 1);
        } else if (this.ext) {
            this.ext.vertexAttribDivisorANGLE(this.attributes.instanceOffset, 1);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceColors);
        gl.enableVertexAttribArray(this.attributes.instanceColor);
        gl.vertexAttribPointer(this.attributes.instanceColor, 4, gl.FLOAT, false, 0, 0);
        if (this.isWebGL2) {
            gl.vertexAttribDivisor(this.attributes.instanceColor, 1);
        } else if (this.ext) {
            this.ext.vertexAttribDivisorANGLE(this.attributes.instanceColor, 1);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.characterIndices);
        gl.enableVertexAttribArray(this.attributes.characterIndex);
        gl.vertexAttribPointer(this.attributes.characterIndex, 1, gl.FLOAT, false, 0, 0);
        if (this.isWebGL2) {
            gl.vertexAttribDivisor(this.attributes.characterIndex, 1);
        } else if (this.ext) {
            this.ext.vertexAttribDivisorANGLE(this.attributes.characterIndex, 1);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.selected);
        gl.enableVertexAttribArray(this.attributes.selected);
        gl.vertexAttribPointer(this.attributes.selected, 1, gl.FLOAT, false, 0, 0);
        if (this.isWebGL2) {
            gl.vertexAttribDivisor(this.attributes.selected, 1);
        } else if (this.ext) {
            this.ext.vertexAttribDivisorANGLE(this.attributes.selected, 1);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceScales);
        gl.enableVertexAttribArray(this.attributes.instanceScale);
        gl.vertexAttribPointer(this.attributes.instanceScale, 2, gl.FLOAT, false, 0, 0);
        if (this.isWebGL2) {
            gl.vertexAttribDivisor(this.attributes.instanceScale, 1);
        } else if (this.ext) {
            this.ext.vertexAttribDivisorANGLE(this.attributes.instanceScale, 1);
        }

        // Bind index buffer
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
    }

    createShaderProgram(vertexSource, fragmentSource) {
        const gl = this.gl;

        const vs = this.compileShader(gl.VERTEX_SHADER, vertexSource);
        const fs = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);

        // Strong guard so attachShader never sees a non-shader
        if (!vs || !fs) {
            if (vs) gl.deleteShader(vs);
            if (fs) gl.deleteShader(fs);
            return null;
        }

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Failed to link program:', gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            return null;
        }

        // Optional: enumerate active uniforms/attribs to spot type surprises
        // (very helpful for catching mismatched or dead-stripped uniforms).
        // Set window.SLOP_DEBUG = true before load to enable.
        if (window.SLOP_DEBUG) {
            const nu = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
            for (let i = 0; i < nu; i++) {
                const info = gl.getActiveUniform(program, i);
                console.log('[uniform]', info && info.name, info && info.size, info && info.type);
            }
            const na = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) || 0;
            for (let i = 0; i < na; i++) {
                const info = gl.getActiveAttrib(program, i);
                console.log('[attrib ]', info && info.name, info && info.size, info && info.type);
            }
        }

        // You can safely delete shaders after a successful link
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        return program;
    }

    compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);

        // Strip any stray NULs that can break parsers
        // (The console showed a NUL right after the error lines.)
        source = source.replace(/\u0000/g, '');

        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const stage = (type === gl.VERTEX_SHADER ? 'vertex' : 'fragment');
            const log = gl.getShaderInfoLog(shader) || '(no log)';
            const numbered = source.split('\n')
                .map((l, i) => `${String(i + 1).padStart(3, ' ')}| ${l}`)
                .join('\n');
            console.error(`Failed to compile ${stage} shader:\n${log}\n\nNumbered source:\n${numbered}`);
            gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    updatePerformance(startTime) {
        const deltaTime = performance.now() - startTime;
        this.frameCount++;

        if (performance.now() - this.lastFrameTime >= 1000) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastFrameTime = performance.now();

            if (this.options.onFPSUpdate) {
                this.options.onFPSUpdate(this.fps, deltaTime);
            }
        }
    }

    clearCache() {
        this.lastCellCount = -1;
        this.lastViewport = { startRow: -1, endRow: -1, startCol: -1, endCol: -1 };
        this.bufferVersion++;
    }

    destroy() {
        const gl = this.gl;

        Object.values(this.buffers).forEach(buffer => gl.deleteBuffer(buffer));
        Object.values(this.textures).forEach(texture => gl.deleteTexture(texture));

        if (this.program) {
            gl.deleteProgram(this.program);
        }

        this.gl = null;
    }
}

export default WebGLRendererOptimized;