"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { frameIndexes, loadDocuments, commitDocuments, translateAnnotations } = require("./common");
const { decodePngRgba, encodePngRgba } = require("../xsxb_mcp_cutout");
const { measureSpriteGeometry } = require("../xsxb_mcp_lock");
const { canvasAnchor, renderContactSheet } = require("../xsxb_mcp_visual_qa");

/** Builds shared canvases without interpolation; plans are previews by default. */
function createCanvasTool(context, revisions) {
  return function resizeCanvas(args) {
    const { project, profile, animation } = context.animationFor(args),
      indexes = frameIndexes(args, animation.frames.length);
    const selected = indexes.map((index) => {
      const file = context.resolveAnimationFramePath(project, animation.frames[index].path, animation);
      context.assertWritableAnimationFrame(project, animation, file, "Canvas edits require writable frames.");
      const image = decodePngRgba(file);
      return {
        index,
        file,
        image,
        geometry: measureSpriteGeometry(image.data, image.width, image.height),
        anchor: canvasAnchor(image.width, image.height, animation.anchorMode),
      };
    });
    const pad = args.padding ?? 0,
      mode = args.mode || "pad",
      preserve = args.preserve_origin !== false;
    let left, top, width, height;
    if (mode === "trim") {
      const visible = selected.filter((f) => f.geometry.bboxH > 0);
      if (!visible.length) throw new Error("Cannot trim an entirely transparent selection.");
      left = Math.min(...visible.map((f) => f.geometry.minX - f.anchor.x)) - pad;
      top = Math.min(...visible.map((f) => f.geometry.minY - f.anchor.y)) - pad;
      const right = Math.max(...visible.map((f) => f.geometry.maxX + 1 - f.anchor.x)) + pad,
        bottom = Math.max(...visible.map((f) => f.geometry.maxY + 1 - f.anchor.y)) + pad;
      if (preserve) {
        width =
          animation.anchorMode === "canvas_left_bottom"
            ? Math.ceil(right)
            : Math.ceil(Math.max(-left, right)) * 2;
        height = Math.ceil(-top);
        left = animation.anchorMode === "canvas_left_bottom" ? 0 : -width / 2;
        top = -height;
      } else {
        width = Math.ceil(right - left);
        height = Math.ceil(bottom - top);
      }
    } else {
      width = args.width;
      height = args.height;
      if (!Number.isInteger(width) || !Number.isInteger(height))
        throw new Error("pad mode requires width and height.");
    }
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 4096 ||
      height > 4096
    )
      throw new Error("Canvas dimensions must be 1–4096 pixels.");
    const outputs = [],
      plans = [];
    const { paths, documents } = loadDocuments(context.projectStore, project),
      stored = documents.manifest.profiles
        .find((p) => p.id === profile.id)
        .animations.find((a) => String(a.id || a.name) === String(animation.id || animation.name));
    for (const frame of selected) {
      const anchor = canvasAnchor(width, height, animation.anchorMode);
      const rawX = mode === "trim" ? -left - frame.anchor.x : anchor.x - frame.anchor.x,
        rawY = mode === "trim" ? -top - frame.anchor.y : anchor.y - frame.anchor.y;
      if (preserve && (!Number.isInteger(rawX) || !Number.isInteger(rawY)))
        throw new Error(
          "Exact origin preservation requires matching width parity; choose an even/odd width matching source canvases.",
        );
      const dx = Math.round(rawX),
        dy = Math.round(rawY),
        data = new Uint8ClampedArray(width * height * 4);
      let clipped = 0;
      for (let y = 0; y < frame.image.height; y++)
        for (let x = 0; x < frame.image.width; x++) {
          const from = (y * frame.image.width + x) * 4,
            nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            if (frame.image.data[from + 3] > 0) clipped++;
            continue;
          }
          data.set(frame.image.data.subarray(from, from + 4), (ny * width + nx) * 4);
        }
      if (clipped && args.allow_clip !== true)
        throw new Error(
          `Canvas would clip ${clipped} visible pixels in frame ${frame.index}; enlarge it or explicitly pass allow_clip=true.`,
        );
      const shiftX = frame.anchor.x + dx - anchor.x,
        shiftY = frame.anchor.y + dy - anchor.y;
      stored.frames[frame.index].width = width;
      stored.frames[frame.index].height = height;
      translateAnnotations(
        documents,
        `${profile.id}/${animation.id || animation.name}:${frame.index}`,
        shiftX,
        shiftY,
      );
      outputs.push({
        target: frame.file,
        bytes: encodePngRgba(data, width, height),
        image: { data, width, height },
      });
      plans.push({
        frame: frame.index,
        width,
        height,
        dx,
        dy,
        groupDelta: { x: shiftX, y: shiftY },
        clippedPixels: clipped,
      });
    }
    const previewPath = path.join(context.currentArtifactDir(project), `canvas_${Date.now()}.png`),
      sheet = renderContactSheet(
        outputs.map((o) => o.image),
        {
          cell: 192,
          columns: Math.min(8, outputs.length),
          pad: 8,
          grid: false,
          normalize: "cell",
          labels: true,
          frameIndexes: indexes,
        },
      );
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, encodePngRgba(sheet.data, sheet.width, sheet.height));
    const result = {
      projectId: project.id,
      animationId: animation.id || animation.name,
      dryRun: args.dry_run !== false,
      frames: plans,
      preview: { path: previewPath },
      preserveOrigin: preserve,
    };
    if (!result.dryRun) {
      result.revisionId = revisions.save(project, "before canvas", true).revisionId;
      commitDocuments(paths, documents, outputs);
      result.sync = context.synchronize(project, args.sync === true);
    }
    return result;
  };
}
module.exports = { createCanvasTool, translateAnnotations };
