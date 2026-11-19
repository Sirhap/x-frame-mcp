"use strict";

const { decodePngRgba, encodePngRgba, subjectAnchor } = require("./xsxb_mcp_cutout");
const { BUNDLED_TRAIL_TEXTURE } = require("./lib/attack_trails");

/**
 * Places the two pointed ends of a stage-sized slash relative to the visible
 * character. Opposite blade normals bend both Hermite tangents towards the
 * facing side. The brush narrows to a point at each end in texture space.
 */
function planCrescent({ firstPath, lastPath, start, end, facing, direction, scale, fit }) {
  const poses = [firstPath, lastPath].map((file) => {
    const image = decodePngRgba(file);
    const body = subjectAnchor(image.data, image.width, image.height);
    if (!body) throw new Error("Crescent needs a visible character on both endpoint frames.");
    return {
      x: body.centerX - image.width / 2,
      feet: body.feetY - image.height,
      height: body.height,
      width: image.width,
      canvasHeight: image.height,
    };
  });
  const strike = poses[1];
  const nominalHeight = Math.max(...poses.map((p) => p.height)) * 1.13;
  const side = facing === "left" ? -1 : 1;
  const halfBand = 0.086,
    slope = 0.17,
    strength = 3.95;
  // Each Hermite rail has symmetric horizontal tangents. Its furthest reach is
  // at t=1/2 (h10 - h11 = 1/4); vertical extrema are the two endpoint sticks.
  const rear = 0.1 + halfBand * slope;
  const reach = -0.1 + halfBand * slope + (strength * (1 + 2 * halfBand)) / (4 * Math.hypot(1, slope));
  const left = side === 1 ? rear : reach,
    right = side === 1 ? reach : rear;
  const rise = 1.09 + halfBand;
  const canvasX = strike.width / 2 + strike.x,
    canvasY = strike.canvasHeight + strike.feet;
  // Leave room for filtered edge pixels and the software compositor's triangle overlap.
  const inset = 2;
  const maxHeight = Math.max(
    0,
    Math.min((canvasX - inset) / left, (strike.width - canvasX - inset) / right, (canvasY - inset) / rise),
  );
  const requestedHeight = nominalHeight * scale;
  const height = fit === "shrink" ? Math.min(requestedHeight, maxHeight) : requestedHeight;
  if (fit === "shrink" && height * 2 * halfBand < 1)
    throw new Error(
      "Too little space on the strike frame to fit a visible crescent. Add canvas padding or choose another strike frame.",
    );
  const overflowPx = {
    left: Math.max(0, Math.ceil(left * height - canvasX - 1e-8)),
    right: Math.max(0, Math.ceil(right * height + canvasX - strike.width - 1e-8)),
    top: Math.max(0, Math.ceil(rise * height - canvasY - 1e-8)),
  };
  const framing = {
    frame: end,
    requestedScale: scale,
    appliedScale: height / nominalHeight,
    maxScale: maxHeight / nominalHeight,
    overflowPx,
  };
  const x = strike.x - side * height * 0.1;
  const lower = strike.feet - height * 0.09;
  const upper = lower - height;
  const halfWidth = height * halfBand;
  const sticks = [start, end].map((frame, i) => {
    const atUpper = direction === "up" ? i === 1 : i === 0;
    const y = atUpper ? upper : lower;
    const outward = atUpper ? -1 : 1;
    // Tilting the endpoint tangents makes the tips meet the arc at a shallow angle.
    const offset = { x: side * halfWidth * slope, y: outward * halfWidth };
    return {
      frame,
      top: { x: x + offset.x, y: y + offset.y },
      bottom: { x: x - offset.x, y: y - offset.y },
      directionOffset: (direction === "up") === (facing === "left") ? 180 : 0,
      tangentStrength: strength,
      layer: "front",
      phaseMode: "manual",
      framePhase: 0.99,
    };
  });
  return { sticks, framing };
}

/** Makes an RGBA brush with tapered ends, a warm near-white core and colored
 * bristles. It is stored as an ordinary original-color texture so the MCP,
 * Tuner and Godot use the same existing textured mesh renderer. */
function crescentBrush(color) {
  if (!/^#[a-f0-9]{6}$/i.test(color)) throw new Error("Crescent color must be #RRGGBB.");
  const edge = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const grain = decodePngRgba(BUNDLED_TRAIL_TEXTURE);
  const width = 512,
    height = 128;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width;
    const envelope = Math.sin(Math.PI * u) ** 0.85;
    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const luma =
        grain.data[4 * (Math.floor(v * grain.height) * grain.width + Math.floor(u * grain.width))] / 255;
      const warp = 0.025 * Math.sin(u * 11 + v * 24) + 0.014 * Math.sin(u * 18 + v * 48);
      const cross = Math.abs(2 * v - 1 + warp) / envelope;
      if (cross >= 1.05) continue;
      const bristle = (1 + Math.sin(86 * v + 2.5 * Math.sin(u * 9 + v * 11))) * 0.5;
      // Leave negative space between the solid core and the outer brush hairs.
      const boundary = 0.73 + 0.05 * bristle + 0.05 * luma;
      const body = Math.max(0, Math.min(1, (boundary - cross) * 20));
      const outerHair = 0.91 + 0.035 * Math.sin(13 * u + 7 * v);
      const innerHair = 0.8 + 0.03 * Math.sin(18 * u - 8 * v);
      const hair = Math.max(
        0,
        1 - Math.min(Math.abs(cross - outerHair) / 0.045, Math.abs(cross - innerHair) / 0.036),
      );
      const alpha = Math.max(body, hair * (0.58 + 0.42 * luma));
      const core = Math.min(1, Math.max(0, (0.73 - cross) * 4.9));
      const streak = Math.sin(41 * v + 1.3 * Math.sin(9 * u)) ** 12;
      const light = Math.min(1, (0.91 - 0.1 * streak) * core + 0.06 * luma + 0.025 * bristle);
      const index = 4 * (y * width + x);
      for (let ch = 0; ch < 3; ch++) rgba[index + ch] = edge[ch] + ([255, 222, 216][ch] - edge[ch]) * light;
      rgba[index + 3] = 255 * alpha;
    }
  }
  return encodePngRgba(rgba, width, height);
}
module.exports = { planCrescent, crescentBrush };
