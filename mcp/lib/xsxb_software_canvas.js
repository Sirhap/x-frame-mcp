"use strict";

/**
 * Minimal Canvas 2D + Image polyfill so AttackTrailEditor can bake meshes in Node
 * without Playwright. Only the drawing path used by trail export is implemented.
 */

const { decodePngRgba } = require("../xsxb_mcp_cutout");

function identity() {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiply(left, right) {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

function apply(matrix, x, y) {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
}

function invert(matrix) {
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(det) < 1e-12) return null;
  return {
    a: matrix.d / det,
    b: -matrix.b / det,
    c: -matrix.c / det,
    d: matrix.a / det,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / det,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / det,
  };
}

function parseColor(value) {
  const text = String(value || "").trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const raw = hex[1];
    const full =
      raw.length === 3
        ? raw
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : raw;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
      255,
    ];
  }
  const rgba = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgba) {
    const alpha =
      rgba[4] === undefined ? 255 : Math.round(Number(rgba[4]) * (Number(rgba[4]) <= 1 ? 255 : 1));
    return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), alpha];
  }
  return [0, 0, 0, 255];
}

function copyMask(mask) {
  return mask ? Uint8Array.from(mask) : null;
}

function sampleBilinear(source, width, height, x, y) {
  if (x < -1 || y < -1 || x > width || y > height) return [0, 0, 0, 0];
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;
  const pixel = (px, py) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return [0, 0, 0, 0];
    const offset = (py * width + px) * 4;
    return [source[offset], source[offset + 1], source[offset + 2], source[offset + 3]];
  };
  const c00 = pixel(x0, y0);
  const c10 = pixel(x1, y0);
  const c01 = pixel(x0, y1);
  const c11 = pixel(x1, y1);
  const mix = (left, right, t) => left + (right - left) * t;
  const top = c00.map((channel, index) => mix(channel, c10[index], fx));
  const bottom = c01.map((channel, index) => mix(channel, c11[index], fx));
  return top.map((channel, index) => mix(channel, bottom[index], fy));
}

function blendPixel(dest, offset, src, composite, alphaScale) {
  const sr = src[0];
  const sg = src[1];
  const sb = src[2];
  const sa = Math.max(0, Math.min(255, src[3] * alphaScale));
  if (sa <= 0 && composite !== "destination-in") return;
  const dr = dest[offset];
  const dg = dest[offset + 1];
  const db = dest[offset + 2];
  const da = dest[offset + 3];
  if (composite === "destination-in") {
    const factor = sa / 255;
    dest[offset] = dr * factor;
    dest[offset + 1] = dg * factor;
    dest[offset + 2] = db * factor;
    dest[offset + 3] = da * factor;
    return;
  }
  if (composite === "lighter") {
    dest[offset] = Math.min(255, dr + sr * (sa / 255));
    dest[offset + 1] = Math.min(255, dg + sg * (sa / 255));
    dest[offset + 2] = Math.min(255, db + sb * (sa / 255));
    dest[offset + 3] = Math.min(255, da + sa);
    return;
  }
  const srcA = sa / 255;
  const outA = srcA + (da / 255) * (1 - srcA);
  if (outA <= 0) {
    dest[offset] = 0;
    dest[offset + 1] = 0;
    dest[offset + 2] = 0;
    dest[offset + 3] = 0;
    return;
  }
  dest[offset] = (sr * srcA + dr * (da / 255) * (1 - srcA)) / outA;
  dest[offset + 1] = (sg * srcA + dg * (da / 255) * (1 - srcA)) / outA;
  dest[offset + 2] = (sb * srcA + db * (da / 255) * (1 - srcA)) / outA;
  dest[offset + 3] = outA * 255;
}

function pointInTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign({ x: px, y: py }, a, b);
  const d2 = sign({ x: px, y: py }, b, c);
  const d3 = sign({ x: px, y: py }, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  if (length <= 1e-8) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function parseBlurRadius(filter) {
  const match = String(filter || "").match(/blur\(\s*([\d.]+)px\s*\)/i);
  return match ? Number(match[1]) : 0;
}

function boxBlur(pixels, width, height, radius) {
  const size = Math.max(1, Math.round(radius));
  if (size <= 0) return pixels;
  const src = pixels;
  const tmp = new Uint8ClampedArray(src.length);
  const passes = 2;
  const kernel = size * 2 + 1;
  let current = src;
  let next = tmp;
  for (let pass = 0; pass < passes; pass += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let count = 0;
        for (let k = -size; k <= size; k += 1) {
          const xx = Math.max(0, Math.min(width - 1, x + k));
          const offset = (y * width + xx) * 4;
          r += current[offset];
          g += current[offset + 1];
          b += current[offset + 2];
          a += current[offset + 3];
          count += 1;
        }
        const dest = (y * width + x) * 4;
        next[dest] = r / count;
        next[dest + 1] = g / count;
        next[dest + 2] = b / count;
        next[dest + 3] = a / count;
      }
    }
    const swap = current;
    current = next;
    next = swap;
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let count = 0;
        for (let k = -size; k <= size; k += 1) {
          const yy = Math.max(0, Math.min(height - 1, y + k));
          const offset = (yy * width + x) * 4;
          r += current[offset];
          g += current[offset + 1];
          b += current[offset + 2];
          a += current[offset + 3];
          count += 1;
        }
        const dest = (y * width + x) * 4;
        next[dest] = r / count;
        next[dest + 1] = g / count;
        next[dest + 2] = b / count;
        next[dest + 3] = a / count;
      }
    }
    const swap2 = current;
    current = next;
    next = swap2;
    void kernel;
  }
  return current === pixels ? Uint8ClampedArray.from(current) : current;
}

function sourcePixels(image) {
  if (!image) return null;
  if (image instanceof SoftwareCanvas)
    return { data: image._pixels, width: image.width, height: image.height };
  if (image.data && image.width && image.height) {
    return { data: image.data, width: image.width, height: image.height };
  }
  return null;
}

class SoftwareContext {
  constructor(canvas) {
    this.canvas = canvas;
    this._resetStyle();
    this._path = [];
    this._stack = [];
  }

  _resetStyle() {
    this._transform = identity();
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.fillStyle = "#000000";
    this.strokeStyle = "#000000";
    this.lineWidth = 1;
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this.filter = "none";
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = "low";
    this._clip = null;
  }

  _state() {
    return {
      transform: { ...this._transform },
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      filter: this.filter,
      imageSmoothingEnabled: this.imageSmoothingEnabled,
      imageSmoothingQuality: this.imageSmoothingQuality,
      clip: copyMask(this._clip),
    };
  }

  save() {
    this._stack.push(this._state());
  }

  restore() {
    const state = this._stack.pop();
    if (!state) return;
    this._transform = state.transform;
    this.globalAlpha = state.globalAlpha;
    this.globalCompositeOperation = state.globalCompositeOperation;
    this.fillStyle = state.fillStyle;
    this.strokeStyle = state.strokeStyle;
    this.lineWidth = state.lineWidth;
    this.lineCap = state.lineCap;
    this.lineJoin = state.lineJoin;
    this.filter = state.filter;
    this.imageSmoothingEnabled = state.imageSmoothingEnabled;
    this.imageSmoothingQuality = state.imageSmoothingQuality;
    this._clip = state.clip;
  }

  setTransform(a, b, c, d, e, f) {
    this._transform = { a, b, c, d, e, f };
  }

  translate(x, y) {
    this._transform = multiply(this._transform, {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: Number(x) || 0,
      f: Number(y) || 0,
    });
  }

  rotate(radians) {
    const angle = Number(radians) || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this._transform = multiply(this._transform, { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 });
  }

  scale(x, y = x) {
    this._transform = multiply(this._transform, {
      a: Number(x) || 0,
      b: 0,
      c: 0,
      d: Number(y) || 0,
      e: 0,
      f: 0,
    });
  }

  beginPath() {
    this._path = [];
  }

  moveTo(x, y) {
    this._path.push({ type: "move", ...apply(this._transform, x, y) });
  }

  lineTo(x, y) {
    this._path.push({ type: "line", ...apply(this._transform, x, y) });
  }

  closePath() {
    this._path.push({ type: "close" });
  }

  _polygons() {
    const polygons = [];
    let current = [];
    const flush = () => {
      if (current.length >= 3) polygons.push(current);
      current = [];
    };
    for (const command of this._path) {
      if (command.type === "move") {
        flush();
        current = [{ x: command.x, y: command.y }];
      } else if (command.type === "line") {
        if (!current.length) current.push({ x: command.x, y: command.y });
        else current.push({ x: command.x, y: command.y });
      } else if (command.type === "close") {
        flush();
      }
    }
    flush();
    return polygons;
  }

  _visitCovered(points, visitor) {
    if (points.length < 3) return;
    const box = boundsOf(points);
    const minX = Math.max(0, Math.floor(box.minX));
    const minY = Math.max(0, Math.floor(box.minY));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(box.maxX));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(box.maxY));
    const a = points[0];
    for (let i = 1; i < points.length - 1; i += 1) {
      const b = points[i];
      const c = points[i + 1];
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (pointInTriangle(x + 0.5, y + 0.5, a, b, c)) visitor(x, y);
        }
      }
    }
  }

  _put(x, y, color) {
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return;
    if (this._clip && !this._clip[y * this.canvas.width + x]) return;
    blendPixel(
      this.canvas._pixels,
      (y * this.canvas.width + x) * 4,
      color,
      this.globalCompositeOperation,
      this.globalAlpha,
    );
  }

  fill() {
    const color = parseColor(this.fillStyle);
    for (const polygon of this._polygons()) this._visitCovered(polygon, (x, y) => this._put(x, y, color));
  }

  stroke() {
    const color = parseColor(this.strokeStyle);
    const radius = Math.max(0.5, Number(this.lineWidth) || 1) / 2;
    const points = [];
    for (const command of this._path) {
      if (command.type === "move" || command.type === "line") points.push(command);
    }
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const box = boundsOf([start, end]);
      const minX = Math.max(0, Math.floor(box.minX - radius - 1));
      const minY = Math.max(0, Math.floor(box.minY - radius - 1));
      const maxX = Math.min(this.canvas.width - 1, Math.ceil(box.maxX + radius + 1));
      const maxY = Math.min(this.canvas.height - 1, Math.ceil(box.maxY + radius + 1));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (distanceToSegment(x + 0.5, y + 0.5, start.x, start.y, end.x, end.y) <= radius + 0.35) {
            this._put(x, y, color);
          }
        }
      }
    }
  }

  clip() {
    const mask = new Uint8Array(this.canvas.width * this.canvas.height);
    for (const polygon of this._polygons()) {
      this._visitCovered(polygon, (x, y) => {
        mask[y * this.canvas.width + x] = 1;
      });
    }
    if (!this._clip) {
      this._clip = mask;
      return;
    }
    for (let index = 0; index < mask.length; index += 1) {
      this._clip[index] = this._clip[index] && mask[index] ? 1 : 0;
    }
  }

  clearRect(x, y, width, height) {
    const corners = [
      apply(this._transform, x, y),
      apply(this._transform, x + width, y),
      apply(this._transform, x + width, y + height),
      apply(this._transform, x, y + height),
    ];
    const previous = this.globalCompositeOperation;
    this.globalCompositeOperation = "source-over";
    const savedAlpha = this.globalAlpha;
    this.globalAlpha = 1;
    this._visitCovered(corners, (px, py) => {
      if (this._clip && !this._clip[py * this.canvas.width + px]) return;
      const offset = (py * this.canvas.width + px) * 4;
      this.canvas._pixels[offset] = 0;
      this.canvas._pixels[offset + 1] = 0;
      this.canvas._pixels[offset + 2] = 0;
      this.canvas._pixels[offset + 3] = 0;
    });
    this.globalCompositeOperation = previous;
    this.globalAlpha = savedAlpha;
  }

  drawImage(image, dx, dy, dw, dh) {
    const source = sourcePixels(image);
    if (!source) return;
    const destWidth = dw == null ? source.width : dw;
    const destHeight = dh == null ? source.height : dh;
    const mapped = [
      apply(this._transform, dx, dy),
      apply(this._transform, dx + destWidth, dy),
      apply(this._transform, dx + destWidth, dy + destHeight),
      apply(this._transform, dx, dy + destHeight),
    ];
    const inverse = invert(this._transform);
    if (!inverse) return;
    let pixels = source.data;
    const blur = parseBlurRadius(this.filter);
    if (blur > 0) pixels = boxBlur(pixels, source.width, source.height, blur);
    const box = boundsOf(mapped);
    const minX = Math.max(0, Math.floor(box.minX));
    const minY = Math.max(0, Math.floor(box.minY));
    const maxX = Math.min(this.canvas.width - 1, Math.ceil(box.maxX));
    const maxY = Math.min(this.canvas.height - 1, Math.ceil(box.maxY));
    const scaleX = source.width / destWidth;
    const scaleY = source.height / destHeight;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const user = apply(inverse, x + 0.5, y + 0.5);
        const u = (user.x - dx) * scaleX;
        const v = (user.y - dy) * scaleY;
        if (u < -0.5 || v < -0.5 || u >= source.width + 0.5 || v >= source.height + 0.5) continue;
        const sample = this.imageSmoothingEnabled
          ? sampleBilinear(pixels, source.width, source.height, u, v)
          : sampleBilinear(pixels, source.width, source.height, Math.floor(u) + 0.5, Math.floor(v) + 0.5);
        this._put(x, y, sample);
      }
    }
  }

  getImageData(x, y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const sx = x + column;
        const sy = y + row;
        const dest = (row * width + column) * 4;
        if (sx < 0 || sy < 0 || sx >= this.canvas.width || sy >= this.canvas.height) continue;
        const src = (sy * this.canvas.width + sx) * 4;
        data[dest] = this.canvas._pixels[src];
        data[dest + 1] = this.canvas._pixels[src + 1];
        data[dest + 2] = this.canvas._pixels[src + 2];
        data[dest + 3] = this.canvas._pixels[src + 3];
      }
    }
    return { data, width, height };
  }

  putImageData(imageData, x, y) {
    for (let row = 0; row < imageData.height; row += 1) {
      for (let column = 0; column < imageData.width; column += 1) {
        const dx = x + column;
        const dy = y + row;
        if (dx < 0 || dy < 0 || dx >= this.canvas.width || dy >= this.canvas.height) continue;
        const src = (row * imageData.width + column) * 4;
        const dest = (dy * this.canvas.width + dx) * 4;
        this.canvas._pixels[dest] = imageData.data[src];
        this.canvas._pixels[dest + 1] = imageData.data[src + 1];
        this.canvas._pixels[dest + 2] = imageData.data[src + 2];
        this.canvas._pixels[dest + 3] = imageData.data[src + 3];
      }
    }
  }
}

class SoftwareCanvas {
  constructor(width = 300, height = 150) {
    this._width = Math.max(1, Math.round(Number(width) || 300));
    this._height = Math.max(1, Math.round(Number(height) || 150));
    this._pixels = new Uint8ClampedArray(this._width * this._height * 4);
    this._context = new SoftwareContext(this);
  }

  get width() {
    return this._width;
  }

  set width(value) {
    this._width = Math.max(1, Math.round(Number(value) || 1));
    this._pixels = new Uint8ClampedArray(this._width * this._height * 4);
    this._context._clip = null;
  }

  get height() {
    return this._height;
  }

  set height(value) {
    this._height = Math.max(1, Math.round(Number(value) || 1));
    this._pixels = new Uint8ClampedArray(this._width * this._height * 4);
    this._context._clip = null;
  }

  get data() {
    return this._pixels;
  }

  getContext(type) {
    if (String(type) === "2d") return this._context;
    return null;
  }
}

class SoftwareImage {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.data = new Uint8ClampedArray(0);
    this.onload = null;
    this.onerror = null;
    this._src = "";
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = String(value || "");
    try {
      if (!/^data:image\/png;base64,/i.test(this._src)) throw new Error("unsupported image src");
      const decoded = decodePngFromDataUrl(this._src);
      this.width = decoded.width;
      this.height = decoded.height;
      this.data = decoded.data;
      queueMicrotask(() => {
        if (typeof this.onload === "function") this.onload();
      });
    } catch (error) {
      queueMicrotask(() => {
        if (typeof this.onerror === "function") this.onerror(error);
      });
    }
  }
}

function decodePngFromDataUrl(dataUrl) {
  const base64 = String(dataUrl).split(",")[1];
  const buffer = Buffer.from(base64, "base64");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const temp = path.join(os.tmpdir(), `xsxb-img-${process.pid}-${Date.now()}-${Math.random()}.png`);
  fs.writeFileSync(temp, buffer);
  try {
    return decodePngRgba(temp);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function createSoftwareDocument() {
  const document = {
    body: {
      getAttribute() {
        return "";
      },
    },
    createElement(name) {
      if (String(name).toLowerCase() === "canvas") return new SoftwareCanvas();
      return {
        addEventListener() {},
        classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {},
        getAttribute() {
          return "";
        },
        hidden: true,
      };
    },
    querySelector() {
      return null;
    },
  };
  return document;
}

function createSoftwareDom() {
  const document = createSoftwareDocument();
  const window = {
    document,
    Image: SoftwareImage,
    addEventListener() {},
    HTMLInputElement: function HTMLInputElement() {},
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
  };
  document.defaultView = window;
  return { window, document, Image: SoftwareImage, SoftwareCanvas };
}

module.exports = {
  SoftwareCanvas,
  SoftwareImage,
  createSoftwareDom,
};
