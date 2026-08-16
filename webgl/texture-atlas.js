/**
 * Texture Atlas Generator for SLOP WebGL Renderer
 * Creates a texture atlas containing all characters needed for sequence rendering
 */

export class TextureAtlas {
    constructor(options = {}) {
        this.options = {
            fontSize: 128,  // Increased for even better quality
            fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
            fontWeight: '600',
            padding: 10,  // More padding for larger fonts and better sampling
            atlasSize: 4096,  // Larger atlas for higher resolution characters
            highDPI: true,  // Enable DPI scaling for crisp text
            subpixelPrecision: true,  // Enable subpixel positioning
            ...options
        };

        this.characters = this.getCharacterSet();
        this.atlas = null;
        this.uvMap = new Map();
        this.charWidth = 0;
        this.charHeight = 0;

        this.generate();
    }

    getCharacterSet() {
        // All possible characters we need to render
        return [
            // Nucleotides
            'A', 'C', 'G', 'T', 'U',
            // Gaps and unknowns
            '-', '.', 'N', 'X', '?',
            // Amino acids (single letter codes)
            'R', 'K', 'D', 'E', 'Q', 'H', 'S', 'Y', 'W', 'F',
            'P', 'M', 'I', 'L', 'V', 'B', 'Z', 'J', 'O', '*',
            // Numbers for positions (optional)
            '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
            // Special characters
            ' ', '|', ':', '.'
        ];
    }

    generate() {
        // Limit DPR to 2 for texture atlas to prevent excessive memory usage
        const dpr = this.options.highDPI ? Math.min(window.devicePixelRatio || 1, 2) : 1;
        const fontSize = this.options.fontSize * dpr;
        const padding = this.options.padding * dpr;

        // Create off-screen canvas for atlas generation
        const canvas = document.createElement('canvas');
        canvas.width = this.options.atlasSize * dpr;
        canvas.height = this.options.atlasSize * dpr;

        const ctx = canvas.getContext('2d', { alpha: true });

        // Clear canvas with transparent background
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Set up font with better rendering
        ctx.font = `${this.options.fontWeight} ${fontSize}px ${this.options.fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'white';  // White text for better alpha channel

        // Enable anti-aliasing for smooth edges
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Additional text rendering hints for better quality
        if (ctx.webkitImageSmoothingEnabled !== undefined) {
            ctx.webkitImageSmoothingEnabled = true;
        }
        if (ctx.mozImageSmoothingEnabled !== undefined) {
            ctx.mozImageSmoothingEnabled = true;
        }

        // Set better text rendering mode
        if ('textRendering' in ctx) {
            ctx.textRendering = 'optimizeLegibility';
        }

        // Don't apply filters that might cause outlines
        // ctx.filter = 'contrast(1.2) brightness(1.05)';

        // Measure character dimensions
        const metrics = ctx.measureText('W'); // Use widest character
        this.charWidth = Math.ceil(metrics.width + padding * 2);
        this.charHeight = Math.ceil(fontSize * 1.2 + padding * 2);

        // Calculate grid dimensions
        const cols = Math.floor(canvas.width / this.charWidth);
        const rows = Math.floor(canvas.height / this.charHeight);

        // Store grid dimensions for shader use
        this.gridCols = cols;
        this.gridRows = rows;

        if (this.characters.length > cols * rows) {
            console.warn(`Texture atlas too small for all characters. Need ${this.characters.length}, have ${cols * rows}`);
        }

        // Render each character centered in its cell
        this.characters.forEach((char, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);

            const x = col * this.charWidth;
            const y = row * this.charHeight;

            // Draw character centered - use simple middle baseline
            ctx.fillText(
                char,
                x + this.charWidth / 2,
                y + this.charHeight / 2
            );

            // Store UV coordinates (normalized 0-1)
            this.uvMap.set(char, {
                index: index,
                u1: x / canvas.width,
                v1: y / canvas.height,
                u2: (x + this.charWidth) / canvas.width,
                v2: (y + this.charHeight) / canvas.height,
                pixelX: x,
                pixelY: y,
                pixelWidth: this.charWidth,
                pixelHeight: this.charHeight
            });
        });

        // Store the atlas canvas
        this.atlas = canvas;

        // Log atlas info
        console.log(`Texture atlas generated: ${canvas.width}x${canvas.height}, ${this.characters.length} characters`);
    }

    createGLTexture(gl) {
        if (!this.atlas) {
            console.error('Texture atlas not generated');
            return null;
        }

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);

        // Upload atlas to GPU
        gl.texImage2D(
            gl.TEXTURE_2D,
            0, // mip level
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            this.atlas
        );

        // Generate mipmaps BEFORE setting texture parameters
        gl.generateMipmap(gl.TEXTURE_2D);

        // Set texture parameters for high-quality text rendering with mipmaps
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Enable anisotropic filtering if available for better quality at angles
        const ext = gl.getExtension('EXT_texture_filter_anisotropic') ||
                    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
                    gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
        if (ext) {
            const maxAnisotropy = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
            gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, maxAnisotropy);
            console.log(`Anisotropic filtering enabled: ${maxAnisotropy}x`);
        }

        return texture;
    }

    getCharacterUV(char) {
        return this.uvMap.get(char) || this.uvMap.get('?'); // Fallback to '?' for unknown
    }

    getCharacterIndex(char) {
        const uv = this.uvMap.get(char);
        return uv ? uv.index : 0;
    }

    // Debug method to visualize the atlas
    debugDraw(targetCanvas) {
        if (!this.atlas) return;

        const ctx = targetCanvas.getContext('2d');
        ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);

        // Draw the atlas
        ctx.drawImage(this.atlas, 0, 0, targetCanvas.width, targetCanvas.height);

        // Draw grid lines
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
        ctx.lineWidth = 1;

        const scale = targetCanvas.width / this.atlas.width;

        this.uvMap.forEach((uv, char) => {
            const x = uv.pixelX * scale;
            const y = uv.pixelY * scale;
            const w = uv.pixelWidth * scale;
            const h = uv.pixelHeight * scale;

            ctx.strokeRect(x, y, w, h);

            // Label
            ctx.fillStyle = 'yellow';
            ctx.font = '10px monospace';
            ctx.fillText(char, x + 2, y + 10);
        });
    }

    // Generate specialized atlases for different purposes
    static generateNucleotideAtlas(options = {}) {
        const atlas = new TextureAtlas({
            ...options,
            fontSize: 96, // Larger for better quality
        });

        // Filter to just nucleotides
        atlas.characters = ['A', 'C', 'G', 'T', 'U', '-', 'N'];
        atlas.generate();

        return atlas;
    }

    static generateAminoAcidAtlas(options = {}) {
        const atlas = new TextureAtlas({
            ...options,
            fontSize: 96, // Consistent larger size
        });

        // Filter to amino acids
        atlas.characters = [
            'A', 'R', 'N', 'D', 'C', 'Q', 'E', 'G', 'H', 'I',
            'L', 'K', 'M', 'F', 'P', 'S', 'T', 'W', 'Y', 'V',
            'B', 'Z', 'X', '*', '-'
        ];
        atlas.generate();

        return atlas;
    }

    destroy() {
        this.atlas = null;
        this.uvMap.clear();
    }
}

// Color schemes for different character types
export const ColorSchemes = {
    nucleotide: {
        'A': { r: 0, g: 255, b: 0 },       // Bright Green
        'C': { r: 0, g: 0, b: 255 },       // Deep Blue
        'G': { r: 0, g: 139, b: 139 },     // Dark Teal
        'T': { r: 0, g: 255, b: 255 },     // Cyan
        'U': { r: 0, g: 255, b: 255 },     // Cyan (same as T)
        '-': { r: 240, g: 240, b: 240 },   // Light gray
        default: { r: 128, g: 128, b: 128 } // Gray
    },

    aminoAcid: {
        // Hydrophobic (orange)
        'A': { r: 255, g: 149, b: 0 },
        'V': { r: 255, g: 149, b: 0 },
        'I': { r: 255, g: 149, b: 0 },
        'L': { r: 255, g: 149, b: 0 },
        'M': { r: 255, g: 149, b: 0 },
        'F': { r: 255, g: 149, b: 0 },
        'W': { r: 255, g: 149, b: 0 },
        'P': { r: 255, g: 149, b: 0 },

        // Polar (green)
        'S': { r: 0, g: 170, b: 0 },
        'T': { r: 0, g: 170, b: 0 },
        'N': { r: 0, g: 170, b: 0 },
        'Q': { r: 0, g: 170, b: 0 },
        'C': { r: 0, g: 170, b: 0 },
        'Y': { r: 0, g: 170, b: 0 },
        'G': { r: 0, g: 170, b: 0 },

        // Basic (blue)
        'R': { r: 0, g: 102, b: 255 },
        'K': { r: 0, g: 102, b: 255 },
        'H': { r: 0, g: 102, b: 255 },

        // Acidic (red)
        'D': { r: 255, g: 0, b: 0 },
        'E': { r: 255, g: 0, b: 0 },

        // Stop (black)
        '*': { r: 0, g: 0, b: 0 },

        // Gap (light gray)
        '-': { r: 240, g: 240, b: 240 },

        default: { r: 102, g: 102, b: 102 }
    },

    conservation: {
        high: { r: 255, g: 0, b: 0 },      // Red for highly conserved
        medium: { r: 255, g: 255, b: 0 },  // Yellow for medium
        low: { r: 0, g: 255, b: 0 },       // Green for low
        none: { r: 200, g: 200, b: 200 }   // Gray for no conservation
    }
};

export function getColor(char, scheme = 'nucleotide') {
    const colorScheme = ColorSchemes[scheme] || ColorSchemes.nucleotide;
    return colorScheme[char] || colorScheme.default;
}