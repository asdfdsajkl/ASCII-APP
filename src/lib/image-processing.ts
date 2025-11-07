/**
 * Measure approximate code character width/height in pixels for the current font.
 * Used to derive row counts based on image aspect ratio and character aspect.
 */
export const measureCharMetrics = (fontSizePx: number, fontFace: string) => {
    if (typeof window === 'undefined') return { charWidth: 8, charHeight: 16 };
    const measurer = document.createElement('span');
    measurer.style.visibility = 'hidden';
    measurer.style.position = 'absolute';
    measurer.style.fontFamily = fontFace || 'monospace';
    measurer.style.whiteSpace = 'pre';
    measurer.style.lineHeight = '1';
    measurer.style.fontSize = `${fontSizePx}px`;
    measurer.textContent = 'M';
    document.body.appendChild(measurer);
    const rect = measurer.getBoundingClientRect();
    document.body.removeChild(measurer);
    return { charWidth: rect.width, charHeight: rect.height };
};

/**
 * Heuristically detect the image background by sampling border pixels.
 * Returns a predicate that classifies a pixel as background (transparent/white/black).
 */
export const detectBackground = (imageData: ImageData) => {
    const data = imageData.data;
    const w = imageData.width, h = imageData.height;
    const transparentThresh = 32;
    const opaqueThresh = 220;
    const whiteThresh = 245;
    const blackThresh = 10;
    let trans = 0, white = 0, black = 0, samples = 0;

    const samplePixel = (idx: number) => {
        const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
        if (a < transparentThresh) trans++;
        else if (brightness >= whiteThresh && a >= opaqueThresh) white++;
        else if (brightness <= blackThresh && a >= opaqueThresh) black++;
        samples++;
    };

    for (let x = 0; x < w; x++) {
        samplePixel((0 * w + x) * 4);
        samplePixel(((h - 1) * w + x) * 4);
    }
    for (let y = 1; y < h - 1; y++) {
        samplePixel((y * w + 0) * 4);
        samplePixel((y * w + (w - 1)) * 4);
    }

    if (trans >= Math.max(white, black) && trans > samples * 0.3) {
        return (r: number, g: number, b: number, a: number) => a < transparentThresh;
    }
    if (white >= Math.max(black, trans) && white > samples * 0.3) {
        return (r: number, g: number, b: number, a: number) => (0.299 * r + 0.587 * g + 0.114 * b) >= whiteThresh && a >= opaqueThresh;
    }
    if (black >= Math.max(white, trans) && black > samples * 0.3) {
        return (r: number, g: number, b: number, a: number) => (0.299 * r + 0.587 * g + 0.114 * b) <= blackThresh && a >= opaqueThresh;
    }
    
    return () => false;
}

/**
 * Compute a tight bounding box around the foreground by trimming background rows/columns.
 * Adds a 1px margin if a valid box is found; falls back to full image if empty.
 */
export const computeForegroundBBox = (imageData: ImageData, isBackground: (r: number, g: number, b: number, a: number) => boolean) => {
    const data = imageData.data;
    const w = imageData.width, h = imageData.height;
    let top = 0, bottom = h, left = 0, right = w;

    const rowIsBackground = (y: number) => {
        for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            if (!isBackground(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) return false;
        }
        return true;
    };
    
    const colIsBackground = (x: number) => {
        for (let y = 0; y < h; y++) {
            const idx = (y * w + x) * 4;
            if (!isBackground(data[idx], data[idx + 1], data[idx + 2], data[idx + 3])) return false;
        }
        return true;
    };

    while (top < bottom && rowIsBackground(top)) top++;
    while (bottom - 1 > top && rowIsBackground(bottom - 1)) bottom--;
    while (left < right && colIsBackground(left)) left++;
    while (right - 1 > left && colIsBackground(right - 1)) right--;

    if (left >= right || top >= bottom) return { left: 0, top: 0, right: w, bottom: h };
    
    left = Math.max(0, left - 1);
    top = Math.max(0, top - 1);
    right = Math.min(w, right + 1);
    bottom = Math.min(h, bottom + 1);
    
    return { left, top, right, bottom };
}

/**
 * Optionally invert the image colors and write back to the canvas.
 */
export const applyImageAdjustments = (ctx: CanvasRenderingContext2D, width: number, height: number, invert: boolean) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    if (invert) {
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 255 - data[i];
            data[i + 1] = 255 - data[i + 1];
            data[i + 2] = 255 - data[i + 2];
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

/**
 * Floyd–Steinberg error diffusion on a grayscale buffer.
 * Quantizes to nearest step and diffuses error to neighbors, skipping background.
 */
export const floydSteinbergRefine = (grayBuf: Uint8ClampedArray, bgMask: Uint8Array, w: number, h: number, step: number) => {
    const clamp = (v: number) => v < 0 ? 0 : (v > 255 ? 255 : v);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (bgMask[i]) continue;
            const old = grayBuf[i];
            const q = Math.round(old / step) * step;
            const err = old - q;
            grayBuf[i] = q;
            if (x + 1 < w) { const r = i + 1; if (!bgMask[r]) grayBuf[r] = clamp(grayBuf[r] + err * (7 / 16)); }
            if (x - 1 >= 0 && y + 1 < h) { const dl = i + w - 1; if (!bgMask[dl]) grayBuf[dl] = clamp(grayBuf[dl] + err * (3 / 16)); }
            if (y + 1 < h) { const d = i + w; if (!bgMask[d]) grayBuf[d] = clamp(grayBuf[d] + err * (5 / 16)); }
            if (x + 1 < w && y + 1 < h) { const dr = i + w + 1; if (!bgMask[dr]) grayBuf[dr] = clamp(grayBuf[dr] + err * (1 / 16)); }
        }
    }
}

/**
 * Preprocess image for Compact Mode: posterize to 2 levels, median filter,
 * morphological opening (erode→dilate) controlled by simplicity, then scale.
 */
export const preprocessImage = (ctx: CanvasRenderingContext2D, img: HTMLImageElement, simplicity: number) => {
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    if (!tempCtx) {
        ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
        return;
    };

    const targetWidth = ctx.canvas.width;
    const targetHeight = ctx.canvas.height;
    
    const processWidth = Math.min(img.width, 400);
    const processHeight = (processWidth / img.width) * img.height;

    tempCanvas.width = processWidth;
    tempCanvas.height = processHeight;

    // 1. Draw original image
    tempCtx.drawImage(img, 0, 0, processWidth, processHeight);
    
    // 2. Grayscale and Posterize
    const imageData = tempCtx.getImageData(0, 0, processWidth, processHeight);
    posterize(imageData.data, 2); // Hard posterize to 2 levels (black/white)

    // 3. Median Filter to remove salt-and-pepper noise
    medianFilter(imageData.data, processWidth, processHeight);

    // 4. Morphological Opening (Erode then Dilate) to remove small objects
    const binaryData = toBinary(imageData.data);
    const passes = Math.floor((simplicity - 1) / 2); // Control passes with Simplicity slider
    for(let i = 0; i < passes; i++) {
      erode(binaryData, processWidth, processHeight);
    }
    for(let i = 0; i < passes; i++) {
      dilate(binaryData, processWidth, processHeight);
    }
    fromBinary(binaryData, imageData.data);

    // 5. Put cleaned data back and draw to main canvas
    tempCtx.putImageData(imageData, 0, 0);
    ctx.imageSmoothingEnabled = false; // Use nearest-neighbor for crisp pixels
    ctx.drawImage(tempCanvas, 0, 0, targetWidth, targetHeight);
};


// --- Morphological and Pre-processing Helpers ---

/** Posterize RGB to a limited number of brightness levels. */
function posterize(data: Uint8ClampedArray, levels = 4) {
    if (levels <= 1) levels = 2;
    const step = 255 / (levels - 1);
    for (let i = 0; i < data.length; i += 4) {
        const brightness = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        const level = Math.round(brightness / step) * step;
        data[i] = level;
        data[i+1] = level;
        data[i+2] = level;
    }
}

/** Median filter to reduce salt-and-pepper noise. */
function medianFilter(data: Uint8ClampedArray, width: number, height: number, radius: number = 1) {
    const output = new Uint8ClampedArray(data.length);
    const windowSize = (radius * 2 + 1) * (radius * 2 + 1);
    const windowR = new Uint8Array(windowSize);
    const windowG = new Uint8Array(windowSize);
    const windowB = new Uint8Array(windowSize);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let n = 0;
            for (let j = -radius; j <= radius; j++) {
                for (let i = -radius; i <= radius; i++) {
                    const nx = Math.min(width - 1, Math.max(0, x + i));
                    const ny = Math.min(height - 1, Math.max(0, y + j));
                    const idx = (ny * width + nx) * 4;
                    windowR[n] = data[idx];
                    windowG[n] = data[idx + 1];
                    windowB[n] = data[idx + 2];
                    n++;
                }
            }
            windowR.sort();
            windowG.sort();
            windowB.sort();
            const mid = Math.floor(windowSize / 2);
            const outIdx = (y * width + x) * 4;
            output[outIdx] = windowR[mid];
            output[outIdx + 1] = windowG[mid];
            output[outIdx + 2] = windowB[mid];
            output[outIdx + 3] = data[outIdx + 3];
        }
    }
    data.set(output);
}


/** Convert grayscale RGB data to binary mask: 1=white, 0=black. */
function toBinary(data: Uint8ClampedArray): Uint8Array {
    const binary = new Uint8Array(data.length / 4);
    for (let i = 0; i < binary.length; i++) {
        binary[i] = data[i * 4] > 128 ? 1 : 0; // 1 for white, 0 for black
    }
    return binary;
}

/** Write binary mask back to RGB channels as 0/255. */
function fromBinary(binary: Uint8Array, data: Uint8ClampedArray) {
    for (let i = 0; i < binary.length; i++) {
        const val = binary[i] * 255;
        data[i * 4] = val;
        data[i * 4 + 1] = val;
        data[i * 4 + 2] = val;
    }
}

/** Binary erosion using 4-neighborhood to remove small white regions. */
function erode(binaryData: Uint8Array, width: number, height: number) {
    const input = new Uint8Array(binaryData);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (
                input[i - width] === 0 || input[i + width] === 0 ||
                input[i - 1] === 0 || input[i + 1] === 0
            ) {
                binaryData[i] = 0;
            }
        }
    }
}

/** Binary dilation using 4-neighborhood to restore/thicken white regions. */
function dilate(binaryData: Uint8Array, width: number, height: number) {
    const input = new Uint8Array(binaryData);
    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            const i = y * width + x;
            if (
                input[i - width] === 1 || input[i + width] === 1 ||
                input[i - 1] === 1 || input[i + 1] === 1
            ) {
                binaryData[i] = 1;
            }
        }
    }
}
