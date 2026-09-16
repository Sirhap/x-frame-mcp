"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  EMPTY_ATTACK_TRAILS,
  attackTrailTextureDirectory,
  normalizeAttackTrails,
} = require("./attack_trails");
const { EMPTY_MANIFEST, EMPTY_TUNING } = require("./project_store");

/**
 * Deep-clones JSON-compatible data.
 * @param {unknown} value JSON-compatible value.
 * @returns {any} Independent copy.
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolves a child path only when it remains inside its base directory.
 * @param {string} base Allowed base.
 * @param {string} requested Requested child.
 * @returns {string} Safe absolute path or an empty string.
 */
function safeResolve(base, requested) {
  const resolvedBase = path.resolve(base);
  const fullPath = path.resolve(resolvedBase, String(requested || ""));
  return fullPath === resolvedBase || fullPath.startsWith(`${resolvedBase}${path.sep}`) ? fullPath : "";
}

/**
 * Unlinks one workspace copy when no remaining binding still points at it,
 * then removes empty ancestor directories down to the workspace root.
 * @param {string} requested Stored relative or absolute path.
 * @param {string} allowedRoot Directory the file must remain inside.
 * @param {Set<string>} retained Resolved paths still referenced.
 * @param {string} root MCP host root.
 * @param {string} workspaceDir Project workspace directory (empty-parent stop).
 * @returns {void}
 */
function unlinkUnreferencedWorkspaceCopy(requested, allowedRoot, retained, root, workspaceDir) {
  const resolved = safeResolve(root, requested);
  if (!resolved || !resolved.startsWith(`${allowedRoot}${path.sep}`) || retained.has(resolved)) {
    return;
  }
  fs.rmSync(resolved, { force: true });
  let directory = path.dirname(resolved);
  while (directory.startsWith(`${workspaceDir}${path.sep}`)) {
    try {
      fs.rmdirSync(directory);
    } catch {
      break;
    }
    directory = path.dirname(directory);
  }
}

/**
 * Removes dictionary entries owned by one animation.
 * @param {object} dictionary Indexed override dictionary.
 * @param {string} prefix Animation key prefix.
 * @returns {object} Filtered copy.
 */
function withoutAnimationKeys(dictionary, prefix) {
  return Object.fromEntries(
    Object.entries(dictionary && typeof dictionary === "object" ? dictionary : {}).filter(
      ([key]) => !String(key).startsWith(prefix),
    ),
  );
}

/**
 * Returns whether a persisted binding belongs to one animation.
 * @param {object} binding Binding record.
 * @param {string} animationKey `<profile>/<animation>` key.
 * @returns {boolean} Whether the binding is owned by the animation.
 */
function bindingBelongsToAnimation(binding, animationKey) {
  const metadata = binding?.metadata && typeof binding.metadata === "object" ? binding.metadata : {};
  const profileId = String(metadata.profileId || binding?.profileId || "");
  let animation = String(metadata.animation || binding?.animation || binding?.animationId || "");
  if (animation && profileId && !animation.includes("/")) animation = `${profileId}/${animation}`;
  if (animation === animationKey) return true;
  const key = String(binding?.key || binding?.frameKey || "");
  return key === animationKey || key.startsWith(`${animationKey}:`);
}

/**
 * Normalizes legacy keyed bindings and current array bindings.
 * @param {unknown} value Persisted binding collection.
 * @returns {object[]} Normalized binding records.
 */
function normalizeBindings(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === "object");
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, entry]) => ({
    key,
    ...(entry && typeof entry === "object" ? entry : {}),
  }));
}

/**
 * Builds the persisted keys owned by one animation, including an unambiguous legacy name.
 * @param {object} profile Profile record that currently contains the animation.
 * @param {object} animation Animation record being replaced or deleted.
 * @returns {{animationId:string,animationKeys:Set<string>,legacyAnimationId:string,legacyKeyIsUnambiguous:boolean}}
 * Ownership keys.
 */
function animationOwnership(profile, animation) {
  const profileId = String(profile?.id || "");
  const animationId = String(animation?.id || animation?.name || "");
  const animationKey = `${profileId}/${animationId}`;
  const legacyAnimationId = String(animation?.name || "");
  const remaining = Array.isArray(profile?.animations) ? profile.animations : [];
  const legacyKeyIsUnambiguous =
    Boolean(legacyAnimationId) &&
    legacyAnimationId !== animationId &&
    !remaining.some(
      (entry) => entry !== animation && String(entry?.id || entry?.name || "") === legacyAnimationId,
    );
  return {
    animationId,
    animationKeys: new Set([
      animationKey,
      ...(legacyKeyIsUnambiguous ? [`${profileId}/${legacyAnimationId}`] : []),
    ]),
    legacyAnimationId,
    legacyKeyIsUnambiguous,
  };
}

/**
 * Removes frame overrides and bindings owned by one animation without writing files.
 * @param {{
 *   tuning?:object,
 *   audioBindings?:unknown,
 *   imageAttachments?:unknown,
 *   attachmentAssets?:unknown,
 *   attackTrails?:object,
 *   profile:object,
 *   animation:object,
 * }} options In-memory records and the animation being replaced.
 * @returns {{
 *   tuning:object,
 *   frameAudioBindings:object[],
 *   frameImageAttachments:object[],
 *   attachmentAssets:object[],
 *   attackTrails:object,
 *   ownedAnimationKeys:string[],
 * }} Cleaned copies.
 */
function stripAnimationOwnedData(options) {
  const profile = options.profile;
  const animation = options.animation;
  const { animationId, animationKeys, legacyAnimationId, legacyKeyIsUnambiguous } = animationOwnership(
    profile,
    animation,
  );
  const ownedAnimationKeys = Array.from(animationKeys);
  const tuning = clone(options.tuning && typeof options.tuning === "object" ? options.tuning : EMPTY_TUNING);
  for (const field of ["frame_visual_overrides", "frame_playback_overrides", "frame_box_overrides"]) {
    tuning[field] = ownedAnimationKeys.reduce(
      (record, key) => withoutAnimationKeys(record, `${key}:`),
      tuning[field],
    );
  }
  const groupValuePrefixes = [animationId, ...(legacyKeyIsUnambiguous ? [legacyAnimationId] : [])].map(
    (id) => `profiles.${profile.id}.groups.${id}.`,
  );
  tuning.values = groupValuePrefixes.reduce(
    (record, prefix) => withoutAnimationKeys(record, prefix),
    tuning.values,
  );
  const attackTrails = clone(
    options.attackTrails && typeof options.attackTrails === "object"
      ? options.attackTrails
      : EMPTY_ATTACK_TRAILS,
  );
  attackTrails.bindings =
    attackTrails.bindings && typeof attackTrails.bindings === "object" ? attackTrails.bindings : {};
  for (const key of ownedAnimationKeys) delete attackTrails.bindings[key];
  return {
    tuning,
    frameAudioBindings: normalizeBindings(options.audioBindings).filter(
      (binding) => !ownedAnimationKeys.some((key) => bindingBelongsToAnimation(binding, key)),
    ),
    frameImageAttachments: normalizeBindings(options.imageAttachments).filter(
      (binding) => !ownedAnimationKeys.some((key) => bindingBelongsToAnimation(binding, key)),
    ),
    attachmentAssets: normalizeBindings(options.attachmentAssets).filter(
      (asset) => !animationKeys.has(String(asset.groupKey || "")),
    ),
    attackTrails,
    ownedAnimationKeys,
  };
}

/**
 * Deletes an animation, its frame directory, overrides, and frame bindings.
 * The caller owns the surrounding filesystem transaction and Godot sync.
 * @param {{root:string,projectStore:object,project:object,profileId:string,animationId:string}} options Mutation options.
 * @returns {{manifest:object,tuning:object,frameAudioBindings:object[],frameImageAttachments:object[],attachmentAssets:object[],attackTrails:object,removedFrames:number,removedDirectory:string,removedAttackTrailTextureDirectory:string,removedAttackTrailTextureDirectories:string[]}}
 * Mutation result.
 */
function deleteAnimation(options) {
  const { root, projectStore, project } = options;
  const profileId = String(options.profileId || "");
  const animationId = String(options.animationId || "");
  const paths = projectStore.projectPaths(project);
  const manifest = clone(projectStore.readJson(paths.manifest, EMPTY_MANIFEST));
  const tuning = clone(projectStore.readJson(paths.tuning, EMPTY_TUNING));
  const audioBindings = projectStore.readJson(paths.frameAudio, []);
  const imageAttachments = projectStore.readJson(paths.frameImageAttachments, []);
  const attachmentAssets = projectStore.readJson(paths.attachmentAssets, []);
  const attackTrails = normalizeAttackTrails(projectStore.readJson(paths.attackTrails, EMPTY_ATTACK_TRAILS));
  const profileIndex = (manifest.profiles || []).findIndex((entry) => String(entry.id) === profileId);
  if (profileIndex < 0) throw new Error(`Profile not found: ${profileId}`);
  const profile = manifest.profiles[profileIndex];
  const animationIndex = (profile.animations || []).findIndex(
    (entry) => String(entry.id || entry.name) === animationId,
  );
  if (animationIndex < 0) throw new Error(`Animation not found: ${profileId}/${animationId}`);
  const [animation] = profile.animations.splice(animationIndex, 1);
  if (!profile.animations.length) manifest.profiles.splice(profileIndex, 1);

  const animationKey = `${profileId}/${animationId}`;
  const legacyAnimationId = String(animation.name || "");
  const legacyKeyIsUnambiguous =
    legacyAnimationId &&
    legacyAnimationId !== animationId &&
    !(profile.animations || []).some((entry) => String(entry.id || entry.name || "") === legacyAnimationId);
  const animationKeys = new Set([
    animationKey,
    ...(legacyKeyIsUnambiguous ? [`${profileId}/${legacyAnimationId}`] : []),
  ]);
  const ownedAnimationKeys = Array.from(animationKeys);
  const removedAttackTrailTexturePaths = ownedAnimationKeys.flatMap((key) =>
    Array.from(attackTrails.bindings[key] || [], (segment) => String(segment?.texture?.path || "")),
  );
  for (const key of ownedAnimationKeys) delete attackTrails.bindings[key];
  for (const field of ["frame_visual_overrides", "frame_playback_overrides", "frame_box_overrides"]) {
    tuning[field] = ownedAnimationKeys.reduce(
      (record, key) => withoutAnimationKeys(record, `${key}:`),
      tuning[field],
    );
  }
  const groupValuePrefixes = [animationId, ...(legacyKeyIsUnambiguous ? [legacyAnimationId] : [])].map(
    (id) => `profiles.${profileId}.groups.${id}.`,
  );
  tuning.values = groupValuePrefixes.reduce(
    (record, prefix) => withoutAnimationKeys(record, prefix),
    tuning.values,
  );
  if (!profile.animations.length) {
    tuning.values = withoutAnimationKeys(tuning.values, `profiles.${profileId}.character.`);
  }
  const previousAudio = normalizeBindings(audioBindings);
  const previousAttachments = normalizeBindings(imageAttachments);
  const previousAssets = normalizeBindings(attachmentAssets);
  const nextAudio = previousAudio.filter(
    (binding) => !ownedAnimationKeys.some((key) => bindingBelongsToAnimation(binding, key)),
  );
  const nextAttachments = previousAttachments.filter(
    (binding) => !ownedAnimationKeys.some((key) => bindingBelongsToAnimation(binding, key)),
  );
  const nextAssets = previousAssets.filter((asset) => !animationKeys.has(String(asset.groupKey || "")));
  const removedAudioPaths = previousAudio
    .filter((binding) => !nextAudio.includes(binding))
    .map((binding) => String(binding.path || ""));
  const removedAttachmentPaths = previousAttachments
    .filter((binding) => !nextAttachments.includes(binding))
    .map((binding) => String(binding.path || ""));
  const removedAssetPaths = previousAssets
    .filter((asset) => !nextAssets.includes(asset))
    .map((asset) => String(asset.path || ""));

  projectStore.writeJson(paths.manifest, manifest);
  projectStore.writeJson(paths.tuning, tuning);
  projectStore.writeJson(paths.frameAudio, nextAudio);
  projectStore.writeJson(paths.frameImageAttachments, nextAttachments);
  projectStore.writeJson(paths.attachmentAssets, nextAssets);
  projectStore.writeJson(paths.attackTrails, attackTrails);

  const workspaceDir = projectStore.projectWorkspaceDir(project);
  const source = String(animation.source || path.dirname(animation.frames?.[0]?.path || ""));
  const removedDirectory = safeResolve(root, source);
  if (removedDirectory && removedDirectory.startsWith(`${workspaceDir}${path.sep}`)) {
    fs.rmSync(removedDirectory, { recursive: true, force: true });
  }
  const retainedAttackTrailTexturePaths = new Set(
    Object.values(attackTrails.bindings)
      .flat()
      .map((segment) => safeResolve(root, segment?.texture?.path || ""))
      .filter(Boolean),
  );
  const retainedWorkspaceCopyPaths = new Set(
    [...nextAudio, ...nextAttachments, ...nextAssets]
      .map((entry) => safeResolve(root, entry?.path || ""))
      .filter(Boolean),
  );
  const audioWorkspaceRoot = path.join(workspaceDir, "audio");
  const attachmentsWorkspaceRoot = path.join(workspaceDir, "attachments");
  for (const copyPath of removedAudioPaths) {
    unlinkUnreferencedWorkspaceCopy(
      copyPath,
      audioWorkspaceRoot,
      retainedWorkspaceCopyPaths,
      root,
      workspaceDir,
    );
  }
  for (const copyPath of removedAttachmentPaths) {
    unlinkUnreferencedWorkspaceCopy(
      copyPath,
      attachmentsWorkspaceRoot,
      retainedWorkspaceCopyPaths,
      root,
      workspaceDir,
    );
  }
  for (const copyPath of removedAssetPaths) {
    unlinkUnreferencedWorkspaceCopy(copyPath, workspaceDir, retainedWorkspaceCopyPaths, root, workspaceDir);
  }
  const attackTrailWorkspaceRoot = path.join(workspaceDir, "attack_trails");
  for (const texturePath of removedAttackTrailTexturePaths) {
    const resolvedTexturePath = safeResolve(root, texturePath);
    if (
      resolvedTexturePath.startsWith(`${attackTrailWorkspaceRoot}${path.sep}`) &&
      !retainedAttackTrailTexturePaths.has(resolvedTexturePath)
    ) {
      fs.rmSync(resolvedTexturePath, { force: true });
    }
  }
  const removedAttackTrailTextureDirectories = [
    attackTrailTextureDirectory(projectStore, project, profileId, animationId),
    ...(legacyKeyIsUnambiguous
      ? [attackTrailTextureDirectory(projectStore, project, profileId, legacyAnimationId)]
      : []),
  ].filter((directory, index, directories) => directories.indexOf(directory) === index);
  for (const textureDirectory of removedAttackTrailTextureDirectories) {
    const textureDirectoryStillReferenced = Object.values(attackTrails.bindings)
      .flat()
      .some((segment) => {
        const texturePath = safeResolve(root, segment?.texture?.path || "");
        return texturePath === textureDirectory || texturePath?.startsWith(`${textureDirectory}${path.sep}`);
      });
    if (!textureDirectoryStillReferenced) {
      fs.rmSync(textureDirectory, { recursive: true, force: true });
    }
  }
  return {
    manifest,
    tuning,
    frameAudioBindings: nextAudio,
    frameImageAttachments: nextAttachments,
    attachmentAssets: nextAssets,
    attackTrails,
    removedFrames: Array.isArray(animation.frames) ? animation.frames.length : 0,
    removedDirectory,
    removedAttackTrailTextureDirectory: removedAttackTrailTextureDirectories[0],
    removedAttackTrailTextureDirectories,
  };
}

module.exports = {
  bindingBelongsToAnimation,
  deleteAnimation,
  normalizeBindings,
  stripAnimationOwnedData,
  withoutAnimationKeys,
};
