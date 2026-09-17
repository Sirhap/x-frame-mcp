"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { clone, requireId, loadDocuments, commitDocuments } = require("./common");
const { remapBindings, remapAttackTrails } = require("../lib/frame_organizer");

/** Rewrites only animation ownership identifiers, leaving arbitrary display text alone. */
function rewriteOwner(value, oldProfile, oldId, newProfile, newId) {
  const oldKey = `${oldProfile}/${oldId}`,
    newKey = `${newProfile}/${newId}`;
  if (Array.isArray(value)) return value.map((v) => rewriteOwner(v, oldProfile, oldId, newProfile, newId));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => {
      if (["key", "frameKey", "animation", "groupKey"].includes(key) && typeof v === "string")
        v = v === oldKey ? newKey : v.startsWith(`${oldKey}:`) ? `${newKey}${v.slice(oldKey.length)}` : v;
      if (key === "animation" && v === oldId) v = newKey;
      if (key === "profileId" && v === oldProfile) v = newProfile;
      if (key === "animationId" && v === oldId) v = newId;
      return [key, rewriteOwner(v, oldProfile, oldId, newProfile, newId)];
    }),
  );
}
/** Creates frame-preserving animation copy/split/merge/rename operations. */
function createAnimationManager(context, revisions) {
  /** Plans all destinations before committing any manifest or PNG. */
  function manage(args) {
    const selection = context.animationFor(args),
      { project, profile, animation } = selection;
    const { paths, documents } = loadDocuments(context.projectStore, project),
      original = clone(documents);
    const targetProfile = documents.manifest.profiles.find((p) => p.id === profile.id);
    const sourceId = String(animation.id || animation.name),
      action = args.action;
    const sourceAnimations =
      action === "merge"
        ? (args.source_animation_ids || []).map((id) => {
            const found = profile.animations.find((a) => String(a.id || a.name) === id);
            if (!found) throw new Error(`Animation not found: ${id}`);
            return found;
          })
        : [animation];
    if (action === "merge" && sourceAnimations.length < 2)
      throw new Error("Merge requires at least two source animations.");
    if (
      sourceAnimations.some(
        (a) => a.anchorMode !== animation.anchorMode || Boolean(a.flipH) !== Boolean(animation.flipH),
      )
    )
      throw new Error("Merge requires matching anchor modes and flip settings.");
    const outputPlans =
      action === "split"
        ? (args.segments || []).map((segment) => ({
            id: requireId(segment.animation_id, "segment animation_id"),
            sources: [{ animation, start: segment.start_frame, end: segment.end_frame }],
          }))
        : [
            {
              id: requireId(args.target_animation_id, "target_animation_id"),
              sources: sourceAnimations.map((a) => ({ animation: a, start: 0, end: a.frames.length - 1 })),
            },
          ];
    if (!outputPlans.length) throw new Error("Provide split segments.");
    if (new Set(outputPlans.map((p) => p.id)).size !== outputPlans.length)
      throw new Error("Destination animation ids must be unique.");
    for (const plan of outputPlans) {
      if (targetProfile.animations.some((a) => String(a.id || a.name) === plan.id))
        throw new Error(`Destination already exists: ${plan.id}`);
      for (const source of plan.sources)
        if (
          !Number.isInteger(source.start) ||
          !Number.isInteger(source.end) ||
          source.start < 0 ||
          source.end < source.start ||
          source.end >= source.animation.frames.length
        )
          throw new Error("Segment range is outside its source animation.");
    }
    if (
      outputPlans.length > 100 ||
      outputPlans.some(
        (plan) => plan.sources.reduce((sum, source) => sum + source.end - source.start + 1, 0) > 5000,
      )
    )
      throw new Error("Authoring limit: at most 100 destinations and 5000 frames per animation.");
    const workspace = context.projectStore.projectWorkspaceDir(project),
      files = [],
      outputs = [];
    const indexedFields = ["frame_box_overrides", "frame_visual_overrides", "frame_playback_overrides"];
    for (const plan of outputPlans) {
      const fps = args.fps || plan.sources[0].animation.fps;
      const output = { ...clone(plan.sources[0].animation), id: plan.id, name: plan.id, fps, frames: [] };
      delete output.inPlace;
      const targetDir = path.join(workspace, "assets", profile.id, plan.id);
      if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length)
        throw new Error(`Destination folder exists: ${targetDir}`);
      output.source = path.relative(context.root, targetDir).split(path.sep).join("/");
      for (const source of plan.sources) {
        const srcId = String(source.animation.id || source.animation.name),
          oldKey = `${profile.id}/${srcId}`,
          newKey = `${profile.id}/${plan.id}`,
          offset = output.frames.length;
        const groupPrefix = `profiles.${profile.id}.groups.${srcId}.`,
          newPrefix = `profiles.${profile.id}.groups.${plan.id}.`;
        const groupValues = Object.fromEntries(
          Object.entries(original.tuning.values || {})
            .filter(([key]) => key.startsWith(groupPrefix))
            .map(([key, value]) => [key.slice(groupPrefix.length), value]),
        );
        if (offset) {
          const first = plan.sources[0].animation,
            firstPrefix = `profiles.${profile.id}.groups.${first.id || first.name}.`;
          const firstValues = Object.fromEntries(
            Object.entries(original.tuning.values || {})
              .filter(([key]) => key.startsWith(firstPrefix))
              .map(([key, value]) => [key.slice(firstPrefix.length), value]),
          );
          if (JSON.stringify(groupValues) !== JSON.stringify(firstValues))
            throw new Error("Merge requires matching group visual settings; bake or equalize them first.");
        }
        documents.tuning.values ||= {};
        for (const [key, value] of Object.entries(groupValues))
          documents.tuning.values[newPrefix + key] = clone(value);
        const items = Array.from({ length: source.end - source.start + 1 }, (_, i) => ({
          sourceIndex: i + source.start,
        }));
        for (const [localIndex, item] of items.entries()) {
          const index = offset + localIndex,
            srcFrame = source.animation.frames[item.sourceIndex],
            file = context.resolveAnimationFramePath(project, srcFrame.path, source.animation);
          if (!file) throw new Error("Invalid source frame path.");
          const name = `frame_${String(index + 1).padStart(4, "0")}.png`,
            target = path.join(targetDir, name);
          files.push({ target, bytes: fs.readFileSync(file) });
          output.frames.push({
            ...clone(srcFrame),
            id: `frame_${String(index + 1).padStart(4, "0")}`,
            name,
            path: path.relative(context.root, target).split(path.sep).join("/"),
            duration: (Number(srcFrame.duration || 1) * fps) / Number(source.animation.fps || 12),
          });
          for (const field of indexedFields) {
            documents.tuning[field] ||= {};
            const value = original.tuning[field]?.[`${oldKey}:${item.sourceIndex}`];
            if (value !== undefined) {
              const next = clone(value);
              if (field === "frame_playback_overrides" && next.duration !== undefined)
                next.duration = (Number(next.duration) * fps) / Number(source.animation.fps || 12);
              documents.tuning[field][`${newKey}:${index}`] = next;
            }
          }
        }
        for (const field of ["frameAudio", "frameImageAttachments"]) {
          const remapped = remapBindings(original[field], oldKey, items).filter(
            (binding) =>
              String(binding.key || binding.frameKey || "").startsWith(`${oldKey}:`) ||
              binding.metadata?.animation === oldKey,
          );
          const shifted = remapped.map((binding) => {
            const next = rewriteOwner(binding, profile.id, srcId, profile.id, plan.id);
            for (const key of ["key", "frameKey"])
              if (next[key]) next[key] = next[key].replace(/:(\d+)$/, (_, i) => `:${Number(i) + offset}`);
            if (next.frame !== undefined) next.frame += offset;
            if (next.metadata) {
              next.metadata.frame += offset;
              if (next.metadata.displayFrame !== undefined) next.metadata.displayFrame += offset;
            }
            return next;
          });
          if (!Array.isArray(documents[field]))
            documents[field] = Object.entries(documents[field] || {}).map(([key, value]) => ({
              key,
              ...value,
            }));
          documents[field].push(...shifted);
        }
        const trails = remapAttackTrails(original.attackTrails, oldKey, items).bindings?.[oldKey] || [];
        documents.attackTrails.bindings ||= {};
        documents.attackTrails.bindings[newKey] ||= [];
        for (const segment of trails) {
          if (!segment.sticks.length) continue;
          const next = clone(segment);
          next.id = action === "merge" ? `${srcId}_${next.id || "trail"}_${offset}` : next.id;
          for (const stick of next.sticks) stick.frame += offset;
          next.startFrame = Math.min(...next.sticks.map((s) => s.frame));
          next.endFrame = Math.max(...next.sticks.map((s) => s.frame));
          documents.attackTrails.bindings[newKey].push(next);
        }
        for (const asset of original.attachmentAssets || [])
          if (asset.groupKey === oldKey)
            documents.attachmentAssets.push({ ...clone(asset), groupKey: newKey });
      }
      targetProfile.animations.push(output);
      outputs.push({ animationId: plan.id, frameCount: output.frames.length, fps });
    }
    if (action === "rename") {
      targetProfile.animations = targetProfile.animations.filter((a) => String(a.id || a.name) !== sourceId);
      const prefix = `${profile.id}/${sourceId}:`;
      for (const field of indexedFields)
        for (const key of Object.keys(documents.tuning[field] || {}))
          if (key.startsWith(prefix)) delete documents.tuning[field][key];
      for (const key of Object.keys(documents.tuning.values || {}))
        if (key.startsWith(`profiles.${profile.id}.groups.${sourceId}.`)) delete documents.tuning.values[key];
      for (const field of ["frameAudio", "frameImageAttachments"])
        documents[field] = (Array.isArray(documents[field]) ? documents[field] : []).filter(
          (b) =>
            !String(b.key || b.frameKey || "").startsWith(prefix) &&
            b.metadata?.animation !== `${profile.id}/${sourceId}`,
        );
      delete documents.attackTrails.bindings?.[`${profile.id}/${sourceId}`];
      documents.attachmentAssets = (documents.attachmentAssets || []).filter(
        (a) => a.groupKey !== `${profile.id}/${sourceId}`,
      );
      if (
        documents.tuning.reference_frame?.profile_id === profile.id &&
        documents.tuning.reference_frame?.animation_id === sourceId
      )
        documents.tuning.reference_frame.animation_id = outputPlans[0].id;
    }
    const result = {
      projectId: project.id,
      action,
      outputs,
      dryRun: args.dry_run !== false,
      sourcesPreserved: action !== "rename",
    };
    if (result.dryRun) return result;
    result.revisionId = revisions.save(project, `before ${action}`, true).revisionId;
    const referenced = new Set(
      documents.manifest.profiles
        .flatMap((p) => p.animations || [])
        .flatMap((a) => a.frames || [])
        .map((frame) => path.resolve(context.root, frame.path)),
    );
    const removed =
      action === "rename"
        ? animation.frames
            .map((frame) => context.resolveAnimationFramePath(project, frame.path, animation))
            .filter((file) => file && file.startsWith(`${workspace}${path.sep}`) && !referenced.has(file))
        : [];
    commitDocuments(paths, documents, files, removed);
    if (action === "rename") {
      const resolvedWorkspace = path.resolve(workspace);
      const oldDir = path.resolve(resolvedWorkspace, "assets", profile.id, sourceId);
      if (oldDir.startsWith(`${resolvedWorkspace}${path.sep}`) && fs.existsSync(oldDir)) {
        const remaining = fs
          .readdirSync(oldDir, { recursive: true, withFileTypes: true })
          .some((entry) => entry.isFile());
        if (!remaining) fs.rmSync(oldDir, { recursive: true, force: true });
      }
    }
    if (action === "rename" || action === "copy" || action === "merge") {
      context.selectAnimation(project.id, profile.id, outputPlans[0].id);
    }
    return { ...result, sync: context.synchronize(project, args.sync === true) };
  }
  return manage;
}
module.exports = { createAnimationManager };
