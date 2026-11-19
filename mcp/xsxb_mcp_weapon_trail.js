"use strict";
const path = require("node:path");
const { decodePngRgba, encodePngRgba } = require("./xsxb_mcp_cutout");
const { measureLongAxis } = require("./xsxb_mcp_visual_qa");
const { normalizeAttachmentTransform } = require("./lib/animation_tuner/public/app_attachment_utils");

/** Places the brush rails on the bound blade in actor-local coordinates. */
function bladePose(binding, axis, motion) {
  const transform = normalizeAttachmentTransform(binding.transform);
  const rad = (transform.rotation * Math.PI) / 180;
  function pointAt(fraction) {
    const x = (axis.pommel.x + fraction * (axis.tip.x - axis.pommel.x) - axis.center.x) * transform.scaleX;
    const y = (axis.pommel.y + fraction * (axis.tip.y - axis.pommel.y) - axis.center.y) * transform.scaleY;
    return {
      x: transform.offset.x + x * Math.cos(rad) - y * Math.sin(rad),
      y: transform.offset.y + x * Math.sin(rad) + y * Math.cos(rad),
    };
  }
  return motion ? { top: pointAt(1), bottom: pointAt(0.48) } : { top: pointAt(0.95), bottom: pointAt(0.62) };
}

/** Unit tangent perpendicular to the authored blade, in the mesh renderer's winding. */
function tangent(pose) {
  const dx = pose.bottom.x - pose.top.x,
    dy = pose.bottom.y - pose.top.y;
  const length = Math.hypot(dx, dy);
  return { x: -dy / length, y: dx / length };
}

/**
 * Fits the two Hermite handles to the weapon's available poses without adding
 * intermediate control sticks. The circular-arc estimate supplies a prior
 * when the attachment is only bound on the requested endpoint frames.
 */
function fitHandles(samples) {
  const first = samples[0],
    last = samples.at(-1),
    a = tangent(first),
    b = tangent(last);
  const dx = last.top.x - first.top.x,
    dy = last.top.y - first.top.y;
  const span = Math.hypot(dx, dy);
  if (span < 1 && Math.hypot(last.bottom.x - first.bottom.x, last.bottom.y - first.bottom.y) < 1)
    throw new Error(
      "The weapon endpoints coincide. Choose a shorter swing with distinct start and end poses.",
    );
  const angle = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)));
  // A changing grip or scale can skew the fit at one endpoint. Use the
  // observed swing direction at both ends to keep the brush from folding back.
  let travel = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1],
      current = samples[i];
    const previousNormal = tangent(previous),
      currentNormal = tangent(current);
    travel +=
      (current.top.x - previous.top.x) * (previousNormal.x + currentNormal.x) +
      (current.top.y - previous.top.y) * (previousNormal.y + currentNormal.y);
  }
  const sign = travel < 0 ? -1 : 1;
  const prior = (sign * 2) / (1 + Math.cos(angle / 2));
  // Solve a regularized two-variable least-squares fit of the blade tip.
  const weight = Math.max(1, span * span * 0.001);
  let startEnergy = weight,
    endEnergy = weight,
    coupling = 0,
    startProjection = weight * prior,
    endProjection = weight * prior;
  for (const sample of samples.slice(1, -1)) {
    const t = (sample.time - first.time) / (last.time - first.time);
    const base = t * t * (3 - 2 * t);
    const rx = sample.top.x - first.top.x - base * dx,
      ry = sample.top.y - first.top.y - base * dy;
    const startBasis = t * (1 - t) ** 2 * span,
      endBasis = -t * t * (1 - t) * span;
    startEnergy += startBasis * startBasis;
    endEnergy += endBasis * endBasis;
    coupling += startBasis * endBasis * (a.x * b.x + a.y * b.y);
    startProjection += startBasis * (a.x * rx + a.y * ry);
    endProjection += endBasis * (b.x * rx + b.y * ry);
  }
  const determinant = startEnergy * endEnergy - coupling * coupling;
  return [
    (startProjection * endEnergy - endProjection * coupling) / determinant,
    (endProjection * startEnergy - startProjection * coupling) / determinant,
  ].map((handle) => sign * Math.min(4, Math.max(0.05, sign * handle)));
}

/**
 * Derives brush sticks from a rigid PNG weapon, using every displayed pose for motion trails.
 * Times use the same per-frame playback durations as the animation exporter.
 * @param {object} job Host root, binding key, attachment id, frame range and bindings.
 * @returns {object[]} Ordered mesh controls in actor-local coordinates.
 */
function weaponTrailSticks({
  root,
  bindingKey,
  byFrame,
  axes,
  attachmentId,
  start,
  end,
  durations,
  motion = false,
}) {
  if (start >= end) throw new Error("start_frame must precede end_frame for a weapon brush trail.");
  const samples = [];
  let elapsed = 0;
  for (let frame = start; frame <= end; frame++) {
    const time = elapsed + durations[frame] * 0.99;
    elapsed += durations[frame];
    const endpoint = frame === start || frame === end;
    if (!durations[frame]) {
      if (endpoint) throw new Error(`Frame ${frame} is disabled. Choose a visible endpoint.`);
      continue;
    }
    const matches = (byFrame.get(frame) || []).filter((entry) => entry.id === attachmentId);
    if (matches.length !== 1) {
      if (motion || endpoint || matches.length)
        throw new Error(
          `Expected one binding for attachment "${attachmentId}" on frame ${frame} of ${bindingKey}. Check xsxb_get_animation with include:["attachments"], or supply sticks for a painted weapon.`,
        );
      continue;
    }
    const binding = matches[0];
    const file = path.resolve(root, binding.path);
    if (!axes.has(file)) {
      const image = decodePngRgba(file);
      axes.set(file, measureLongAxis(image.data, image.width, image.height));
    }
    samples.push({ frame, time, ...bladePose(binding, axes.get(file), motion) });
  }
  if (motion) return motionSticks(samples);
  const handles = fitHandles(samples);
  return [samples[0], samples.at(-1)].map(({ frame, top, bottom }, i) => ({
    frame,
    top,
    bottom,
    phaseMode: "manual",
    framePhase: 0.99,
    layer: "behind",
    directionOffset: handles[i] < 0 ? 180 : 0,
    tangentStrength: Math.abs(handles[i]),
  }));
}
/** Tangents bisect the arriving and departing tip paths, blending translation of the hand with rotation. */
function motionSticks(samples) {
  function unit(a, b) {
    const x = b.x - a.x,
      y = b.y - a.y,
      length = Math.hypot(x, y);
    return length > 0.001 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
  }
  return samples.map((pose, i) => {
    const prior = samples[i - 1],
      next = samples[i + 1];
    const incoming = prior && unit(prior.top, pose.top),
      outgoing = next && unit(pose.top, next.top);
    const a = incoming ?? outgoing,
      b = outgoing ?? incoming;
    const normal = tangent(pose);
    let dx = (a.x + b.x) * 0.5,
      dy = (a.y + b.y) * 0.5;
    // At either extreme the blade normal estimates the curvature missing from a one-sided chord.
    if (!prior || !next) {
      const dot = normal.x * dx + normal.y * dy;
      dx = dx * 0.35 + normal.x * dot * 0.65;
      dy = dy * 0.35 + normal.y * dot * 0.65;
    }
    const offset = ((Math.atan2(dy, dx) - Math.atan2(normal.y, normal.x)) * 180) / Math.PI;
    return {
      frame: pose.frame,
      top: pose.top,
      bottom: pose.bottom,
      framePhase: 0,
      phaseMode: "manual",
      layer: "behind",
      directionOffset: ((offset + 540) % 360) - 180,
      tangentStrength: Math.hypot(dx, dy),
    };
  });
}

/** Blade-space brush. The leading cross-section meets the blade; earlier history tapers to a single glint. */
function motionBrush(color) {
  if (!/^#[a-f0-9]{6}$/i.test(color)) throw new Error("Weapon motion color must be #RRGGBB.");
  const base = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const width = 128,
    height = 48,
    rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width,
      band = 0.92 * Math.pow(1 - u, 0.85);
    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const outer = 0.005 + 0.12 * u * u,
        across = (v - outer) / band;
      if (across < 0 || across > 1) continue;
      const light = across < 0.1 ? 0.93 : across < 0.28 ? 0.7 : across < 0.63 ? 0.34 : 0.05;
      const i = 4 * (y * width + x);
      for (let k = 0; k < 3; k++) rgba[i + k] = base[k] + (255 - base[k]) * light;
      rgba[i + 3] = across < 0.63 ? 255 : 194;
    }
  }
  return encodePngRgba(rgba, width, height);
}
/** Measure the last uninterrupted turn up to impact using actual displayed-frame durations.
 * Direction is measured around the blade, independent of character translation. Values are
 * authoring evidence, never a pass/fail aesthetic score. A straight thrust keeps short history.
 */
function reviewSwing(sticks, durations) {
  let elapsed = 0,
    runStart = 0,
    runEnd = 0,
    turn = 0,
    direction = 0;
  const reversals = [];
  const angle = ({ top, bottom }) => Math.atan2(top.y - bottom.y, top.x - bottom.x);
  let previous = sticks[0],
    lastAngle = angle(previous);
  for (const stick of sticks.slice(1)) {
    const nextAngle = angle(stick),
      delta = nextAngle - lastAngle;
    const degrees = (Math.atan2(Math.sin(delta), Math.cos(delta)) * 180) / Math.PI;
    const intervalStart = elapsed;
    for (let frame = previous.frame; frame < stick.frame; frame++) elapsed += durations[frame] * 1000;
    // Accumulate small angular steps before treating a change of sign as a reversal.
    if (Math.abs(degrees) >= 1) {
      const sign = Math.sign(degrees);
      if (!direction || sign !== direction) {
        runStart = intervalStart;
        turn = 0;
        if (direction) reversals.push(previous.frame);
      }
      runEnd = elapsed;
      direction = sign;
      turn += degrees;
      lastAngle = nextAngle;
    }
    previous = stick;
  }
  const swingMs = Math.round(direction ? runEnd - runStart : elapsed);
  const suggestedHistoryMs = Math.max(1, Math.min(5000, direction ? swingMs : Math.min(150, swingMs)));
  return { sweepDegrees: Math.round(Math.abs(turn)), swingMs, suggestedHistoryMs, reversalFrames: reversals };
}
module.exports = { weaponTrailSticks, motionBrush, reviewSwing };
