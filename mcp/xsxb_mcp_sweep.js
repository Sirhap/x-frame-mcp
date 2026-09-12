"use strict";

const { stickPose } = require("./lib/attack_trails");

/** Returns a finite number clamped to an inclusive range. */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

/** Resolves one stick's playback arrival time from frame timing. */
function stickArrival(stick, durations) {
  const frame = Math.max(0, Math.round(Number(stick?.frame) || 0));
  let elapsed = 0;
  for (let index = 0; index < Math.min(frame, durations.length); index += 1) {
    elapsed += Math.max(0, Number(durations[index]) || 0);
  }
  return elapsed + Math.max(0, Number(durations[frame]) || 0) * clamp(stick?.framePhase, 0, 1);
}

/** Linearly interpolates two group-space points. */
function interpolatePoint(left, right, amount) {
  return {
    x: left.x + (right.x - left.x) * amount,
    y: left.y + (right.y - left.y) * amount,
  };
}

/** Returns the blade pose at an absolute animation time. */
function poseAt(sticks, arrivals, time) {
  if (time <= arrivals[0]) return stickPose(sticks[0]);
  const last = arrivals.length - 1;
  if (time >= arrivals[last]) return stickPose(sticks[last]);
  for (let index = 0; index < last; index += 1) {
    if (time > arrivals[index + 1]) continue;
    const span = Math.max(1e-6, arrivals[index + 1] - arrivals[index]);
    const amount = clamp((time - arrivals[index]) / span, 0, 1);
    const left = stickPose(sticks[index]);
    const right = stickPose(sticks[index + 1]);
    const top = interpolatePoint(left.top, right.top, amount);
    const bottom = interpolatePoint(left.bottom, right.bottom, amount);
    return { top, bottom, center: interpolatePoint(left.center, right.center, amount) };
  }
  return stickPose(sticks[last]);
}

/** Returns enabled normalized segments intended for the deterministic sweep renderer. */
function sweepSegments(trails, bindingKey) {
  return (trails?.bindings?.[bindingKey] || []).filter(
    (segment) =>
      segment &&
      segment.enabled !== false &&
      segment.renderMode === "sweep" &&
      Array.isArray(segment.sticks) &&
      segment.sticks.length >= 2,
  );
}

/** Validates the authored input required for a temporal blade sweep. */
function assertSweepSticks(sticks) {
  if (!Array.isArray(sticks) || sticks.length < 2) {
    const error = new Error("render_mode=sweep requires at least two explicit blade-edge sticks.");
    error.code = "SWEEP_STICKS_REQUIRED";
    throw error;
  }
  const frames = new Set();
  const layers = new Set();
  for (const [index, stick] of sticks.entries()) {
    if (!stick || typeof stick !== "object" || !stick.top || !stick.bottom) {
      const error = new Error(`sticks[${index}] requires both top and bottom for render_mode=sweep.`);
      error.code = "SWEEP_STICK_INVALID";
      throw error;
    }
    if (!Number.isInteger(Number(stick.frame))) {
      const error = new Error(`sticks[${index}].frame is required for render_mode=sweep.`);
      error.code = "SWEEP_STICK_INVALID";
      throw error;
    }
    frames.add(Number(stick.frame));
    layers.add(String(stick.layer || "behind"));
  }
  if (frames.size < 2) {
    const error = new Error("render_mode=sweep requires sticks on at least two different frames.");
    error.code = "SWEEP_TIMELINE_REQUIRED";
    throw error;
  }
  if (layers.size > 1) {
    const error = new Error("render_mode=sweep requires all sticks to use the same layer.");
    error.code = "SWEEP_LAYER_MIXED";
    throw error;
  }
}

/** Samples monotonically increasing moments over a bounded slice of the blade path. */
function sampleTimes(arrivals, start, end) {
  const points = [start, end, ...arrivals.filter((time) => time > start && time < end)].sort(
    (left, right) => left - right,
  );
  const samples = [];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    const steps = Math.max(1, Math.ceil((right - left) * 60));
    for (let step = 0; step < steps; step += 1) samples.push(left + ((right - left) * step) / steps);
  }
  samples.push(end);
  return [...new Set(samples)];
}

/** Draws a filled, fading blade trajectory on a Canvas-compatible context. */
function drawSweepLayer(context, segments, currentTime, durations, origin, layer) {
  let drawn = 0;
  for (const segment of segments) {
    const sticks = segment.sticks;
    const segmentLayer = String(sticks[0]?.layer || segment.layer || "behind");
    if (segmentLayer !== layer) continue;
    const arrivals = sticks.map((stick) => stickArrival(stick, durations));
    const first = arrivals[0];
    const last = arrivals.at(-1);
    const lifetime = clamp(Number(segment.trailDurationMs) / 1000, 0.001, 5, 0.15);
    if (currentTime <= first || currentTime > last + lifetime) continue;
    const start = Math.max(first, currentTime - lifetime);
    const end = Math.min(last, currentTime);
    if (end <= start) continue;
    const times = sampleTimes(arrivals, start, end);
    for (let index = 1; index < times.length; index += 1) {
      const older = times[index - 1];
      const newer = times[index];
      const age = Math.max(0, currentTime - (older + newer) / 2);
      const alpha = clamp(segment.opacity, 0, 1) * Math.max(0, 1 - age / lifetime) ** 1.5;
      if (alpha <= 0) continue;
      const left = poseAt(sticks, arrivals, older);
      const right = poseAt(sticks, arrivals, newer);
      context.save();
      context.globalAlpha = alpha;
      context.fillStyle = segment.color || "#d9364a";
      context.beginPath();
      context.moveTo(origin.x + left.top.x, origin.y + left.top.y);
      context.lineTo(origin.x + left.bottom.x, origin.y + left.bottom.y);
      context.lineTo(origin.x + right.bottom.x, origin.y + right.bottom.y);
      context.lineTo(origin.x + right.top.x, origin.y + right.top.y);
      context.closePath();
      context.fill();
      context.restore();
      drawn += 1;
    }
  }
  return drawn;
}

module.exports = { assertSweepSticks, drawSweepLayer, sweepSegments };
