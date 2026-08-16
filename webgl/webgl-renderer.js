/**
 * WebGL Renderer for SLOP MSA Viewer
 * High-performance GPU-accelerated rendering for biological sequence alignments
 */

export class WebGLRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.textureAtlas = null;
        this.options = {
            antialias: true,
            alpha: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,  // Required for canvas.toBlob() to capture frame
            powerPreference: 'high-performance',
            desynchronized: true,  // Bypass compositor for lower latency
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
        this.cellData = null;
        this.instanceCount = 0;

        // Performance tracking
        this.frameCount = 0;
        this.lastFrameTime = 0;
        this.fps = 0;

        this.init();
    }

    init() {
        // Try WebGL2 first, fallback to WebGL1
        this.gl = this.canvas.getContext('webgl2', this.options) ||
                  this.canvas.getContext('webgl', this.options);

        if (!this.gl) {
            throw new Error('WebGL not supported');
        }

        this.isWebGL2 = this.gl instanceof WebGL2RenderingContext;
        // console.log(`WebGL Renderer initialized (WebGL${this.isWebGL2 ? '2' : '1'})`);

        if (!this.isWebGL2) {
            // console.warn('WebGL2 not available, falling back to WebGL1 with limited features');
            // Don't throw error, continue with WebGL1
        }

        // Set up GL state
        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0.06, 0.09, 0.16, 0.0); // Transparent background to not interfere with overlay

        // Initialize shaders
        this.initShaders();

        // Set up buffers
        this.initBuffers();

        // Create texture atlas
        this.initTextureAtlas();

        // Handle initial sizing and projection
        this.handleResize();
    }

    initShaders() {
        const gl = this.gl;

        // Vertex shader - positions cells and passes data to fragment shader
        let vertexShaderSource;
        if (this.isWebGL2) {
            vertexShaderSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
in vec2 a_instancePosition;
in vec2 a_instanceOffset;
in vec4 a_instanceColor;
in float a_characterIndex;
in float a_selected;
in float a_instanceScale;

uniform mat4 u_projection;
uniform vec2 u_cellSize;
uniform vec2 u_atlasSize;
uniform float u_atlasGridCols;
uniform float u_atlasGridRows;
uniform vec2 u_scrollVelocity;
uniform vec2 u_viewportCenter;
uniform float u_time;

out vec2 v_texCoord;
out vec4 v_color;
out float v_selected;
out float v_fadeAmount;
out vec2 v_worldPos;

void main() {
    // Calculate world position with per-instance scaling and offsets
    vec2 size = u_cellSize * a_instanceScale;
    vec2 worldPos = a_instancePosition + a_instanceOffset + a_position * size;
    gl_Position = u_projection * vec4(worldPos, 0.0, 1.0);

    // Calculate texture coordinates based on character index
    float row = floor(a_characterIndex / u_atlasGridCols);
    float col = mod(a_characterIndex, u_atlasGridCols);

    // Calculate the size of each character cell in texture coordinates
    float cellWidth = 1.0 / u_atlasGridCols;
    float cellHeight = 1.0 / u_atlasGridRows;

    // Calculate the top-left corner of the character in texture space
    vec2 charOffset = vec2(col * cellWidth, row * cellHeight);

    // Apply the local texture coordinate within the character cell
    v_texCoord = charOffset + a_texCoord * vec2(cellWidth, cellHeight);

    v_color = a_instanceColor;
    v_selected = a_selected;
    v_worldPos = worldPos;

    // Calculate smooth fade based on distance from viewport center
    float distFromCenter = length(worldPos - u_viewportCenter);
    float maxDist = max(u_viewportCenter.x, u_viewportCenter.y) * 1.2;

    // Smooth fade at edges
    v_fadeAmount = 1.0 - smoothstep(maxDist * 0.8, maxDist, distFromCenter);

    // Extra fade based on scroll velocity for smooth motion
    float velocityFactor = length(u_scrollVelocity) * 0.0003;
    v_fadeAmount *= (1.0 - min(velocityFactor * 0.15, 0.2));

    // Add subtle wave effect during scrolling for visual interest
    float wave = sin(worldPos.x * 0.005 + u_time * 2.0) * 0.02;
    v_fadeAmount = clamp(v_fadeAmount + wave * velocityFactor, 0.0, 1.0);
}`;
        } else {
            // WebGL1 shader
            vertexShaderSource = `attribute vec2 a_position;
attribute vec2 a_texCoord;
attribute vec2 a_instancePosition;
attribute vec2 a_instanceOffset;
attribute vec4 a_instanceColor;
attribute float a_characterIndex;
attribute float a_selected;
attribute float a_instanceScale;

uniform mat4 u_projection;
uniform vec2 u_cellSize;
uniform vec2 u_atlasSize;
uniform float u_atlasGridCols;
uniform float u_atlasGridRows;

varying vec2 v_texCoord;
varying vec4 v_color;
varying float v_selected;

void main() {
    // Calculate world position with per-instance scaling and offsets
    vec2 size = u_cellSize * a_instanceScale;
    vec2 worldPos = a_instancePosition + a_instanceOffset + a_position * size;
    gl_Position = u_projection * vec4(worldPos, 0.0, 1.0);

    // Calculate texture coordinates based on character index
    float row = floor(a_characterIndex / u_atlasGridCols);
    float col = mod(a_characterIndex, u_atlasGridCols);

    // Calculate the size of each character cell in texture coordinates
    float cellWidth = 1.0 / u_atlasGridCols;
    float cellHeight = 1.0 / u_atlasGridRows;

    // Calculate the top-left corner of the character in texture space
    vec2 charOffset = vec2(col * cellWidth, row * cellHeight);

    // Apply the local texture coordinate within the character cell
    v_texCoord = charOffset + a_texCoord * vec2(cellWidth, cellHeight);

    v_color = a_instanceColor;
    v_selected = a_selected;
}`;
        }

        // Fragment shader - renders characters with colors and effects
        let fragmentShaderSource;
        if (this.isWebGL2) {
            fragmentShaderSource = `#version 300 es
precision highp float;

uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_scrollVelocity;

in vec2 v_texCoord;
in vec4 v_color;
in float v_selected;
in float v_fadeAmount;
in vec2 v_worldPos;

out vec4 fragColor;

void main() {
    vec4 texColor = texture(u_texture, v_texCoord);

    // Background color based on nucleotide - full brightness
    vec3 bgColor = v_color.rgb;
    float bgAlpha = v_color.a;

    // The texture has black text where alpha > 0
    float textAlpha = texColor.a;

    vec3 finalColor;
    float finalAlpha;

    // Improved edge smoothing with smoothstep
    float smoothAlpha = smoothstep(0.3, 0.7, textAlpha);

    // Mix background color with text
    if (bgAlpha > 0.0) {
        // We have a background color (nucleotide cell)
        if (smoothAlpha > 0.01) {
            // Smooth blend between background and text
            finalColor = mix(bgColor, vec3(0.0, 0.0, 0.0), smoothAlpha);
            finalAlpha = max(bgAlpha, smoothAlpha);
        } else {
            // Just background color
            finalColor = bgColor;
            finalAlpha = bgAlpha;
        }
    } else if (smoothAlpha > 0.01) {
        // Text without background (shouldn't happen in normal rendering)
        finalColor = vec3(0.0, 0.0, 0.0);
        finalAlpha = smoothAlpha;
    } else {
        // No text and no background - discard
        discard;
    }

    // Selection effect - invert to white text on dark colored backgrounds
    if (v_selected > 0.5) {
        // Use smoothed alpha for better selection rendering
        if (smoothAlpha > 0.3) {
            // This is text - make it white
            finalColor = vec3(1.0, 1.0, 1.0);  // Pure white text
        } else {
            // This is background - darken the original color
            finalColor = finalColor * 0.3 + vec3(0.05, 0.05, 0.1);  // Dark with slight blue tint
        }

        // Add subtle pulse to the selection
        float pulse = sin(u_time * 2.5) * 0.05 + 1.0;
        finalColor *= pulse;

        // Ensure full opacity for visibility
        finalAlpha = 1.0;
    }

    // Apply smooth fade effect for cells entering/leaving viewport
    finalAlpha *= v_fadeAmount;

    // Subtle glow effect at edges during scrolling
    float scrollSpeed = length(u_scrollVelocity) * 0.001;
    if (v_fadeAmount < 0.9 && scrollSpeed > 0.05) {
        // Create a soft blue glow at the edges
        vec3 glowColor = vec3(0.4, 0.5, 0.7);
        float glowIntensity = (1.0 - v_fadeAmount) * scrollSpeed * 2.0;
        finalColor = mix(finalColor, glowColor, glowIntensity * 0.3);

        // Fade out edges smoothly
        finalAlpha *= smoothstep(0.0, 0.4, v_fadeAmount);
    }

    // Add very subtle color variation based on position for visual richness
    vec3 positionTint = vec3(
        sin(v_worldPos.x * 0.002) * 0.02,
        cos(v_worldPos.y * 0.002) * 0.02,
        sin(v_worldPos.x * 0.001 + v_worldPos.y * 0.001) * 0.02
    );
    finalColor = clamp(finalColor + positionTint, 0.0, 1.0);

    fragColor = vec4(finalColor, finalAlpha);
}`;
        } else {
            // WebGL1 shader
            fragmentShaderSource = `precision highp float;

uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_resolution;

varying vec2 v_texCoord;
varying vec4 v_color;
varying float v_selected;

void main() {
    vec4 texColor = texture2D(u_texture, v_texCoord);

    // Background color based on nucleotide - full brightness
    vec3 bgColor = v_color.rgb;
    float bgAlpha = v_color.a;

    // The texture has black text where alpha > 0
    float textAlpha = texColor.a;

    vec3 finalColor;
    float finalAlpha;

    // Improved edge smoothing with smoothstep
    float smoothAlpha = smoothstep(0.3, 0.7, textAlpha);

    // Mix background color with text
    if (bgAlpha > 0.0) {
        // We have a background color (nucleotide cell)
        if (smoothAlpha > 0.01) {
            // Smooth blend between background and text
            finalColor = mix(bgColor, vec3(0.0, 0.0, 0.0), smoothAlpha);
            finalAlpha = max(bgAlpha, smoothAlpha);
        } else {
            // Just background color
            finalColor = bgColor;
            finalAlpha = bgAlpha;
        }
    } else if (smoothAlpha > 0.01) {
        // Text without background (shouldn't happen in normal rendering)
        finalColor = vec3(0.0, 0.0, 0.0);
        finalAlpha = smoothAlpha;
    } else {
        // No text and no background - discard
        discard;
    }

    // Selection effect - invert to white text on dark backgrounds
    if (v_selected > 0.5) {
        // For WebGL 1.0, we approximate the inversion effect
        vec4 texColor = texture2D(u_texture, v_texCoord);

        if (texColor.a > 0.5) {
            // This is text - make it white
            finalColor = vec3(1.0, 1.0, 1.0);
        } else {
            // This is background - darken it significantly
            finalColor = finalColor * 0.25 + vec3(0.0, 0.0, 0.05);  // Dark with slight blue tint
        }

        finalAlpha = 1.0;  // Full opacity
    }

    gl_FragColor = vec4(finalColor, finalAlpha);
}`;
        }

        // Compile shaders
        this.program = this.createShaderProgram(vertexShaderSource, fragmentShaderSource);
        gl.useProgram(this.program);

        // Get attribute and uniform locations
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
            atlasSize: gl.getUniformLocation(this.program, 'u_atlasSize'),
            atlasGridCols: gl.getUniformLocation(this.program, 'u_atlasGridCols'),
            atlasGridRows: gl.getUniformLocation(this.program, 'u_atlasGridRows'),
            texture: gl.getUniformLocation(this.program, 'u_texture'),
            time: gl.getUniformLocation(this.program, 'u_time'),
            resolution: gl.getUniformLocation(this.program, 'u_resolution'),
            scrollVelocity: gl.getUniformLocation(this.program, 'u_scrollVelocity'),
            viewportCenter: gl.getUniformLocation(this.program, 'u_viewportCenter')
        };
    }

    createShaderProgram(vertexSource, fragmentSource) {
        const gl = this.gl;

        const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this.compileShader(gl.FRAGMENT_SHADER, fragmentSource);

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('Shader program linking failed:', gl.getProgramInfoLog(program));
            throw new Error('Failed to link shader program');
        }

        return program;
    }

    compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const shaderType = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
            console.error(`${shaderType} shader compilation failed:`, gl.getShaderInfoLog(shader));
            console.error('Shader source:', source);
            throw new Error(`Failed to compile ${shaderType} shader`);
        }

        return shader;
    }

    initBuffers() {
        const gl = this.gl;

        // Create a quad for each cell (two triangles)
        const quadVertices = new Float32Array([
            0, 0,  // Top-left
            1, 0,  // Top-right
            0, 1,  // Bottom-left
            1, 1   // Bottom-right
        ]);

        const quadTexCoords = new Float32Array([
            0, 0,
            1, 0,
            0, 1,
            1, 1
        ]);

        const quadIndices = new Uint16Array([
            0, 1, 2,
            2, 1, 3
        ]);

        // Create vertex buffer
        this.buffers.vertices = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.vertices);
        gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

        // Create texture coordinate buffer
        this.buffers.texCoords = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.texCoords);
        gl.bufferData(gl.ARRAY_BUFFER, quadTexCoords, gl.STATIC_DRAW);

        // Create index buffer
        this.buffers.indices = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices, gl.STATIC_DRAW);

        // Create instance buffers (will be populated per frame)
        this.buffers.instancePositions = gl.createBuffer();
        this.buffers.instanceOffsets = gl.createBuffer();
        this.buffers.instanceColors = gl.createBuffer();
        this.buffers.characterIndices = gl.createBuffer();
        this.buffers.selected = gl.createBuffer();
        this.buffers.instanceScales = gl.createBuffer();

        // Pre-allocate instance data arrays
        const initialCapacity = 10000; // Initial capacity, will grow dynamically
        this.allocateInstanceStorage(initialCapacity);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instancePositions);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.positions, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceOffsets);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.offsets, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceColors);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.colors, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.characterIndices);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.characters, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.selected);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.selected, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceScales);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.scales, gl.DYNAMIC_DRAW);
    }

    allocateInstanceStorage(capacity) {
        this.instanceCapacity = capacity;
        this.instanceData = {
            positions: new Float32Array(capacity * 2),
            offsets: new Float32Array(capacity * 2),
            colors: new Float32Array(capacity * 4),
            characters: new Float32Array(capacity),
            selected: new Float32Array(capacity),
            scales: new Float32Array(capacity)
        };
    }

    ensureCapacity(required) {
        if (required <= this.instanceCapacity) return;

        let newCapacity = this.instanceCapacity;
        while (newCapacity < required) {
            newCapacity = Math.ceil(newCapacity * 1.5);
        }

        this.allocateInstanceStorage(newCapacity);

        const gl = this.gl;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instancePositions);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.positions, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceOffsets);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.offsets, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceColors);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.colors, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.characterIndices);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.characters, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.selected);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.selected, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceScales);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.scales, gl.DYNAMIC_DRAW);
    }

    initTextureAtlas() {
        // This will be implemented in texture-atlas.js
        // For now, create a simple white texture as placeholder
        const gl = this.gl;

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        // White pixel placeholder
        const pixel = new Uint8Array([255, 255, 255, 255]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        this.textures.atlas = texture;
    }

    updateProjectionMatrix(width, height) {
        const dpr = window.devicePixelRatio || 1;
        const viewWidth = width ?? this.canvas.clientWidth ?? (this.canvas.width / dpr);
        const viewHeight = height ?? this.canvas.clientHeight ?? (this.canvas.height / dpr);

        const safeWidth = Math.max(1, viewWidth || 1);
        const safeHeight = Math.max(1, viewHeight || 1);

        this.viewSize = { width: safeWidth, height: safeHeight };

        // Create orthographic projection matrix in CSS pixel space
        // Small offset to account for clipping edge
        const left = -10;  // Shift left by 10 pixels to show content that would be clipped
        const right = safeWidth - 10;
        const bottom = safeHeight;
        const top = 0;
        const near = -1;
        const far = 1;

        this.projectionMatrix = new Float32Array([
            2 / (right - left), 0, 0, 0,
            0, 2 / (top - bottom), 0, 0,
            0, 0, -2 / (far - near), 0,
            -(right + left) / (right - left),
            -(top + bottom) / (top - bottom),
            -(far + near) / (far - near),
            1
        ]);
    }

    handleResize() {
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = this.canvas.clientWidth || 0;
        const cssHeight = this.canvas.clientHeight || 0;
        const width = Math.max(1, Math.round(cssWidth * dpr));
        const height = Math.max(1, Math.round(cssHeight * dpr));

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        this.gl.viewport(0, 0, width, height);
        this.updateProjectionMatrix(cssWidth, cssHeight);
    }

    render(renderData, options = {}) {
        const gl = this.gl;
        const startTime = performance.now();

        this.handleResize();

        const labelWidth = options.labelWidth || 0;
        const headerHeight = options.headerHeight || 0;
        const dpr = window.devicePixelRatio || 1;

        // Clear the entire canvas without scissor test
        gl.disable(gl.SCISSOR_TEST);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (!renderData || !renderData.cells || renderData.cells.length === 0) {
            gl.disable(gl.SCISSOR_TEST);
            return;
        }

        // Prepare instance data
        this.prepareInstanceData(renderData, options);

        // Use shader program
        gl.useProgram(this.program);

        // Set uniforms
        gl.uniformMatrix4fv(this.uniforms.projection, false, this.projectionMatrix);
        gl.uniform2f(this.uniforms.cellSize, options.cellWidth || 10, options.cellHeight || 20);

        // Get atlas properties from texture atlas if available
        const atlasSize = this.textureAtlas ? this.textureAtlas.options.atlasSize : 512;
        gl.uniform2f(this.uniforms.atlasSize, atlasSize, atlasSize);

        const atlasGridCols = this.textureAtlas ? this.textureAtlas.gridCols : 16;
        gl.uniform1f(this.uniforms.atlasGridCols, atlasGridCols);

        const atlasGridRows = this.textureAtlas ? this.textureAtlas.gridRows : 16;
        gl.uniform1f(this.uniforms.atlasGridRows, atlasGridRows);

        gl.uniform1f(this.uniforms.time, performance.now() / 1000);
        gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);

        // Pass scroll velocity and viewport center for effects
        const scrollVelocity = options.scrollVelocity || [0, 0];
        gl.uniform2f(this.uniforms.scrollVelocity, scrollVelocity[0], scrollVelocity[1]);

        const viewportCenter = [this.canvas.width / 2, this.canvas.height / 2];
        gl.uniform2f(this.uniforms.viewportCenter, viewportCenter[0], viewportCenter[1]);

        // Bind texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures.atlas);
        gl.uniform1i(this.uniforms.texture, 0);

        // Set up vertex attributes
        this.setupAttributes();

        // Draw instanced quads
        if (this.isWebGL2) {
            gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.instanceCount);
        } else {
            // Fallback for WebGL1 - would need extension or manual instancing
            this.drawInstancedWebGL1(this.instanceCount);
        }

        // Update performance metrics
        this.updatePerformance(startTime);
    }

    prepareInstanceData(renderData, options) {
        const { cells } = renderData;
        this.instanceCount = cells.length;
        this.ensureCapacity(this.instanceCount);

        for (let i = 0; i < this.instanceCount; i++) {
            const cell = cells[i];

            // Position
            this.instanceData.positions[i * 2] = cell.x;
            this.instanceData.positions[i * 2 + 1] = cell.y;

            // Offset within the cell
            const offsetX = typeof cell.offsetX === 'number' ? cell.offsetX : 0;
            const offsetY = typeof cell.offsetY === 'number' ? cell.offsetY : 0;
            this.instanceData.offsets[i * 2] = offsetX;
            this.instanceData.offsets[i * 2 + 1] = offsetY;

            // Color
            const color = cell.color || {};
            this.instanceData.colors[i * 4] = ((color.r ?? 0) / 255);
            this.instanceData.colors[i * 4 + 1] = ((color.g ?? 0) / 255);
            this.instanceData.colors[i * 4 + 2] = ((color.b ?? 0) / 255);
            this.instanceData.colors[i * 4 + 3] = typeof color.a === 'number' ? color.a : 1.0;

            // Character index (map character to atlas position)
            this.instanceData.characters[i] = this.getCharacterIndex(cell.char);

            // Selection state
            this.instanceData.selected[i] = cell.selected ? 1.0 : 0.0;

            // Scale
            this.instanceData.scales[i] = typeof cell.scale === 'number' ? cell.scale : 1.0;
        }

        // Update GPU buffers
        this.updateInstanceBuffers();
    }

    updateInstanceBuffers() {
        const gl = this.gl;

        const positionSlice = this.instanceData.positions.subarray(0, this.instanceCount * 2);
        const offsetSlice = this.instanceData.offsets.subarray(0, this.instanceCount * 2);
        const colorSlice = this.instanceData.colors.subarray(0, this.instanceCount * 4);
        const characterSlice = this.instanceData.characters.subarray(0, this.instanceCount);
        const selectedSlice = this.instanceData.selected.subarray(0, this.instanceCount);
        const scaleSlice = this.instanceData.scales.subarray(0, this.instanceCount);

        // Update position buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instancePositions);
        gl.bufferData(gl.ARRAY_BUFFER, positionSlice, gl.DYNAMIC_DRAW);

        // Update offset buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceOffsets);
        gl.bufferData(gl.ARRAY_BUFFER, offsetSlice, gl.DYNAMIC_DRAW);

        // Update color buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceColors);
        gl.bufferData(gl.ARRAY_BUFFER, colorSlice, gl.DYNAMIC_DRAW);

        // Update character buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.characterIndices);
        gl.bufferData(gl.ARRAY_BUFFER, characterSlice, gl.DYNAMIC_DRAW);

        // Update selection buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.selected);
        gl.bufferData(gl.ARRAY_BUFFER, selectedSlice, gl.DYNAMIC_DRAW);

        // Update scale buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceScales);
        gl.bufferData(gl.ARRAY_BUFFER, scaleSlice, gl.DYNAMIC_DRAW);
    }

    setupAttributes() {
        const gl = this.gl;

        // Vertex position
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.vertices);
        gl.enableVertexAttribArray(this.attributes.position);
        gl.vertexAttribPointer(this.attributes.position, 2, gl.FLOAT, false, 0, 0);

        // Texture coordinates
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.texCoords);
        gl.enableVertexAttribArray(this.attributes.texCoord);
        gl.vertexAttribPointer(this.attributes.texCoord, 2, gl.FLOAT, false, 0, 0);

        // Instance attributes
        if (this.isWebGL2) {
            // Instance position
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instancePositions);
            gl.enableVertexAttribArray(this.attributes.instancePosition);
            gl.vertexAttribPointer(this.attributes.instancePosition, 2, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(this.attributes.instancePosition, 1);

            // Instance offset
            if (this.attributes.instanceOffset >= 0) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceOffsets);
                gl.enableVertexAttribArray(this.attributes.instanceOffset);
                gl.vertexAttribPointer(this.attributes.instanceOffset, 2, gl.FLOAT, false, 0, 0);
                gl.vertexAttribDivisor(this.attributes.instanceOffset, 1);
            }

            // Instance color
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceColors);
            gl.enableVertexAttribArray(this.attributes.instanceColor);
            gl.vertexAttribPointer(this.attributes.instanceColor, 4, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(this.attributes.instanceColor, 1);

            // Character index
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.characterIndices);
            gl.enableVertexAttribArray(this.attributes.characterIndex);
            gl.vertexAttribPointer(this.attributes.characterIndex, 1, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(this.attributes.characterIndex, 1);

            // Selection state
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.selected);
            gl.enableVertexAttribArray(this.attributes.selected);
            gl.vertexAttribPointer(this.attributes.selected, 1, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(this.attributes.selected, 1);

            // Instance scale
            if (this.attributes.instanceScale >= 0) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.instanceScales);
                gl.enableVertexAttribArray(this.attributes.instanceScale);
                gl.vertexAttribPointer(this.attributes.instanceScale, 1, gl.FLOAT, false, 0, 0);
                gl.vertexAttribDivisor(this.attributes.instanceScale, 1);
            }
        }

        // Bind index buffer
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buffers.indices);
    }

    getCharacterIndex(char) {
        // Use texture atlas to get character index if available
        if (this.textureAtlas) {
            return this.textureAtlas.getCharacterIndex(char);
        }

        // Fallback map if no texture atlas
        const charMap = {
            'A': 0, 'C': 1, 'G': 2, 'T': 3, 'U': 4,
            '-': 5, '.': 6, 'N': 7,
            // Amino acids
            'R': 8, 'K': 9, 'D': 10, 'E': 11,
            'Q': 12, 'H': 13, 'S': 14, 'Y': 15,
            'W': 16, 'F': 17, 'P': 18, 'M': 19,
            'I': 20, 'L': 21, 'V': 22, '*': 23
        };
        return charMap[char] || 7; // Default to 'N' for unknown
    }

    setTextureAtlas(textureAtlas) {
        this.textureAtlas = textureAtlas;
        if (textureAtlas && this.gl) {
            const texture = textureAtlas.createGLTexture(this.gl);
            this.textures.atlas = texture;
        }
    }

    drawInstancedWebGL1(instanceCount) {
        // Fallback for WebGL1 without instancing extension
        const gl = this.gl;
        for (let i = 0; i < instanceCount; i++) {
            // Update per-instance uniforms
            // This is slower but works without instancing
            gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        }
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

    destroy() {
        const gl = this.gl;

        // Clean up buffers
        Object.values(this.buffers).forEach(buffer => gl.deleteBuffer(buffer));

        // Clean up textures
        Object.values(this.textures).forEach(texture => gl.deleteTexture(texture));

        // Clean up shaders
        if (this.program) {
            gl.deleteProgram(this.program);
        }

        this.gl = null;
    }
}
