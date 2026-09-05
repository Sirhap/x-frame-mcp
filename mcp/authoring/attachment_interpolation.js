"use strict";
const { loadDocuments, commitDocuments, clone, requireId } = require("./common");

/** Interpolates authored attachment transforms between explicit keyframes in group space. */
function createAttachmentInterpolation(context, revisions) {
  return function interpolate(args) {
    const { project, profile, animation } = context.animationFor(args),
      { paths, documents } = loadDocuments(context.projectStore, project);
    const id = requireId(args.id, "attachment id"),
      key = `${profile.id}/${animation.id || animation.name}`,
      mode = args.interpolation || "linear";
    const keys = [...(args.keyframes || [])].sort((a, b) => a.frame - b.frame);
    if (keys.length < 2 || new Set(keys.map((k) => k.frame)).size !== keys.length)
      throw new Error("Provide at least two unique keyframes.");
    for (const entry of keys)
      if (entry.frame < 0 || entry.frame >= animation.frames.length)
        throw new Error("Keyframe is outside the animation.");
    const bindings = documents.frameImageAttachments;
    if (!Array.isArray(bindings)) throw new Error("Unsupported attachment storage format.");
    const template = bindings.find(
      (b) => b.id === id && String(b.key || b.frameKey || "").startsWith(`${key}:`),
    );
    if (!template) throw new Error("Bind the attachment image with xsxb_add_attachment first.");
    const values = keys.map((k) => ({
      frame: k.frame,
      x: k.offset_x,
      y: k.offset_y,
      rotation: k.rotation ?? template.transform?.rotation ?? 0,
      scale: k.scale ?? template.transform?.scale?.x ?? 1,
      layer: k.layer ?? template.layer,
    }));
    const generated = [];
    for (let frame = values[0].frame; frame <= values.at(-1).frame; frame++) {
      const rightIndex = values.findIndex((k) => k.frame >= frame),
        right = values[rightIndex],
        left = values[Math.max(0, rightIndex - 1)];
      let t = right.frame === left.frame ? 0 : (frame - left.frame) / (right.frame - left.frame);
      if (mode === "hold" && frame !== right.frame) t = 0;
      else if (mode === "smooth") t = t * t * (3 - 2 * t);
      const mix = (a, b) => a + (b - a) * t;
      let delta = right.rotation - left.rotation;
      if (args.rotation_path !== "direct")
        delta = ((((delta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const exact = values.find((k) => k.frame === frame),
        next = clone(template),
        frameKey = `${key}:${frame}`;
      next.key = frameKey;
      next.frameKey = frameKey;
      next.frame = frame;
      next.metadata = { ...next.metadata, profileId: profile.id, animation: key, frame, displayFrame: frame };
      next.transform = {
        ...next.transform,
        offset: { x: mix(left.x, right.x), y: mix(left.y, right.y) },
        scale: { x: mix(left.scale, right.scale), y: mix(left.scale, right.scale) },
        rotation: exact ? exact.rotation : left.rotation + delta * t,
      };
      next.layer = exact ? exact.layer : left.layer;
      generated.push(next);
    }
    const result = {
      projectId: project.id,
      animationId: animation.id || animation.name,
      id,
      interpolation: mode,
      dryRun: args.dry_run !== false,
      updatedFrames: generated.length,
      bindings: generated,
      warnings: [
        "Interpolation does not track hands or infer occlusion. Inspect the exported preview; layer changes only at keyframes.",
      ],
    };
    if (result.dryRun) return result;
    const indexSet = new Set(generated.map((b) => b.key));
    if (args.replace === false && bindings.some((b) => b.id === id && indexSet.has(b.key)))
      throw new Error("Interpolation overlaps existing bindings; allow replace or choose another range.");
    result.revisionId = revisions.save(project, "before attachment interpolation", true).revisionId;
    documents.frameImageAttachments = [
      ...bindings.filter((b) => b.id !== id || !indexSet.has(b.key)),
      ...generated,
    ];
    commitDocuments(paths, { frameImageAttachments: documents.frameImageAttachments });
    result.sync = context.synchronize(project, args.sync === true);
    return result;
  };
}
module.exports = { createAttachmentInterpolation };
