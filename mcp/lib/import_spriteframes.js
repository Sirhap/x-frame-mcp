const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { EMPTY_ATTACK_TRAILS, normalizeAttackTrails } = require("./attack_trails");
const { stripAnimationOwnedData } = require("./animation_mutations");
const {
  EMPTY_MANIFEST,
  EMPTY_TUNING,
  createProjectStore,
  godotProjectName,
  sanitizeFps,
  slug,
} = require("./project_store");
const { syncGodotProject } = require("./godot_sync");
const { upsertEstimatedFrameBoxes } = require("./box_estimator");
const { ensureInitialCharacterScale } = require("./import_scale");
const { resolveXsxbRoot } = require("./xsxb_root");

const ROOT = resolveXsxbRoot(__dirname);
const projectStore = createProjectStore(ROOT);

function usage() {
  console.log(`Usage:
node tools/import_spriteframes.js --project-root <godot_project_root> [--project <id>] [--file <spriteframes.tres>] [--all]
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "all") args.all = true;
    else {
      args[key] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Creates a detached JSON-compatible copy for rollback.
 * @param {unknown} value Source value.
 * @returns {unknown} Cloned value.
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function walk(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".godot" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, result);
    else if (entry.isFile() && entry.name.endsWith(".spriteframes.tres")) result.push(full);
  }
  return result;
}

function shouldInclude(filePath, projectRoot, includeAll) {
  if (includeAll) return true;
  const rel = path.relative(projectRoot, filePath).replaceAll("\\", "/").toLowerCase();
  return /(character|characters|actor|actors|enemy|enemies|player|npc|boss|monster|role)/.test(rel);
}

function resolveGodotPath(rawPath, projectRoot, ownerFile) {
  if (!rawPath) return null;
  const root = path.resolve(projectRoot);
  let resolved;
  if (rawPath.startsWith("res://")) resolved = path.resolve(root, rawPath.slice("res://".length));
  else if (path.isAbsolute(rawPath)) resolved = path.resolve(rawPath);
  else resolved = path.resolve(path.dirname(ownerFile), rawPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

function getPngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return { width: 0, height: 0 };
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function initialAnchorModeForBatch(_animations) {
  // Grounded actors should enter the tuner/game at a stable foot-center origin.
  // Different source canvas sizes are handled per group, not by changing anchor.
  return "canvas_bottom_center";
}

function parseSpriteFrames(filePath, projectRoot) {
  const text = fs.readFileSync(filePath, "utf8");
  const resources = new Map();
  const extRegex = /\[ext_resource[^\]]*path="([^"]+)"[^\]]*id="([^"]+)"[^\]]*\]/g;
  let extMatch;
  while ((extMatch = extRegex.exec(text)) !== null) {
    resources.set(extMatch[2], resolveGodotPath(extMatch[1], projectRoot, filePath));
  }

  const animations = [];
  const animationRegex =
    /\{\s*"frames"\s*:\s*\[([\s\S]*?)\],\s*"loop"\s*:[\s\S]*?"name"\s*:\s*&"([^"]+)"[\s\S]*?"speed"\s*:\s*([-\d.]+)/g;
  let animationMatch;
  while ((animationMatch = animationRegex.exec(text)) !== null) {
    const [, frameBody, name, speed] = animationMatch;
    const frames = [];
    const frameRegex = /\{\s*"duration"\s*:\s*([-\d.]+),\s*"texture"\s*:\s*ExtResource\("([^"]+)"\)\s*\}/g;
    let frameMatch;
    while ((frameMatch = frameRegex.exec(frameBody)) !== null) {
      const source = resources.get(frameMatch[2]);
      if (!source || !fs.existsSync(source) || path.extname(source).toLowerCase() !== ".png") continue;
      frames.push({
        source,
        duration: Number(frameMatch[1] || 1),
      });
    }
    if (frames.length) {
      animations.push({ id: slug(name), name, fps: sanitizeFps(speed), frames });
    }
  }
  return animations;
}

function ensureProfile(manifest, profileId, label) {
  manifest.profiles = Array.isArray(manifest.profiles) ? manifest.profiles : [];
  let profile = manifest.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    profile = {
      id: profileId,
      label,
      kind: "actor",
      bodyScale: 1,
      runtimeScale: 1,
      animations: [],
    };
    manifest.profiles.push(profile);
  }
  profile.animations = Array.isArray(profile.animations) ? profile.animations : [];
  return profile;
}

function projectForImport(args, projectRoot) {
  let registry = projectStore.readRegistry();
  const label = args.project || godotProjectName(projectRoot) || path.basename(projectRoot);
  const requestedId = slug(label);
  const explicitProject = Boolean(args.project);
  let project = registry.projects.find((entry) => entry.id === requestedId);
  if (!project) {
    registry = projectStore.addProject({ id: requestedId, label, projectRoot });
    project = registry.projects.find((entry) => entry.id === registry.activeProjectId);
  } else if (project.projectRoot && !samePath(project.projectRoot, projectRoot)) {
    if (explicitProject) {
      throw new Error(
        `Project id "${project.id}" is already bound to ${project.projectRoot}. Use a different --project id for ${projectRoot}.`,
      );
    } else {
      registry = projectStore.addProject({ label, projectRoot });
    }
    project = registry.projects.find((entry) => entry.id === registry.activeProjectId);
  } else if (project.projectRoot !== projectRoot) {
    project.projectRoot = projectRoot;
    registry.activeProjectId = project.id;
    registry = projectStore.writeRegistry(registry);
    project = registry.projects.find((entry) => entry.id === registry.activeProjectId);
  }
  if (!project) throw new Error(`Project not found: ${requestedId}`);
  return project;
}

function importSpriteFrames(filePath, projectRoot, project, manifest, tuning, transaction) {
  const relFile = path.relative(projectRoot, filePath).replaceAll("\\", "/");
  const profileId = slug(relFile.replace(/\.spriteframes\.tres$/i, ""));
  const profileLabel = path.basename(filePath, ".spriteframes.tres");
  const profile = ensureProfile(manifest, profileId, profileLabel);
  const animations = parseSpriteFrames(filePath, projectRoot);
  const batchAnchorMode = initialAnchorModeForBatch(animations);
  const paths = projectStore.projectPaths(project);
  const workspaceAssets = path.join(paths.workspaceDir, "assets");
  let importedFrames = 0;
  const scaleSamples = [];

  for (const animation of animations) {
    const targetDir = path.join(workspaceAssets, profileId, animation.id);
    if (transaction.targets.has(targetDir)) {
      throw new Error(`Duplicate SpriteFrames animation target: ${profileId}/${animation.id}`);
    }
    transaction.targets.add(targetDir);
    const stagingDir = `${targetDir}.import-${transaction.operationId}`;
    const backupDir = `${targetDir}.backup-${transaction.operationId}`;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    transaction.installs.push({ targetDir, stagingDir, backupDir });
    const frameFiles = [];
    const frames = animation.frames.map((frame, index) => {
      const targetName = `frame_${String(index + 1).padStart(4, "0")}.png`;
      const stagingPath = path.join(stagingDir, targetName);
      const finalPath = path.join(targetDir, targetName);
      fs.copyFileSync(frame.source, stagingPath);
      frameFiles.push(stagingPath);
      scaleSamples.push({ filePath: stagingPath, animationId: animation.id, animationName: animation.name });
      importedFrames += 1;
      const size = getPngSize(stagingPath);
      if (size.width < 1 || size.height < 1) throw new Error(`Invalid PNG frame: ${frame.source}`);
      return {
        id: `frame_${String(index + 1).padStart(4, "0")}`,
        name: targetName,
        path: path.relative(ROOT, finalPath).replaceAll("\\", "/"),
        duration: frame.duration,
        ...size,
      };
    });
    const nextAnimation = {
      id: animation.id,
      name: animation.name,
      type: "actor",
      anchorMode: batchAnchorMode,
      fps: animation.fps,
      source: path.relative(ROOT, targetDir).replaceAll("\\", "/"),
      frames,
    };
    const existingIndex = profile.animations.findIndex((entry) => entry.id === animation.id);
    if (existingIndex >= 0) {
      const stripped = stripAnimationOwnedData({
        tuning,
        audioBindings: transaction.frameAudio,
        imageAttachments: transaction.frameImageAttachments,
        attachmentAssets: transaction.attachmentAssets,
        attackTrails: transaction.attackTrails,
        profile,
        animation: profile.animations[existingIndex],
      });
      tuning.frame_visual_overrides = stripped.tuning.frame_visual_overrides;
      tuning.frame_playback_overrides = stripped.tuning.frame_playback_overrides;
      tuning.frame_box_overrides = stripped.tuning.frame_box_overrides;
      tuning.values = stripped.tuning.values;
      transaction.frameAudio = stripped.frameAudioBindings;
      transaction.frameImageAttachments = stripped.frameImageAttachments;
      transaction.attachmentAssets = stripped.attachmentAssets;
      transaction.attackTrails = stripped.attackTrails;
      profile.animations[existingIndex] = nextAnimation;
    } else profile.animations.push(nextAnimation);
    upsertEstimatedFrameBoxes(tuning, profileId, nextAnimation, frameFiles, { replace: true });
  }

  const scaleResult = ensureInitialCharacterScale(tuning, profileId, project.projectRoot, scaleSamples);
  return { profileId, animations: animations.length, frames: importedFrames, scaleResult };
}

/**
 * Atomically installs every staged animation directory and metadata file.
 * @param {object} transaction Staged directory transaction.
 * @param {object} paths Project metadata paths.
 * @param {object} manifest Updated manifest.
 * @param {object} tuning Updated tuning.
 * @param {object} originals Original metadata for rollback.
 * @returns {void}
 */
function commitImportTransaction(transaction, paths, manifest, tuning, originals) {
  const installed = [];
  try {
    for (const entry of transaction.installs) {
      const installedEntry = { ...entry, backupCreated: false, directoryInstalled: false };
      installed.push(installedEntry);
      if (fs.existsSync(entry.targetDir)) {
        fs.renameSync(entry.targetDir, entry.backupDir);
        installedEntry.backupCreated = true;
      }
      fs.renameSync(entry.stagingDir, entry.targetDir);
      installedEntry.directoryInstalled = true;
    }
    projectStore.writeJson(paths.manifest, manifest);
    projectStore.writeJson(paths.tuning, tuning);
    if (originals.frameAudio !== undefined) projectStore.writeJson(paths.frameAudio, transaction.frameAudio);
    if (originals.frameImageAttachments !== undefined)
      projectStore.writeJson(paths.frameImageAttachments, transaction.frameImageAttachments);
    if (originals.attachmentAssets !== undefined)
      projectStore.writeJson(paths.attachmentAssets, transaction.attachmentAssets);
    if (originals.attackTrails !== undefined)
      projectStore.writeJson(paths.attackTrails, transaction.attackTrails);
  } catch (error) {
    for (const entry of installed.reverse()) {
      if (entry.directoryInstalled && fs.existsSync(entry.targetDir)) {
        fs.rmSync(entry.targetDir, { recursive: true, force: true });
      }
      if (entry.backupCreated && fs.existsSync(entry.backupDir))
        fs.renameSync(entry.backupDir, entry.targetDir);
    }
    for (const entry of transaction.installs) {
      if (fs.existsSync(entry.stagingDir)) fs.rmSync(entry.stagingDir, { recursive: true, force: true });
    }
    projectStore.writeJson(paths.manifest, originals.manifest);
    projectStore.writeJson(paths.tuning, originals.tuning);
    if (originals.frameAudio !== undefined) projectStore.writeJson(paths.frameAudio, originals.frameAudio);
    if (originals.frameImageAttachments !== undefined)
      projectStore.writeJson(paths.frameImageAttachments, originals.frameImageAttachments);
    if (originals.attachmentAssets !== undefined)
      projectStore.writeJson(paths.attachmentAssets, originals.attachmentAssets);
    if (originals.attackTrails !== undefined)
      projectStore.writeJson(paths.attackTrails, originals.attackTrails);
    throw error;
  }
  for (const entry of installed) {
    if (!entry.backupCreated) continue;
    try {
      fs.rmSync(entry.backupDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove import backup ${entry.backupDir}: ${error.message}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["project-root"]) {
    usage();
    process.exit(1);
  }
  const projectRoot = path.resolve(args["project-root"]);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root not found: ${projectRoot}`);
  }
  const files = args.file
    ? [path.resolve(args.file)]
    : walk(projectRoot)
        .filter((filePath) => shouldInclude(filePath, projectRoot, args.all))
        .sort(naturalSort);
  if (!files.length) throw new Error("No SpriteFrames files found.");

  const project = projectForImport(args, projectRoot);
  const paths = projectStore.projectPaths(project);
  const manifest = projectStore.readJson(paths.manifest, EMPTY_MANIFEST);
  const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
  const audioBindings = projectStore.readJson(paths.frameAudio, []);
  const imageAttachments = projectStore.readJson(paths.frameImageAttachments, []);
  const attachmentAssets = projectStore.readJson(paths.attachmentAssets, []);
  const attackTrails = normalizeAttackTrails(projectStore.readJson(paths.attackTrails, EMPTY_ATTACK_TRAILS));
  const originals = {
    manifest: clone(manifest),
    tuning: clone(tuning),
    frameAudio: clone(audioBindings),
    frameImageAttachments: clone(imageAttachments),
    attachmentAssets: clone(attachmentAssets),
    attackTrails: clone(attackTrails),
  };
  const transaction = {
    operationId: crypto.randomBytes(8).toString("hex"),
    installs: [],
    targets: new Set(),
    frameAudio: audioBindings,
    frameImageAttachments: imageAttachments,
    attachmentAssets,
    attackTrails,
  };
  let results;
  try {
    results = files.map((filePath) =>
      importSpriteFrames(filePath, projectRoot, project, manifest, tuning, transaction),
    );
    commitImportTransaction(transaction, paths, manifest, tuning, originals);
  } catch (error) {
    for (const entry of transaction.installs) {
      if (fs.existsSync(entry.stagingDir)) fs.rmSync(entry.stagingDir, { recursive: true, force: true });
    }
    throw error;
  }
  const godotSync = syncGodotProject(ROOT, projectStore, project, { manifest, tuning });

  const frameCount = results.reduce((sum, result) => sum + result.frames, 0);
  console.log(`Imported ${frameCount} frames from ${results.length} SpriteFrames files`);
  console.log(`Project: ${project.id}`);
  for (const result of results) {
    console.log(`${result.profileId}: ${result.animations} animations, ${result.frames} frames`);
    if (result.scaleResult?.changed) {
      console.log(`${result.profileId}: initial scale ${result.scaleResult.scale}`);
    }
  }
  if (godotSync.ok) {
    console.log(
      `Godot assets: ${godotSync.copiedFrames}/${godotSync.frameCount} frames synced to ${godotSync.assetRoot}`,
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseSpriteFrames,
  importSpriteFrames,
  commitImportTransaction,
  resolveGodotPath,
};
