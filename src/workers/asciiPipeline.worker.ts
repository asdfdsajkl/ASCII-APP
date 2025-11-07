// ASCII pipeline Web Worker: processes ImageData off the main thread.
// Receives: { imageData: ImageData, options: { invertColors, charSetName, charSet, gamma, dithering, compactMode } }
// Returns: { ascii: string }

import { detectBackground, computeForegroundBBox, floydSteinbergRefine } from '@/lib/image-processing';

type Options = {
  invertColors: boolean;
  charSetName: 'standard' | 'detailed' | 'simple' | 'binary' | 'braille';
  charSet: string[];
  gamma: number;
  dithering: boolean;
  compactMode: boolean;
  preprocess: boolean;
  preprocessStrength: number;
};

// Edge-aware preprocessing: preserves detail by smoothing low-gradient areas
// and classifying background via local thresholding. Morphology applies to masks only.
function computeLuminance(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const Y = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      Y[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return Y;
}

// sRGB to linear approximation and linear luminance (Rec. 709 coefficients)
function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function computeLuminanceLinear(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const Y = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = srgbToLinear(data[i]);
      const g = srgbToLinear(data[i + 1]);
      const b = srgbToLinear(data[i + 2]);
      const yl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      Y[y * width + x] = yl;
    }
  }
  return Y;
}

function sobelGradient(Y: Float32Array, width: number, height: number): Float32Array {
  const G = new Float32Array(width * height);
  let maxG = 1e-6;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const xm1 = x - 1, xp1 = x + 1, ym1 = y - 1, yp1 = y + 1;
      const a = Y[ym1 * width + xm1], b = Y[ym1 * width + x], c = Y[ym1 * width + xp1];
      const d = Y[y * width + xm1], e = Y[idx], f = Y[y * width + xp1];
      const g = Y[yp1 * width + xm1], h = Y[yp1 * width + x], i = Y[yp1 * width + xp1];
      const gx = -a + c - 2 * d + 2 * f - g + i;
      const gy = -a - 2 * b - c + g + 2 * h + i;
      const mag = Math.abs(gx) + Math.abs(gy);
      G[idx] = mag;
      if (mag > maxG) maxG = mag;
    }
  }
  // Normalize to [0,1]
  const inv = 1 / maxG;
  for (let j = 0; j < G.length; j++) G[j] = Math.min(1, G[j] * inv);
  return G;
}

function edgeAwareSmooth(Y: Float32Array, grad: Float32Array, width: number, height: number, strength: number) {
  if (strength <= 0) return;
  const out = new Float32Array(Y.length);
  const spatial = [1, 2, 1, 2, 4, 2, 1, 2, 1]; // 3x3 Gaussian kernel
  const sigmaR = 4 + strength * 5; // further milder range sigma
  const invTwoSigmaRSq = 1 / (2 * sigmaR * sigmaR);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = Y[idx];
      let wSum = 0;
      let vSum = 0;
      let k = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const nx = Math.min(width - 1, Math.max(0, x + kx));
          const ny = Math.min(height - 1, Math.max(0, y + ky));
          const nIdx = ny * width + nx;
          const v = Y[nIdx];
          const range = Math.exp(-(v - center) * (v - center) * invTwoSigmaRSq);
          const w = spatial[k++] * range;
          wSum += w;
          vSum += v * w;
        }
      }
      const bilateral = vSum / Math.max(1e-6, wSum);
      const edgeFactor = 1 - Math.min(1, grad[idx]);
      const blend = Math.min(1, Math.max(0, strength * edgeFactor * 0.25)); // reduce blending slightly more
      out[idx] = center * (1 - blend) + bilateral * blend;
    }
  }
  Y.set(out);
}

function buildIntegralImage(Y: Float32Array, width: number, height: number): Float64Array {
  const I = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      rowSum += Y[idx];
      I[idx] = rowSum + (y > 0 ? I[(y - 1) * width + x] : 0);
    }
  }
  return I;
}
// Build integral images for sum and sum of squares (for local mean/std)
function buildIntegralImages(Y: Float32Array, width: number, height: number): { I: Float64Array; I2: Float64Array } {
  const I = new Float64Array(width * height);
  const I2 = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSum2 = 0;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v = Y[idx];
      rowSum += v;
      rowSum2 += v * v;
      I[idx] = rowSum + (y > 0 ? I[(y - 1) * width + x] : 0);
      I2[idx] = rowSum2 + (y > 0 ? I2[(y - 1) * width + x] : 0);
    }
  }
  return { I, I2 };
}

function boxSum(I: Float64Array, width: number, height: number, x: number, y: number, r: number): number {
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(width - 1, x + r);
  const y1 = Math.min(height - 1, y + r);
  const A = I[y0 * width + x0];
  const B = I[y0 * width + x1];
  const C = I[y1 * width + x0];
  const D = I[y1 * width + x1];
  return D - B - C + A;
}
// Compute local mean/std using integral images
function boxStats(I: Float64Array, I2: Float64Array, width: number, height: number, x: number, y: number, r: number): { mean: number; std: number } {
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(width - 1, x + r);
  const y1 = Math.min(height - 1, y + r);
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  const A = I[y0 * width + x0];
  const B = I[y0 * width + x1];
  const C = I[y1 * width + x0];
  const D = I[y1 * width + x1];
  const As = I2[y0 * width + x0];
  const Bs = I2[y0 * width + x1];
  const Cs = I2[y1 * width + x0];
  const Ds = I2[y1 * width + x1];
  const sum = D - B - C + A;
  const sum2 = Ds - Bs - Cs + As;
  const mean = sum / Math.max(1, area);
  const var_ = Math.max(0, sum2 / Math.max(1, area) - mean * mean);
  const std = Math.sqrt(var_);
  return { mean, std };
}

// Compute local mean over a square window for all pixels
function computeLocalMean(Y: Float32Array, width: number, height: number, radius: number): Float32Array {
  const I = buildIntegralImage(Y, width, height);
  const out = new Float32Array(width * height);
  const areaBase = (2 * radius + 1) * (2 * radius + 1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mean = boxSum(I, width, height, x, y, radius) / areaBase;
      out[y * width + x] = mean;
    }
  }
  return out;
}

// Retinex-style reflectance: log(Y) - log(illumination)
function computeReflectanceLog(Ylin: Float32Array, illum: Float32Array): Float32Array {
  const R = new Float32Array(Ylin.length);
  const eps = 1e-6;
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < Ylin.length; i++) {
    const v = Math.log(Ylin[i] + eps) - Math.log(illum[i] + eps);
    R[i] = v;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const range = Math.max(1e-6, maxV - minV);
  for (let i = 0; i < R.length; i++) R[i] = Math.min(1, Math.max(0, (R[i] - minV) / range));
  return R;
}

// Percentile threshold from histogram (0..1 values)
function percentileThreshold(buf: Float32Array, p: number): number {
  const bins = 256;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < buf.length; i++) {
    const b = Math.max(0, Math.min(bins - 1, Math.floor(buf[i] * (bins - 1))));
    hist[b]++;
  }
  const target = Math.floor((buf.length * p) / 100);
  let cum = 0;
  for (let i = 0; i < bins; i++) {
    cum += hist[i];
    if (cum >= target) return i / (bins - 1);
  }
  return 0.5;
}
// Soft background probability (0..1) using local mean/std with edge gating
function computeSoftBackgroundProb(Y: Float32Array, width: number, height: number, radius: number, k: number, grad?: Float32Array, gThresh: number = 0.2): Float32Array {
  const { I, I2 } = buildIntegralImages(Y, width, height);
  const P = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const { mean, std } = boxStats(I, I2, width, height, x, y, radius);
      const val = Y[idx];
      const thresh = mean - k * std; // darker-than-local becomes foreground
      const beta = Math.max(5, 0.5 * std + 5); // softness scale
      let z = (val - thresh) / beta;
      let p = 1 / (1 + Math.exp(-z));
      if (grad) {
        const g = grad[idx];
        if (g > gThresh) {
          const gate = Math.min(1, (g - gThresh) / Math.max(1e-6, 1 - gThresh));
          p *= 1 - 0.75 * gate; // reduce bg probability near edges
        }
      }
      P[idx] = Math.max(0, Math.min(1, p));
    }
  }
  return P;
}

function computeLocalBackgroundMask(Y: Float32Array, width: number, height: number, radius: number, t: number, grad?: Float32Array, gThresh: number = 0.2): Uint8Array {
  const I = buildIntegralImage(Y, width, height);
  const areaBase = (2 * radius + 1) * (2 * radius + 1);
  const bg = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mean = boxSum(I, width, height, x, y, radius) / areaBase;
      const val = Y[y * width + x];
      // Edge gating: treat strong edges as foreground to preserve detail
      if (grad && grad[y * width + x] > gThresh) {
        bg[y * width + x] = 0;
      } else {
        // Bradley adaptive threshold: foreground if val < mean * (1 - t)
        bg[y * width + x] = val >= mean * (1 - t) ? 1 : 0;
      }
    }
  }
  return bg;
}

function erodeMask(mask: Uint8Array, width: number, height: number, edgeMask?: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  const idx = (x: number, y: number) => y * width + x;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (edgeMask && edgeMask[i]) { out[i] = mask[i]; continue; }
      let keep = 1;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const nx = Math.min(width - 1, Math.max(0, x + kx));
          const ny = Math.min(height - 1, Math.max(0, y + ky));
          if (mask[idx(nx, ny)] === 0) { keep = 0; break; }
        }
        if (!keep) break;
      }
      out[i] = keep;
    }
  }
  return out;
}

function dilateMask(mask: Uint8Array, width: number, height: number, edgeMask?: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  const idx = (x: number, y: number) => y * width + x;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (edgeMask && edgeMask[i]) { out[i] = mask[i]; continue; }
      let on = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const nx = Math.min(width - 1, Math.max(0, x + kx));
          const ny = Math.min(height - 1, Math.max(0, y + ky));
          if (mask[idx(nx, ny)] === 1) { on = 1; break; }
        }
        if (on) break;
      }
      out[i] = on;
    }
  }
  return out;
}

function refineMasks(bgMask: Uint8Array, width: number, height: number, grad: Float32Array, passes: number): Uint8Array {
  if (passes <= 0) return bgMask;
  // Skip strong edge regions when morphing
  const edgeMask = new Uint8Array(bgMask.length);
  for (let i = 0; i < grad.length; i++) edgeMask[i] = grad[i] > 0.35 ? 1 : 0;
  let fgMask = new Uint8Array(bgMask.length);
  for (let i = 0; i < bgMask.length; i++) fgMask[i] = bgMask[i] ? 0 : 1;
  let bg = bgMask;
  let fg = fgMask;
  for (let p = 0; p < passes; p++) {
    // Background closing fills small holes
    bg = dilateMask(bg, width, height, edgeMask);
    bg = erodeMask(bg, width, height, edgeMask);
    // Foreground opening removes salt noise
    fg = erodeMask(fg, width, height, edgeMask);
    fg = dilateMask(fg, width, height, edgeMask);
  }
  // Merge back to bg mask: background if bg==1, else foreground
  const merged = new Uint8Array(bg.length);
  for (let i = 0; i < bg.length; i++) merged[i] = bg[i];
  return merged;
}

// Simple, effective preprocessing profile (fixed)
const DEFAULT_PREPROCESS = { smooth: 0.25, radius: 3, k: 0.18, gThresh: 0.15, fade: 0.65, morphPasses: 1 } as const;

// Unified lightweight preprocessing helpers
function posterizeGray(buf: Uint8ClampedArray, levels: number) {
  if (levels <= 1) levels = 2;
  const step = 255 / (levels - 1);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.round(buf[i] / step) * step;
  }
}

function medianFilterGray(buf: Uint8ClampedArray, width: number, height: number, radius: number = 1) {
  const out = new Uint8ClampedArray(buf.length);
  const windowSize = (radius * 2 + 1) * (radius * 2 + 1);
  const window = new Uint8Array(windowSize);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let j = -radius; j <= radius; j++) {
        for (let i = -radius; i <= radius; i++) {
          const nx = Math.min(width - 1, Math.max(0, x + i));
          const ny = Math.min(height - 1, Math.max(0, y + j));
          window[n++] = buf[ny * width + nx];
        }
      }
      // Sort small window and take median
      window.sort();
      const mid = window[Math.floor(windowSize / 2)];
      out[y * width + x] = mid;
    }
  }
  buf.set(out);
}

function generateBrailleArt(grayBuf: Uint8ClampedArray, width: number, height: number, bbox: {left: number, top: number, right: number, bottom: number}): string {
  let asciiArt = '';
  const startY = Math.floor(bbox.top / 4) * 4;
  const endY = Math.ceil(bbox.bottom / 4) * 4;
  const startX = Math.floor(bbox.left / 2) * 2;
  const endX = Math.ceil(bbox.right / 2) * 2;

  for (let y = startY; y < endY; y += 4) {
    for (let x = startX; x < endX; x += 2) {
      const dotMap = [1, 2, 3, 7, 4, 5, 6, 8];
      let brailleCode = 0x2800;
      let dotIndex = 0;

      for (let col = 0; col < 2; col++) {
        for (let row = 0; row < 4; row++) {
          const px = x + col;
          const py = y + row;
          if (px < width && py < height) {
            const brightness = grayBuf[py * width + px];
            if (brightness > 127) {
              brailleCode |= (1 << (dotMap[dotIndex] - 1));
            }
          }
          dotIndex++;
        }
      }
      asciiArt += String.fromCharCode(brailleCode);
    }
    asciiArt += '\n';
  }
  return asciiArt;
}

self.onmessage = (evt: MessageEvent) => {
  const { imageData, options } = evt.data as { imageData: ImageData; options: Options };
  const { invertColors, charSetName, charSet, gamma, dithering, compactMode, preprocess, preprocessStrength } = options;

  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  // Optional color inversion first
  if (invertColors) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
    }
  }

  // Build luminance
  const Y = computeLuminance(data, w, h);

  // Background mask: use library detection (preprocess removed)
  const isBackground = detectBackground(imageData);
  const bgMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      bgMask[y * w + x] = isBackground(r, g, b, a) ? 1 : 0;
    }
  }

  // Compute bbox: compactMode shows full frame; otherwise use library foreground bbox
  const bbox: { left: number; top: number; right: number; bottom: number } = compactMode
    ? { left: 0, top: 0, right: w, bottom: h }
    : computeForegroundBBox(imageData, detectBackground(imageData));

  // Prepare grayscale buffer: classic luminance with gamma
  const grayBuf = new Uint8ClampedArray(w * h);
  const gammaLUT = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) gammaLUT[i] = Math.max(0, Math.min(255, Math.pow(i / 255, gamma) * 255));
  for (let i = 0; i < grayBuf.length; i++) {
    grayBuf[i] = gammaLUT[Math.max(0, Math.min(255, Math.round(Y[i])))];
  }

  // Unified lightweight preprocessing, gated by toggle
  if (preprocess) {
    const origGray = grayBuf.slice();
    const preGray = grayBuf.slice();
    if (compactMode) {
      posterizeGray(preGray, 2);
      medianFilterGray(preGray, w, h, 1);
    } else {
      posterizeGray(preGray, 3);
      medianFilterGray(preGray, w, h, 1);
    }
    const blend = Math.max(0, Math.min(1, (preprocessStrength ?? 0) / 10));
    for (let i = 0; i < grayBuf.length; i++) {
      const v = preGray[i] * (1 - blend) + origGray[i] * blend;
      grayBuf[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }

  // Dithering improves tonal transitions for ASCII sets; skip for Braille.
  const setLen = charSet.length || 1;
  const step = Math.max(1, Math.floor(255 / setLen));
  if (dithering && charSetName !== 'braille') {
    floydSteinbergRefine(grayBuf, bgMask, w, h, step);
  }

  // Precompute intensity-to-char mapping; build rows efficiently
  const charMap = new Array<string>(256);
  for (let i = 0; i < 256; i++) {
    const charIdx = Math.max(0, Math.min(setLen - 1, Math.round(i / step)));
    charMap[i] = charSet[charIdx] || ' ';
  }

  let asciiArtResult = '';
  if (charSetName === 'braille') {
    const brailleBbox = {
      left: Math.floor(bbox.left / 2) * 2,
      top: Math.floor(bbox.top / 4) * 4,
      right: Math.ceil(bbox.right / 2) * 2,
      bottom: Math.ceil(bbox.bottom / 4) * 4,
    };
    asciiArtResult = generateBrailleArt(grayBuf, w, h, brailleBbox);
  } else {
    const regularBbox = {
      left: Math.floor(bbox.left),
      top: Math.floor(bbox.top),
      right: Math.ceil(bbox.right),
      bottom: Math.ceil(bbox.bottom),
    };
    const lines: string[] = [];
    for (let y = regularBbox.top; y < regularBbox.bottom; y++) {
      const rowChars: string[] = [];
      for (let x = regularBbox.left; x < regularBbox.right; x++) {
        const idx = y * w + x;
        rowChars.push(bgMask[idx] ? ' ' : charMap[grayBuf[idx]]);
      }
      lines.push(rowChars.join(''));
    }
    asciiArtResult = lines.join('\n');
  }

  self.postMessage({ ascii: asciiArtResult });
};
