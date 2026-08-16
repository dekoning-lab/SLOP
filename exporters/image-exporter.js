/**
 * Image Exporter for SLOP
 * Exports the current visible alignment view as a high-resolution image
 * Captures exactly what's on screen including labels and ruler
 */

export class ImageExporter {
    /**
     * @param {HTMLCanvasElement} canvas - The WebGL canvas to export
     * @param {HTMLElement} uiCanvas - The UI overlay canvas (optional)
     * @param {Function} renderFunction - Function to call to re-render the view
     * @param {Object} dataProvider - Object with methods to get alignment data
     */
    constructor(canvas, uiCanvas = null, renderFunction = null, dataProvider = null) {
        this.canvas = canvas;
        this.uiCanvas = uiCanvas;
        this.renderFunction = renderFunction;
        this.dataProvider = dataProvider;
    }

    /**
     * Export the current view as an image
     * Simple approach: capture exactly what's visible on screen
     * @param {Object} options - Export options
     * @param {string} options.filename - Output filename (without extension)
     * @param {string} options.format - Image format ('png' or 'jpeg', default: 'jpeg')
     * @param {number} options.quality - JPEG quality (0.0 to 1.0, default: 0.92)
     * @returns {Promise<void>}
     */
    async exportCurrentView(options = {}) {
        const filename = options.filename || `alignment_${this.getTimestamp()}`;
        const format = options.format || 'jpeg';
        const quality = options.quality || 0.92;
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const extension = format === 'jpeg' ? '.jpg' : '.png';

        console.log(`Exporting ${format.toUpperCase()} (quality: ${quality})...`);

        try {
            console.log('Canvas dimensions:', this.canvas.width, 'x', this.canvas.height);
            console.log('Canvas element:', this.canvas);
            console.log('Data provider available:', !!this.dataProvider);

            // Force a fresh render to ensure everything is up to date
            if (this.renderFunction) {
                console.log('Calling render function...');
                this.renderFunction();
                // Wait for render to complete
                await new Promise(resolve => requestAnimationFrame(resolve));
            }

            // Don't try to get context again - it will fail if canvas already has a context
            // Just wait for any pending operations

            // Create a composite canvas that combines WebGL and UI layers
            const width = this.canvas.width;
            const height = this.canvas.height;

            console.log('Creating composite canvas:', width, 'x', height);

            const compositeCanvas = document.createElement('canvas');
            compositeCanvas.width = width;
            compositeCanvas.height = height;
            const ctx = compositeCanvas.getContext('2d');

            // For JPEG, add white background
            if (format === 'jpeg') {
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, width, height);
            }

            // Draw the WebGL canvas (sequence data)
            ctx.drawImage(this.canvas, 0, 0);

            // Draw the UI overlay if it exists (labels, ruler, etc.)
            if (this.uiCanvas) {
                ctx.drawImage(this.uiCanvas, 0, 0);
            }

            // Taxon labels disabled per user request
            // if (this.dataProvider) {
            //     console.log('Drawing taxon labels...');
            //     this.drawTaxonLabels(ctx, width, height);
            // }

            // Auto-crop to remove empty space
            const croppedCanvas = this.autoCrop(compositeCanvas);
            console.log(`Cropped from ${width}x${height} to ${croppedCanvas.width}x${croppedCanvas.height}`);

            // Convert to blob
            const blob = await new Promise(resolve => {
                croppedCanvas.toBlob(resolve, mimeType, quality);
            });

            if (!blob) {
                throw new Error('Failed to generate image blob');
            }

            // Download the image
            const sizeInKB = (blob.size / 1024).toFixed(1);
            console.log(`Export successful: ${sizeInKB} KB at ${croppedCanvas.width}x${croppedCanvas.height}px (cropped)`);
            this.downloadBlob(blob, `${filename}${extension}`);

        } catch (error) {
            console.error('Error exporting image:', error);
            console.error('Stack trace:', error.stack);
            alert(`Failed to export image: ${error.message}. Please try taking a screenshot instead.`);
        }
    }

    /**
     * Auto-crop a canvas to remove empty space
     * @param {HTMLCanvasElement} sourceCanvas - The canvas to crop
     * @returns {HTMLCanvasElement} - Cropped canvas
     */
    autoCrop(sourceCanvas) {
        const ctx = sourceCanvas.getContext('2d');
        const width = sourceCanvas.width;
        const height = sourceCanvas.height;

        // Get image data to scan for non-empty pixels
        const imageData = ctx.getImageData(0, 0, width, height);
        const pixels = imageData.data;

        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;

        // Find bounds of non-empty content
        // Look for actual sequence content (colored nucleotides)
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const r = pixels[idx];
                const g = pixels[idx + 1];
                const b = pixels[idx + 2];
                const a = pixels[idx + 3];

                // Check if pixel is meaningful content
                // Look for colors that indicate nucleotides or UI elements
                // Dark background is around (15, 23, 42) or similar dark blues
                // White background is (255, 255, 255)
                // We want to exclude both of these

                const isDarkBackground = (r < 30 && g < 40 && b < 60);
                const isWhiteBackground = (r > 250 && g > 250 && b > 250);
                const isTransparent = a < 10;

                // Content is anything that's not background
                const isContent = !isDarkBackground && !isWhiteBackground && !isTransparent;

                if (isContent) {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
            }
        }

        // Log the detected bounds before padding
        console.log(`Content bounds detected: X(${minX}-${maxX}), Y(${minY}-${maxY})`);

        // Add different padding for different edges
        // More padding on right to avoid cutting off last codon
        // Less padding on top/left where there's already empty space
        const leftPadding = 2;
        const topPadding = 2;
        const rightPadding = 20;  // Extra padding to ensure last codon isn't cut
        const bottomPadding = 5;

        minX = Math.max(0, minX - leftPadding);
        minY = Math.max(0, minY - topPadding);
        maxX = Math.min(width - 1, maxX + rightPadding);
        maxY = Math.min(height - 1, maxY + bottomPadding);

        console.log(`After padding: X(${minX}-${maxX}), Y(${minY}-${maxY})`);

        // Calculate cropped dimensions
        const cropWidth = maxX - minX + 1;
        const cropHeight = maxY - minY + 1;

        // If no content found or dimensions are invalid, return original
        if (cropWidth <= 0 || cropHeight <= 0 || minX >= width || minY >= height) {
            console.log('No content found for cropping, returning original canvas');
            return sourceCanvas;
        }

        // Create new canvas with cropped dimensions
        const croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = cropWidth;
        croppedCanvas.height = cropHeight;
        const croppedCtx = croppedCanvas.getContext('2d');

        // Copy the cropped region
        croppedCtx.drawImage(
            sourceCanvas,
            minX, minY, cropWidth, cropHeight,  // Source rectangle
            0, 0, cropWidth, cropHeight          // Destination rectangle
        );

        return croppedCanvas;
    }

    /**
     * Trigger browser download of a blob
     * @param {Blob} blob - The blob to download
     * @param {string} filename - Download filename
     */
    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();

        // Clean up
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    /**
     * Draw taxon labels on the left side of the canvas
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     */
    drawTaxonLabels(ctx, width, height) {
        if (!this.dataProvider || !this.dataProvider.getSequenceNames) {
            console.log('No data provider or getSequenceNames method');
            return;
        }

        const names = this.dataProvider.getSequenceNames();
        console.log('Got sequence names:', names ? names.length : 'null');
        const visibleRows = this.dataProvider.getVisibleRows ? this.dataProvider.getVisibleRows() : null;
        console.log('Visible rows:', visibleRows);
        const cellHeight = this.dataProvider.getCellHeight ? this.dataProvider.getCellHeight() : 20;
        const headerHeight = this.dataProvider.getHeaderHeight ? this.dataProvider.getHeaderHeight() : 30;
        const labelWidth = this.dataProvider.getLabelWidth ? this.dataProvider.getLabelWidth() : 100;
        const scrollY = this.dataProvider.getScrollY ? this.dataProvider.getScrollY() : 0;

        // Create dark background for labels (matching app theme)
        ctx.fillStyle = '#0F172A'; // Dark blue-gray background
        ctx.fillRect(0, 0, labelWidth, height);

        // Draw border on the right side
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(labelWidth, 0);
        ctx.lineTo(labelWidth, height);
        ctx.stroke();

        // Set font for labels - match the cell size
        const fontSize = Math.round(cellHeight * 0.5); // Proportional to cell height
        ctx.font = `${fontSize}px "JetBrains Mono", "Consolas", monospace`;
        ctx.fillStyle = '#E2E8F0'; // Light gray text
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        // Draw each visible taxon name
        if (visibleRows && names) {
            const startRow = visibleRows.start || 0;
            const endRow = visibleRows.end || names.length;

            for (let i = startRow; i <= endRow && i < names.length; i++) {
                // Calculate exact Y position to align with rows
                // The position should match exactly how rows are rendered
                const rowIndex = i - startRow;
                const y = headerHeight + (rowIndex * cellHeight) + (cellHeight / 2);

                if (y > headerHeight - cellHeight && y < height + cellHeight) {
                    const name = names[i] || `Seq ${i + 1}`;
                    // Truncate name if too long
                    const maxWidth = labelWidth - 15; // Leave padding
                    let displayName = name;

                    ctx.save();
                    // Measure and truncate if needed
                    if (ctx.measureText(name).width > maxWidth) {
                        while (displayName.length > 0 && ctx.measureText(displayName + '...').width > maxWidth) {
                            displayName = displayName.slice(0, -1);
                        }
                        displayName += '...';
                    }

                    // Add subtle hover effect for current row (optional)
                    const isCurrentRow = Math.abs(y - height/2) < cellHeight/2;
                    if (isCurrentRow) {
                        ctx.fillStyle = '#F3F4F6'; // Brighter for current row
                    }

                    ctx.fillText(displayName, 8, y);
                    ctx.restore();
                }
            }
        }

        // Draw header area background
        ctx.fillStyle = '#1E293B'; // Slightly lighter for header
        ctx.fillRect(0, 0, labelWidth, headerHeight);

        // Add "TAXA" label in header
        ctx.fillStyle = '#94A3B8';
        ctx.font = `${Math.round(headerHeight * 0.4)}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('TAXA', labelWidth / 2, headerHeight / 2);
    }

    /**
     * Get current timestamp for filename
     * @returns {string} Timestamp in YYYY-MM-DD_HH-MM format
     */
    getTimestamp() {
        const now = new Date();
        const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
        const time = now.toTimeString().slice(0, 5).replace(':', '-'); // HH-MM
        return `${date}_${time}`;
    }
}