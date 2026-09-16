const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { estimateFrameBoxes, upsertEstimatedFrameBoxes } = require("./box_estimator");
const { ensureInitialCharacterScale } = require("./import_scale");
const {
  normalizeBindings,
  safeResolve: resolveWorkspaceCopy,
  stripAnimationOwnedData,
  unlinkUnreferencedWorkspaceCopy,
} = require("./animation_mutations");
const { findGodotProjectRoot, forgetGodotImportCache } = require("./godot_sync");

const ANIMATION_TYPES = Object.freeze(["actor", "boss", "vfx", "prop", "scene_prop_attachment"]);

/**
 * Normalizes a stored clip type. Invalid values fail instead of becoming actor.
 * @param {unknown} value Requested type.
 * @returns {string} One of ANIMATION_TYPES.
 */
function resolveAnimationType(value) {
  const requested = String(value || "actor");
  if (!ANIMATION_TYPES.includes(requested)) {
    throw new Error(`animation_type must be one of: ${ANIMATION_TYPES.join(", ")}`);
  }
  return requested;
}

/**
 * Resolves clip type for import. Replace omit keeps the stored type; first-import omit is actor.
 * Empty string counts as omitted so it does not wipe a stored vfx/prop type.
 * @param {unknown} requested Raw animation_type / animationType.
 * @param {unknown} [existingType] Stored type used when requested is omitted on replace.
 * @returns {string} One of ANIMATION_TYPES.
 */
function resolveImportedAnimationType(requested, existingType) {
  const omitted = requested === undefined || requested === null || requested === "";
  return resolveAnimationType(omitted ? (existingType ?? requested) : requested);
}

/**
 * Deep-clones JSON-compatible project data.
 * @param {unknown} value JSON-compatible value.
 * @returns {any}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolves a path only when it remains inside the requested base.
 * @param {string} base Allowed base directory.
 * @param {string} requested Requested path.
 * @returns {string|null}
 */
function safeResolve(base, requested) {
  const fullPath = path.resolve(base, String(requested || ""));
  return fullPath === base || fullPath.startsWith(`${base}${path.sep}`) ? fullPath : null;
}

/**
 * Converts platform separators into manifest separators.
 * @param {string} value Path value.
 * @returns {string}
 */
function reslash(value) {
  return String(value || "").replaceAll("\\", "/");
}

/**
 * Stores a frame path relative to the XSXB root when possible, otherwise absolute
 * so game-pack files outside the root still round-trip.
 * @param {string} root XSXB root.
 * @param {string} absolutePath On-disk PNG path.
 * @returns {string} Manifest path.
 */
function storedImportPath(root, absolutePath) {
  const resolved = path.resolve(absolutePath);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return reslash(relative);
  }
  return reslash(resolved);
}

/**
 * Resolves absolute PNG paths previously owned by one animation.
 * Empty stored paths are skipped.
 * @param {string} root XSXB root.
 * @param {object|null|undefined} animation Manifest animation.
 * @returns {string[]} Absolute owned frame paths.
 */
function ownedAnimationFramePaths(root, animation) {
  const frames = Array.isArray(animation?.frames) ? animation.frames : [];
  const result = [];
  for (const frame of frames) {
    const raw = String(frame?.path || "").trim();
    if (!raw) continue;
    result.push(path.resolve(root, raw));
  }
  return result;
}

/**
 * Unlinks previously owned in-place frame files that the replacement clip no longer
 * references. Skips missing paths and workspace copies (those swap via backup/rename).
 * Forgets Godot `.ctex` / `.md5` cache and unlinks sibling `.import` / `.uid` sidecars
 * for each dropped numbered PNG.
 * @param {string[]} previousPaths Absolute paths owned by the old animation.
 * @param {Iterable<string>} keptPaths Absolute paths still referenced by the new frames.
 * @param {string} workspaceTargetDir Workspace asset directory that must not be deleted here.
 * @returns {void}
 */
function unlinkUnreferencedInPlaceFrames(previousPaths, keptPaths, workspaceTargetDir) {
  const kept = new Set(
    Array.from(keptPaths || [])
      .filter(Boolean)
      .map((filePath) => path.resolve(filePath)),
  );
  const workspace = path.resolve(workspaceTargetDir);
  for (const raw of previousPaths || []) {
    const absolute = path.resolve(raw);
    if (kept.has(absolute)) continue;
    if (absolute === workspace || absolute.startsWith(`${workspace}${path.sep}`)) continue;
    try {
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      const godotRoot = findGodotProjectRoot(path.dirname(absolute));
      if (godotRoot) forgetGodotImportCache(godotRoot, absolute);
      for (const sidecar of [`${absolute}.import`, `${absolute}.uid`]) {
        try {
          if (fs.existsSync(sidecar) && fs.statSync(sidecar).isFile()) fs.unlinkSync(sidecar);
        } catch {
          // Missing or already gone — skip.
        }
      }
      fs.unlinkSync(absolute);
    } catch {
      // Missing or already gone — skip.
    }
  }
}

/**
 * Reads dimensions from a PNG header.
 * @param {Buffer} buffer PNG data.
 * @returns {{width:number,height:number}}
 */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Frame organizer only accepts PNG image data.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/**
 * Decodes a PNG data URL.
 * @param {string} value PNG data URL.
 * @returns {Buffer|null}
 */
function decodePngDataUrl(value) {
  const match = /^data:image\/png;base64,(.+)$/i.exec(String(value || ""));
  return match ? Buffer.from(match[1], "base64") : null;
}

/**
 * Reads one import frame while keeping inline data URLs backward-compatible.
 * An explicit in-place source wins; otherwise inline data wins over sourcePath.
 * @param {{data?:string,sourcePath?:string}} item Inline PNG or on-disk source.
 * @param {number} index Zero-based frame index for diagnostics.
 * @param {string} [inPlaceSource] Validated original path for in-place imports.
 * @returns {{buffer:Buffer,dimensions:{width:number,height:number}}} One frame.
 */
function readImportFrame(item, index, inPlaceSource) {
  const sourcePath = inPlaceSource || (item.data === undefined ? String(item.sourcePath || "").trim() : "");
  const buffer = sourcePath ? fs.readFileSync(sourcePath) : decodePngDataUrl(item.data);
  if (!buffer) throw new Error(`Frame ${index + 1} is not PNG image data.`);
  return { buffer, dimensions: pngSize(buffer) };
}

/**
 * Mirrors saved box offsets and rotations for a horizontally flipped frame.
 * @param {object} boxes Frame box entry.
 * @returns {object}
 */
function mirrorBoxes(boxes) {
  const result = clone(boxes);
  for (const box of Object.values(result)) {
    if (!box || typeof box !== "object") continue;
    if (box.offset && typeof box.offset === "object") box.offset.x = -Number(box.offset.x || 0);
    if (box.rotation !== undefined) box.rotation = -Number(box.rotation || 0);
  }
  return result;
}

/**
 * Remaps one indexed tuning dictionary to a new frame order.
 * @param {object} source Original tuning dictionary.
 * @param {string} prefix Stable animation key prefix.
 * @param {Array<{sourceIndex:number|null,flipped?:boolean}>} items New frame plan.
 * @param {boolean} mirrorFrameBoxes Whether mirrored frame boxes require X inversion.
 * @returns {object}
 */
function remapIndexedDictionary(source, prefix, items, mirrorFrameBoxes = false) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!key.startsWith(prefix) || key === `${prefix}__group`) result[key] = clone(value);
  }
  items.forEach((item, newIndex) => {
    if (!Number.isInteger(item.sourceIndex)) return;
    const oldKey = `${prefix}${item.sourceIndex}`;
    if (!(oldKey in (source || {}))) return;
    const value = mirrorFrameBoxes && item.flipped ? mirrorBoxes(source[oldKey]) : clone(source[oldKey]);
    result[`${prefix}${newIndex}`] = value;
  });
  return result;
}

/**
 * Remaps or clears a persisted reference-frame descriptor after a frame plan.
 * @param {object|null|undefined} descriptor Saved reference-frame descriptor.
 * @param {string} profileId Animation profile.
 * @param {string} animationId Animation id.
 * @param {Array<{sourceIndex?:number|null}>} items New frame plan.
 * @returns {object|null} Remapped descriptor, or null when the referenced frame was removed.
 */
function remapReferenceFrame(descriptor, profileId, animationId, items) {
  if (!descriptor || typeof descriptor !== "object") return null;
  if (String(descriptor.profile_id || "") !== String(profileId || "")) return clone(descriptor);
  if (String(descriptor.animation_id || "") !== String(animationId || "")) return clone(descriptor);
  const oldIndex = Number(descriptor.frame_index);
  if (!Number.isInteger(oldIndex) || oldIndex < 0) return null;
  const newIndex = Array.from(items || []).findIndex((item) => item?.sourceIndex === oldIndex);
  if (newIndex < 0) return null;
  return { ...clone(descriptor), frame_index: newIndex };
}

/**
 * Returns a binding's stable animation and frame metadata.
 * @param {object} binding Audio or image attachment binding.
 * @returns {{animation:string,frame:number|null}}
 */
function bindingInfo(binding) {
  const metadata = binding?.metadata && typeof binding.metadata === "object" ? binding.metadata : {};
  let animation = String(metadata.animation || binding?.animation || "");
  const profileId = String(metadata.profileId || binding?.profileId || "");
  if (animation && profileId && !animation.includes("/")) animation = `${profileId}/${animation}`;
  const keyMatch = /^(.*):(\d+)$/.exec(String(binding?.key || binding?.frameKey || ""));
  if (!animation && keyMatch) animation = keyMatch[1];
  const frame = Number(metadata.frame ?? binding?.frame ?? keyMatch?.[2]);
  return { animation, frame: Number.isFinite(frame) ? frame : null };
}

/**
 * Replaces the numeric frame suffix in a binding key.
 * @param {string} value Existing key.
 * @param {number} frame New frame index.
 * @returns {string}
 */
function rekeyBindingValue(value, frame) {
  const text = String(value || "");
  return /:\d+$/.test(text) ? text.replace(/:\d+$/, `:${frame}`) : text;
}

/**
 * Remaps frame audio or attachment bindings to the new frame plan.
 * @param {object[]|object} bindings Existing bindings, including the legacy keyed format.
 * @param {string} animationKey Stable animation key.
 * @param {Array<{sourceIndex:number|null}>} items New frame plan.
 * @returns {object[]}
 */
function remapBindings(bindings, animationKey, items) {
  const untouched = [];
  const indexed = new Map();
  const normalizedBindings = Array.isArray(bindings)
    ? bindings
    : Object.entries(bindings && typeof bindings === "object" ? bindings : {}).map(([key, value]) => ({
        key,
        ...(value && typeof value === "object" ? value : {}),
      }));
  for (const binding of normalizedBindings) {
    const info = bindingInfo(binding);
    if (info.animation === animationKey && Number.isInteger(info.frame)) {
      if (!indexed.has(info.frame)) indexed.set(info.frame, []);
      indexed.get(info.frame).push(binding);
    } else {
      untouched.push(clone(binding));
    }
  }
  const remapped = [];
  items.forEach((item, newIndex) => {
    if (!Number.isInteger(item.sourceIndex)) return;
    for (const binding of indexed.get(item.sourceIndex) || []) {
      const next = clone(binding);
      if (next.metadata && typeof next.metadata === "object") {
        next.metadata.frame = newIndex;
        next.metadata.displayFrame = newIndex;
      }
      if (next.frame !== undefined) next.frame = newIndex;
      if (next.key) next.key = rekeyBindingValue(next.key, newIndex);
      if (next.frameKey) next.frameKey = rekeyBindingValue(next.frameKey, newIndex);
      remapped.push(next);
    }
  });
  return [...untouched, ...remapped];
}

/**
 * Normalizes a trail stick's phase for deterministic chronological sorting.
 * @param {unknown} value Saved frame phase.
 * @returns {number} Finite phase clamped to the current frame.
 */
function normalizedTrailFramePhase(value) {
  if (value === null || value === undefined) return 0.5;
  const phase = Number(value);
  return Number.isFinite(phase) ? Math.min(1, Math.max(0, phase)) : 0.5;
}

/**
 * Remaps attack-trail sticks to the replacement frame order.
 * Drops segments whose sticks all lived on omitted frames, except empty presetOnly placeholders.
 * @param {object} source Attack-trail document.
 * @param {string} animationKey Stable profile/animation key.
 * @param {Array<{sourceIndex:number|null}>} items New frame plan.
 * @returns {object} Remapped attack-trail document.
 */
function remapAttackTrails(source, animationKey, items) {
  const result = clone(source && typeof source === "object" ? source : { schemaVersion: 8, bindings: {} });
  if (!result.bindings || typeof result.bindings !== "object") result.bindings = {};
  if (!Array.isArray(result.bindings[animationKey])) return result;
  const frameMap = new Map();
  items.forEach((item, nextIndex) => {
    if (!Number.isInteger(item.sourceIndex)) return;
    if (!frameMap.has(item.sourceIndex)) frameMap.set(item.sourceIndex, []);
    frameMap.get(item.sourceIndex).push(nextIndex);
  });
  result.bindings[animationKey] = result.bindings[animationKey]
    .map((segment) => {
      const sticks = Array.from(segment?.sticks || [])
        .flatMap((stick, sourceIndex) => {
          const savedOrder = Number(stick?.order);
          const stableOrder = Number.isFinite(savedOrder) ? savedOrder : sourceIndex;
          return Array.from(frameMap.get(Number(stick?.frame)) || []).map((frame) => ({
            stick: { ...stick, frame },
            sourceIndex,
            stableOrder,
          }));
        })
        .sort(
          (left, right) =>
            left.stick.frame - right.stick.frame ||
            normalizedTrailFramePhase(left.stick.framePhase) -
              normalizedTrailFramePhase(right.stick.framePhase) ||
            left.stableOrder - right.stableOrder ||
            left.sourceIndex - right.sourceIndex,
        )
        .map(({ stick }, order) => ({ ...stick, order }));
      return { ...segment, sticks };
    })
    .filter((segment) => segment.sticks.length > 0 || segment.presetOnly === true);
  return result;
}

/**
 * Locates a manifest animation.
 * @param {object} manifest Animation manifest.
 * @param {string} profileId Profile identifier.
 * @param {string} animationId Animation identifier.
 * @returns {{profile:object,animation:object}}
 */
/**
 * Builds a workspace-safe folder name for imported PNG sequences.
 * @param {unknown} value Profile or animation id.
 * @param {string} fallback Fallback segment.
 * @returns {string} Path segment.
 */
function assetFolderSegment(value, fallback) {
  const slug = String(value || "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

/**
 * Resolves the directory that will own reorganized PNG frames.
 * Spritesheet-backed animations keep the atlas file and write a sibling asset folder.
 * @param {string} root Tuner root.
 * @param {string} workspaceDir Project workspace.
 * @param {object} animation Manifest animation.
 * @param {string} profileId Profile id.
 * @param {string} animationId Animation id.
 * @returns {string} Target frame directory.
 */
function resolveReorganizeTargetDir(root, workspaceDir, animation, profileId, animationId) {
  const sourceDirectory = reslash(animation.source || path.dirname(animation.frames?.[0]?.path || ""));
  const resolved = safeResolve(root, sourceDirectory);
  if (!resolved || !resolved.startsWith(`${workspaceDir}${path.sep}`)) {
    throw new Error("Animation assets must stay inside the active project workspace.");
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const targetDir = path.join(
      workspaceDir,
      "assets",
      assetFolderSegment(profileId, "profile"),
      assetFolderSegment(animationId, "animation"),
    );
    if (!targetDir.startsWith(`${workspaceDir}${path.sep}`)) {
      throw new Error("Animation assets must stay inside the active project workspace.");
    }
    return targetDir;
  }
  return resolved;
}

function findAnimation(manifest, profileId, animationId) {
  const profile = (manifest.profiles || []).find((entry) => String(entry.id) === profileId);
  if (!profile) throw new Error(`Profile not found: ${profileId}`);
  const animation = (profile.animations || []).find(
    (entry) => String(entry.id || entry.name) === animationId,
  );
  if (!animation) throw new Error(`Animation not found: ${profileId}/${animationId}`);
  return { profile, animation };
}

/**
 * Returns an existing profile or creates a manifest profile for a new import.
 * @param {object} manifest Animation manifest.
 * @param {string} profileId Stable profile identifier.
 * @param {string} profileLabel User-facing profile label.
 * @param {string} profileKind Runtime profile kind.
 * @returns {object}
 */
function ensureImportProfile(manifest, profileId, profileLabel, profileKind) {
  manifest.profiles = Array.isArray(manifest.profiles) ? manifest.profiles : [];
  let profile = manifest.profiles.find((entry) => String(entry.id) === profileId);
  if (!profile) {
    profile = {
      id: profileId,
      label: profileLabel || profileId,
      kind: profileKind || "actor",
      bodyScale: 1,
      runtimeScale: 1,
      animations: [],
    };
    manifest.profiles.push(profile);
  }
  profile.animations = Array.isArray(profile.animations) ? profile.animations : [];
  return profile;
}

/**
 * Imports a new browser-created PNG sequence into one project atomically.
 * @param {{
 *   root:string,
 *   projectStore:object,
 *   project:object,
 *   profileId:string,
 *   profileLabel?:string,
 *   profileKind?:string,
 *   animationId:string,
 *   animationName?:string,
 *   animationType?:string,
 *   anchorMode?:string,
 *   fps?:number,
 *   inPlace?:boolean,
 *   items:Array<{data?:string,name?:string,sourcePath?:string}>
 * }} options Import operation.
 * @returns {{manifest:object,tuning:object,frameCount:number,targetDir:string,profileId:string,animationId:string,inPlace:boolean}}
 */
function importAnimation(options) {
  const { root, projectStore, project, profileId, animationId } = options;
  const items = Array.isArray(options.items) ? options.items : [];
  const inPlace = Boolean(options.inPlace);
  if (!project) throw new Error("An active project is required.");
  if (!profileId || !animationId) throw new Error("Profile and animation names are required.");
  if (!items.length) throw new Error("Import at least one animation frame.");
  if (items.length > 5000) throw new Error("Animation import limit is 5000 frames.");

  const sourcePaths = inPlace
    ? items.map((item, index) => {
        const sourcePath = String(item.sourcePath || "").trim();
        if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
          throw new Error(`in_place import requires an existing PNG path for frame ${index + 1}.`);
        }
        return path.resolve(sourcePath);
      })
    : [];

  const paths = projectStore.projectPaths(project);
  const manifest = projectStore.readJson(paths.manifest, { schemaVersion: 1, profiles: [] });
  const tuning = projectStore.readJson(paths.tuning, {
    schemaVersion: 1,
    values: {},
    scene_settings: {},
    frame_visual_overrides: {},
    frame_playback_overrides: {},
    frame_box_overrides: {},
  });
  const originals = {
    manifest: clone(manifest),
    tuning: clone(tuning),
  };
  const profile = ensureImportProfile(
    manifest,
    profileId,
    String(options.profileLabel || profileId),
    String(options.profileKind || "actor"),
  );
  const existingIndex = profile.animations.findIndex(
    (entry) => String(entry.id || entry.name) === animationId,
  );
  const replacing = Boolean(options.replace) && existingIndex >= 0;
  const previousOwnedFramePaths =
    replacing && inPlace ? ownedAnimationFramePaths(root, profile.animations[existingIndex]) : [];
  if (existingIndex >= 0 && !replacing) {
    throw Object.assign(new Error(`Animation already exists: ${profileId}/${animationId}`), {
      status: 409,
      code: "animation_exists",
    });
  }

  const workspaceDir = projectStore.projectWorkspaceDir(project);
  const targetDir = path.join(workspaceDir, "assets", profileId, animationId);
  if (!targetDir.startsWith(`${workspaceDir}${path.sep}`)) {
    throw new Error("Animation assets must stay inside the active project workspace.");
  }
  if (!inPlace && fs.existsSync(targetDir) && !replacing) {
    throw new Error(`Animation asset folder already exists: ${profileId}/${animationId}`);
  }

  const audioBindings = projectStore.readJson(paths.frameAudio, []);
  const imageAttachments = projectStore.readJson(paths.frameImageAttachments, []);
  const attachmentAssets = projectStore.readJson(paths.attachmentAssets, []);
  const attackTrails = projectStore.readJson(paths.attackTrails, { schemaVersion: 8, bindings: {} });
  originals.frameAudio = clone(audioBindings);
  originals.frameImageAttachments = clone(imageAttachments);
  originals.attachmentAssets = clone(attachmentAssets);
  originals.attackTrails = clone(attackTrails);
  let nextAudio = audioBindings;
  let nextAttachments = imageAttachments;
  let nextAssets = attachmentAssets;
  let nextTrails = attackTrails;
  if (replacing) {
    const stripped = stripAnimationOwnedData({
      tuning,
      audioBindings,
      imageAttachments,
      attachmentAssets,
      attackTrails,
      profile,
      animation: profile.animations[existingIndex],
    });
    Object.assign(tuning, stripped.tuning);
    tuning.values = stripped.tuning.values;
    tuning.frame_visual_overrides = stripped.tuning.frame_visual_overrides;
    tuning.frame_playback_overrides = stripped.tuning.frame_playback_overrides;
    tuning.frame_box_overrides = stripped.tuning.frame_box_overrides;
    nextAudio = stripped.frameAudioBindings;
    nextAttachments = stripped.frameImageAttachments;
    nextAssets = stripped.attachmentAssets;
    nextTrails = stripped.attackTrails;
  }

  const operationId = crypto.randomBytes(8).toString("hex");
  const stagingDir = `${targetDir}.import-${operationId}`;
  const backupDir = `${targetDir}.backup-${operationId}`;
  if (!inPlace) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
  }
  let frames = [];
  let animation = null;
  try {
    const frameFiles = [];
    const usedFrameIds = new Set();
    frames = items.map((item, index) => {
      // Read and release one frame at a time; source paths need no base64 copy.
      const { buffer, dimensions } = readImportFrame(item, index, sourcePaths[index]);
      const requestedFrameId = String(items[index]?.frameId || items[index]?.id || "")
        .replace(/[\u0000-\u001f]/g, "")
        .slice(0, 160);
      const fallbackFrameId = `frame_${String(index + 1).padStart(4, "0")}`;
      let frameId = requestedFrameId || fallbackFrameId;
      let suffix = 2;
      while (usedFrameIds.has(frameId)) {
        frameId = `${requestedFrameId || fallbackFrameId}-${suffix}`;
        suffix += 1;
      }
      usedFrameIds.add(frameId);
      if (inPlace) {
        const sourcePath = sourcePaths[index];
        frameFiles.push(sourcePath);
        return {
          id: frameId,
          name: path.basename(sourcePath),
          path: storedImportPath(root, sourcePath),
          assetRevision: Math.max(0, Number(items[index]?.assetRevision) || 0),
          duration: 1,
          ...dimensions,
        };
      }
      const frameName = `frame_${String(index + 1).padStart(4, "0")}.png`;
      const stagingPath = path.join(stagingDir, frameName);
      fs.writeFileSync(stagingPath, buffer);
      frameFiles.push(stagingPath);
      return {
        id: frameId,
        name: frameName,
        path: reslash(path.relative(root, path.join(targetDir, frameName))),
        assetRevision: Math.max(0, Number(items[index]?.assetRevision) || 0),
        duration: 1,
        ...dimensions,
      };
    });
    const animationType = resolveAnimationType(options.animationType);
    animation = {
      id: animationId,
      name: String(options.animationName || animationId),
      type: animationType,
      anchorMode: String(options.anchorMode || "canvas_bottom_center"),
      fps: Math.max(1, Math.min(120, Number(options.fps || 12))),
      source: inPlace
        ? storedImportPath(root, path.dirname(sourcePaths[0]))
        : reslash(path.relative(root, targetDir)),
      frames,
    };
    if (inPlace) animation.inPlace = true;
    if (replacing) profile.animations[existingIndex] = animation;
    else profile.animations.push(animation);
    ensureInitialCharacterScale(
      tuning,
      profileId,
      project.projectRoot,
      frameFiles.map((filePath) => ({
        filePath,
        animationId,
        animationName: animation.name,
      })),
    );
    upsertEstimatedFrameBoxes(tuning, profileId, animation, frameFiles, { replace: true });
  } catch (error) {
    if (!inPlace) fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  let backupCreated = false;
  let directoryInstalled = false;
  try {
    if (replacing && fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      backupCreated = true;
    }
    if (!inPlace) {
      fs.renameSync(stagingDir, targetDir);
      directoryInstalled = true;
    }
    projectStore.writeJson(paths.manifest, manifest);
    projectStore.writeJson(paths.tuning, tuning);
    if (replacing) {
      projectStore.writeJson(paths.frameAudio, nextAudio);
      projectStore.writeJson(paths.frameImageAttachments, nextAttachments);
      projectStore.writeJson(paths.attachmentAssets, nextAssets);
      projectStore.writeJson(paths.attackTrails, nextTrails);
    }
  } catch (error) {
    if (directoryInstalled) fs.rmSync(targetDir, { recursive: true, force: true });
    if (backupCreated && fs.existsSync(backupDir)) fs.renameSync(backupDir, targetDir);
    if (!inPlace) fs.rmSync(stagingDir, { recursive: true, force: true });
    projectStore.writeJson(paths.manifest, originals.manifest);
    projectStore.writeJson(paths.tuning, originals.tuning);
    if (replacing) {
      projectStore.writeJson(paths.frameAudio, originals.frameAudio);
      projectStore.writeJson(paths.frameImageAttachments, originals.frameImageAttachments);
      projectStore.writeJson(paths.attachmentAssets, originals.attachmentAssets);
      projectStore.writeJson(paths.attackTrails, originals.attackTrails);
    }
    throw error;
  }
  if (replacing) {
    const retainedWorkspaceCopyPaths = new Set(
      [...nextAudio, ...nextAttachments, ...nextAssets]
        .map((entry) => resolveWorkspaceCopy(root, entry?.path || ""))
        .filter(Boolean),
    );
    const retainedAttackTrailTexturePaths = new Set(
      Object.values(nextTrails.bindings || {})
        .flat()
        .map((segment) => resolveWorkspaceCopy(root, segment?.texture?.path || ""))
        .filter(Boolean),
    );
    const audioWorkspaceRoot = path.join(workspaceDir, "audio");
    const attachmentsWorkspaceRoot = path.join(workspaceDir, "attachments");
    const attackTrailWorkspaceRoot = path.join(workspaceDir, "attack_trails");
    for (const binding of normalizeBindings(originals.frameAudio)) {
      unlinkUnreferencedWorkspaceCopy(
        binding.path,
        audioWorkspaceRoot,
        retainedWorkspaceCopyPaths,
        root,
        workspaceDir,
      );
    }
    for (const binding of normalizeBindings(originals.frameImageAttachments)) {
      unlinkUnreferencedWorkspaceCopy(
        binding.path,
        attachmentsWorkspaceRoot,
        retainedWorkspaceCopyPaths,
        root,
        workspaceDir,
      );
    }
    for (const asset of normalizeBindings(originals.attachmentAssets)) {
      unlinkUnreferencedWorkspaceCopy(
        asset.path,
        workspaceDir,
        retainedWorkspaceCopyPaths,
        root,
        workspaceDir,
      );
    }
    for (const segment of Object.values(originals.attackTrails?.bindings || {}).flat()) {
      unlinkUnreferencedWorkspaceCopy(
        segment?.texture?.path || "",
        attackTrailWorkspaceRoot,
        retainedAttackTrailTexturePaths,
        root,
        workspaceDir,
      );
    }
  }
  if (backupCreated) {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove import backup ${backupDir}: ${error.message}`);
    }
  }
  if (replacing && inPlace) {
    unlinkUnreferencedInPlaceFrames(previousOwnedFramePaths, sourcePaths, targetDir);
  }

  return {
    manifest,
    tuning,
    frameCount: frames.length,
    targetDir: inPlace ? path.dirname(sourcePaths[0]) : targetDir,
    profileId,
    animationId,
    inPlace,
  };
}

/**
 * Applies an organizer frame plan to one project animation using atomic directory replacement.
 * @param {{
 *   root:string,
 *   projectStore:object,
 *   project:object,
 *   profileId:string,
 *   animationId:string,
 *   items:Array<{sourceIndex?:number|null,sourcePath?:string,data?:string,name?:string,flipped?:boolean}>
 * }} options Organizer operation.
 * @returns {{manifest:object,tuning:object,frameAudioBindings:object[],frameImageAttachments:object[],frameCount:number,targetDir:string}}
 */
function reorganizeAnimation(options) {
  const { root, projectStore, project, profileId, animationId } = options;
  const items = Array.isArray(options.items) ? options.items : [];
  if (!items.length) throw new Error("An animation must keep at least one frame.");
  if (items.length > 5000) throw new Error("Frame organizer limit is 5000 frames per animation.");

  const paths = projectStore.projectPaths(project);
  const manifest = projectStore.readJson(paths.manifest, { schemaVersion: 1, profiles: [] });
  const tuning = projectStore.readJson(paths.tuning, {
    schemaVersion: 1,
    values: {},
    frame_visual_overrides: {},
    frame_playback_overrides: {},
    frame_box_overrides: {},
  });
  const frameAudioBindings = projectStore.readJson(paths.frameAudio, []);
  const frameImageAttachments = projectStore.readJson(paths.frameImageAttachments, []);
  const attackTrails = projectStore.readJson(paths.attackTrails, { schemaVersion: 8, bindings: {} });
  const originals = {
    manifest: clone(manifest),
    tuning: clone(tuning),
    frameAudioBindings: clone(frameAudioBindings),
    frameImageAttachments: clone(frameImageAttachments),
    attackTrails: clone(attackTrails),
  };
  const { animation } = findAnimation(manifest, profileId, animationId);
  const workspaceDir = projectStore.projectWorkspaceDir(project);
  const targetDir = resolveReorganizeTargetDir(root, workspaceDir, animation, profileId, animationId);

  const buffers = items.map((item) => {
    const inlineBuffer = decodePngDataUrl(item.data);
    if (inlineBuffer) return inlineBuffer;
    const sourcePath = safeResolve(root, item.sourcePath);
    if (
      !sourcePath ||
      !sourcePath.startsWith(`${workspaceDir}${path.sep}`) ||
      path.extname(sourcePath).toLowerCase() !== ".png"
    ) {
      throw new Error(`Invalid organizer source frame: ${item.sourcePath || "missing path"}`);
    }
    return fs.readFileSync(sourcePath);
  });
  const operationId = crypto.randomBytes(8).toString("hex");
  const stagingDir = `${targetDir}.organize-${operationId}`;
  const backupDir = `${targetDir}.backup-${operationId}`;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const usedFrameIds = new Set();
  const nextFrames = buffers.map((buffer, index) => {
    const size = pngSize(buffer);
    const frameName = `frame_${String(index + 1).padStart(4, "0")}.png`;
    fs.writeFileSync(path.join(stagingDir, frameName), buffer);
    const preferred = String(
      items[index].frameId ||
        items[index].id ||
        (Number.isInteger(items[index].sourceIndex)
          ? animation.frames?.[items[index].sourceIndex]?.id
          : "") ||
        "",
    );
    let frameId = preferred;
    if (!frameId || usedFrameIds.has(frameId)) {
      let serial = index + 1;
      do {
        frameId = `frame_${String(serial).padStart(4, "0")}`;
        serial += 1;
      } while (usedFrameIds.has(frameId));
    }
    usedFrameIds.add(frameId);
    return {
      id: frameId,
      name: frameName,
      path: reslash(path.relative(root, path.join(targetDir, frameName))),
      assetRevision: Math.max(
        0,
        Number(
          items[index].assetRevision ??
            (Number.isInteger(items[index].sourceIndex)
              ? animation.frames?.[items[index].sourceIndex]?.assetRevision
              : 0),
        ) || 0,
      ),
      duration: Number(
        Number.isInteger(items[index].sourceIndex)
          ? animation.frames?.[items[index].sourceIndex]?.duration || 1
          : 1,
      ),
      ...size,
    };
  });

  const animationKey = `${profileId}/${animationId}`;
  const prefix = `${animationKey}:`;
  tuning.frame_visual_overrides = remapIndexedDictionary(tuning.frame_visual_overrides, prefix, items);
  tuning.frame_playback_overrides = remapIndexedDictionary(tuning.frame_playback_overrides, prefix, items);
  tuning.frame_box_overrides = remapIndexedDictionary(tuning.frame_box_overrides, prefix, items, true);
  items.forEach((item, index) => {
    if (Number.isInteger(item.sourceIndex)) return;
    const boxes = estimateFrameBoxes(path.join(stagingDir, nextFrames[index].name), {
      type: animation.type,
      anchorMode: animation.anchorMode,
      animationId,
      animationName: animation.name,
      frameIndex: index,
      frameCount: items.length,
      groupCanvasWidth: nextFrames[index].width,
      groupCanvasHeight: nextFrames[index].height,
    });
    if (Object.keys(boxes).length) tuning.frame_box_overrides[`${prefix}${index}`] = boxes;
  });
  const nextAudioBindings = remapBindings(frameAudioBindings, animationKey, items);
  const nextImageAttachments = remapBindings(frameImageAttachments, animationKey, items);
  const nextAttackTrails = remapAttackTrails(attackTrails, animationKey, items);
  tuning.reference_frame = remapReferenceFrame(tuning.reference_frame, profileId, animationId, items);
  animation.frames = nextFrames;
  animation.source = reslash(path.relative(root, targetDir));

  let backupCreated = false;
  let directorySwapped = false;
  try {
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
      backupCreated = true;
    }
    fs.renameSync(stagingDir, targetDir);
    directorySwapped = true;
    projectStore.writeJson(paths.manifest, manifest);
    projectStore.writeJson(paths.tuning, tuning);
    projectStore.writeJson(paths.frameAudio, nextAudioBindings);
    projectStore.writeJson(paths.frameImageAttachments, nextImageAttachments);
    projectStore.writeJson(paths.attackTrails, nextAttackTrails);
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    if (directorySwapped) fs.rmSync(targetDir, { recursive: true, force: true });
    if (backupCreated && fs.existsSync(backupDir)) fs.renameSync(backupDir, targetDir);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    projectStore.writeJson(paths.manifest, originals.manifest);
    projectStore.writeJson(paths.tuning, originals.tuning);
    projectStore.writeJson(paths.frameAudio, originals.frameAudioBindings);
    projectStore.writeJson(paths.frameImageAttachments, originals.frameImageAttachments);
    projectStore.writeJson(paths.attackTrails, originals.attackTrails);
    throw error;
  }

  const attachmentAssets = projectStore.readJson(paths.attachmentAssets, []);
  const retainedWorkspaceCopyPaths = new Set(
    [...nextAudioBindings, ...nextImageAttachments, ...normalizeBindings(attachmentAssets)]
      .map((entry) => resolveWorkspaceCopy(root, entry?.path || ""))
      .filter(Boolean),
  );
  const retainedAttackTrailTexturePaths = new Set(
    Object.values(nextAttackTrails.bindings || {})
      .flat()
      .map((segment) => resolveWorkspaceCopy(root, segment?.texture?.path || ""))
      .filter(Boolean),
  );
  const audioWorkspaceRoot = path.join(workspaceDir, "audio");
  const attachmentsWorkspaceRoot = path.join(workspaceDir, "attachments");
  const attackTrailWorkspaceRoot = path.join(workspaceDir, "attack_trails");
  for (const binding of normalizeBindings(originals.frameAudioBindings)) {
    unlinkUnreferencedWorkspaceCopy(
      binding.path,
      audioWorkspaceRoot,
      retainedWorkspaceCopyPaths,
      root,
      workspaceDir,
    );
  }
  for (const binding of normalizeBindings(originals.frameImageAttachments)) {
    unlinkUnreferencedWorkspaceCopy(
      binding.path,
      attachmentsWorkspaceRoot,
      retainedWorkspaceCopyPaths,
      root,
      workspaceDir,
    );
  }
  for (const segment of Object.values(originals.attackTrails?.bindings || {}).flat()) {
    unlinkUnreferencedWorkspaceCopy(
      segment?.texture?.path || "",
      attackTrailWorkspaceRoot,
      retainedAttackTrailTexturePaths,
      root,
      workspaceDir,
    );
  }

  return {
    manifest,
    tuning,
    frameAudioBindings: nextAudioBindings,
    frameImageAttachments: nextImageAttachments,
    attackTrails: nextAttackTrails,
    frameCount: nextFrames.length,
    targetDir,
  };
}

module.exports = {
  ANIMATION_TYPES,
  importAnimation,
  mirrorBoxes,
  remapBindings,
  remapAttackTrails,
  remapIndexedDictionary,
  remapReferenceFrame,
  reorganizeAnimation,
  resolveAnimationType,
  resolveImportedAnimationType,
  unlinkUnreferencedInPlaceFrames,
};
