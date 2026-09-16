"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const { frameIndexes } = require("./common");
const { previewFrames } = require("./preview");
const { decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");
const {
  measureSpriteGeometry,
  flattenFrameBackground,
  resolvePreviewBackground,
} = require("../xsxb_mcp_lock");
const { renderContactSheet, canvasAnchor } = require("../xsxb_mcp_visual_qa");

/** Measures transparent holes and bright edge pixels without inferring semantic intent. */
function alphaEvidence(image) {
  const { width: w, height: h, data } = image,
    n = w * h,
    seen = new Uint8Array(n),
    queue = new Int32Array(n);
  let holes = 0,
    holePixels = 0,
    edgePixels = 0,
    whiteEdgePixels = 0,
    boundaryPixels = 0;
  for (let i = 0; i < n; i++) {
    const alpha = data[i * 4 + 3],
      x = i % w,
      y = Math.floor(i / w);
    if (alpha > 8) {
      if (x === 0 || x === w - 1 || y === 0 || y === h - 1) boundaryPixels++;
      let edge = false;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ])
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || data[(ny * w + nx) * 4 + 3] <= 8) edge = true;
      if (edge) {
        edgePixels++;
        const rgb = data.subarray(i * 4, i * 4 + 3);
        if (Math.min(...rgb) >= 220 && Math.max(...rgb) - Math.min(...rgb) < 30) whiteEdgePixels++;
      }
      continue;
    }
    if (seen[i]) continue;
    let head = 0,
      tail = 1,
      touches = false;
    queue[0] = i;
    seen[i] = 1;
    while (head < tail) {
      const p = queue[head++],
        px = p % w,
        py = Math.floor(p / w);
      if (px === 0 || px === w - 1 || py === 0 || py === h - 1) touches = true;
      for (const [nx, ny] of [
        [px - 1, py],
        [px + 1, py],
        [px, py - 1],
        [px, py + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const next = ny * w + nx;
        if (!seen[next] && data[next * 4 + 3] <= 8) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (!touches) {
      holes++;
      holePixels += tail;
    }
  }
  return {
    holes,
    holePixels,
    edgePixels,
    whiteEdgePixels,
    whiteEdgeRatio: whiteEdgePixels / Math.max(1, edgePixels),
    boundaryPixels,
  };
}
/** Returns the median of finite values. */
function median(values) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}
/** Flags explainable cross-frame anomalies and produces a numbered evidence sheet. */
function createQualityTool(context) {
  return function inspect(args) {
    const { project, profile, animation } = context.lookupAnimation(args),
      indexes = frameIndexes(args, animation.frames.length);
    const measured = indexes.map((index) => {
      const image = decodePngRgba(
          context.resolveAnimationFramePath(project, animation.frames[index].path, animation),
        ),
        g = measureSpriteGeometry(image.data, image.width, image.height),
        a = canvasAnchor(image.width, image.height, animation.anchorMode);
      return {
        index,
        image,
        metrics: { ...g, ...alphaEvidence(image), feetGroupY: g.feetY - a.y, centerGroupX: g.cx - a.x },
      };
    });
    const body = median(measured.map((f) => f.metrics.bodyH)),
      feet = median(measured.map((f) => f.metrics.feetGroupY)),
      center = median(measured.map((f) => f.metrics.centerGroupX));
    const frames = measured.map((f) => {
      const m = f.metrics,
        issues = [];
      if (m.bboxH === 0) issues.push({ kind: "empty", value: 0 });
      if (body > 0 && Math.abs(m.bodyH - body) / body > (args.size_tolerance ?? 0.2))
        issues.push({ kind: "size_jump", value: m.bodyH, reference: body });
      if (Math.abs(m.feetGroupY - feet) > (args.feet_tolerance ?? 3))
        issues.push({ kind: "feet_drift", value: m.feetGroupY, reference: feet });
      if (Math.abs(m.centerGroupX - center) > (args.center_tolerance ?? 5))
        issues.push({ kind: "center_drift", value: m.centerGroupX, reference: center });
      if (m.holePixels >= (args.min_hole_pixels ?? 4))
        issues.push({ kind: "alpha_holes", value: m.holePixels });
      if (m.whiteEdgePixels >= 4 && m.whiteEdgeRatio > (args.white_edge_ratio ?? 0.25))
        issues.push({ kind: "bright_edge", value: m.whiteEdgeRatio });
      if (m.boundaryPixels) issues.push({ kind: "touches_canvas_edge", value: m.boundaryPixels });
      return { frame: f.index, metrics: m, issues };
    });
    const flagged = frames.filter((f) => f.issues.length),
      previewRows = (flagged.length ? flagged : frames).slice(0, 24),
      images = previewRows.map((row) =>
        flattenFrameBackground(
          measured.find((f) => f.index === row.frame).image,
          resolvePreviewBackground("magenta"),
        ),
      );
    const sheet = renderContactSheet(previewFrames(images), {
        cell: 256,
        columns: Math.min(6, images.length),
        pad: 8,
        grid: false,
        normalize: "none",
        labels: true,
        frameIndexes: previewRows.map((row) => row.frame),
      }),
      output = path.join(context.currentArtifactDir(project), `quality_${Date.now()}.png`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, encodePngRgba(sheet.data, sheet.width, sheet.height));
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: animation.id || animation.name,
      frameCount: frames.length,
      flaggedCount: flagged.length,
      frames,
      preview: { path: output, frameIndexes: previewRows.map((f) => f.frame) },
      warnings: [
        "Heuristic suspects only: white fur, intentional holes, jumps and full-canvas art can trigger flags. Inspect evidence before editing.",
      ],
      __mcp: {
        verification: {
          status: "unknown",
          checks: flagged.flatMap((f) => f.issues.map((issue) => ({ frame: f.frame, ...issue }))),
          evidence: [output],
        },
      },
    };
  };
}
module.exports = { createQualityTool };
