/* global SelfieSegmentation */
'use strict';

// Turns a photo into a cloud of colored dots that trace the person in it.
// Everything runs here on the PC: the photo is never saved or sent anywhere,
// only the dot positions and colors are kept.
(function () {
  const LONG_SIDE = 800;  // working resolution
  const EDGE_GAP = 3;     // min px between outline dots
  const FILL_GAP = 11;    // min px between fill dots inside the body
  const MAX_EDGE = 5000;
  const MAX_FILL = 900;

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image this app can read. Try a JPG or PNG.')); };
      img.src = url;
    });
  }

  // Person/background mask from MediaPipe Selfie Segmentation (model ships with the app).
  async function segment(canvas) {
    if (typeof SelfieSegmentation === 'undefined') return null;
    const seg = new SelfieSegmentation({ locateFile: f => '../node_modules/@mediapipe/selfie_segmentation/' + f });
    seg.setOptions({ modelSelection: 0 });
    try {
      const px = await Promise.race([
        new Promise((resolve, reject) => {
          seg.onResults(r => {
            try {
              const c = document.createElement('canvas');
              c.width = canvas.width; c.height = canvas.height;
              const x = c.getContext('2d', { willReadFrequently: true });
              x.drawImage(r.segmentationMask, 0, 0, c.width, c.height);
              resolve(x.getImageData(0, 0, c.width, c.height).data);
            } catch (e) { reject(e); }
          });
          seg.send({ image: canvas }).catch(reject);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('segmentation timed out')), 20000)),
      ]);
      // The mask lives in the alpha channel on some GPUs and in red on others: use whichever varies.
      const n = canvas.width * canvas.height;
      let aMin = 255, aMax = 0, rMin = 255, rMax = 0;
      for (let i = 0; i < n; i++) {
        const a = px[i * 4 + 3], r = px[i * 4];
        if (a < aMin) aMin = a; if (a > aMax) aMax = a;
        if (r < rMin) rMin = r; if (r > rMax) rMax = r;
      }
      const ch = aMax - aMin >= rMax - rMin ? 3 : 0;
      if (Math.max(aMax - aMin, rMax - rMin) < 40) return null;
      const mask = new Float32Array(n);
      for (let i = 0; i < n; i++) mask[i] = px[i * 4 + ch] / 255;
      return mask;
    } catch (e) {
      console.warn('Shape: segmentation failed, using plain edges', e);
      return null;
    } finally {
      try { seg.close(); } catch { /* already closed */ }
    }
  }

  function sobel(src, W, H) {
    const out = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = src[i - W + 1] + 2 * src[i + 1] + src[i + W + 1] - src[i - W - 1] - 2 * src[i - 1] - src[i + W - 1];
        const gy = src[i + W - 1] + 2 * src[i + W] + src[i + W + 1] - src[i - W - 1] - 2 * src[i - W] - src[i - W + 1];
        out[i] = Math.hypot(gx, gy);
      }
    }
    return out;
  }

  function percentile(arr, p) {
    const sample = [];
    for (let i = 0; i < arr.length; i += 7) if (arr[i] > 0) sample.push(arr[i]);
    if (!sample.length) return 1;
    sample.sort((a, b) => a - b);
    return sample[Math.floor(sample.length * p)] || 1;
  }

  // Dark pixels (hair, beard, jeans) would vanish on black, so lift lightness and keep the hue.
  function dotColor(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    const L = Math.min(0.86, Math.max(0.52, l * 1.15));
    const S = Math.min(0.9, s * 1.35 + 0.08);
    return `hsl(${Math.round(h)} ${Math.round(S * 100)}% ${Math.round(L * 100)}%)`;
  }

  function mulberry(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function build(img, mask, W, H, rgba) {
    const n = W * H;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) gray[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

    const inside = new Float32Array(n);
    if (mask) {
      // Soft threshold, then keep a 1px margin so the outline itself is counted.
      for (let i = 0; i < n; i++) inside[i] = mask[i] > 0.5 ? 1 : mask[i] > 0.25 ? 0.5 : 0;
    } else {
      inside.fill(1);
    }

    const mag = sobel(gray, W, H);
    const norm = percentile(mag, 0.96);
    const strength = new Float32Array(n);
    let boundary = null;
    if (mask) {
      const m255 = new Float32Array(n);
      for (let i = 0; i < n; i++) m255[i] = mask[i] * 255;
      boundary = sobel(m255, W, H);
    }
    for (let i = 0; i < n; i++) {
      let s = Math.min(1, mag[i] / norm) * inside[i];
      if (boundary) s = Math.max(s, Math.min(1, boundary[i] / 400));
      strength[i] = s;
    }

    const blocked = new Uint8Array(n);
    const block = (x, y, r) => {
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        const span = Math.floor(Math.sqrt(r * r - dy * dy));
        for (let dx = -span; dx <= span; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) blocked[yy * W + xx] = 1;
        }
      }
    };
    const colorAt = (x, y) => {
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
        const i = (yy * W + xx) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; c++;
      }
      return dotColor(r / c, g / c, b / c);
    };

    // Pass 1: outline and inner lines, strongest edges first, evenly spaced.
    const cand = [];
    const threshold = mask ? 0.3 : 0.35;
    for (let i = 0; i < n; i++) if (strength[i] > threshold) cand.push(i);
    cand.sort((a, b) => strength[b] - strength[a]);
    const points = [];
    for (const i of cand) {
      if (points.length >= MAX_EDGE) break;
      if (blocked[i]) continue;
      const x = i % W, y = (i / W) | 0;
      points.push([x, y, +strength[i].toFixed(2), colorAt(x, y), 1]);
      block(x, y, EDGE_GAP);
    }
    const edgeCount = points.length;

    // Pass 2: sparse fill inside the person so the body reads as solid.
    if (mask) {
      const rand = mulberry(7);
      const inner = [];
      for (let i = 0; i < n; i++) if (inside[i] === 1 && !blocked[i]) inner.push(i);
      for (let k = inner.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [inner[k], inner[j]] = [inner[j], inner[k]]; }
      let added = 0;
      for (const i of inner) {
        if (added >= MAX_FILL) break;
        if (blocked[i]) continue;
        const x = i % W, y = (i / W) | 0;
        points.push([x, y, 0.1, colorAt(x, y), 0]);
        block(x, y, FILL_GAP);
        added++;
      }
    }

    // Short strokes between neighbouring outline dots draw the lines of the picture.
    const cell = EDGE_GAP * 3;
    const grid = new Map();
    for (let k = 0; k < edgeCount; k++) {
      const key = Math.floor(points[k][0] / cell) + ',' + Math.floor(points[k][1] / cell);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(k);
    }
    const strokes = [];
    const seen = new Set();
    const maxD = EDGE_GAP * 2.3;
    for (let k = 0; k < edgeCount; k++) {
      const [x, y] = points[k];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const near = [];
      for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (const j of grid.get(gx + ',' + gy) || []) {
          if (j === k) continue;
          const d = Math.hypot(points[j][0] - x, points[j][1] - y);
          if (d <= maxD) near.push([d, j]);
        }
      }
      near.sort((a, b) => a[0] - b[0]);
      for (const [, j] of near.slice(0, 2)) {
        const id = k < j ? k * 100000 + j : j * 100000 + k;
        if (!seen.has(id)) { seen.add(id); strokes.push([k, j]); }
      }
    }

    return { version: 1, w: W, h: H, segmented: !!mask, points, strokes };
  }

  async function fromFile(file) {
    const img = await loadImage(file);
    const scale = LONG_SIDE / Math.max(img.naturalWidth, img.naturalHeight);
    const W = Math.max(32, Math.round(img.naturalWidth * scale));
    const H = Math.max(32, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const rgba = ctx.getImageData(0, 0, W, H).data;
    const mask = await segment(canvas);
    return build(img, mask, W, H, rgba);
  }

  window.VaultShape = { fromFile };
})();
