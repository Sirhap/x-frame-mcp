const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EMPTY_MANIFEST, EMPTY_TUNING, reslash, writeJson } = require("./project_store");
const { ensureGodotRuntime } = require("./godot_runtime");
const { EMPTY_ATTACK_TRAILS, clone: cloneAttackTrails, normalizeAttackTrails } = require("./attack_trails");

const GODOT_SYNC_ROOT = "xsxb_frame_tuner";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeResolve(base, requested) {
  const resolvedBase = path.resolve(base);
  const full = path.resolve(resolvedBase, String(requested || ""));
  return full === resolvedBase || full.startsWith(`${resolvedBase}${path.sep}`) ? full : null;
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validGodotProjectRoot(project) {
  const projectRoot = project?.projectRoot ? path.resolve(String(project.projectRoot)) : "";
  if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) return "";
  if (!fs.existsSync(path.join(projectRoot, "project.godot"))) return "";
  return projectRoot;
}

function godotProjectRelPath(...parts) {
  return reslash(path.join(GODOT_SYNC_ROOT, ...parts));
}

function godotDataRelPath(project, fileName) {
  return godotProjectRelPath("data", "projects", project.id, fileName);
}

function godotDataDir(projectRoot, project) {
  return path.join(projectRoot, GODOT_SYNC_ROOT, "data", "projects", project.id);
}

function copyFileIfChanged(source, target, force = false) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!force && fs.existsSync(target)) {
    const sourceStat = fs.statSync(source);
    const targetStat = fs.statSync(target);
    if (sourceStat.size === targetStat.size) {
      const sourceBuffer = fs.readFileSync(source);
      const targetBuffer = fs.readFileSync(target);
      if (sourceBuffer.equals(targetBuffer)) return false;
    }
  }
  fs.copyFileSync(source, target);
  return true;
}

/**
 * Drops Godot's imported .ctex when the PNG changed or the cached source_md5 is stale.
 * Sync writes pixels; Godot will not reload them until this cache is gone.
 * @param {string} projectRoot Bound Godot root with project.godot.
 * @param {string} pngPath Absolute PNG path inside the Godot project.
 * @returns {number} Deleted cache files.
 */
function invalidateGodotImport(projectRoot, pngPath) {
  const importPath = `${pngPath}.import`;
  if (!fs.existsSync(importPath) || !projectRoot) return 0;
  const importRoot = path.join(projectRoot, ".godot", "imported");
  const text = fs.readFileSync(importPath, "utf8");
  const dests = new Set();
  for (const match of text.matchAll(/res:\/\/(\.godot\/imported\/[^\s"\]]+)/g)) {
    dests.add(match[1].replace(/\.md5$/i, ".ctex"));
  }
  if (!dests.size) return 0;
  const sourceMd5 = crypto.createHash("md5").update(fs.readFileSync(pngPath)).digest("hex");
  let deleted = 0;
  for (const rel of dests) {
    const ctex = path.join(projectRoot, rel);
    if (!isInside(ctex, importRoot)) continue;
    const md5Path = ctex.replace(/\.ctex$/i, ".md5");
    let stale = !fs.existsSync(ctex);
    if (!stale && fs.existsSync(md5Path)) {
      const recorded = /source_md5="([0-9a-f]+)"/i.exec(fs.readFileSync(md5Path, "utf8"));
      stale = !recorded || recorded[1] !== sourceMd5;
    } else if (!stale) {
      stale = true;
    }
    if (!stale) continue;
    for (const filePath of [ctex, md5Path]) {
      if (!fs.existsSync(filePath)) continue;
      fs.rmSync(filePath, { force: true });
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Removes unreferenced files from one generated asset directory and prunes empty folders.
 * @param {string} directory Generated directory to prune.
 * @param {Set<string>} retainedPaths Absolute file paths that must remain available.
 * @returns {void}
 */
function pruneGeneratedDirectory(directory, retainedPaths) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) pruneGeneratedDirectory(fullPath, retainedPaths);
    else if (!retainedPaths.has(path.resolve(fullPath))) fs.rmSync(fullPath, { force: true });
  }
  if (!fs.readdirSync(directory).length) fs.rmSync(directory, { recursive: true, force: true });
}

function fileContentHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sourcePathForFrame(root, projectRoot, framePath) {
  const raw = String(framePath || "");
  if (!raw) return "";
  if (raw.startsWith("res://")) {
    const local = path.join(projectRoot, raw.slice("res://".length));
    if (fs.existsSync(local)) return local;
    return "";
  }
  if (path.isAbsolute(raw)) return fs.existsSync(raw) ? raw : "";
  const fromTuner = safeResolve(root, raw);
  if (fromTuner && fs.existsSync(fromTuner)) return fromTuner;
  const fromProject = path.resolve(projectRoot, raw);
  if (isInside(fromProject, projectRoot) && fs.existsSync(fromProject)) return fromProject;
  return "";
}

function localFrameRelPath(framePath, fallbackName = "frame.png") {
  const raw = reslash(framePath || fallbackName)
    .replace(/^res:\/\//, "")
    .replace(/^\/+/, "");
  const candidate = raw.startsWith(`${GODOT_SYNC_ROOT}/`) ? raw : godotProjectRelPath(raw || fallbackName);
  const normalized = path.posix.normalize(candidate).replace(/^\/+/, "");
  if (normalized.startsWith(`${GODOT_SYNC_ROOT}/`) && !normalized.split("/").includes("..")) {
    return normalized;
  }
  return godotProjectRelPath(path.posix.basename(raw || fallbackName));
}

/**
 * Resolves Godot-manifest frame paths that already live under GODOT_SYNC_ROOT.
 * @param {object|null|undefined} manifest Previously synced animation manifest.
 * @param {string} projectRoot Bound Godot project root.
 * @returns {string[]} Absolute synced frame paths.
 */
function resolveSyncedManifestFramePaths(manifest, projectRoot) {
  const syncRoot = path.join(projectRoot, GODOT_SYNC_ROOT);
  const resolved = [];
  for (const profile of Array.isArray(manifest?.profiles) ? manifest.profiles : []) {
    for (const animation of Array.isArray(profile.animations) ? profile.animations : []) {
      for (const frame of Array.isArray(animation.frames) ? animation.frames : []) {
        const raw = String(frame?.path || "").trim();
        if (!raw) continue;
        const fullPath = path.resolve(projectRoot, raw);
        if (isInside(fullPath, syncRoot)) resolved.push(path.resolve(fullPath));
      }
    }
  }
  return resolved;
}

/**
 * Drops leftover synced frame files and empty clip directories after a shrink or delete.
 * Prunes only parent directories of retained ∪ previous frame paths, never GODOT_SYNC_ROOT itself.
 * @param {string[]} previousPaths Absolute frame paths from the last Godot manifest.
 * @param {Set<string>} retained Absolute frame PNG paths this sync keeps.
 * @param {string} syncRoot Absolute GODOT_SYNC_ROOT directory.
 * @returns {void}
 */
function pruneStaleSyncedFrames(previousPaths, retained, syncRoot) {
  const resolvedSyncRoot = path.resolve(syncRoot);
  for (const previous of previousPaths) {
    const fullPath = path.resolve(previous);
    if (retained.has(fullPath)) continue;
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
    fs.rmSync(fullPath, { force: true });
  }
  const parents = new Set();
  for (const filePath of [...retained, ...previousPaths]) {
    const parent = path.dirname(path.resolve(filePath));
    if (parent === resolvedSyncRoot || !isInside(parent, resolvedSyncRoot)) continue;
    parents.add(parent);
  }
  for (const directory of parents) pruneGeneratedDirectory(directory, retained);
}

function syncManifest(root, projectStore, project, manifestInput = null, options = {}) {
  const projectRoot = validGodotProjectRoot(project);
  if (!projectRoot) return { manifest: manifestInput || EMPTY_MANIFEST, copiedFrames: 0, frameCount: 0 };

  const paths = projectStore.projectPaths(project);
  const manifest = clone(manifestInput || projectStore.readJson(paths.manifest, EMPTY_MANIFEST));
  let copiedFrames = 0;
  let frameCount = 0;
  let invalidatedImports = 0;
  const syncRoot = path.join(projectRoot, GODOT_SYNC_ROOT);
  const targetManifest = path.join(godotDataDir(projectRoot, project), "animation_manifest.json");
  let previousManifest = EMPTY_MANIFEST;
  if (fs.existsSync(targetManifest)) {
    try {
      previousManifest = JSON.parse(fs.readFileSync(targetManifest, "utf8"));
    } catch {
      previousManifest = EMPTY_MANIFEST;
    }
  }
  const previousPaths = resolveSyncedManifestFramePaths(previousManifest, projectRoot);
  const retained = new Set();

  for (const profile of Array.isArray(manifest.profiles) ? manifest.profiles : []) {
    for (const animation of Array.isArray(profile.animations) ? profile.animations : []) {
      const frames = Array.isArray(animation.frames) ? animation.frames : [];
      if (animation.source) animation.source = localFrameRelPath(animation.source, "assets");
      for (const frame of frames) {
        const source = sourcePathForFrame(root, projectRoot, frame.path);
        const nextRel = localFrameRelPath(frame.path, frame.name || "frame.png");
        const target = path.join(projectRoot, nextRel);
        frame.path = nextRel;
        frameCount += 1;
        if (!isInside(target, syncRoot)) continue;
        if (!source || path.extname(source).toLowerCase() !== ".png") continue;
        retained.add(path.resolve(target));
        if (copyFileIfChanged(source, target, options.force === true)) copiedFrames += 1;
        if (fs.existsSync(target)) invalidatedImports += invalidateGodotImport(projectRoot, target);
      }
    }
  }

  pruneStaleSyncedFrames(previousPaths, retained, syncRoot);
  writeJson(targetManifest, manifest);
  return { copiedFrames, frameCount, invalidatedImports };
}

function syncTuning(projectStore, project, tuningInput = null) {
  const projectRoot = validGodotProjectRoot(project);
  if (!projectRoot) return { wroteTuning: false };
  const paths = projectStore.projectPaths(project);
  const tuning = clone(tuningInput || projectStore.readJson(paths.tuning, EMPTY_TUNING));
  const targetTuning = path.join(godotDataDir(projectRoot, project), "animation_tuning.json");
  writeJson(targetTuning, tuning);
  return { wroteTuning: true };
}

function sanitizeSegment(value, fallback = "asset") {
  const text = String(value || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/\.\./g, "_")
    .replace(/^_+|_+$/g, "");
  return text && !/^\.+$/.test(text) ? text : fallback;
}

function audioExtension(binding) {
  const nameExt = path.extname(String(binding?.name || "")).toLowerCase();
  if (nameExt) return nameExt;
  const type = String(binding?.type || "").toLowerCase();
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("wav")) return ".wav";
  if (type.includes("ogg")) return ".ogg";
  if (type.includes("flac")) return ".flac";
  if (type.includes("aac")) return ".aac";
  return ".audio";
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(?:;[\w.-]+=[^;,]+)*(;base64)?,([\s\S]*)$/i.exec(String(dataUrl || ""));
  if (!match) return null;
  let decodedText = "";
  if (!match[2]) {
    try {
      decodedText = decodeURIComponent(match[3] || "");
    } catch (error) {
      throw Object.assign(new Error("Invalid data URL encoding."), { status: 400, cause: error });
    }
  }
  return {
    mime: match[1] || "",
    buffer: match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodedText, "utf8"),
  };
}

function frameAudioKey(binding, index) {
  if (binding?.key) return String(binding.key);
  const metadata = binding?.metadata || {};
  const animation = metadata.animation || binding?.animation || "animation";
  const frame = Number(metadata.frame ?? binding?.frame ?? index);
  return `${animation}:${Number.isFinite(frame) ? frame : index}`;
}

function frameBindingInfo(binding, index) {
  const metadata = binding?.metadata && typeof binding.metadata === "object" ? binding.metadata : {};
  const profileId = String(metadata.profileId || binding?.profileId || "");
  let animation = String(
    metadata.animation || binding?.animation || binding?.animation_id || binding?.action || "",
  );
  if (animation && profileId && !animation.includes("/")) animation = `${profileId}/${animation}`;
  const frame = Number(
    metadata.frame ?? binding?.frame ?? binding?.frame_index ?? binding?.frameNumber ?? index,
  );
  return {
    animation,
    frame: Number.isFinite(frame) ? frame : index,
  };
}

function stableFrameBindingKey(binding, index) {
  const info = frameBindingInfo(binding, index);
  return info.animation ? `${info.animation}:${info.frame}` : frameAudioKey(binding, index);
}

function assignStableFrameBindingKey(entry, sourceBinding, index) {
  const stableKey = stableFrameBindingKey(sourceBinding, index);
  const sourceKey = String(entry.key || sourceBinding?.key || "");
  if (sourceKey && sourceKey !== stableKey && !entry.sourceKey) entry.sourceKey = sourceKey;
  entry.key = stableKey;
  if (entry.frameKey !== undefined || sourceBinding?.frameKey !== undefined) entry.frameKey = stableKey;
  return entry;
}

function syncFrameAudio(projectStore, project, bindingsInput = null) {
  const projectRoot = validGodotProjectRoot(project);
  if (!projectRoot) return { audioCount: 0, copiedAudio: 0 };
  const paths = projectStore.projectPaths(project);
  const raw = bindingsInput ?? projectStore.readJson(paths.frameAudio, []);
  const bindings = Array.isArray(raw)
    ? raw
    : Object.entries(raw || {}).map(([key, value]) => ({
        key,
        ...(value && typeof value === "object" ? value : {}),
      }));
  const localBindings = [];
  let copiedAudio = 0;
  const audioRoot = path.join(projectRoot, GODOT_SYNC_ROOT, "audio", "projects", project.id);
  const retainedAudio = new Set();

  bindings.forEach((binding, index) => {
    if (!binding || typeof binding !== "object") return;
    const next = { ...binding };
    delete next.data;
    const data = decodeDataUrl(binding.data);
    if (data?.buffer?.length) {
      const key = sanitizeSegment(frameAudioKey(binding, index), `audio_${index + 1}`);
      const ext = audioExtension(binding);
      const hash = crypto.createHash("sha256").update(data.buffer).digest("hex").slice(0, 12);
      const idPart = sanitizeSegment(binding.id || binding.name || `sfx_${index + 1}`, `sfx_${index + 1}`);
      const audioRel = godotProjectRelPath("audio", "projects", project.id, `${key}_${idPart}_${hash}${ext}`);
      const target = path.join(projectRoot, audioRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data.buffer);
      copiedAudio += 1;
      next.path = `res://${audioRel}`;
      next.type = next.type || data.mime;
      retainedAudio.add(path.resolve(target));
    } else if (binding.path) {
      next.path = String(binding.path);
    } else if (binding.file) {
      next.path = String(binding.file);
    }
    if (next.path) {
      const existing = sourcePathForFrame("", projectRoot, next.path);
      if (existing && isInside(existing, audioRoot)) retainedAudio.add(path.resolve(existing));
      localBindings.push(assignStableFrameBindingKey(next, binding, index));
    }
  });

  pruneGeneratedDirectory(audioRoot, retainedAudio);
  const targetAudio = path.join(godotDataDir(projectRoot, project), "frame_audio_bindings.json");
  writeJson(targetAudio, localBindings);
  return { audioCount: localBindings.length, copiedAudio };
}

function syncFrameImageAttachments(root, projectStore, project, attachmentsInput = null) {
  const projectRoot = validGodotProjectRoot(project);
  if (!projectRoot) return { imageAttachmentCount: 0, copiedImageAttachments: 0 };
  const paths = projectStore.projectPaths(project);
  const raw = attachmentsInput ?? projectStore.readJson(paths.frameImageAttachments, []);
  const attachments = Array.isArray(raw) ? raw.filter((entry) => entry && typeof entry === "object") : [];
  const localAttachments = [];
  let copiedImageAttachments = 0;
  const attachmentRoot = path.join(projectRoot, GODOT_SYNC_ROOT, "attachments", "projects", project.id);
  const retainedAttachments = new Set();

  attachments.forEach((attachment, index) => {
    const next = clone(attachment);
    const source = sourcePathForFrame(root, projectRoot, next.path);
    if (!source) return;
    const ext = path.extname(source) || path.extname(String(next.name || "")) || ".png";
    const hash = String(next.assetHash || fileContentHash(source));
    const nextRel = godotProjectRelPath("attachments", "projects", project.id, `${hash}${ext.toLowerCase()}`);
    const target = path.join(projectRoot, nextRel);
    if (copyFileIfChanged(source, target)) copiedImageAttachments += 1;
    retainedAttachments.add(path.resolve(target));
    next.path = `res://${nextRel}`;
    next.assetHash = hash;
    assignStableFrameBindingKey(next, attachment, index);
    localAttachments.push(next);
  });

  pruneGeneratedDirectory(attachmentRoot, retainedAttachments);
  const targetFile = path.join(godotDataDir(projectRoot, project), "frame_image_attachments.json");
  writeJson(targetFile, localAttachments);
  return { imageAttachmentCount: localAttachments.length, copiedImageAttachments };
}

function syncAttackTrails(root, projectStore, project, trailsInput = null) {
  const projectRoot = validGodotProjectRoot(project);
  if (!projectRoot) return { attackTrailCount: 0, copiedAttackTrailTextures: 0 };
  const paths = projectStore.projectPaths(project);
  const raw = trailsInput ?? projectStore.readJson(paths.attackTrails, EMPTY_ATTACK_TRAILS);
  const local = normalizeAttackTrails(cloneAttackTrails(raw));
  const projectTextureRoot = path.join(projectRoot, GODOT_SYNC_ROOT, "attack_trails", "projects", project.id);
  const retainedProjectTextures = new Set();
  let attackTrailCount = 0;
  let copiedAttackTrailTextures = 0;
  const presetSource = sourcePathForFrame(root, projectRoot, local.presetTexture?.path);
  if (presetSource && path.extname(presetSource).toLowerCase() === ".png") {
    const presetHash = String(local.presetTexture.assetHash || fileContentHash(presetSource));
    const presetRel = godotProjectRelPath("attack_trails", "presets", `${presetHash}.png`);
    const presetTarget = path.join(projectRoot, presetRel);
    if (copyFileIfChanged(presetSource, presetTarget)) copiedAttackTrailTextures += 1;
    local.presetTexture.path = `res://${presetRel}`;
    local.presetTexture.assetHash = presetHash;
  }
  for (const [bindingKey, segments] of Object.entries(local.bindings)) {
    for (const segment of segments) {
      attackTrailCount += 1;
      const source = sourcePathForFrame(root, projectRoot, segment.texture?.path);
      if (!source || path.extname(source).toLowerCase() !== ".png") continue;
      const hash = String(segment.texture.assetHash || fileContentHash(source));
      const [profileId = "profile", animationId = "animation"] = bindingKey.split("/");
      const nextRel = godotProjectRelPath(
        "attack_trails",
        "projects",
        project.id,
        sanitizeSegment(profileId, "profile"),
        sanitizeSegment(animationId, "animation"),
        `${hash}.png`,
      );
      const target = path.join(projectRoot, nextRel);
      retainedProjectTextures.add(path.resolve(target));
      if (copyFileIfChanged(source, target)) copiedAttackTrailTextures += 1;
      segment.texture.path = `res://${nextRel}`;
      segment.texture.assetHash = hash;
    }
  }
  pruneGeneratedDirectory(projectTextureRoot, retainedProjectTextures);
  const targetFile = path.join(godotDataDir(projectRoot, project), "attack_trails.json");
  writeJson(targetFile, local);
  return { attackTrailCount, copiedAttackTrailTextures };
}

function syncGodotProject(root, projectStore, project, options = {}) {
  const projectRoot = validGodotProjectRoot(project);
  if (!projectRoot) {
    return {
      ok: false,
      reason: "No bound Godot project root",
      copiedFrames: 0,
      frameCount: 0,
      invalidatedImports: 0,
      audioCount: 0,
      copiedAudio: 0,
      imageAttachmentCount: 0,
      copiedImageAttachments: 0,
    };
  }
  const paths = projectStore.projectPaths(project);
  const manifestInput = options.manifest || projectStore.readJson(paths.manifest, EMPTY_MANIFEST);
  const copyOptions = { force: options.force === true };
  const manifestResult = syncManifest(root, projectStore, project, manifestInput, copyOptions);
  const tuningResult = syncTuning(projectStore, project, options.tuning);
  const audioResult = syncFrameAudio(projectStore, project, options.frameAudioBindings);
  const imageAttachmentResult = syncFrameImageAttachments(
    root,
    projectStore,
    project,
    options.frameImageAttachments,
  );
  const attackTrailResult = syncAttackTrails(root, projectStore, project, options.attackTrails);
  const runtimeResult = ensureGodotRuntime(root, project, { manifest: manifestInput });
  return {
    ok: true,
    projectRoot,
    dataDir: reslash(path.join(projectRoot, GODOT_SYNC_ROOT, "data", "projects", project.id)),
    assetRoot: reslash(path.join(projectRoot, GODOT_SYNC_ROOT)),
    ...manifestResult,
    ...tuningResult,
    ...audioResult,
    ...imageAttachmentResult,
    ...attackTrailResult,
    ...runtimeResult,
  };
}

module.exports = {
  GODOT_SYNC_ROOT,
  fileContentHash,
  godotDataRelPath,
  localFrameRelPath,
  sourcePathForFrame,
  syncFrameAudio,
  syncFrameImageAttachments,
  syncAttackTrails,
  syncGodotProject,
  syncManifest,
  syncTuning,
  invalidateGodotImport,
  validGodotProjectRoot,
};
