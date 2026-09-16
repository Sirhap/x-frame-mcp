"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_ATTACK_TRAIL_PRESET_TEXTURE,
  EMPTY_ATTACK_TRAILS,
  bladeEdgeTravel,
  normalizeAttackTrails,
  pngInfo,
  stickCenterTravel,
  validateAttackTrails,
} = require("./lib/attack_trails");
const { deleteAnimation } = require("./lib/animation_mutations");
const { estimateFrameBoxes, frameBoxKey, upsertEstimatedFrameBoxes } = require("./lib/box_estimator");
const {
  importAnimation,
  reorganizeAnimation,
  resolveImportedAnimationType,
} = require("./lib/frame_organizer");
const { withFileTransaction } = require("./lib/file_transaction");
const { createAuthoringTools } = require("./authoring");
const { shouldCommit } = require("./xsxb_mcp_commit");
const { frameIndexes } = require("./authoring/common");
const { syncGodotProject, validGodotProjectRoot } = require("./lib/godot_sync");
const { parseSpriteFrames } = require("./lib/import_spriteframes");
const { createProjectStore, EMPTY_TUNING, reslash, slug } = require("./lib/project_store");
const { gameLocalAuthoringStale, validateImport } = require("./lib/validate_import");
const {
  ALPHA_VISIBLE,
  collectWorkbenchExtras,
  compressPngFile,
  cutoutFrameFiles,
  cutoutPngFile,
  cutoutVerifyStatus,
  decodePngRgba,
  encodePngRgba,
  placeFramesOnCanvas,
  subjectAnchor,
} = require("./xsxb_mcp_cutout");
const {
  findDuplicatesInPngFiles,
  findLoopInPngFiles,
  resolveExternalLoopFrames,
  analyzePngFiles,
  chooseAnalyzeWindow,
} = require("./xsxb_mcp_loop");
const {
  describeGroupGrid,
  estimateVisualScales,
  findMotionWindow,
  measureFrame,
  measureFrameFiles,
  measureLongAxis,
  parseGripT,
  renderContactSheet,
  summarizeMetrics,
  canvasAnchor,
} = require("./xsxb_mcp_visual_qa");
const {
  assertOverlayId,
  overlayGridImage,
  placeImageOnTarget,
  measureAlphaBottom,
} = require("./xsxb_mcp_place");
const { compileSmearBrief } = require("./xsxb_mcp_smear_brief");
const { compilePlaceBrief } = require("./xsxb_mcp_place_brief");
const { detectRegions } = require("./xsxb_mcp_detect_regions");
const { createFlorenceDetector } = require("./xsxb_mcp_florence");
const { resolvePerceptionRegion } = require("./xsxb_mcp_region_store");
const {
  assertObservation,
  canonicalValue,
  containsCellToken,
  createObservation,
  observeFile,
  sha256,
} = require("./xsxb_mcp_observation");
const { gateReceipt, successReceipt } = require("./xsxb_mcp_receipt");
const { composeFrameDiff } = require("./xsxb_mcp_diff_frames");
const {
  assembleGodotValidation,
  classifyInspectQa,
  clipHasMeasurableSubject,
  composeValidationEvidence,
  describeGodotHandoff,
  evaluateScaleContract,
  isFxOrAirborne,
  measureKeyedSubject,
  pickValidationEvidenceFrameIndex,
} = require("./xsxb_mcp_validate_godot");
const {
  borderFloodKey,
  composeRbOverlay,
  flattenFrameBackground,
  geometryDeltas,
  measureSpriteGeometry,
  metricHeight,
  planRegisterClip,
  resolvePreviewBackground,
  scaleAboutFeet,
} = require("./xsxb_mcp_lock");
const { validateToolArguments } = require("./xsxb_mcp_schema");
const { compositeAttackTrails } = require("./xsxb_mcp_trail_preview");
const { assertSweepSticks } = require("./xsxb_mcp_sweep");
const {
  cellIdToken,
  normalizeTrailPathKind,
  parseWritePoint,
  planPlantFeet,
  shiftPlantedRgba,
  trailUsesHermiteMesh,
} = require("./xsxb_mcp_plant");
const { DEFAULT_PROFILE_ID, MCP_TOOL_NAMES, toolDefinitions } = require("./xsxb_mcp_tool_catalog");
const { clearNumberedPngs, sliceSheet } = require("./xsxb_mcp_slice");
const {
  PNG_NAME,
  audioMimeType,
  booleanFlag,
  classifyValidationMessage,
  isInsideDirectory,
  mcpArtifactDir,
  resolveMcpArtifactPath,
  listPngSequence,
  mergeBox,
  pngFileToItem,
  requireExistingFile,
  requireFps,
  resolveExportFps,
  exportFrameDurationSeconds,
  requireFrameIndex,
  resolveImportSource,
  sliceExtractedFrames,
} = require("./xsxb_mcp_arguments");
const {
  createTestWav,
  encodeGifWithFfmpeg,
  extractVideoFrames,
  probeVideoTiming,
  resolveSourceDurationSec,
  suggestGameFps,
  suggestImportFps,
} = require("./xsxb_mcp_processes");

const BOX_NAMES = Object.freeze(["hurtbox", "collisionbox", "hitbox"]);

/**
 * Resolves group/frame visual_size for baking or GIF rematch.
 * Character visual_size is Godot playback scale and is not included.
 * @param {object} tuning Project tuning file.
 * @param {string} profileId Profile id.
 * @param {string} animationId Animation id.
 * @param {number} frameCount Frame count.
 * @returns {number[]} Per-frame scales.
 */
function bakedVisualScales(tuning, profileId, animationId, frameCount) {
  const values = tuning?.values && typeof tuning.values === "object" ? tuning.values : {};
  const group = Number(values[`profiles.${profileId}.groups.${animationId}.visual_size`]);
  const groupScale = Number.isFinite(group) && group > 0 ? group : 1;
  const overrides =
    tuning?.frame_visual_overrides && typeof tuning.frame_visual_overrides === "object"
      ? tuning.frame_visual_overrides
      : {};
  const scales = [];
  for (let index = 0; index < frameCount; index += 1) {
    const key = frameBoxKey(profileId, animationId, index);
    const override = overrides[key] && typeof overrides[key] === "object" ? overrides[key] : {};
    const frameScale = Number(override.visual_size);
    scales.push(Number.isFinite(frameScale) && frameScale > 0 ? frameScale : groupScale);
  }
  return scales;
}

/**
 * Per-frame playback durations in seconds. Disabled frames contribute 0, matching Tuner arrival.
 * @param {object} tuning Project tuning file.
 * @param {string} profileId Profile id.
 * @param {string} animationId Animation id.
 * @param {object[]|number} framesOrCount Animation frames or a count.
 * @param {number} fps Playback fps.
 * @returns {number[]} Seconds per absolute frame.
 */
function playbackDurations(tuning, profileId, animationId, framesOrCount, fps) {
  const frames = Array.isArray(framesOrCount) ? framesOrCount : [];
  const frameCount = frames.length || Number(framesOrCount) || 0;
  const overrides =
    tuning?.frame_playback_overrides && typeof tuning.frame_playback_overrides === "object"
      ? tuning.frame_playback_overrides
      : {};
  const durations = [];
  for (let index = 0; index < frameCount; index += 1) {
    const key = frameBoxKey(profileId, animationId, index);
    const override = overrides[key] && typeof overrides[key] === "object" ? overrides[key] : {};
    if (override.disabled === true) {
      durations.push(0);
      continue;
    }
    durations.push(exportFrameDurationSeconds(frames[index], override, fps));
  }
  return durations;
}

/**
 * Picks overlay grid arguments shared by export_sheet and cutout inspectFeet.
 * @param {object} args Tool arguments.
 * @returns {object} Renderer options.
 */
function overlayGridOptions(args = {}) {
  return {
    grid_density: args.grid_density,
    grid_divs: args.grid_divs,
    grid_x: args.grid_x,
    grid_y: args.grid_y,
    grid_scope: args.grid_scope,
  };
}

/**
 * Pads one RGBA frame onto a larger canvas without resampling.
 * Placement matches `xsxb_resize_canvas` mode=pad (`preserve_origin` default):
 * destination minus source `canvasAnchor`, integer origin only.
 * @param {{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} image Source frame.
 * @param {number} width Destination width.
 * @param {number} height Destination height.
 * @param {string} [anchorMode] Animation anchor.
 * @returns {{data:Uint8ClampedArray,width:number,height:number}} Padded frame.
 */
function padFramePreserveOrigin(image, width, height, anchorMode) {
  const destWidth = Math.trunc(Number(width) || 0);
  const destHeight = Math.trunc(Number(height) || 0);
  if (destWidth < 1 || destHeight < 1) {
    throw new Error("Canvas dimensions must be 1–4096 pixels.");
  }
  if (destWidth === image.width && destHeight === image.height) return image;
  const srcAnchor = canvasAnchor(image.width, image.height, anchorMode);
  const destAnchor = canvasAnchor(destWidth, destHeight, anchorMode);
  const rawX = destAnchor.x - srcAnchor.x;
  const rawY = destAnchor.y - srcAnchor.y;
  if (!Number.isInteger(rawX) || !Number.isInteger(rawY)) {
    throw new Error(
      "Exact origin preservation requires matching width parity; choose an even/odd width matching source canvases.",
    );
  }
  const dx = Math.round(rawX);
  const dy = Math.round(rawY);
  const data = new Uint8ClampedArray(destWidth * destHeight * 4);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= destWidth || ny >= destHeight) continue;
      const from = (y * image.width + x) * 4;
      data.set(image.data.subarray(from, from + 4), (ny * destWidth + nx) * 4);
    }
  }
  return { data, width: destWidth, height: destHeight };
}

/**
 * Frame size + overlay grid used to resolve write-tool cell ids.
 * @param {object} animation Animation record.
 * @param {object} [frameRecord] Manifest frame.
 * @param {object} [args] Tool arguments.
 * @param {{width?:number,height?:number,data?:Uint8ClampedArray}} [image] Decoded PNG.
 * @returns {object} parseWritePoint options.
 */
function writePointOptions(animation, frameRecord, args = {}, image) {
  const width = Number(image?.width || frameRecord?.width || 0);
  const height = Number(image?.height || frameRecord?.height || 0);
  let subject = null;
  if (String(args.grid_scope || "") === "subject" && image?.data) {
    subject = subjectAnchor(image.data, width, height);
  }
  return {
    width,
    height,
    anchorMode: String(animation?.anchorMode || "canvas_bottom_center"),
    grid: overlayGridOptions(args),
    subject,
  };
}

/**
 * Resolves overlay cell ids on a box min/max patch before mergeBox.
 * @param {object} patch Raw box patch.
 * @param {object} animation Animation record.
 * @param {object} frameRecord Manifest frame.
 * @param {object} args Tool arguments.
 * @param {{width?:number,height?:number,data?:Uint8ClampedArray}} [image] Decoded PNG.
 * @returns {object} Patch with group points.
 */
function resolveBoxPatch(patch, animation, frameRecord, args, image) {
  if (!patch || typeof patch !== "object") return patch;
  const next = { ...patch };
  if (next.min !== undefined) {
    next.min = parseWritePoint(next.min, {
      ...writePointOptions(animation, frameRecord, args, image),
      label: "box min",
    });
  }
  if (next.max !== undefined) {
    next.max = parseWritePoint(next.max, {
      ...writePointOptions(animation, frameRecord, args, image),
      label: "box max",
    });
  }
  return next;
}

/**
 * Creates the business service used by the XSXB MCP transport.
 * @param {{root?:string,extractVideoFramesImpl?:Function,cutoutPngFileImpl?:Function}} [options] Service dependencies.
 * @returns {{tools:object[],call:(name:string,args?:object)=>Promise<object>}} MCP-facing service.
 */
function createXsxbMcpService(options = {}) {
  const root = path.resolve(options.root || process.env.XSXB_ROOT || process.cwd());
  const projectStore = createProjectStore(root);
  const extractVideoFramesImpl = options.extractVideoFramesImpl || extractVideoFrames;
  const encodeGifImpl = options.encodeGifImpl || encodeGifWithFfmpeg;
  const florenceDetectImpl =
    options.florenceDetectImpl === undefined ? createFlorenceDetector({ root }) : options.florenceDetectImpl;
  const compositeTrailImpl = options.compositeTrailImpl || compositeAttackTrails;
  const cutoutPngFileImpl = options.cutoutPngFileImpl || null;
  const context = { projectId: "", profileId: "", animationId: "" };

  /**
   * Selects a project and clears child selections only when the project changes.
   * @param {string} projectId Resolved project id.
   * @returns {void}
   */
  function selectProject(projectId) {
    if (context.projectId === projectId) return;
    context.projectId = projectId;
    context.profileId = "";
    context.animationId = "";
  }

  /**
   * Resolves the active Tuner project's `.xsxb` folder for MCP artifacts.
   * @param {object} [project] Project record when already loaded.
   * @returns {string} Absolute artifact directory.
   */
  function currentArtifactDir(project) {
    const target = project || projectStore.activeProject(context.projectId);
    return mcpArtifactDir(target ? projectStore.projectWorkspaceDir(target) : "", root);
  }

  /**
   * Copies an artifact to an extra destination when copy_to is set.
   * @param {string} source Written file.
   * @param {unknown} requested Extra destination.
   * @returns {string|undefined} Absolute copy path.
   */
  function copyIfRequested(source, requested) {
    if (!requested) return undefined;
    const target = path.resolve(String(requested));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return target;
  }

  /**
   * Copies an artifact to an extra destination when copy_to is set.
   * @param {string} source Written file.
   * @param {unknown} requested Extra destination.
   * @returns {string|undefined} Absolute copy path.
   */
  function copyIfRequested(source, requested) {
    if (!requested) return undefined;
    const target = path.resolve(String(requested));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return target;
  }

  /**
   * Composites authored attack-trail meshes and frame image attachments onto export frames.
   * @param {object} selection Project/profile/animation.
   * @param {string[]} framePaths Source PNG paths.
   * @param {number[]} frameIndexes Absolute indexes.
   * @param {number[]} durations Per-absolute-frame seconds.
   * @param {number} fps Playback fps.
   * @returns {Promise<object>} Composite receipt.
   */
  function bakeTrailsOnto(selection, framePaths, frameIndexes, durations, fps) {
    const { project, profile, animation } = selection;
    const paths = projectStore.projectPaths(project);
    const trails = normalizeAttackTrails(projectStore.readJson(paths.attackTrails, EMPTY_ATTACK_TRAILS));
    const attachments = projectStore.readJson(paths.frameImageAttachments, []);
    const animationId = String(animation.id || animation.name);
    const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
    const ownerScales = bakedVisualScales(tuning, profile.id, animationId, (animation.frames || []).length);
    const ownerRotation = Number(
      tuning?.values?.[`profiles.${profile.id}.groups.${animationId}.rotation`] || 0,
    );
    return compositeTrailImpl({
      framePaths,
      frameIndexes,
      durations,
      fps,
      trails,
      attachments: Array.isArray(attachments) ? attachments : [],
      bindingKey: `${profile.id}/${animation.id || animation.name}`,
      root,
      ownerScales,
      flipH: animation.flipH === true,
      ownerRotation,
    });
  }

  /**
   * Copies a local file into the project workspace and returns the repo-relative path.
   * Rewrites the content-addressed dest when it already exists but bytes have drifted.
   * @param {object} project Project record.
   * @param {string} subdir Workspace subdirectory.
   * @param {string} absolutePath Source file.
   * @returns {string} Relative POSIX path.
   */
  function copyIntoWorkspace(project, subdir, absolutePath) {
    const destDir = path.join(projectStore.projectWorkspaceDir(project), subdir);
    fs.mkdirSync(destDir, { recursive: true });
    const buffer = fs.readFileSync(absolutePath);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const extension = path.extname(absolutePath) || "";
    const destPath = path.join(destDir, `${hash}${extension}`);
    if (!fs.existsSync(destPath) || !fs.readFileSync(destPath).equals(buffer)) {
      fs.writeFileSync(destPath, buffer);
    }
    return reslash(path.relative(root, destPath));
  }

  /**
   * Resolves a registry project without changing the in-memory selection.
   * @param {string} [projectId] Requested id, or the current context / active project.
   * @returns {object} Registry project.
   */
  function lookupProject(projectId) {
    const registry = projectStore.readRegistry();
    const requested = String(projectId || context.projectId || "").trim();
    const project = requested
      ? registry.projects.find((entry) => entry.id === slug(requested))
      : projectStore.resolveProject(registry);
    if (!project && requested) throw new Error(`XSXB project not found: ${requested}`);
    if (!project) throw new Error("No XSXB project is available.");
    return project;
  }

  function registryProject(projectId, syncRequested = false) {
    const project = lookupProject(projectId);
    if (syncRequested && !validGodotProjectRoot(project)) {
      const boundPath = project.projectRoot || "(empty)";
      throw new Error(
        `XSXB project ${project.id} Godot binding does not exist: ${boundPath}. Use xsxb_bind_godot to retarget.`,
      );
    }
    selectProject(project.id);
    return project;
  }

  function manifestFor(project) {
    const paths = projectStore.projectPaths(project);
    return projectStore.readJson(paths.manifest, { schemaVersion: 1, profiles: [] });
  }

  /**
   * Reads frame-audio bindings as an array regardless of the stored shape.
   * @param {object} paths Project data paths.
   * @returns {object[]} SFX bindings.
   */
  function readSfxBindings(paths) {
    const raw = projectStore.readJson(paths.frameAudio, []);
    return Array.isArray(raw)
      ? raw
      : Object.entries(raw || {}).map(([key, value]) => ({ key, ...(value || {}) }));
  }

  function animationFor(args = {}) {
    const project = registryProject(args.project_id || args.project, false);
    const manifest = manifestFor(project);
    const profileId = String(args.profile_id || args.profile || context.profileId || "").trim();
    const previousAnimation = profileId === context.profileId ? context.animationId : "";
    const animationId = String(args.animation_id || args.animation || previousAnimation || "").trim();
    const profiles = Array.isArray(manifest.profiles) ? manifest.profiles : [];
    const profile = profileId ? profiles.find((entry) => entry.id === profileId) : profiles[0];
    if (!profile) throw new Error(`Animation profile not found: ${profileId || "(default)"}`);
    const animations = Array.isArray(profile.animations) ? profile.animations : [];
    const animation = animationId
      ? animations.find((entry) => String(entry.id || entry.name) === animationId)
      : animations[0];
    if (!animation) throw new Error(`Animation not found: ${profile.id}/${animationId || "(default)"}`);
    selectProject(project.id);
    context.profileId = profile.id;
    context.animationId = String(animation.id || animation.name);
    return { project, manifest, profile, animation };
  }

  /**
   * Resolves the import profile: explicit args, then last context profile, else mcp_imports.
   * @param {object} [args] Tool arguments.
   * @returns {string} Slug profile id.
   */
  function resolveImportProfileId(args = {}) {
    return slug(
      args.profile_id || args.profile || context.profileId || DEFAULT_PROFILE_ID,
      DEFAULT_PROFILE_ID,
    );
  }

  /**
   * Resolves a manifest frame path only when it stays inside the project workspace
   * or the bound Godot root. When the animation was imported with in_place, also
   * allows the XSXB root and absolute game-pack PNG paths.
   * @param {object} project Project record.
   * @param {unknown} rawPath Stored frame path.
   * @param {object} [animation] Manifest animation (reads inPlace).
   * @returns {string} Absolute path, or empty when the path is missing or unsafe.
   */
  function resolveAnimationFramePath(project, rawPath, animation) {
    const raw = String(rawPath || "").trim();
    if (!raw) return "";
    if (raw.startsWith("res://")) {
      const projectRoot = String(project.projectRoot || "").trim();
      if (!projectRoot) return "";
      const resolved = path.resolve(projectRoot, raw.slice("res://".length));
      return isInsideDirectory(resolved, projectRoot) ? resolved : "";
    }
    const resolved = path.resolve(root, raw);
    const workspaceDir = projectStore.projectWorkspaceDir(project);
    if (isInsideDirectory(resolved, workspaceDir)) return resolved;
    const projectRoot = String(project.projectRoot || "").trim();
    if (projectRoot && isInsideDirectory(resolved, projectRoot)) return resolved;
    if (animation && animation.inPlace) {
      if (isInsideDirectory(resolved, root)) return resolved;
      if (path.isAbsolute(raw) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    }
    return "";
  }

  /**
   * Allows writes to workspace copies, or to original files of an in_place import.
   * @param {object} project Project record.
   * @param {object} animation Manifest animation.
   * @param {string} absolute Resolved frame path.
   * @param {string} label Error label.
   * @returns {void}
   */
  function assertWritableAnimationFrame(project, animation, absolute, label) {
    if (!absolute) {
      throw new Error(label);
    }
    const workspaceDir = projectStore.projectWorkspaceDir(project);
    if (isInsideDirectory(absolute, workspaceDir)) return;
    if (animation && animation.inPlace) return;
    throw new Error(label);
  }

  function animationResult(selection) {
    const { project, profile, animation } = selection;
    const frames = Array.from(animation.frames || []).map((frame, index) => {
      const rawPath = String(frame.path || "");
      const absolutePath = resolveAnimationFramePath(project, rawPath, animation);
      return {
        index,
        ...frame,
        absolutePath,
        exists: Boolean(absolutePath && fs.existsSync(absolutePath)),
      };
    });
    return {
      project: projectStore.projectForClient(project),
      profile: { ...profile, animations: undefined },
      animation: { ...animation, frames },
      frameCount: frames.length,
      generatedFrameCount: frames.filter((frame) => frame.exists).length,
      allFramesGenerated: frames.length > 0 && frames.every((frame) => frame.exists),
    };
  }

  /**
   * Synchronizes after a local commit without discarding the committed result.
   * Failed synchronization can be retried without repeating the local mutation.
   * @param {object} project Resolved project.
   * @param {boolean} enabled Whether synchronization was requested.
   * @param {object} options Godot synchronization options.
   * @returns {object} Sync result, including a structured failure when necessary.
   */
  function synchronize(project, enabled, options = {}) {
    if (enabled === false) return { requested: false, ok: null };
    try {
      const result = syncGodotProject(root, projectStore, project, options);
      if (result.ok) return { requested: true, ...result };
      return {
        requested: true,
        ...result,
        projectId: project.id,
        error: { code: "GODOT_SYNC_FAILED", message: result.reason || "Godot synchronization failed." },
      };
    } catch (error) {
      return {
        requested: true,
        ok: false,
        projectId: project.id,
        error: { code: "GODOT_SYNC_FAILED", message: error.message || String(error) },
      };
    }
  }

  async function createProject(args = {}) {
    const registry = projectStore.readRegistry();
    const requestedId = String(args.project_id || args.project || "").trim();
    const existing = requestedId ? registry.projects.find((entry) => entry.id === requestedId) : null;
    const setActive = existing ? booleanFlag(args.set_active, false) : booleanFlag(args.set_active, true);
    if (existing) {
      if (setActive) {
        projectStore.setActiveProject(existing.id);
        selectProject(existing.id);
      }
      return {
        created: false,
        projectId: existing.id,
        project: projectStore.projectForClient(existing),
      };
    }
    const written = projectStore.addProject({
      id: requestedId || undefined,
      label: args.label,
      projectRoot: args.project_root,
    });
    const project = projectStore.activeProject(written.activeProjectId);
    if (!setActive && written.activeProjectId !== registry.activeProjectId && registry.activeProjectId) {
      projectStore.setActiveProject(registry.activeProjectId);
    } else {
      selectProject(project.id);
    }
    return {
      created: true,
      projectId: project.id,
      project: projectStore.projectForClient(project),
    };
  }

  async function listProjects() {
    const registry = projectStore.readRegistry();
    return {
      activeProjectId: registry.activeProjectId,
      count: registry.projects.length,
      projects: registry.projects.map((project) => {
        const manifest = manifestFor(project);
        const profiles = Array.isArray(manifest.profiles) ? manifest.profiles : [];
        const animations = profiles.flatMap((profile) => profile.animations || []);
        return {
          ...projectStore.projectForClient(project),
          active: project.id === registry.activeProjectId,
          godotProjectValid: Boolean(validGodotProjectRoot(project)),
          profileCount: profiles.length,
          animationCount: animations.length,
          frameCount: animations.reduce((sum, animation) => sum + (animation.frames?.length || 0), 0),
        };
      }),
    };
  }

  async function importVideo(args = {}) {
    const videoPath = path.resolve(String(args.file_path || args.path || ""));
    if (!fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
      throw new Error(`Video file not found: ${videoPath}`);
    }
    const syncRequested = booleanFlag(args.sync);
    const project = registryProject(args.project_id || args.project, syncRequested);
    const profileId = resolveImportProfileId(args);
    const manifest = manifestFor(project);
    const profile = (manifest.profiles || []).find((entry) => entry.id === profileId);
    const baseAnimationId = slug(
      args.animation_id || args.animation || path.basename(videoPath, path.extname(videoPath)),
      "video_import",
    );
    const used = new Set((profile?.animations || []).map((entry) => String(entry.id || entry.name)));
    const existingAnimation = (profile?.animations || []).find(
      (entry) => String(entry.id || entry.name) === baseAnimationId,
    );
    const replaced = booleanFlag(args.replace) && used.has(baseAnimationId);
    let animationId = baseAnimationId;
    if (!replaced) {
      let suffix = 2;
      while (used.has(animationId)) {
        animationId = `${baseAnimationId}_${suffix}`;
        suffix += 1;
      }
    }
    if (booleanFlag(args.in_place)) {
      throw new Error(
        "in_place is not supported for video extraction; extracted frames are temporary. Import a PNG sequence instead.",
      );
    }
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-mcp-video-"));
    try {
      const extracted = sliceExtractedFrames(
        await extractVideoFramesImpl(videoPath, temporaryDirectory, args),
        args,
      );
      if (!extracted.paths.length) throw new Error("Video extraction produced no PNG frames.");
      const probe = await probeVideoTiming(videoPath, args);
      const sourceFrameCount = extracted.extractedCount;
      const sourceDurationSec = resolveSourceDurationSec(args, probe);
      const suggestedFps = suggestImportFps({
        sourceFrameCount,
        sourceDurationSec,
        probedFps: probe.probedFps,
      });
      const fpsOmitted = args.fps === undefined || args.fps === null || args.fps === "";
      const fps = fpsOmitted && suggestedFps !== undefined ? requireFps(suggestedFps) : requireFps(args.fps);
      const items = extracted.paths.map((framePath) => ({
        name: path.basename(framePath),
        sourcePath: framePath,
      }));
      const animationType = resolveImportedAnimationType(
        args.animation_type ?? args.animationType,
        replaced ? existingAnimation?.type : undefined,
      );
      const imported = importAnimation({
        root,
        projectStore,
        project,
        profileId,
        profileLabel: profileId,
        animationId,
        animationName: animationId,
        animationType,
        fps,
        replace: replaced,
        items,
      });
      selectProject(project.id);
      context.profileId = profileId;
      context.animationId = animationId;
      const sync = synchronize(project, syncRequested);
      const validation = booleanFlag(args.validate)
        ? validateImport({ project: project.id }, { root, projectStore })
        : { requested: false, ok: null, errors: [], warnings: [], summary: {} };
      const suggestedGameFps = suggestedFps === undefined ? undefined : suggestGameFps(suggestedFps);
      return {
        projectId: project.id,
        profileId,
        animationId,
        animationType,
        sourceVideo: videoPath,
        fps,
        sourceFrameCount,
        sourceDurationSec,
        suggestedFps,
        suggestedGameFps,
        next:
          suggestedGameFps === undefined
            ? undefined
            : `pass fps=${suggestedGameFps} (suggestedGameFps) to xsxb_export_gif for a game loop`,
        extractedFrameCount: extracted.extractedCount,
        importedFrameCount: imported.frameCount,
        startFrame: extracted.startFrame,
        endFrame: extracted.endFrame,
        replaced,
        targetDirectory: imported.targetDir,
        sync,
        validation: booleanFlag(args.validate) ? { requested: true, ...validation } : validation,
      };
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  function uniqueAnimationId(project, profileId, requestedId, fallback, replace = false) {
    const manifest = manifestFor(project);
    const profile = (manifest.profiles || []).find((entry) => entry.id === profileId);
    const used = new Set((profile?.animations || []).map((entry) => String(entry.id || entry.name)));
    const base = slug(requestedId || fallback, fallback);
    if (replace && used.has(base)) return base;
    let animationId = base;
    let suffix = 2;
    while (used.has(animationId)) {
      animationId = `${base}_${suffix}`;
      suffix += 1;
    }
    return animationId;
  }

  function importPngItems(args, items, sourceLabel) {
    if (!items.length) throw new Error(`No PNG frames provided for ${sourceLabel} import.`);
    const syncRequested = booleanFlag(args.sync);
    const project = registryProject(args.project_id || args.project, syncRequested);
    const profileId = resolveImportProfileId(args);
    const requestedId = slug(
      args.animation_id || args.animation,
      sourceLabel === "png_sequence" ? "png_sequence" : "imported",
    );
    const existingAnimation = (manifestFor(project).profiles || [])
      .find((entry) => entry.id === profileId)
      ?.animations?.find((entry) => String(entry.id || entry.name) === requestedId);
    const replaced = booleanFlag(args.replace) && Boolean(existingAnimation);
    const animationId = uniqueAnimationId(
      project,
      profileId,
      args.animation_id || args.animation,
      sourceLabel === "png_sequence" ? "png_sequence" : "imported",
      booleanFlag(args.replace),
    );
    let importItems = Array.isArray(items) ? items : [];
    if (String(args.loop_endpoint || "none") === "duplicate_first" && importItems.length) {
      const first = importItems[0];
      importItems = [...importItems, { ...first, name: `loop_end_${first.name || "frame.png"}` }];
    }
    const inPlace = booleanFlag(args.in_place);
    if (inPlace) {
      const missing = importItems.findIndex((item) => !item?.sourcePath);
      if (missing >= 0) {
        throw new Error(
          "in_place import requires on-disk PNG paths (PNG sequence, item.path, or spriteframes sources).",
        );
      }
    }
    const fps = requireFps(args.fps, replaced ? existingAnimation.fps : 12);
    const animationType = resolveImportedAnimationType(
      args.animation_type ?? args.animationType,
      replaced ? existingAnimation.type : undefined,
    );
    const imported = importAnimation({
      root,
      projectStore,
      project,
      profileId,
      profileLabel: profileId,
      animationId,
      animationName: String(args.animation_name || animationId),
      animationType,
      fps,
      replace: replaced,
      inPlace,
      items: importItems,
    });
    selectProject(project.id);
    context.profileId = profileId;
    context.animationId = animationId;
    const sync = synchronize(project, syncRequested);
    const validation = booleanFlag(args.validate)
      ? { requested: true, ...validateImport({ project: project.id }, { root, projectStore }) }
      : { requested: false, ok: null, errors: [], warnings: [], summary: {} };
    const stored = (manifestFor(project).profiles || [])
      .find((entry) => entry.id === profileId)
      ?.animations?.find((entry) => String(entry.id || entry.name) === animationId);
    const measured = [];
    if (stored) {
      collectFramePaths(project, stored).forEach((filePath, index) => {
        try {
          const image = decodePngRgba(filePath);
          measured.push({ index, ...measureSpriteGeometry(image.data, image.width, image.height) });
        } catch {
          // Import already stored the bytes; the bbox summary is best-effort.
        }
      });
    }
    const bboxHeights = measured.map((frame) => frame.bboxH);
    return {
      source: sourceLabel,
      projectId: project.id,
      profileId,
      animationId,
      animationType,
      fps,
      importedFrameCount: imported.frameCount,
      replaced: Boolean(replaced),
      inPlace: Boolean(imported.inPlace),
      targetDirectory: imported.targetDir,
      metrics: measured.length
        ? {
            canvas: { width: measured[0].canvasW, height: measured[0].canvasH },
            bboxH: {
              min: Math.min(...bboxHeights),
              max: Math.max(...bboxHeights),
            },
            frames: measured.map((frame) => ({
              index: frame.index,
              bboxH: frame.bboxH,
              bodyH: frame.bodyH,
              feetY: frame.feetY,
            })),
          }
        : undefined,
      sync,
      validation,
    };
  }

  async function importUnified(args = {}) {
    const source = resolveImportSource(args);
    if (source === "video") {
      return { source, ...(await importVideo(args)) };
    }
    if (source === "png_sequence") {
      const directory = path.resolve(String(args.directory || args.file_path || args.path || ""));
      const sliced = sliceExtractedFrames(listPngSequence(directory), args);
      return {
        ...importPngItems(args, sliced.paths.map(pngFileToItem), "png_sequence"),
        startFrame: sliced.startFrame,
        endFrame: sliced.endFrame,
        sourceFrameCount: sliced.extractedCount,
      };
    }
    if (source === "items") {
      const items = Array.isArray(args.items) ? args.items : [];
      const normalized = items.map((item, index) => {
        if (item?.data) return { name: item.name || `frame_${index + 1}.png`, data: item.data };
        const filePath = path.resolve(String(item?.path || item?.file_path || ""));
        if (!filePath || !fs.existsSync(filePath)) {
          throw new Error(`Import item ${index + 1} needs PNG data or an existing file path.`);
        }
        return pngFileToItem(filePath);
      });
      const sliced = sliceExtractedFrames(normalized, args);
      return {
        ...importPngItems(args, sliced.paths, "items"),
        startFrame: sliced.startFrame,
        endFrame: sliced.endFrame,
        sourceFrameCount: sliced.extractedCount,
      };
    }
    if (source === "spriteframes") {
      const filePath = path.resolve(String(args.file_path || args.path || ""));
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`SpriteFrames file not found: ${filePath}`);
      }
      const syncRequested = booleanFlag(args.sync);
      const project = registryProject(args.project_id || args.project, syncRequested);
      const projectRoot = validGodotProjectRoot(project) || path.dirname(filePath);
      const parsed = parseSpriteFrames(filePath, projectRoot);
      if (!parsed.length) throw new Error(`No PNG animations found in ${filePath}`);
      const requestedId = args.animation_id || args.animation;
      let animations = parsed;
      if (requestedId && parsed.length > 1) {
        const want = slug(requestedId);
        animations = parsed.filter(
          (animation) => slug(animation.id) === want || slug(animation.name) === want,
        );
        if (!animations.length) {
          const available = parsed.map((animation) => animation.id).join(", ");
          throw new Error(`No SpriteFrames clip matches "${requestedId}". Available: ${available}`);
        }
      }
      const singleClipRename = Boolean(requestedId) && parsed.length === 1;
      const profileId = resolveImportProfileId(args);
      const fpsOmitted = args.fps === undefined || args.fps === null || args.fps === "";
      const imported = [];
      for (const animation of animations) {
        const sliced = sliceExtractedFrames(
          animation.frames.map((frame) => pngFileToItem(frame.source)),
          args,
        );
        const items = sliced.paths;
        const animationId = singleClipRename ? requestedId : animation.id;
        const existingId = slug(animationId, animation.id);
        const existingAnimation = (manifestFor(project).profiles || [])
          .find((entry) => entry.id === profileId)
          ?.animations?.find((entry) => String(entry.id || entry.name) === existingId);
        const replacing = booleanFlag(args.replace) && Boolean(existingAnimation);
        imported.push(
          importPngItems(
            {
              ...args,
              profile_id: profileId,
              animation_id: animationId,
              animation_name: args.animation_name || animation.name,
              fps: fpsOmitted ? (replacing ? undefined : animation.fps) : args.fps,
              sync: false,
              validate: false,
            },
            items,
            "spriteframes",
          ),
        );
      }
      const last = imported[imported.length - 1];
      const sync = synchronize(project, syncRequested);
      const validation = booleanFlag(args.validate)
        ? { requested: true, ...validateImport({ project: project.id }, { root, projectStore }) }
        : { requested: false, ok: null, errors: [], warnings: [], summary: {} };
      return {
        source: "spriteframes",
        projectId: project.id,
        profileId,
        animationId: last.animationId,
        importedAnimationCount: imported.length,
        importedFrameCount: imported.reduce((sum, entry) => sum + entry.importedFrameCount, 0),
        animations: imported.map((entry) => ({
          animationId: entry.animationId,
          importedFrameCount: entry.importedFrameCount,
        })),
        sync,
        validation,
      };
    }
    throw new Error(`Unsupported import source: ${source}`);
  }

  /**
   * Cuts a packed sheet into a PNG sequence, optionally importing the result.
   * @param {object} args Tool arguments.
   * @returns {Promise<object>} Slice receipt.
   */
  async function sliceSheetTool(args = {}) {
    const receipt = sliceSheet(args);
    const animationId = args.animation_id || args.animation;
    if (!animationId) return receipt;
    if (!receipt.paths.length) {
      throw new Error("No cells to import (all skipped or empty sheet).");
    }
    const importArgs = {
      source: "items",
      items: receipt.paths.map((filePath) => ({ path: filePath })),
      animation_id: animationId,
      animation_name: args.animation_name,
      project_id: args.project_id,
      profile_id: args.profile_id,
      fps: args.fps,
      replace: args.replace,
      sync: args.sync,
      validate: args.validate,
      loop_endpoint: args.loop_endpoint,
    };
    if (args.in_place !== undefined) importArgs.in_place = args.in_place;
    if (args.animation_type !== undefined) importArgs.animation_type = args.animation_type;
    return { ...receipt, imported: await importUnified(importArgs) };
  }

  function projectSnapshot(args = {}) {
    const project = lookupProject(args.project_id || args.project);
    const registry = projectStore.readRegistry();
    const manifest = manifestFor(project);
    const profiles = Array.isArray(manifest.profiles) ? manifest.profiles : [];
    const animations = profiles.flatMap((profile) =>
      (profile.animations || []).map((animation) => ({
        profileId: profile.id,
        id: String(animation.id || animation.name),
        name: String(animation.name || animation.id || ""),
        type: animation.type || "actor",
        fps: Number(animation.fps || 12),
        frameCount: Array.isArray(animation.frames) ? animation.frames.length : 0,
      })),
    );
    const handoff = projectStore.readJson(projectStore.projectPaths(project).godotHandoff, null);
    return {
      ...projectStore.projectForClient(project),
      projectId: project.id,
      active: project.id === registry.activeProjectId,
      godotProjectValid: Boolean(validGodotProjectRoot(project)),
      godotProjectRoot: project.projectRoot || "",
      profileCount: profiles.length,
      animationCount: animations.length,
      frameCount: animations.reduce((sum, animation) => sum + animation.frameCount, 0),
      profiles: profiles.map((profile) => ({
        id: profile.id,
        label: profile.label || profile.id,
        kind: profile.kind || "actor",
        animationCount: Array.isArray(profile.animations) ? profile.animations.length : 0,
      })),
      animations,
      sync: {
        godotProjectValid: Boolean(validGodotProjectRoot(project)),
        lastSync: handoff?.lastSync || null,
        lastFailure: handoff?.lastFailure || null,
      },
    };
  }

  function updateFrameBoxes(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot update boxes on an animation without frames.");
    const batch = Array.isArray(args.frames) && args.frames.length > 0;
    const requests = batch
      ? args.frames
      : [
          {
            frame: args.frame || 0,
            hurtbox: args.hurtbox,
            collisionbox: args.collisionbox,
            hitbox: args.hitbox,
          },
        ];
    const paths = projectStore.projectPaths(project);
    const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
    tuning.frame_box_overrides =
      tuning.frame_box_overrides && typeof tuning.frame_box_overrides === "object"
        ? tuning.frame_box_overrides
        : {};
    const updates = requests.map((request) => {
      if (!request || typeof request !== "object") {
        throw new Error("Each frames item must be an object with frame and box patches.");
      }
      const frame = requireFrameIndex(request.frame ?? 0, frames.length - 1);
      const patches = BOX_NAMES.filter((name) => request[name] && typeof request[name] === "object");
      if (!patches.length) throw new Error("Provide at least one of hurtbox, collisionbox, or hitbox.");
      const key = frameBoxKey(profile.id, animation.id || animation.name, frame);
      const current =
        tuning.frame_box_overrides[key] && typeof tuning.frame_box_overrides[key] === "object"
          ? tuning.frame_box_overrides[key]
          : {};
      const boxes = { ...current };
      const needsBoxImage =
        String(args.grid_scope || "") === "subject" ||
        patches.some((name) => cellIdToken(request[name].min) || cellIdToken(request[name].max));
      const boxPath = resolveAnimationFramePath(project, frames[frame].path, animation);
      const boxImage =
        needsBoxImage && boxPath && fs.existsSync(boxPath) ? decodePngRgba(boxPath) : undefined;
      for (const name of patches) {
        boxes[name] = mergeBox(
          current[name],
          resolveBoxPatch(request[name], animation, frames[frame], args, boxImage),
          { ground: name === "collisionbox" },
        );
      }
      tuning.frame_box_overrides[key] = boxes;
      return { frame, key, boxes };
    });
    projectStore.writeJson(paths.tuning, tuning);
    const base = {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      updatedFrames: updates.length,
      sync: synchronize(project, booleanFlag(args.sync)),
    };
    if (!batch)
      return {
        ...base,
        frame: updates[0].frame,
        key: updates[0].key,
        boxes: updates[0].boxes,
        space: "group",
      };
    return { ...base, updates, space: "group" };
  }

  function estimateBoxes(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot estimate boxes on an animation without frames.");
    const frameFiles = frames.map((frame, index) => {
      const absolute = resolveAnimationFramePath(project, frame.path, animation);
      if (!absolute || !fs.existsSync(absolute)) {
        throw new Error(`Frame ${index} has no generated PNG on disk; import or regenerate frames first.`);
      }
      return absolute;
    });
    const replace = booleanFlag(args.replace);
    const dryRun = booleanFlag(args.dry_run);
    const animationId = String(animation.id || animation.name);
    const paths = projectStore.projectPaths(project);
    const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
    tuning.frame_box_overrides =
      tuning.frame_box_overrides && typeof tuning.frame_box_overrides === "object"
        ? tuning.frame_box_overrides
        : {};
    const keyFor = (index) => frameBoxKey(profile.id, animationId, index);
    const existing = new Set(
      frames.map((_, index) => keyFor(index)).filter((key) => tuning.frame_box_overrides[key]),
    );
    upsertEstimatedFrameBoxes(tuning, profile.id, { ...animation, id: animationId }, frameFiles, {
      replace,
    });
    const results = frames.map((_, index) => {
      const key = keyFor(index);
      const had = existing.has(key);
      const skippedExisting = !replace && had;
      return {
        frame: index,
        estimated: !skippedExisting && Boolean(tuning.frame_box_overrides[key]),
        skippedExisting,
        boxes: tuning.frame_box_overrides[key] || null,
      };
    });
    if (!dryRun) projectStore.writeJson(paths.tuning, tuning);
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId,
      frameCount: frames.length,
      estimatedFrames: results.filter((entry) => entry.estimated).length,
      skippedExistingFrames: results.filter((entry) => entry.skippedExisting).length,
      replace,
      dryRun,
      frames: results,
      sync: synchronize(project, dryRun ? false : booleanFlag(args.sync)),
    };
  }

  function updateTiming(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    const paths = projectStore.projectPaths(project);
    const manifest = manifestFor(project);
    const target = (manifest.profiles || [])
      .find((entry) => entry.id === profile.id)
      ?.animations?.find(
        (entry) => String(entry.id || entry.name) === String(animation.id || animation.name),
      );
    if (!target) throw new Error(`Animation not found: ${profile.id}/${animation.id || animation.name}`);
    const fps = requireFps(args.fps === undefined ? target.fps : args.fps, Number(target.fps || 12));
    const batch = Array.isArray(args.frames) && args.frames.length > 0;
    const singleRequested =
      args.frame !== undefined ||
      args.duration_ms !== undefined ||
      args.duration !== undefined ||
      args.disabled !== undefined;
    let playback = null;
    let playbackUpdates = null;
    if (batch || singleRequested) {
      if (!frames.length) throw new Error("Cannot update frame timing on an animation without frames.");
      const requests = batch
        ? args.frames
        : [
            {
              frame: args.frame,
              duration_ms: args.duration_ms,
              duration: args.duration,
              disabled: args.disabled,
            },
          ];
      const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
      tuning.frame_playback_overrides =
        tuning.frame_playback_overrides && typeof tuning.frame_playback_overrides === "object"
          ? tuning.frame_playback_overrides
          : {};
      const applied = requests.map((request) => {
        if (!request || typeof request !== "object") {
          throw new Error("Each frames item must be an object with frame and timing fields.");
        }
        const frame = requireFrameIndex(request.frame ?? 0, frames.length - 1);
        const key = frameBoxKey(profile.id, animation.id || animation.name, frame);
        const current = tuning.frame_playback_overrides[key] || {};
        let duration = Number(current.duration || 1);
        if (request.duration_ms !== undefined) duration = (Number(request.duration_ms) * fps) / 1000;
        else if (request.duration !== undefined) duration = Number(request.duration);
        duration = Math.max(0.001, duration);
        const disabled =
          request.disabled === undefined ? current.disabled === true : Boolean(request.disabled);
        if (disabled || duration !== 1) tuning.frame_playback_overrides[key] = { duration, disabled };
        else delete tuning.frame_playback_overrides[key];
        return {
          frame,
          key,
          duration,
          durationMs: Math.round((duration * 1000) / fps),
          disabled,
        };
      });
      target.fps = fps;
      projectStore.writeJson(paths.manifest, manifest);
      projectStore.writeJson(paths.tuning, tuning);
      if (batch) playbackUpdates = applied;
      else playback = applied[0];
    } else {
      target.fps = fps;
      projectStore.writeJson(paths.manifest, manifest);
    }
    const result = {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      fps,
      playback,
      sync: synchronize(project, booleanFlag(args.sync)),
    };
    if (playbackUpdates) result.playbackUpdates = playbackUpdates;
    return result;
  }

  function setVisualTransform(args = {}) {
    const batch = Array.isArray(args.frames) && args.frames.length > 0;
    const level = String(args.level || (batch ? "frame" : "group"))
      .trim()
      .toLowerCase();
    if (!["character", "group", "frame"].includes(level)) {
      throw new Error('level must be one of "character", "group", or "frame".');
    }
    const clear = booleanFlag(args.clear);
    const clearGroup = booleanFlag(args.clear_group);
    const fields = ["visual_size", "offset_x", "offset_y", "rotation"].filter(
      (name) => args[name] !== undefined,
    );
    if (!fields.length && !clear && !batch && !clearGroup) {
      throw new Error(
        "Provide at least one of visual_size, offset_x, offset_y, rotation, frames, clear_group, or clear=true.",
      );
    }
    let visualSize = null;
    if (args.visual_size !== undefined) {
      visualSize = Number(args.visual_size);
      if (!Number.isFinite(visualSize) || visualSize <= 0) {
        throw new Error("visual_size must be a finite number greater than 0.");
      }
    }
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const animationId = String(animation.id || animation.name);
    const paths = projectStore.projectPaths(project);
    const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
    tuning.values = tuning.values && typeof tuning.values === "object" ? tuning.values : {};
    if (clearGroup || (batch && clearGroup)) {
      const base = `profiles.${profile.id}.groups.${animationId}`;
      for (const suffix of ["visual_size", "visual_scale"]) {
        delete tuning.values[`${base}.${suffix}`];
      }
    }
    /**
     * Writes one frame-level visual override.
     * @param {object} request Frame patch.
     * @returns {object} Applied row.
     */
    function writeFrameOverride(request) {
      const frames = animation.frames || [];
      if (!frames.length) throw new Error("Cannot set frame visuals on an animation without frames.");
      const frame = requireFrameIndex(request.frame ?? args.frame ?? 0, frames.length - 1);
      tuning.frame_visual_overrides =
        tuning.frame_visual_overrides && typeof tuning.frame_visual_overrides === "object"
          ? tuning.frame_visual_overrides
          : {};
      const key = frameBoxKey(profile.id, animationId, frame);
      if (booleanFlag(request.clear) || (clear && !batch)) {
        delete tuning.frame_visual_overrides[key];
        return { frame, key, cleared: true };
      }
      const current =
        tuning.frame_visual_overrides[key] && typeof tuning.frame_visual_overrides[key] === "object"
          ? tuning.frame_visual_overrides[key]
          : {};
      const next = { ...current };
      const size = request.visual_size !== undefined ? Number(request.visual_size) : visualSize;
      if (
        size !== null &&
        size !== undefined &&
        !(request.visual_size === undefined && visualSize === null)
      ) {
        if (!Number.isFinite(Number(size)) || Number(size) <= 0) {
          throw new Error("visual_size must be a finite number greater than 0.");
        }
        next.visual_size = Number(size);
        delete next.visual_scale;
      }
      const offsetX = request.offset_x !== undefined ? request.offset_x : args.offset_x;
      const offsetY = request.offset_y !== undefined ? request.offset_y : args.offset_y;
      if (offsetX !== undefined || offsetY !== undefined) {
        const offset = current.offset && typeof current.offset === "object" ? current.offset : {};
        next.offset = {
          x: offsetX === undefined ? Number(offset.x || 0) : Number(offsetX),
          y: offsetY === undefined ? Number(offset.y || 0) : Number(offsetY),
        };
      }
      const rotation = request.rotation !== undefined ? request.rotation : args.rotation;
      if (rotation !== undefined) next.rotation = Number(rotation);
      tuning.frame_visual_overrides[key] = next;
      return { frame, key, override: next };
    }
    let applied;
    if (batch) {
      const updates = args.frames.map((request) => writeFrameOverride(request || {}));
      applied = { updatedFrames: updates.length, updates };
    } else if (level === "frame") {
      if (args.frame === undefined) throw new Error("frame is required when level=frame.");
      applied = writeFrameOverride(args);
    } else {
      const base =
        level === "character"
          ? `profiles.${profile.id}.character`
          : `profiles.${profile.id}.groups.${animationId}`;
      if (clear) {
        for (const suffix of ["visual_size", "visual_scale", "offset", "rotation"]) {
          delete tuning.values[`${base}.${suffix}`];
        }
        applied = { base, cleared: true };
      } else {
        if (visualSize !== null) {
          tuning.values[`${base}.visual_size`] = visualSize;
          delete tuning.values[`${base}.visual_scale`];
        }
        if (args.offset_x !== undefined || args.offset_y !== undefined) {
          const offsetKey = `${base}.offset`;
          const current =
            tuning.values[offsetKey] && typeof tuning.values[offsetKey] === "object"
              ? tuning.values[offsetKey]
              : {};
          tuning.values[offsetKey] = {
            x: args.offset_x === undefined ? Number(current.x || 0) : Number(args.offset_x),
            y: args.offset_y === undefined ? Number(current.y || 0) : Number(args.offset_y),
          };
        }
        if (args.rotation !== undefined) tuning.values[`${base}.rotation`] = Number(args.rotation);
        applied = {
          base,
          values: Object.fromEntries(
            ["visual_size", "visual_scale", "offset", "rotation"]
              .map((suffix) => [`${base}.${suffix}`, tuning.values[`${base}.${suffix}`]])
              .filter(([, value]) => value !== undefined),
          ),
        };
      }
    }
    projectStore.writeJson(paths.tuning, tuning);
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId,
      level: batch ? "frame" : level,
      space: "group",
      ...applied,
      sync: synchronize(project, booleanFlag(args.sync)),
    };
  }

  function removeAnimation(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    const preview = {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      removedFrames: frames.length,
      removedDirectory: String(animation.source || ""),
    };
    if (booleanFlag(args.dry_run)) {
      return { ...preview, dryRun: true, deleted: false };
    }
    const result = deleteAnimation({
      root,
      projectStore,
      project,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
    });
    if (context.animationId === preview.animationId) context.animationId = "";
    return {
      ...preview,
      dryRun: false,
      deleted: true,
      removedFrames: result.removedFrames,
      removedDirectory: result.removedDirectory,
      sync: synchronize(project, booleanFlag(args.sync)),
    };
  }

  async function syncGodot(args = {}) {
    const project = registryProject(args.project_id || args.project, true);
    return {
      projectId: project.id,
      force: booleanFlag(args.force),
      ...synchronize(project, true, { force: booleanFlag(args.force) }),
      godot: describeGodotHandoff(project.projectRoot || "", project.id),
    };
  }

  /**
   * Reads back tuning overrides and bindings owned by one animation.
   * @param {{project:object,profile:object,animation:object}} selection Animation selection.
   * @param {string[]} sections Requested include sections.
   * @returns {object} Extra sections keyed by name.
   */
  function animationExtras(selection, sections) {
    const { project, profile, animation } = selection;
    const animationId = String(animation.id || animation.name);
    const bindingKey = `${profile.id}/${animationId}`;
    const framePrefix = `${bindingKey}:`;
    const frameFromKey = (key) => Number(String(key).slice(framePrefix.length));
    const paths = projectStore.projectPaths(project);
    const wanted = new Set(sections);
    const extras = {};
    if (wanted.has("boxes") || wanted.has("timing") || wanted.has("visual")) {
      const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
      if (wanted.has("boxes")) {
        const overrides = tuning.frame_box_overrides || {};
        extras.boxes = Object.fromEntries(
          Object.keys(overrides)
            .filter((key) => key.startsWith(framePrefix))
            .map((key) => [frameFromKey(key), overrides[key]]),
        );
      }
      if (wanted.has("timing")) {
        const fps = Number(animation.fps || 12);
        const overrides = tuning.frame_playback_overrides || {};
        const frameOverrides = {};
        for (const key of Object.keys(overrides)) {
          if (!key.startsWith(framePrefix)) continue;
          const entry = overrides[key] && typeof overrides[key] === "object" ? overrides[key] : {};
          const duration = Number(entry.duration || 1);
          frameOverrides[frameFromKey(key)] = {
            duration,
            durationMs: Math.round((duration * 1000) / fps),
            disabled: entry.disabled === true,
          };
        }
        extras.timing = { fps, frameOverrides };
      }
      if (wanted.has("visual")) {
        const values = tuning.values && typeof tuning.values === "object" ? tuning.values : {};
        const pick = (base) => ({
          visual_size: values[`${base}.visual_size`],
          visual_scale: values[`${base}.visual_scale`],
          offset: values[`${base}.offset`],
          rotation: values[`${base}.rotation`],
        });
        const overrides =
          tuning.frame_visual_overrides && typeof tuning.frame_visual_overrides === "object"
            ? tuning.frame_visual_overrides
            : {};
        const frameOverrides = {};
        for (const key of Object.keys(overrides)) {
          if (key.startsWith(framePrefix)) frameOverrides[frameFromKey(key)] = overrides[key];
        }
        extras.visual = {
          character: pick(`profiles.${profile.id}.character`),
          group: pick(`profiles.${profile.id}.groups.${animationId}`),
          frameOverrides,
        };
      }
    }
    if (wanted.has("sfx")) {
      extras.sfx = readSfxBindings(paths)
        .filter((entry) => String(entry?.key || "").startsWith(framePrefix))
        .map((entry) => {
          const { data, ...rest } = entry;
          return { ...rest, frame: frameFromKey(entry.key), hasData: Boolean(data) };
        });
    }
    if (wanted.has("attachments")) {
      const raw = projectStore.readJson(paths.frameImageAttachments, []);
      extras.attachments = (Array.isArray(raw) ? raw : [])
        .filter((entry) => String(entry?.key || entry?.frameKey || "").startsWith(framePrefix))
        .map((entry) => ({ ...entry, frame: frameFromKey(entry.key || entry.frameKey) }));
    }
    if (wanted.has("trails")) {
      const trails = normalizeAttackTrails(projectStore.readJson(paths.attackTrails, EMPTY_ATTACK_TRAILS));
      extras.trails = trails.bindings[bindingKey] || [];
    }
    return extras;
  }

  async function getAnimation(args = {}) {
    const selection = animationFor(args);
    const result = animationResult(selection);
    const includeRaw = Array.isArray(args.include)
      ? args.include
      : typeof args.include === "string" && args.include.trim()
        ? args.include.split(",")
        : [];
    const include = includeRaw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
    const allowed = ["boxes", "timing", "visual", "sfx", "attachments", "trails"];
    const unknown = include.filter((entry) => !allowed.includes(entry));
    if (unknown.length) {
      throw new Error(`Unknown include section(s): ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`);
    }
    if (include.length) Object.assign(result, animationExtras(selection, include));
    const first = (result.animation.frames || [])[0];
    const originCanvas = first
      ? canvasAnchor(
          Number(first.width || 0),
          Number(first.height || 0),
          String(selection.animation.anchorMode || "canvas_bottom_center"),
        )
      : null;
    result.space = "group";
    result.ySign = "down";
    result.origin = { group: { x: 0, y: 0 }, canvas: originCanvas };
    const framesMode = String(args.frames || "full").toLowerCase();
    if (framesMode !== "summary") return { ...result, summary: false };
    const samples = (result.animation.frames || []).slice(0, 3).map((frame) => ({
      index: frame.index,
      width: frame.width,
      height: frame.height,
      exists: frame.exists,
      absolutePath: frame.absolutePath,
    }));
    return {
      ...result,
      summary: true,
      sampleFrames: samples,
      animation: { ...result.animation, frames: undefined },
    };
  }

  /**
   * Ranks Tuner loop-segment candidates without changing frames.
   * @param {object} args Tool arguments.
   * @returns {object} Ranked candidates and the recommended order.
   */
  function findLoop(args = {}) {
    const external = resolveExternalLoopFrames(args);
    const source = external?.source || "animation";
    let filePaths = external?.filePaths || [];
    const payload = { source, applied: false };
    if (!external) {
      const selection = animationFor(args);
      const result = animationResult(selection);
      payload.projectId = selection.project.id;
      payload.profileId = selection.profile.id;
      payload.animationId = String(selection.animation.id || selection.animation.name);
      filePaths = result.animation.frames.map((frame) => {
        if (!frame.exists) {
          throw new Error(
            `Frame ${frame.index} has no generated PNG on disk; import or regenerate frames first.`,
          );
        }
        return frame.absolutePath;
      });
    }
    const found = findLoopInPngFiles(filePaths, {
      minPeriod: args.min_period,
      maxPeriod: args.max_period,
      startFrame: args.start_frame,
      preference: args.preference,
      boundaryFactor: args.boundary_factor,
      sampleSize: args.sample_size,
    });
    return {
      ...payload,
      source,
      frameCount: found.frameCount,
      sampleSize: found.sampleSize,
      candidates: found.candidates,
      recommended: found.recommended,
      oneShotLikely: found.oneShotLikely,
      note: found.note,
    };
  }

  /**
   * Finds near-duplicate holds without changing frames.
   * @param {object} args Tool arguments.
   * @returns {object} Drop indexes and the keep-order.
   */
  function findDuplicates(args = {}) {
    const external = resolveExternalLoopFrames(args);
    const source = external?.source || "animation";
    let filePaths = external?.filePaths || [];
    const payload = { source, applied: false };
    if (!external) {
      const selection = animationFor(args);
      payload.projectId = selection.project.id;
      payload.profileId = selection.profile.id;
      payload.animationId = String(selection.animation.id || selection.animation.name);
      filePaths = collectFramePaths(selection.project, selection.animation);
    }
    if (args.duplicate_ratio !== undefined && args.threshold !== undefined) {
      if (Number(args.duplicate_ratio) !== Number(args.threshold)) {
        throw new Error("threshold and duplicate_ratio disagree. Pass only one.");
      }
    }
    return {
      ...payload,
      ...findDuplicatesInPngFiles(filePaths, {
        threshold: args.duplicate_ratio !== undefined ? args.duplicate_ratio : args.threshold,
        sampleSize: args.sample_size,
        autoAdjust: booleanFlag(args.auto_adjust, false),
      }),
    };
  }

  /**
   * Resolves on-disk PNG paths for one imported animation.
   * @param {object} project Project record.
   * @param {object} animation Manifest animation.
   * @param {string} [label] Error label.
   * @returns {string[]} Absolute PNG paths.
   */
  function collectFramePaths(project, animation, label = "Frame") {
    return Array.from(animation.frames || []).map((frame, index) => {
      const absolute = resolveAnimationFramePath(project, frame.path, animation);
      if (!absolute || !fs.existsSync(absolute)) {
        throw new Error(`${label} ${index} has no generated PNG on disk; import or regenerate frames first.`);
      }
      return absolute;
    });
  }

  /**
   * Writes estimated group and zoom-frame visual_size without baking pixels.
   * @param {object} tuning Tuning file.
   * @param {string} profileId Profile id.
   * @param {string} animationId Animation id.
   * @param {{groupScale:number,frames:Array<{index:number,reason:string,scale:number}>}} estimated Scale plan.
   * @returns {void}
   */
  function applyEstimatedVisual(tuning, profileId, animationId, estimated) {
    tuning.values = tuning.values && typeof tuning.values === "object" ? tuning.values : {};
    const base = `profiles.${profileId}.groups.${animationId}`;
    tuning.values[`${base}.visual_size`] = estimated.groupScale;
    delete tuning.values[`${base}.visual_scale`];
    tuning.frame_visual_overrides =
      tuning.frame_visual_overrides && typeof tuning.frame_visual_overrides === "object"
        ? tuning.frame_visual_overrides
        : {};
    const prefix = `${profileId}/${animationId}:`;
    for (const key of Object.keys(tuning.frame_visual_overrides)) {
      if (!key.startsWith(prefix)) continue;
      const current =
        tuning.frame_visual_overrides[key] && typeof tuning.frame_visual_overrides[key] === "object"
          ? tuning.frame_visual_overrides[key]
          : {};
      delete current.visual_size;
      delete current.visual_scale;
      if (!Object.keys(current).length) delete tuning.frame_visual_overrides[key];
      else tuning.frame_visual_overrides[key] = current;
    }
    for (const frame of estimated.frames) {
      if (estimated.mode !== "equalize" && frame.reason !== "zoom") continue;
      const key = frameBoxKey(profileId, animationId, frame.index);
      const current =
        tuning.frame_visual_overrides[key] && typeof tuning.frame_visual_overrides[key] === "object"
          ? tuning.frame_visual_overrides[key]
          : {};
      tuning.frame_visual_overrides[key] = { ...current, visual_size: frame.scale };
    }
  }

  /**
   * Trims leading/trailing rest holds on a clip without changing frames.
   * @param {object} args Tool arguments.
   * @returns {object} Motion window and per-frame activity.
   */
  function findMotion(args = {}) {
    const external = resolveExternalLoopFrames(args);
    const source = external?.source || "animation";
    let filePaths = external?.filePaths || [];
    const payload = { source, applied: false };
    if (!external) {
      const selection = animationFor(args);
      payload.projectId = selection.project.id;
      payload.profileId = selection.profile.id;
      payload.animationId = String(selection.animation.id || selection.animation.name);
      filePaths = collectFramePaths(selection.project, selection.animation);
    }
    const measured = measureFrameFiles(filePaths);
    const found = findMotionWindow(
      measured.map((frame) => ({
        opaque: frame.opaque,
        height: frame.bodyHeight,
        cy: frame.cy,
      })),
    );
    return {
      ...payload,
      frameCount: filePaths.length,
      start: found.start,
      end: found.end,
      order: found.order,
      activity: found.activity,
      frames: measured.map((frame) => ({
        index: frame.index,
        bodyHeight: frame.bodyHeight,
        opaque: frame.opaque,
        cy: frame.cy,
      })),
    };
  }

  /**
   * Writes a grid=false contact sheet of the recommended analyze window.
   * @param {object} args Tool arguments.
   * @param {object|null} project Active project when known.
   * @param {{profileId?:string,animationId?:string}} payload Identity fields.
   * @param {object} analyzed Compact analysis.
   * @param {Array<{data:Uint8ClampedArray,width:number,height:number}>} images Decoded frames.
   * @returns {{kind:string,path:string,start:number,end:number,frameCount:number}} Preview receipt.
   */
  function writeAnalyzePreview(args, project, payload, analyzed, images) {
    const window = chooseAnalyzeWindow(analyzed.loop, analyzed.motion);
    const start = window.start;
    const end = window.end;
    const selected = images.slice(start, end + 1);
    if (!selected.length) {
      throw new Error("Analyze preview has no frames in the recommended window.");
    }
    const sheet = renderContactSheet(selected, {
      cell: args.cell === undefined ? 160 : Math.max(8, Number(args.cell)),
      pad: 8,
      columns: Math.min(selected.length, 8),
      startIndex: start,
      markFrame: start,
      grid: false,
    });
    const defaultName = `${payload.profileId || "clip"}_${payload.animationId || "preview"}_analyze.png`;
    const outputPath = resolveMcpArtifactPath(args.output_path, {
      root,
      artifactDir: currentArtifactDir(project),
      defaultName,
      extensionPattern: /\.png$/i,
      extensionLabel: ".png",
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encodePngRgba(sheet.data, sheet.width, sheet.height));
    return {
      kind: window.kind,
      path: outputPath,
      start,
      end,
      frameCount: selected.length,
    };
  }

  /**
   * One-pass duplicate, loop, and motion analysis after import.
   * @param {object} args Tool arguments.
   * @returns {object} Compact analysis receipt.
   */
  function analyzeClip(args = {}) {
    const external = resolveExternalLoopFrames(args);
    const source = external?.source || "animation";
    let filePaths = external?.filePaths || [];
    const payload = { source, applied: false };
    let project = null;
    if (!external) {
      const selection = animationFor(args);
      payload.projectId = selection.project.id;
      payload.profileId = selection.profile.id;
      payload.animationId = String(selection.animation.id || selection.animation.name);
      filePaths = collectFramePaths(selection.project, selection.animation);
      project = selection.project;
    } else {
      project = projectStore.activeProject(context.projectId);
    }
    if (args.duplicate_ratio !== undefined && args.threshold !== undefined) {
      if (Number(args.duplicate_ratio) !== Number(args.threshold)) {
        throw new Error("threshold and duplicate_ratio disagree. Pass only one.");
      }
    }
    const analyzed = analyzePngFiles(filePaths, {
      minPeriod: args.min_period,
      maxPeriod: args.max_period,
      startFrame: args.start_frame,
      preference: args.preference,
      boundaryFactor: args.boundary_factor,
      sampleSize: args.sample_size,
      threshold: args.duplicate_ratio !== undefined ? args.duplicate_ratio : args.threshold,
      autoAdjust: booleanFlag(args.auto_adjust, false),
    });
    const images = analyzed.images;
    delete analyzed.images;
    const preview = booleanFlag(args.preview, true)
      ? writeAnalyzePreview(args, project, payload, analyzed, images)
      : { skipped: true };
    return { ...payload, ...analyzed, preview };
  }

  /**
   * Estimates standing visual scales against a reference height.
   * @param {object} args Tool arguments.
   * @returns {object} Scale plan, optionally written to tuning.
   */
  function estimateVisual(args = {}) {
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const animationId = String(animation.id || animation.name);
    const targetHeightArg = args.target_height !== undefined ? Number(args.target_height) : null;
    if (targetHeightArg !== null && (!Number.isFinite(targetHeightArg) || targetHeightArg <= 0)) {
      throw new Error("target_height must be a finite number greater than 0.");
    }
    const metric = ["bbox", "body", "torso"].includes(String(args.metric || "body"))
      ? String(args.metric || "body")
      : "body";
    const equalize = booleanFlag(args.equalize);
    const measured = collectFramePaths(project, animation).map((filePath, index) => {
      const image = decodePngRgba(filePath);
      return { index, ...measureSpriteGeometry(image.data, image.width, image.height) };
    });
    let targetHeight = targetHeightArg;
    let referenceAnimationId = "";
    const referenceFrame = Number.isInteger(Number(args.reference_frame))
      ? Math.max(0, Number(args.reference_frame))
      : 0;
    if (args.reference_animation_id) {
      referenceAnimationId = String(args.reference_animation_id).trim();
      const reference = (profile.animations || []).find(
        (entry) => String(entry.id || entry.name) === referenceAnimationId,
      );
      if (!reference) throw new Error(`Reference animation not found: ${referenceAnimationId}`);
      const referenceMeasured = collectFramePaths(project, reference, "Reference frame").map(
        (filePath, index) => {
          const image = decodePngRgba(filePath);
          return { index, ...measureSpriteGeometry(image.data, image.width, image.height) };
        },
      );
      if (targetHeight === null) {
        const pose = referenceMeasured[Math.min(referenceFrame, referenceMeasured.length - 1)];
        targetHeight = metricHeight(pose, metric);
      }
    }
    if (targetHeight === null) {
      throw new Error("Provide target_height or reference_animation_id.");
    }
    const zoomRatio = args.zoom_ratio === undefined ? 1.12 : Number(args.zoom_ratio);
    if (!Number.isFinite(zoomRatio) || zoomRatio < 1) {
      throw new Error("zoom_ratio must be a finite number greater than or equal to 1.");
    }
    const estimated = estimateVisualScales(
      measured.map((frame) => metricHeight(frame, metric)),
      targetHeight,
      { zoomRatio, equalize },
    );
    const apply = shouldCommit(args);
    if (apply) {
      const paths = projectStore.projectPaths(project);
      const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
      applyEstimatedVisual(tuning, profile.id, animationId, estimated);
      projectStore.writeJson(paths.tuning, tuning);
    }
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId,
      referenceAnimationId: referenceAnimationId || undefined,
      referenceFrame,
      metric,
      mode: estimated.mode,
      targetHeight: estimated.targetHeight,
      nativeHeight: estimated.nativeHeight,
      groupScale: estimated.groupScale,
      zoomRatio,
      applied: apply,
      dryRun: !apply,
      zoomFrameCount: estimated.frames.filter((frame) => frame.reason === "zoom").length,
      frames: estimated.frames.map((frame, index) => ({
        ...frame,
        bboxH: measured[index].bboxH,
        bodyH: measured[index].bodyH,
        nearWhite: 0,
      })),
      sync: apply ? synchronize(project, booleanFlag(args.sync)) : { requested: false, ok: null },
    };
  }

  /**
   * Measures clip geometry, optionally against an idle reference.
   * @param {object} args Tool arguments.
   * @returns {object} Per-frame ruler.
   */
  function measureFrames(args = {}) {
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const frames = collectFramePaths(project, animation).map((filePath, index) => {
      const image = decodePngRgba(filePath);
      return { index, ...measureSpriteGeometry(image.data, image.width, image.height) };
    });
    let reference = null;
    let referenceAnimationId = "";
    const referenceFrame = Number.isInteger(Number(args.reference_frame))
      ? Math.max(0, Number(args.reference_frame))
      : 0;
    if (args.reference_animation_id) {
      referenceAnimationId = String(args.reference_animation_id).trim();
      const other = (profile.animations || []).find(
        (entry) => String(entry.id || entry.name) === referenceAnimationId,
      );
      if (!other) throw new Error(`Reference animation not found: ${referenceAnimationId}`);
      const measured = collectFramePaths(project, other, "Reference frame").map((filePath, index) => {
        const image = decodePngRgba(filePath);
        return { index, ...measureSpriteGeometry(image.data, image.width, image.height) };
      });
      reference = measured[Math.min(referenceFrame, measured.length - 1)];
    }
    const first = frames[0] || null;
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      referenceAnimationId: referenceAnimationId || undefined,
      referenceFrame,
      reference: reference
        ? {
            bboxH: reference.bboxH,
            bodyH: reference.bodyH,
            feetY: reference.feetY,
            cx: reference.cx,
            fx: reference.fx,
          }
        : undefined,
      frames: frames.map((frame) => ({
        ...frame,
        ...geometryDeltas(frame, reference, first),
      })),
    };
  }

  /**
   * Locks a clip to a reference pose or target bbox.
   * @param {object} args Tool arguments.
   * @returns {object} Plan or apply receipt.
   */
  function registerClip(args = {}) {
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const filePaths = collectFramePaths(project, animation);
    const frames = filePaths.map((filePath, index) => {
      const image = decodePngRgba(filePath);
      return { index, image, ...measureSpriteGeometry(image.data, image.width, image.height) };
    });
    const metric = ["bbox", "body", "torso"].includes(String(args.metric || "bbox"))
      ? String(args.metric || "bbox")
      : "bbox";
    const mode = String(args.mode || "equalize");
    const align = String(args.align || "cx");
    let reference = null;
    let referenceAnimationId = "";
    const referenceFrame = Number.isInteger(Number(args.reference_frame))
      ? Math.max(0, Number(args.reference_frame))
      : 0;
    if (args.reference_animation_id) {
      referenceAnimationId = String(args.reference_animation_id).trim();
      const other = (profile.animations || []).find(
        (entry) => String(entry.id || entry.name) === referenceAnimationId,
      );
      if (!other) throw new Error(`Reference animation not found: ${referenceAnimationId}`);
      const measured = collectFramePaths(project, other, "Reference frame").map((filePath, index) => {
        const image = decodePngRgba(filePath);
        return { index, ...measureSpriteGeometry(image.data, image.width, image.height) };
      });
      reference = measured[Math.min(referenceFrame, measured.length - 1)];
    }
    const targetHeight =
      args.target_bbox !== undefined
        ? Number(args.target_bbox)
        : reference
          ? metricHeight(reference, metric)
          : null;
    if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
      throw new Error("Provide target_bbox or reference_animation_id.");
    }
    const plan = planRegisterClip(frames, {
      mode,
      metric,
      align,
      targetHeight,
      reference,
      referenceFrame,
    });
    const apply = shouldCommit(args);
    if (apply) {
      withFileTransaction((transaction) => {
        frames.forEach((frame, index) => {
          assertWritableAnimationFrame(
            project,
            animation,
            filePaths[index],
            `Register refused frame ${index} outside the project workspace.`,
          );
          const placed = scaleAboutFeet(frame.image, frame, plan.frames[index]);
          transaction.writeFile(filePaths[index], encodePngRgba(placed.data, placed.width, placed.height));
        });
      });
    }
    const after = apply
      ? filePaths.map((filePath, index) => {
          const image = decodePngRgba(filePath);
          return { index, ...measureSpriteGeometry(image.data, image.width, image.height) };
        })
      : frames.map(({ image: _image, ...geometry }) => geometry);
    const first = after[0];
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      referenceAnimationId: referenceAnimationId || undefined,
      applied: apply,
      dryRun: booleanFlag(args.dry_run) || !apply,
      ...plan,
      frames: plan.frames.map((row, index) => ({
        ...row,
        ...after[index],
        ...geometryDeltas(after[index], reference, first),
      })),
    };
  }

  /**
   * Exports a red/cyan overlay of two frames.
   * @param {object} args Tool arguments.
   * @returns {object} Overlay receipt including `preview.path` for walk-lock visual QA.
   */
  function exportOverlay(args = {}) {
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const frames = animation.frames || [];
    if (frames.length < 1) throw new Error("Cannot overlay an animation without frames.");
    const last = frames.length - 1;
    const frameA = args.frame_a === undefined ? 0 : requireFrameIndex(args.frame_a, last);
    let imageB;
    let frameB =
      args.frame_b === undefined ? Math.min(frameA + 1, last) : requireFrameIndex(args.frame_b, last);
    const pathA = resolveAnimationFramePath(project, frames[frameA].path, animation);
    const imageA = decodePngRgba(pathA);
    if (args.reference_animation_id) {
      const other = (profile.animations || []).find(
        (entry) => String(entry.id || entry.name) === String(args.reference_animation_id).trim(),
      );
      if (!other) throw new Error(`Reference animation not found: ${args.reference_animation_id}`);
      const refFrames = other.frames || [];
      const refIndex =
        args.reference_frame === undefined
          ? 0
          : requireFrameIndex(args.reference_frame, refFrames.length - 1);
      imageB = decodePngRgba(resolveAnimationFramePath(project, refFrames[refIndex].path, other));
      frameB = refIndex;
    } else {
      imageB = decodePngRgba(resolveAnimationFramePath(project, frames[frameB].path, animation));
    }
    const overlay = composeRbOverlay(imageA, imageB);
    const animationId = String(animation.id || animation.name);
    const outputPath = resolveMcpArtifactPath(args.output_path, {
      root,
      artifactDir: currentArtifactDir(project),
      defaultName: `${profile.id}_${animationId}_overlay.png`,
      extensionPattern: /\.png$/i,
      extensionLabel: ".png",
      allowOutsideRoot: true,
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encodePngRgba(overlay.data, overlay.width, overlay.height));
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId,
      frameA,
      frameB,
      outputPath,
      mse: overlay.mse,
      legWidthA: overlay.legWidthA,
      legWidthB: overlay.legWidthB,
      preview: { path: outputPath, width: overlay.width, height: overlay.height },
    };
  }

  /**
   * Copies clip PNGs into a game-pack directory.
   * @param {object} args Tool arguments.
   * @returns {object} Copy receipt.
   */
  function exportPackSlot(args = {}) {
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const dest = path.resolve(String(args.dest || ""));
    if (!dest) throw new Error("dest is required.");
    fs.mkdirSync(dest, { recursive: true });
    clearNumberedPngs(dest);
    const frames = animation.frames || [];
    const last = Math.max(0, frames.length - 1);
    const start = args.start_frame === undefined ? 0 : requireFrameIndex(args.start_frame, last);
    const end = args.end_frame === undefined ? last : requireFrameIndex(args.end_frame, last);
    const copied = [];
    for (let index = start; index <= end; index += 1) {
      const source = resolveAnimationFramePath(project, frames[index].path, animation);
      const target = path.join(dest, `${index - start}.png`);
      fs.copyFileSync(source, target);
      copied.push(target);
    }
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      dest,
      slot: args.slot || "",
      view: args.view || "",
      copied: copied.length,
      paths: copied,
    };
  }

  function layerValidation(raw, layer = "all") {
    const requested = ["standalone", "bind", "gameplay"].includes(layer) ? layer : "all";
    const layers = { standalone: [], bind: [], gameplay: [] };
    const warningLayers = { standalone: [], bind: [], gameplay: [] };
    for (const message of raw.errors || []) layers[classifyValidationMessage(message)].push(message);
    for (const message of raw.warnings || []) warningLayers[classifyValidationMessage(message)].push(message);
    const selectedErrors = requested === "all" ? raw.errors : layers[requested];
    const selectedWarnings = requested === "all" ? raw.warnings : warningLayers[requested];
    return {
      ...raw,
      layer: requested,
      errors: selectedErrors,
      warnings: selectedWarnings,
      layers: {
        standalone: { errors: layers.standalone, warnings: warningLayers.standalone },
        bind: { errors: layers.bind, warnings: warningLayers.bind },
        gameplay: { errors: layers.gameplay, warnings: warningLayers.gameplay },
      },
      ok: selectedErrors.length === 0 && (!raw.strict || selectedWarnings.length === 0),
    };
  }

  async function validateProject(args = {}) {
    const project = registryProject(args.project_id || args.project, false);
    const raw = validateImport(
      {
        project: project.id,
        strict: args.strict === true,
        "require-gameplay": args.require_gameplay === true,
      },
      { root, projectStore },
    );
    return layerValidation({ ...raw, strict: args.strict === true }, args.layer || "all");
  }

  /**
   * Writes a magenta change-map or red/cyan onion of two animation frames.
   * @param {object} args Tool arguments.
   * @returns {object} Diff receipt with a real preview PNG.
   */
  function diffFrames(args = {}) {
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const frames = animation.frames || [];
    if (frames.length < 1) throw new Error("Cannot diff an animation without frames.");
    const last = frames.length - 1;
    const frameA = args.frame_a === undefined ? 0 : requireFrameIndex(args.frame_a, last);
    const frameB =
      args.frame_b === undefined ? Math.min(frameA + 1, last) : requireFrameIndex(args.frame_b, last);
    const pathA = resolveAnimationFramePath(project, frames[frameA].path, animation);
    const pathB = resolveAnimationFramePath(project, frames[frameB].path, animation);
    if (!pathA || !fs.existsSync(pathA) || !pathB || !fs.existsSync(pathB)) {
      throw new Error("Both frames must exist on disk before xsxb_diff_frames.");
    }
    const imageA = decodePngRgba(pathA);
    const imageB = decodePngRgba(pathB);
    const composed = composeFrameDiff(imageA, imageB, { mode: args.mode || "diff" });
    const animationId = String(animation.id || animation.name);
    const outputPath = resolveMcpArtifactPath(args.output_path, {
      root,
      artifactDir: currentArtifactDir(project),
      defaultName: `${profile.id}_${animationId}_${frameA}_${frameB}_${composed.mode}.png`,
      extensionPattern: /\.png$/i,
      extensionLabel: ".png",
      allowOutsideRoot: true,
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encodePngRgba(composed.data, composed.width, composed.height));
    const issues = Array.isArray(composed.issues) ? composed.issues : [];
    const qa = composed.qa || classifyInspectQa({ changedPixelCount: composed.changedPixelCount });
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId,
      frameA,
      frameB,
      mode: composed.mode,
      changedPixelCount: composed.changedPixelCount,
      qa,
      issues,
      next:
        qa === "warn"
          ? issues[0]
            ? `stop; ${issues[0]}`
            : "stop; frames are identical — confirm the wrong pair was not selected"
          : "open preview.path; import is not a visual pass",
      preview: { path: outputPath, width: composed.width, height: composed.height },
    };
  }

  /**
   * Validates Godot handoff including gameplay wiring and the idle scale contract.
   * When bound and standalone tuning, manifest identity, or frame PNG bytes
   * diverge from game-local copies, syncs through the same `synchronize` path
   * as `xsxb_sync_godot` first.
   * Evidence `cells` lists each blit `{id, frame}` in sheet order for measurable clips.
   * Clips with empty frames, zero decodable PNGs, or no measurable subject are listed in evidence `skipped`.
   * @param {object} args Tool arguments.
   * @returns {object} Gate payload; `ok` is the domain pass.
   */
  function validateForGodot(args = {}) {
    const project = registryProject(args.project_id || args.project, false);
    const requireGameplay = booleanFlag(args.require_gameplay, true);
    const strict = booleanFlag(args.strict, false);
    if (validGodotProjectRoot(project) && gameLocalAuthoringStale(project, projectStore, root)) {
      synchronize(project, true);
    }
    const raw = validateImport(
      {
        project: project.id,
        strict,
        "require-gameplay": requireGameplay,
      },
      { root, projectStore },
    );
    const manifest = manifestFor(project);
    const paths = projectStore.projectPaths(project);
    const overrides = projectStore.readJson(paths.tuning, EMPTY_TUNING).frame_box_overrides || {};
    const evidenceFrames = [];
    const evidenceCells = [];
    const evidenceSkipped = [];
    const clips = [];
    for (const profile of Array.isArray(manifest.profiles) ? manifest.profiles : []) {
      for (const animation of Array.isArray(profile.animations) ? profile.animations : []) {
        const animationId = String(animation.id || animation.name);
        const geos = [];
        const clipFrames = [];
        for (const [index, frame] of (animation.frames || []).entries()) {
          const filePath = resolveAnimationFramePath(project, frame.path, animation);
          if (!filePath || !fs.existsSync(filePath)) continue;
          const image = decodePngRgba(filePath);
          const stored = overrides[frameBoxKey(profile.id, animationId, index)];
          let hitbox = stored && typeof stored === "object" ? stored.hitbox || null : null;
          if (!hitbox) {
            hitbox =
              estimateFrameBoxes(filePath, {
                animationId,
                animationName: animation.name,
                type: animation.type,
              }).hitbox || null;
          }
          clipFrames.push({ image, hitbox });
          geos.push(measureKeyedSubject(image));
        }
        if (clipFrames.length) {
          if (clipHasMeasurableSubject(geos)) {
            const picked = pickValidationEvidenceFrameIndex(
              { id: animationId, name: animation.name },
              clipFrames,
            );
            evidenceFrames.push(clipFrames[picked].image);
            evidenceCells.push({ id: animationId, frame: picked });
          } else {
            evidenceSkipped.push({ id: animationId, reason: "unmeasurable_subject" });
            if (!Array.isArray(raw.warnings)) raw.warnings = [];
            raw.warnings.push(
              `${animationId}: unmeasurable transparent subject; omitted from evidence.cells`,
            );
          }
        } else if ((animation.frames || []).length > 0) {
          evidenceSkipped.push({ id: animationId, reason: "zero_decodable_frames" });
          if (!Array.isArray(raw.warnings)) raw.warnings = [];
          raw.warnings.push(`${animationId}: zero decodable frames; omitted from evidence.cells`);
        } else if (!(animation.frames || []).length) {
          evidenceSkipped.push({ id: animationId, reason: "empty_manifest_frames" });
          if (!Array.isArray(raw.warnings)) raw.warnings = [];
          raw.warnings.push(`${animationId}: empty manifest frames; omitted from evidence.cells`);
        }
        if (!clipFrames.length || !clipHasMeasurableSubject(geos)) continue;
        clips.push({
          id: animationId,
          kind: profile.kind || animation.type || "actor",
          type: animation.type || "",
          name: animation.name || animationId,
          grounded: !isFxOrAirborne({
            id: animationId,
            name: animation.name,
            type: animation.type,
            kind: profile.kind,
          }),
          feetYs: geos.map((geometry) => geometry.feetY),
          bodyHs: geos.map((geometry) => geometry.bodyH),
          canvasWs: geos.map((geometry) => geometry.canvasW),
          canvasHs: geos.map((geometry) => geometry.canvasH),
        });
      }
    }
    const scaleContract = evaluateScaleContract(clips);
    const sheet = composeValidationEvidence(evidenceFrames);
    const evidencePath = resolveMcpArtifactPath("", {
      root,
      artifactDir: currentArtifactDir(project),
      defaultName: `${project.id}_godot_evidence.png`,
      extensionPattern: /\.png$/i,
      extensionLabel: ".png",
    });
    const summaryPath = resolveMcpArtifactPath("", {
      root,
      artifactDir: currentArtifactDir(project),
      defaultName: `${project.id}_godot_run_summary.json`,
      extensionPattern: /\.json$/i,
      extensionLabel: ".json",
    });
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, encodePngRgba(sheet.data, sheet.width, sheet.height));
    const godot = describeGodotHandoff(project.projectRoot || "", project.id);
    const assembled = assembleGodotValidation(
      raw,
      scaleContract,
      {
        path: evidencePath,
        width: sheet.width,
        height: sheet.height,
        cells: evidenceCells,
        skipped: evidenceSkipped,
      },
      { strict, godot, summaryPath },
    );
    fs.writeFileSync(
      summaryPath,
      `${JSON.stringify(
        {
          ok: assembled.ok,
          qa: assembled.qa,
          next: assembled.next,
          projectId: project.id,
          errors: assembled.errors,
          warnings: assembled.warnings,
          scale_contract: assembled.scale_contract,
          godot,
          evidence: assembled.evidence,
        },
        null,
        2,
      )}\n`,
    );
    return assembled;
  }

  function setActiveProject(args = {}) {
    const project = registryProject(args.project_id || args.project, false);
    projectStore.setActiveProject(project.id);
    selectProject(project.id);
    return { activeProjectId: project.id, project: projectStore.projectForClient(project) };
  }

  function bindGodot(args = {}) {
    const project = registryProject(args.project_id || args.project, false);
    const previousRoot = project.projectRoot || "";
    const projectRoot = path.resolve(String(args.project_root || args.root || ""));
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
      throw new Error(`Godot project folder not found: ${projectRoot}`);
    }
    if (!fs.existsSync(path.join(projectRoot, "project.godot"))) {
      throw new Error(`Godot project.godot not found in ${projectRoot}`);
    }
    const updated = projectStore.setProjectRoot(project.id, projectRoot).project;
    selectProject(updated.id);
    return {
      projectId: updated.id,
      projectRoot: updated.projectRoot,
      previousRoot,
      godotProjectValid: Boolean(validGodotProjectRoot(updated)),
    };
  }

  /**
   * Writes a standalone smart-cutout next to a workspace PNG.
   * @param {object} args Tool arguments.
   * @returns {Promise<object>} Cutout receipt.
   */
  async function cutoutStandalonePng(args = {}) {
    const inputPath = requireExistingFile(args.file_path, "Cutout image");
    if (!PNG_NAME.test(inputPath)) throw new Error("file_path must be a PNG.");
    if (!isInsideDirectory(inputPath, root)) {
      throw new Error(
        `file_path must stay inside the XSXB workspace root (${root}). Received: ${args.file_path}`,
      );
    }
    const parsed = path.parse(inputPath);
    const outputPath = resolveMcpArtifactPath(args.output_path, {
      root,
      artifactDir: currentArtifactDir(),
      defaultName: `${parsed.name}_cut.png`,
      extensionPattern: PNG_NAME,
      extensionLabel: ".png",
    });
    const explicitCanvas = Number.isInteger(Number(args.output_width || args.canvas))
      ? Math.max(8, Number(args.output_width || args.canvas))
      : Number.isInteger(Number(args.output_height))
        ? Math.max(8, Number(args.output_height))
        : 0;
    const outputWidth = explicitCanvas
      ? Math.max(8, Number(args.output_width || args.canvas || explicitCanvas))
      : undefined;
    const outputHeight = explicitCanvas
      ? Math.max(8, Number(args.output_height || args.canvas || explicitCanvas))
      : undefined;
    const keyColor = args.key_color || args.color || undefined;
    const keyMode = String(args.key_mode || "smart");
    const cutoutImpl = cutoutPngFileImpl || cutoutPngFile;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const receipt = await Promise.resolve(
      cutoutImpl(inputPath, outputPath, {
        ...collectWorkbenchExtras(args),
        keyColor,
        outputWidth,
        outputHeight,
        force: booleanFlag(args.force),
        keyMode,
      }),
    );
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Cutout produced no file: ${outputPath}`);
    }
    const processedFrameCount = receipt.processedFrameCount ?? 1;
    const skippedFrameCount = Number(receipt.skippedFrameCount || 0);
    const outputImage = decodePngRgba(outputPath);
    let opaque = 0;
    for (let offset = 3; offset < outputImage.data.length; offset += 4) {
      if (outputImage.data[offset] > ALPHA_VISIBLE) opaque += 1;
    }
    const cornerAt = (x, y) => {
      const offset = (y * outputImage.width + x) * 4;
      return {
        r: outputImage.data[offset],
        g: outputImage.data[offset + 1],
        b: outputImage.data[offset + 2],
        a: outputImage.data[offset + 3],
      };
    };
    const receiptMode = String(args.receipt || "short");
    let inspectFeet;
    if (receiptMode === "full") {
      try {
        const overlay = overlayGridImage(
          { file_path: outputPath, ...overlayGridOptions(args) },
          { root, artifactDir: currentArtifactDir() },
        );
        inspectFeet = {
          overlayPath: overlay.overlay_path,
          overlay_id: overlay.overlay_id,
          view: overlay.view,
          note: "Still overlay only — source PNG is unchanged. Yellow 0,0 is outside the bitmap; last pixel row is group y=-1. Do not plant soles to 0,0 — plant the sole to y=-1. Look at overlay_path and report cell ids; do not OCR digits.",
        };
      } catch (error) {
        inspectFeet = {
          overlayPath: null,
          error: String(error && error.message ? error.message : error),
          note: "Overlay could not be rendered. Source PNG was not changed by this step.",
        };
      }
    }
    return {
      pipeline: receipt.pipeline || "smart_product",
      rematched: Boolean(receipt.rematched),
      keyed: Boolean(receipt.keyed),
      transparentRatio: 1 - opaque / Math.max(1, outputImage.width * outputImage.height),
      corners: [
        cornerAt(0, 0),
        cornerAt(outputImage.width - 1, 0),
        cornerAt(0, outputImage.height - 1),
        cornerAt(outputImage.width - 1, outputImage.height - 1),
      ],
      backgroundColor: receipt.backgroundColor,
      keyColor: keyColor || (receipt.keyed ? receipt.backgroundColor : null),
      output_path: outputPath,
      file_path: inputPath,
      outputWidth: receipt.outputWidth || outputWidth || outputImage.width || 0,
      outputHeight: receipt.outputHeight || outputHeight || outputImage.height || 0,
      processedFrameCount,
      skippedFrameCount,
      verify: {
        status: cutoutVerifyStatus({
          rematched: Boolean(receipt.rematched),
          keyed: Boolean(receipt.keyed),
          processedFrameCount,
          skippedFrameCount,
          frameCount: 1,
        }),
      },
      ...(inspectFeet ? { inspectFeet } : {}),
      preview: (() => {
        const flattened = flattenFrameBackground(outputImage, resolvePreviewBackground("magenta"));
        const previewPath = resolveMcpArtifactPath(undefined, {
          root,
          artifactDir: currentArtifactDir(),
          defaultName: `${parsed.name}_cut_preview.png`,
          extensionPattern: PNG_NAME,
          extensionLabel: ".png",
        });
        fs.mkdirSync(path.dirname(previewPath), { recursive: true });
        fs.writeFileSync(previewPath, encodePngRgba(flattened.data, flattened.width, flattened.height));
        return { kind: "magenta", path: previewPath };
      })(),
    };
  }

  async function cutoutAnimation(args = {}) {
    if (args.file_path) {
      if (args.frames !== undefined || args.start_frame !== undefined || args.end_frame !== undefined)
        throw new Error("Standalone cutout does not accept frame selection.");
      return cutoutStandalonePng(args);
    }
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const explicitCanvas = Number.isInteger(Number(args.output_width || args.canvas))
      ? Math.max(8, Number(args.output_width || args.canvas))
      : Number.isInteger(Number(args.output_height))
        ? Math.max(8, Number(args.output_height))
        : 0;
    const outputWidth = explicitCanvas
      ? Math.max(8, Number(args.output_width || args.canvas || explicitCanvas))
      : undefined;
    const outputHeight = explicitCanvas
      ? Math.max(8, Number(args.output_height || args.canvas || explicitCanvas))
      : undefined;
    const keyColor = args.key_color || args.color || undefined;
    const frames = Array.from(animation.frames || []);
    if (!frames.length) throw new Error("Cannot cut out an animation without frames.");
    const indexes = frameIndexes(args, frames.length);
    const selectedIndexes = new Set(indexes);
    if (args.apply_visual && indexes.length !== frames.length)
      throw new Error(
        "Partial cutout cannot bake group visual transforms; omit apply_visual or process the full animation.",
      );
    const jobs = [];
    const unsafePaths = [];
    for (const [index, frame] of frames.entries()) {
      if (!selectedIndexes.has(index)) continue;
      const rawPath = String(frame.path || "");
      if (!rawPath) continue;
      const absolutePath = resolveAnimationFramePath(project, rawPath, animation);
      if (!absolutePath) {
        unsafePaths.push(rawPath);
        continue;
      }
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Cutout refused missing on-disk frame ${index}: ${rawPath || absolutePath}`);
      }
      jobs.push({ index, absolutePath });
    }
    if (unsafePaths.length) {
      throw new Error(
        `Cutout refused frame paths outside the project workspace or Godot root: ${unsafePaths.join(", ")}`,
      );
    }
    if (!jobs.length) throw new Error("Cutout found no on-disk frames to process.");
    const paths = projectStore.projectPaths(project);
    const applyVisual = booleanFlag(args.apply_visual);
    const visualScales = applyVisual
      ? bakedVisualScales(
          projectStore.readJson(paths.tuning, EMPTY_TUNING),
          profile.id,
          String(animation.id || animation.name),
          frames.length,
        )
      : undefined;
    const manifest = manifestFor(project);
    const stored = (manifest.profiles || [])
      .find((entry) => entry.id === profile.id)
      ?.animations?.find(
        (entry) => String(entry.id || entry.name) === String(animation.id || animation.name),
      );
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-cutout-batch-"));
    const stagedJobs = jobs.map((job) => ({
      ...job,
      sourcePath: job.absolutePath,
      absolutePath: path.join(staging, `${job.index}.png`),
    }));
    let processedFrameCount = 0;
    let receipt = {
      pipeline: "smart_product",
      rematched: Boolean(explicitCanvas),
      backgroundColor: keyColor || "",
      outputWidth: outputWidth || 0,
      outputHeight: outputHeight || 0,
    };
    const fit = args.fit === undefined ? "none" : String(args.fit);
    const keyMode = String(args.key_mode || "smart");
    const receiptMode = String(args.receipt || "short");
    try {
      for (const job of stagedJobs) fs.copyFileSync(job.sourcePath, job.absolutePath);
      if (cutoutPngFileImpl) {
        for (const job of stagedJobs) {
          const temporaryPath = `${job.absolutePath}.cutout-tmp.png`;
          await cutoutPngFileImpl(job.absolutePath, temporaryPath, {
            ...collectWorkbenchExtras(args),
            keyColor,
            outputWidth,
            outputHeight,
            fit,
            keyMode,
          });
          if (!fs.existsSync(temporaryPath)) {
            throw new Error(`Cutout produced no file for frame ${job.index}: ${job.absolutePath}`);
          }
          fs.renameSync(temporaryPath, job.absolutePath);
          processedFrameCount += 1;
          if (stored?.frames?.[job.index] && outputWidth && outputHeight) {
            stored.frames[job.index].width = outputWidth;
            stored.frames[job.index].height = outputHeight;
          }
        }
      } else {
        receipt = cutoutFrameFiles(
          stagedJobs.map((job) => job.absolutePath),
          {
            ...collectWorkbenchExtras(args),
            keyColor,
            outputWidth,
            outputHeight,
            force: booleanFlag(args.force),
            frameScales: visualScales ? jobs.map((job) => visualScales[job.index]) : undefined,
            fit,
            keyMode,
          },
        );
        processedFrameCount = receipt.processedFrameCount;
        jobs.forEach((job, order) => {
          if (!stored?.frames?.[job.index]) return;
          const size = receipt.frameSizes?.[order];
          if (!size) return;
          stored.frames[job.index].width = size.width;
          stored.frames[job.index].height = size.height;
        });
      }
      let updatedTuning = null;
      if (applyVisual) {
        const animationId = String(animation.id || animation.name);
        const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
        tuning.values = tuning.values && typeof tuning.values === "object" ? tuning.values : {};
        tuning.values[`profiles.${profile.id}.groups.${animationId}.visual_size`] = 1;
        delete tuning.values[`profiles.${profile.id}.groups.${animationId}.visual_scale`];
        const overrides =
          tuning.frame_visual_overrides && typeof tuning.frame_visual_overrides === "object"
            ? tuning.frame_visual_overrides
            : {};
        const prefix = `${frameBoxKey(profile.id, animationId, 0).replace(/:0$/, ":")}`;
        for (const key of Object.keys(overrides)) {
          if (!key.startsWith(prefix)) continue;
          const current = overrides[key] && typeof overrides[key] === "object" ? overrides[key] : {};
          delete current.visual_size;
          delete current.visual_scale;
          if (!Object.keys(current).length) delete overrides[key];
          else overrides[key] = current;
        }
        tuning.frame_visual_overrides = overrides;
        updatedTuning = tuning;
      }
      withFileTransaction((transaction) => {
        for (const job of stagedJobs)
          transaction.writeFile(job.sourcePath, fs.readFileSync(job.absolutePath));
        transaction.writeJson(paths.manifest, manifest);
        if (updatedTuning) transaction.writeJson(paths.tuning, updatedTuning);
      });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    let inspectFeet = null;
    const lookCell = Math.min(
      1024,
      Math.max(8, Number(receipt.outputWidth || 0), Number(receipt.outputHeight || 0)),
    );
    if (receiptMode === "full") {
      try {
        const sheet = await exportSheet({
          project_id: project.id,
          profile_id: profile.id,
          animation_id: String(animation.id || animation.name),
          cell: lookCell,
          columns: Math.min(frames.length, 8),
          grid: true,
          normalize: "none",
          ...overlayGridOptions(args),
        });
        inspectFeet = {
          sheetPath: sheet.outputPath,
          cell: sheet.cell,
          grid: sheet.grid,
          note: "Contact sheet overlay only — source frames are unchanged. Yellow 0,0 is outside the bitmap (canvasAnchor y=height); last pixel row is group y=-1. Do not plant soles to 0,0 or they clip 1px — plant the sole to y=-1. Overlay paints row/col indices matching grid.cells; group x,y are in that JSON — do not OCR overlay digits. Use grid.cells[row][col] (row 0 = top, col 0 = left). If boots float above the last pixel, call xsxb_shift_frames with positive dy. Do not guess boots from pixel color. metrics.feetY is the boot sole and ignores connected bright slash/glow below it; confirm on the overlay before planting. xsxb_shift_frames is already in the catalog; if a client reports it not found, the session catalog is stale — reload the xsxb MCP server.",
        };
      } catch (error) {
        inspectFeet = {
          sheetPath: null,
          overlayOnly: true,
          error: String(error && error.message ? error.message : error),
          note: "Overlay sheet could not be rendered. Source frames were not changed by this step. Call xsxb_export_sheet once the workspace PNGs decode.",
        };
      }
    } else if (receipt.rematched || explicitCanvas) {
      inspectFeet = { sheetPath: null };
    }
    let preview = null;
    try {
      const lookFrames = jobs.map((job) =>
        flattenFrameBackground(decodePngRgba(job.absolutePath), resolvePreviewBackground("magenta")),
      );
      const lookSheet = renderContactSheet(lookFrames, {
        cell: lookCell,
        pad: 8,
        columns: Math.min(jobs.length, 8),
        grid: false,
        normalize: "none",
        labels: false,
      });
      const previewPath = resolveMcpArtifactPath(
        `${profile.id}_${String(animation.id || animation.name)}_cutout_preview.png`,
        {
          root,
          artifactDir: currentArtifactDir(project),
          defaultName: `${profile.id}_${String(animation.id || animation.name)}_cutout_preview.png`,
          extensionPattern: /\.png$/i,
          extensionLabel: ".png",
        },
      );
      fs.mkdirSync(path.dirname(previewPath), { recursive: true });
      fs.writeFileSync(previewPath, encodePngRgba(lookSheet.data, lookSheet.width, lookSheet.height));
      preview = { kind: "magenta", path: previewPath };
    } catch (error) {
      preview = {
        kind: "magenta",
        path: null,
        error: String(error && error.message ? error.message : error),
      };
    }
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      pipeline: receipt.pipeline,
      rematched: receipt.rematched,
      rematchMode: receipt.rematchMode || (receipt.rematched ? "shared" : "none"),
      fit: receipt.fit || fit,
      appliedVisual: applyVisual,
      frameScales: receipt.frameScales,
      keyed: Boolean(receipt.keyed),
      darkClothes: receipt.darkClothes,
      backgroundColor: receipt.backgroundColor,
      keyColor: keyColor || (receipt.keyed ? receipt.backgroundColor : null),
      outputWidth: receipt.outputWidth || outputWidth || 0,
      outputHeight: receipt.outputHeight || outputHeight || 0,
      frameCount: frames.length,
      selectedFrames: indexes,
      selectedFrameCount: jobs.length,
      processedFrameCount,
      skippedFrameCount: Number(receipt.skippedFrameCount || 0),
      verify: {
        status: cutoutVerifyStatus({
          rematched: Boolean(receipt.rematched),
          keyed: Boolean(receipt.keyed),
          processedFrameCount,
          skippedFrameCount: Number(receipt.skippedFrameCount || 0),
          frameCount: jobs.length,
        }),
      },
      preview,
      inspectFeet,
      metrics: booleanFlag(args.metrics, true)
        ? summarizeMetrics(
            jobs.map((job) => {
              try {
                const image = decodePngRgba(job.absolutePath);
                return { index: job.index, ...measureFrame(image.data, image.width, image.height) };
              } catch (error) {
                return {
                  index: job.index,
                  bodyHeight: 0,
                  bodyWidth: 0,
                  feetY: 0,
                  cy: 0,
                  opaque: 0,
                  nearWhite: 0,
                  error: String(error && error.message ? error.message : error),
                };
              }
            }),
          )
        : undefined,
      sync: synchronize(project, booleanFlag(args.sync)),
    };
  }

  function summarizeAttackTrailSticks(sticks) {
    const frames = sticks.map((stick) => Number(stick.frame) || 0);
    const frameSpan = frames.length ? Math.max(...frames) - Math.min(...frames) : 0;
    const centerTravel = Math.round(stickCenterTravel(sticks) * 10) / 10;
    const edgeTravel = Math.round(bladeEdgeTravel(sticks) * 10) / 10;
    let note = null;
    if (sticks.length >= 2 && frameSpan <= 0) {
      note = "Both sticks are on the same frame. The trail blooms on that frame only.";
    }
    return { frameSpan, centerTravel, edgeTravel, note };
  }

  async function addAttackTrail(args = {}) {
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const paths = projectStore.projectPaths(project);
    const trails = normalizeAttackTrails(projectStore.readJson(paths.attackTrails, EMPTY_ATTACK_TRAILS));
    const bindingKey = `${profile.id}/${animation.id || animation.name}`;
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot add an attack trail to an animation without frames.");
    const lastFrame = frames.length - 1;
    const renderMode = String(args.render_mode ?? "mesh").toLowerCase() === "sweep" ? "sweep" : "mesh";
    if (
      args.render_mode !== undefined &&
      !["mesh", "sweep"].includes(String(args.render_mode).toLowerCase())
    ) {
      throw new Error('render_mode must be "mesh" or "sweep".');
    }
    if (renderMode === "sweep") assertSweepSticks(args.sticks);
    const trailDurationMs = Number(args.trail_duration_ms ?? 150);
    if (!Number.isFinite(trailDurationMs) || trailDurationMs < 1 || trailDurationMs > 5000) {
      throw new Error("trail_duration_ms must be between 1 and 5000.");
    }
    const opacity = Number(args.opacity ?? 0.85);
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new Error("opacity must be between 0 and 1.");
    }
    const width = Number(frames[0]?.width || 320);
    const height = Number(frames[0]?.height || 320);
    const startFrame = Number.isInteger(Number(args.start_frame))
      ? Math.min(lastFrame, Math.max(0, Number(args.start_frame)))
      : 0;
    const endFrame = Number.isInteger(Number(args.end_frame))
      ? Math.min(lastFrame, Math.max(startFrame, Number(args.end_frame)))
      : lastFrame;
    let texture = DEFAULT_ATTACK_TRAIL_PRESET_TEXTURE;
    if (args.texture_path) {
      const absolute = requireExistingFile(args.texture_path, "Trail texture");
      const buffer = fs.readFileSync(absolute);
      const info = pngInfo(buffer);
      const hash = crypto.createHash("sha256").update(buffer).digest("hex");
      const destDir = path.join(
        projectStore.projectWorkspaceDir(project),
        "attack_trails",
        profile.id,
        String(animation.id || animation.name),
      );
      fs.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, `${hash}.png`);
      fs.writeFileSync(destPath, buffer);
      texture = {
        path: reslash(path.relative(root, destPath)),
        assetHash: hash,
        name: path.basename(absolute),
        type: "image/png",
        width: info.width,
        height: info.height,
        hasEffectiveAlpha: info.hasEffectiveAlpha,
      };
    }
    const defaultSticks = [
      {
        frame: startFrame,
        top: { x: -width * 0.15, y: -height * 0.3 },
        bottom: { x: width * 0.15, y: height * 0.1 },
      },
      {
        frame: endFrame,
        top: { x: width * 0.15, y: -height * 0.3 },
        bottom: { x: -width * 0.15, y: height * 0.1 },
      },
    ];
    const sticks = (Array.isArray(args.sticks) && args.sticks.length ? args.sticks : defaultSticks).map(
      (stick, index) => {
        if (!stick || typeof stick !== "object") return stick;
        const stickFrame = Number.isInteger(Number(stick.frame))
          ? requireFrameIndex(stick.frame, lastFrame)
          : startFrame;
        const stickRecord = frames[stickFrame] || frames[0];
        const stickPath = resolveAnimationFramePath(project, stickRecord?.path, animation);
        const needsStickImage =
          String(args.grid_scope || "") === "subject" || cellIdToken(stick.top) || cellIdToken(stick.bottom);
        const stickImage =
          needsStickImage && stickPath && fs.existsSync(stickPath) ? decodePngRgba(stickPath) : undefined;
        const pointOptions = writePointOptions(animation, stickRecord, args, stickImage);
        const top = parseWritePoint(stick.top, { ...pointOptions, label: `sticks[${index}].top` });
        const bottom = parseWritePoint(stick.bottom, { ...pointOptions, label: `sticks[${index}].bottom` });
        return {
          ...stick,
          ...(top ? { top } : {}),
          ...(bottom ? { bottom } : {}),
        };
      },
    );
    const pathKind = normalizeTrailPathKind(args.path_kind);
    if (renderMode === "sweep") assertSweepSticks(sticks);
    const segmentId = slug(
      args.id ||
        (args.texture_path ? path.basename(args.texture_path, path.extname(args.texture_path)) : "trail"),
      "trail",
    );
    const segment = {
      id: segmentId,
      name: String(args.name || segmentId),
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      texture,
      colorMode: args.color_mode || args.colorMode || "solid",
      color: args.color || "#d9364a",
      renderMode,
      trailDurationMs,
      opacity,
      pathKind,
      generated: renderMode === "sweep" || pathKind !== "polyline",
      ...(renderMode === "sweep" ? { layer: String(sticks[0].layer || "behind") } : {}),
      sticks,
    };
    if (args.before_stop_chase !== undefined) segment.beforeStopChaseMultiplier = args.before_stop_chase;
    if (args.after_stop_chase !== undefined) segment.afterStopChaseMultiplier = args.after_stop_chase;
    trails.bindings[bindingKey] = [
      ...(trails.bindings[bindingKey] || []).filter((entry) => entry.id !== segment.id),
      segment,
    ];
    const normalized = normalizeAttackTrails(trails);
    const warnings = validateAttackTrails(normalized, selection.manifest);
    projectStore.writeJson(paths.attackTrails, normalized);
    const written = normalized.bindings[bindingKey].find((entry) => entry.id === segment.id);
    return {
      projectId: project.id,
      bindingKey,
      segment: written,
      pathKind: written?.pathKind || pathKind,
      renderMode: written?.renderMode || renderMode,
      useMesh: (written?.renderMode || renderMode) === "mesh" && trailUsesHermiteMesh(written || segment),
      ...summarizeAttackTrailSticks(written?.sticks || []),
      warnings: [
        ...warnings,
        ...(renderMode === "sweep" && booleanFlag(args.sync)
          ? ["render_mode=sweep is baked by MCP exports; the Godot runtime currently uses its mesh fallback."]
          : []),
      ],
      sync: synchronize(project, booleanFlag(args.sync)),
    };
  }

  async function addAttachment(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot attach an image to an animation without frames.");
    const batch = Array.isArray(args.frames) && args.frames.length > 0;
    const requests = batch
      ? args.frames
      : [
          {
            frame: args.frame || 0,
            offset_x: args.offset_x,
            offset_y: args.offset_y,
            scale: args.scale,
            rotation: args.rotation,
          },
        ];
    const absolute = requireExistingFile(args.file_path, "Attachment image");
    if (!/\.png$/i.test(absolute)) throw new Error("Attachment image must be a PNG.");
    const paths = projectStore.projectPaths(project);
    const bindings = projectStore.readJson(paths.frameImageAttachments, []);
    const name = String(args.name || path.basename(absolute));
    const id = slug(args.id || path.basename(absolute, path.extname(absolute)), "attachment");
    const defaultScale = Number(args.scale ?? 1);
    if (!Number.isFinite(defaultScale) || defaultScale <= 0) {
      throw new Error("scale must be a finite number greater than zero.");
    }
    const requestedOrder = args.layer_order ?? args.layerOrder;
    const layer = String(args.layer || "above").toLowerCase();
    if (layer !== "above" && layer !== "below") throw new Error("layer must be either above or below.");
    const layerOrder =
      requestedOrder === undefined || requestedOrder === null || requestedOrder === ""
        ? layer === "below"
          ? -1
          : 1
        : Number(requestedOrder);
    if (!Number.isFinite(layerOrder)) throw new Error("layer_order must be a finite number.");
    const attachmentImage = decodePngRgba(absolute);
    const added = [];
    let next = Array.isArray(bindings) ? bindings.slice() : [];
    for (const request of requests) {
      if (!request || typeof request !== "object") {
        throw new Error("Each frames item must be an object with a frame index.");
      }
      const frame = requireFrameIndex(request.frame ?? 0, frames.length - 1);
      const key = `${profile.id}/${animation.id || animation.name}:${frame}`;
      const source = frames[frame] || frames[0];
      const scale = Number(request.scale ?? defaultScale);
      if (!Number.isFinite(scale) || scale <= 0)
        throw new Error("scale must be a finite number greater than zero.");
      const sourcePath = resolveAnimationFramePath(project, source.path, animation);
      const needsHandImage =
        String(args.grid_scope || "") === "subject" || cellIdToken(request.hand ?? args.hand);
      const sourceImage =
        needsHandImage && sourcePath && fs.existsSync(sourcePath) ? decodePngRgba(sourcePath) : undefined;
      const handReference = request.hand ?? args.hand;
      const hand =
        handReference && typeof handReference === "object" && handReference.region_id
          ? (() => {
              if (
                Object.keys(handReference).some((key) => !["region_id", "basis_snapshot_id"].includes(key))
              ) {
                throw new Error("hand region reference cannot combine with other coordinates.");
              }
              const resolved = resolvePerceptionRegion(handReference, sourcePath, { root });
              const origin = canvasAnchor(
                resolved.width,
                resolved.height,
                animation.anchorMode || "canvas_bottom_center",
              );
              return { x: resolved.x - origin.x, y: resolved.y - origin.y };
            })()
          : parseWritePoint(handReference, {
              ...writePointOptions(animation, source, args, sourceImage),
              label: "hand",
            });
      const gripT = request.t !== undefined ? request.t : args.t;
      let offsetX = Number(request.offset_x ?? args.offset_x ?? 0);
      let offsetY =
        request.offset_y === undefined
          ? args.offset_y === undefined
            ? -Number(source.height || 100) * 0.2
            : Number(args.offset_y)
          : Number(request.offset_y);
      if (hand) {
        const measured = measureLongAxis(
          attachmentImage.data,
          attachmentImage.width,
          attachmentImage.height,
          {
            t: gripT === undefined ? 0.5 : gripT,
          },
        );
        const rotation = Number(request.rotation ?? args.rotation ?? 0);
        if (!Number.isFinite(rotation)) throw new Error("rotation must be a finite number.");
        const radians = (rotation * Math.PI) / 180;
        const cos = Math.cos(radians) * scale;
        const sin = Math.sin(radians) * scale;
        offsetX = hand.x - (cos * measured.localFromCenter.x - sin * measured.localFromCenter.y);
        offsetY = hand.y - (sin * measured.localFromCenter.x + cos * measured.localFromCenter.y);
      } else if (request.rotation !== undefined || args.rotation !== undefined) {
        const rotation = Number(request.rotation ?? args.rotation);
        if (!Number.isFinite(rotation)) throw new Error("rotation must be a finite number.");
      }
      const rotation = Number(request.rotation ?? args.rotation ?? 0);
      if (![offsetX, offsetY, rotation].every(Number.isFinite)) {
        throw new Error("Attachment offset and rotation must be finite numbers.");
      }
      const attachment = {
        id,
        key,
        frameKey: key,
        frame,
        name,
        path: null,
        type: "image/png",
        layer,
        layerOrder,
        transform: {
          offset: { x: offsetX, y: offsetY },
          scale: { x: scale, y: scale },
          rotation,
        },
        metadata: {
          profileId: profile.id,
          animation: `${profile.id}/${animation.id || animation.name}`,
          frame,
          ...(handReference?.region_id
            ? { grip: { ...handReference, t: gripT ?? 0.5, hand, space: "group" } }
            : {}),
        },
      };
      next = next.filter((entry) => entry.id !== id || entry.key !== key);
      next.push(attachment);
      added.push(attachment);
    }
    const relativePath = copyIntoWorkspace(
      project,
      path.join("attachments", profile.id, String(animation.id || animation.name)),
      absolute,
    );
    for (const attachment of added) attachment.path = relativePath;
    projectStore.writeJson(paths.frameImageAttachments, next);
    const base = {
      projectId: project.id,
      bindingCount: next.length,
      sync: synchronize(project, booleanFlag(args.sync)),
    };
    if (!batch) return { ...base, binding: added[0], space: "group" };
    return {
      ...base,
      updatedFrames: added.length,
      bindings: added,
      binding: added[added.length - 1],
      space: "group",
    };
  }

  async function addSfx(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot bind SFX to an animation without frames.");
    const frame = requireFrameIndex(args.frame || 0, frames.length - 1);
    const paths = projectStore.projectPaths(project);
    const bindings = readSfxBindings(paths);
    const key = `${profile.id}/${animation.id || animation.name}:${frame}`;
    const absolute = requireExistingFile(args.file_path, "SFX file");
    const mime = audioMimeType(absolute);
    const buffer = fs.readFileSync(absolute);
    const name = String(args.name || path.basename(absolute));
    const id = slug(args.id || path.basename(absolute, path.extname(absolute)), "sfx");
    const relativePath = copyIntoWorkspace(project, path.join("audio", profile.id), absolute);
    const binding = {
      id,
      key,
      name,
      type: mime,
      size: buffer.length,
      path: relativePath,
      data: `data:${mime};base64,${buffer.toString("base64")}`,
      metadata: {
        profileId: profile.id,
        animation: `${profile.id}/${animation.id || animation.name}`,
        frame,
      },
    };
    const next = [...bindings.filter((entry) => entry.key !== key || entry.id !== binding.id), binding];
    projectStore.writeJson(paths.frameAudio, next);
    return {
      projectId: project.id,
      binding: { ...binding, data: `[${mime} omitted]` },
      bindingCount: next.length,
      sync: synchronize(project, booleanFlag(args.sync)),
    };
  }

  function removeBinding(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const kind = String(args.kind || "")
      .trim()
      .toLowerCase();
    if (!["sfx", "attachment", "trail"].includes(kind)) {
      throw new Error('kind must be one of "sfx", "attachment", or "trail".');
    }
    const id = String(args.id || "").trim();
    if (!id) throw new Error("id is required.");
    const animationId = String(animation.id || animation.name);
    const bindingKey = `${profile.id}/${animationId}`;
    const framePrefix = `${bindingKey}:`;
    const dryRun = booleanFlag(args.dry_run);
    const paths = projectStore.projectPaths(project);
    let frameFilter = null;
    if (args.frame !== undefined) {
      if (kind === "trail") throw new Error("frame is not applicable to trail bindings.");
      frameFilter = requireFrameIndex(args.frame, Math.max(0, (animation.frames || []).length - 1));
    }
    const summarize = (entry) => {
      const { data, ...rest } = entry;
      return rest;
    };
    let removed;
    let remainingCount;
    let write;
    if (kind === "trail") {
      const trails = normalizeAttackTrails(projectStore.readJson(paths.attackTrails, EMPTY_ATTACK_TRAILS));
      const segments = trails.bindings[bindingKey] || [];
      removed = segments.filter((segment) => String(segment.id) === id);
      const kept = segments.filter((segment) => String(segment.id) !== id);
      if (!removed.length) {
        const available = segments.map((segment) => String(segment.id));
        throw new Error(`Trail segment not found: ${id}. Available: ${available.join(", ") || "(none)"}`);
      }
      remainingCount = kept.length;
      write = () => {
        if (kept.length) trails.bindings[bindingKey] = kept;
        else delete trails.bindings[bindingKey];
        projectStore.writeJson(paths.attackTrails, normalizeAttackTrails(trails));
      };
    } else {
      const file = kind === "sfx" ? paths.frameAudio : paths.frameImageAttachments;
      const bindings =
        kind === "sfx"
          ? readSfxBindings(paths)
          : (() => {
              const raw = projectStore.readJson(file, []);
              return Array.isArray(raw) ? raw : [];
            })();
      const matches = (entry) => {
        const key = String(entry?.key || entry?.frameKey || "");
        if (!key.startsWith(framePrefix)) return false;
        if (String(entry?.id) !== id) return false;
        if (frameFilter !== null && key !== `${framePrefix}${frameFilter}`) return false;
        return true;
      };
      removed = bindings.filter(matches);
      const kept = bindings.filter((entry) => !matches(entry));
      if (!removed.length) {
        const available = [
          ...new Set(
            bindings
              .filter((entry) => String(entry?.key || entry?.frameKey || "").startsWith(framePrefix))
              .map((entry) => String(entry?.id)),
          ),
        ];
        throw new Error(
          `${kind} binding not found: ${id}${frameFilter !== null ? ` on frame ${frameFilter}` : ""}. Available: ${available.join(", ") || "(none)"}`,
        );
      }
      remainingCount = kept.length;
      write = () => projectStore.writeJson(file, kept);
    }
    if (!dryRun) write();
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId,
      kind,
      id,
      frame: frameFilter,
      dryRun,
      removed: removed.map(summarize),
      removedCount: removed.length,
      remainingCount,
      sync: synchronize(project, dryRun ? false : booleanFlag(args.sync)),
    };
  }

  async function reorganizeFrames(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    const hasOrder = Array.isArray(args.order) && args.order.length > 0;
    const dryRun = !hasOrder || booleanFlag(args.dry_run);
    let order = Array.isArray(args.order) ? args.order.map(Number) : frames.map((_, index) => index);
    if (String(args.loop_endpoint || "none") === "duplicate_first" && frames.length) {
      order = [...order, 0];
    }
    if (
      !order.length ||
      order.some((index) => !Number.isInteger(index) || index < 0 || index >= frames.length)
    ) {
      throw new Error(
        `Frame order must contain valid source indexes between 0 and ${Math.max(0, frames.length - 1)}.`,
      );
    }
    const result = dryRun
      ? { frameCount: order.length }
      : reorganizeAnimation({
          root,
          projectStore,
          project,
          profileId: profile.id,
          animationId: String(animation.id || animation.name),
          items: order.map((sourceIndex) => ({
            sourceIndex,
            sourcePath: frames[sourceIndex].path,
            frameId: frames[sourceIndex].id,
          })),
        });
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      applied: !dryRun,
      dryRun,
      inputFrameCount: frames.length,
      outputFrameCount: result.frameCount,
      order,
      identityOrder:
        order.length === frames.length && order.every((sourceIndex, index) => sourceIndex === index),
      fps: Number(animation.fps || 0),
      targetDirectory: result.targetDir,
      sync: synchronize(project, !dryRun && booleanFlag(args.sync)),
    };
  }

  function replaceFrame(args = {}) {
    const selection = animationFor(args);
    const { project, manifest, profile, animation } = selection;
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot replace a frame on an animation without frames.");
    if (args.frame === undefined) throw new Error("frame is required.");
    const frame = requireFrameIndex(args.frame, frames.length - 1);
    const absolute = requireExistingFile(args.file_path, "Replacement frame");
    if (!PNG_NAME.test(absolute)) throw new Error("Replacement frame must be a PNG.");
    const buffer = fs.readFileSync(absolute);
    let info;
    try {
      info = pngInfo(buffer);
    } catch {
      throw new Error("Replacement frame must be a valid PNG file.");
    }
    const target = resolveAnimationFramePath(project, frames[frame].path, animation);
    assertWritableAnimationFrame(
      project,
      animation,
      target,
      "Only workspace-managed frames can be replaced; this frame lives outside the project workspace.",
    );
    const previousSize = {
      width: Number(frames[frame].width || 0),
      height: Number(frames[frame].height || 0),
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tempPath = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, target);
    const newSize = { width: info.width, height: info.height };
    const sizeChanged = newSize.width !== previousSize.width || newSize.height !== previousSize.height;
    if (sizeChanged) {
      frames[frame].width = newSize.width;
      frames[frame].height = newSize.height;
      projectStore.writeJson(projectStore.projectPaths(project).manifest, manifest);
    }
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      frame,
      path: reslash(path.relative(root, target)),
      previousSize,
      newSize,
      sizeChanged,
      warnings: sizeChanged
        ? ["Frame size changed; existing boxes, attachments, and trails keep their old coordinates."]
        : [],
      sync: synchronize(project, booleanFlag(args.sync)),
    };
  }

  /**
   * Stages ordered frame shifts and commits their pixels and dimensions together.
   * @param {object} args Animation selector and per-frame shifts.
   * @returns {object} Committed shift receipt.
   */
  function shiftFrames(args = {}) {
    const selection = animationFor(args);
    const { project, manifest, profile, animation } = selection;
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot shift frames on an animation without frames.");
    const rawShifts = Array.isArray(args.frames) ? args.frames : [];
    if (!rawShifts.length) throw new Error("frames is required; each entry needs frame plus dx and/or dy.");
    const shifted = [];
    let sizeChanged = false;
    withFileTransaction((transaction) => {
      for (const entry of rawShifts) {
        if (!entry || typeof entry !== "object") continue;
        if (entry.frame === undefined) throw new Error("Each shift entry needs frame.");
        const index = requireFrameIndex(entry.frame, frames.length - 1);
        const target = resolveAnimationFramePath(project, frames[index].path, animation);
        assertWritableAnimationFrame(
          project,
          animation,
          target,
          `Shift refused frame ${index} outside the project workspace.`,
        );
        if (!fs.existsSync(target)) throw new Error(`Shift refused missing on-disk frame ${index}.`);
        const image = decodePngRgba(transaction.readPath(target));
        const pointOptions = writePointOptions(animation, frames[index], args, image);
        const from = parseWritePoint(entry.from, { ...pointOptions, label: "from" });
        const to = parseWritePoint(entry.to, { ...pointOptions, label: "to" });
        let dx = Math.trunc(Number(entry.dx) || 0);
        let dy = Math.trunc(Number(entry.dy) || 0);
        if (from || to) {
          if (!from || !to) throw new Error("Each shift entry with from/to needs both group points.");
          dx = Math.trunc(to.x - from.x);
          dy = Math.trunc(to.y - from.y);
        }
        if (dx === 0 && dy === 0) {
          shifted.push({ frame: index, dx: 0, dy: 0, skipped: true });
          continue;
        }
        const geometry = measureSpriteGeometry(image.data, image.width, image.height);
        const destMaxY = Number(geometry.maxY) + dy;
        const outHeight = Math.max(image.height, destMaxY + 1);
        const next = shiftPlantedRgba(image.data, image.width, image.height, dx, dy, outHeight);
        transaction.writeFile(target, encodePngRgba(next, image.width, outHeight));
        if (
          Number(frames[index].width || 0) !== image.width ||
          Number(frames[index].height || 0) !== outHeight
        ) {
          frames[index].width = image.width;
          frames[index].height = outHeight;
          sizeChanged = true;
        }
        shifted.push({ frame: index, dx, dy, width: image.width, height: outHeight });
      }
      if (!shifted.length) throw new Error("frames is required; each entry needs frame plus dx and/or dy.");
      if (sizeChanged) {
        transaction.writeJson(projectStore.projectPaths(project).manifest, manifest);
      }
    });
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      shifted,
      space: "group",
      sync: synchronize(project, booleanFlag(args.sync)),
    };
  }

  /**
   * Plants opaque soles onto a target group-Y. Translate only.
   * When `reference_animation_id` is set, pads to at least that canvas first
   * (same origin-preserving pad as `xsxb_resize_canvas`). If omitted on a
   * grounded non-idle actor and the profile has an idle clip, that idle is
   * the reference (pad + median sole). Idle itself stays y=-1 of its canvas.
   * If `target_y` is omitted or -1, plants onto the reference clip's measured
   * sole (median feetY of that clip, not the first hang-heavier frame). An
   * explicit `target_y` other than -1 is honored after the pad. After apply
   * plans every selected frame, pads all frames in this animation to the
   * clip's on-disk max(width)×max(height) so canvases match for diff_frames.
   * @param {object} args Tool arguments.
   * @returns {object} Plant receipt.
   */
  function plantFeet(args = {}) {
    const selection = animationFor(args);
    const { project, manifest, profile, animation } = selection;
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot plant feet on an animation without frames.");
    const lastIndex = frames.length - 1;
    let indexes;
    if (args.frames === undefined || args.frames === null || args.frames === "") {
      indexes = frames.map((_, index) => index);
    } else if (!Array.isArray(args.frames) || args.frames.length === 0) {
      throw new Error("frames must be a non-empty int array, or omit to plant every frame.");
    } else {
      indexes = args.frames.map((value) => requireFrameIndex(value, lastIndex));
    }
    const apply = shouldCommit(args);
    const clipLooksIdle = (clip) =>
      [clip?.id, clip?.name].some((value) =>
        String(value || "")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .includes("idle"),
      );
    let referenceAnimationId = "";
    if (args.reference_animation_id !== undefined) {
      referenceAnimationId = String(args.reference_animation_id || "").trim();
    } else if (
      !isFxOrAirborne({
        id: animation.id,
        name: animation.name,
        type: animation.type,
        kind: animation.kind || profile.kind,
      }) &&
      !clipLooksIdle(animation)
    ) {
      const idle = (profile.animations || []).find((entry) => clipLooksIdle(entry));
      if (idle) referenceAnimationId = String(idle.id || idle.name);
    }
    let lockWidth = 0;
    let lockHeight = 0;
    let referenceSoleGroupY = Number.NaN;
    if (referenceAnimationId) {
      const reference = (profile.animations || []).find(
        (entry) => String(entry.id || entry.name) === referenceAnimationId,
      );
      if (!reference) throw new Error(`Reference animation not found: ${referenceAnimationId}`);
      const referenceImages = collectFramePaths(project, reference, "Reference frame").map((filePath) =>
        decodePngRgba(filePath),
      );
      lockWidth = Math.max(0, ...referenceImages.map((image) => image.width));
      lockHeight = Math.max(0, ...referenceImages.map((image) => image.height));
      const anchorMode = reference.anchorMode || animation.anchorMode || "canvas_bottom_center";
      const soleRows = [];
      for (const image of referenceImages) {
        const aligned =
          image.width === lockWidth && image.height === lockHeight
            ? image
            : padFramePreserveOrigin(image, lockWidth, lockHeight, anchorMode);
        const geometry = measureSpriteGeometry(aligned.data, aligned.width, aligned.height);
        if (Number.isFinite(Number(geometry.feetY))) soleRows.push(Number(geometry.feetY));
      }
      if (soleRows.length) {
        const sorted = soleRows.slice().sort((left, right) => left - right);
        const referenceSoleCanvasY = sorted[Math.floor(sorted.length / 2)];
        const origin = canvasAnchor(lockWidth, lockHeight, anchorMode);
        referenceSoleGroupY = referenceSoleCanvasY - origin.y;
      }
    }
    const rawTargetY = args.target_y;
    const defaultPlantTarget =
      rawTargetY === undefined || rawTargetY === null || rawTargetY === "" || Number(rawTargetY) === -1;
    const targetY =
      referenceAnimationId && defaultPlantTarget && Number.isFinite(referenceSoleGroupY)
        ? referenceSoleGroupY
        : rawTargetY;
    const receipts = [];
    let sizeChanged = false;
    withFileTransaction((transaction) => {
      for (const index of indexes) {
        const target = resolveAnimationFramePath(project, frames[index].path, animation);
        assertWritableAnimationFrame(
          project,
          animation,
          target,
          `Plant refused frame ${index} outside the project workspace.`,
        );
        if (!fs.existsSync(target)) throw new Error(`Plant refused missing on-disk frame ${index}.`);
        const image = decodePngRgba(transaction.readPath(target));
        const destWidth = Math.max(image.width, lockWidth);
        const destHeight = Math.max(image.height, lockHeight);
        const padded = padFramePreserveOrigin(image, destWidth, destHeight, animation.anchorMode);
        const planned = planPlantFeet(padded.data, padded.width, padded.height, {
          targetY,
          to: args.to,
          ...writePointOptions(animation, frames[index], args, padded),
        });
        const outHeight = Math.max(padded.height, Number(planned.outHeight) || padded.height);
        const outWidth = padded.width;
        const grew =
          planned.dy !== 0 ||
          outHeight > padded.height ||
          outWidth !== image.width ||
          padded.height !== image.height;
        if (apply && grew) {
          const next = shiftPlantedRgba(padded.data, padded.width, padded.height, 0, planned.dy, outHeight);
          transaction.writeFile(target, encodePngRgba(next, outWidth, outHeight));
        }
        if (apply) {
          if (
            Number(frames[index].width || 0) !== outWidth ||
            Number(frames[index].height || 0) !== outHeight
          ) {
            frames[index].width = outWidth;
            frames[index].height = outHeight;
            sizeChanged = true;
          }
        }
        receipts.push({
          index,
          feetY: planned.feetY,
          dy: planned.dy,
          targetY: planned.targetY,
          width: outWidth,
          height: outHeight,
        });
      }
      if (apply && frames.length) {
        const clipImages = [];
        for (let index = 0; index < frames.length; index += 1) {
          const target = resolveAnimationFramePath(project, frames[index].path, animation);
          assertWritableAnimationFrame(
            project,
            animation,
            target,
            `Plant refused frame ${index} outside the project workspace.`,
          );
          if (!fs.existsSync(target)) throw new Error(`Plant refused missing on-disk frame ${index}.`);
          clipImages.push({
            index,
            target,
            image: decodePngRgba(transaction.readPath(target)),
          });
        }
        const destWidth = Math.max(...clipImages.map((entry) => entry.image.width));
        const destHeight = Math.max(...clipImages.map((entry) => entry.image.height));
        for (const entry of clipImages) {
          const padded = padFramePreserveOrigin(entry.image, destWidth, destHeight, animation.anchorMode);
          if (padded.width !== entry.image.width || padded.height !== entry.image.height) {
            transaction.writeFile(entry.target, encodePngRgba(padded.data, padded.width, padded.height));
          }
          if (
            Number(frames[entry.index].width || 0) !== destWidth ||
            Number(frames[entry.index].height || 0) !== destHeight
          ) {
            frames[entry.index].width = destWidth;
            frames[entry.index].height = destHeight;
            sizeChanged = true;
          }
        }
        for (const receipt of receipts) {
          receipt.width = destWidth;
          receipt.height = destHeight;
        }
      }
      if (apply && sizeChanged) {
        transaction.writeJson(projectStore.projectPaths(project).manifest, manifest);
      }
    });
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      applied: apply,
      dryRun: booleanFlag(args.dry_run) || !apply,
      referenceAnimationId: referenceAnimationId || undefined,
      frames: receipts,
      space: "group",
      sync: synchronize(project, apply ? booleanFlag(args.sync) : false),
    };
  }

  function compressFrames(args = {}) {
    const selection = animationFor(args);
    const { project, profile, animation } = selection;
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot compress an animation without frames.");
    const lastIndex = frames.length - 1;
    const startFrame = args.start_frame === undefined ? 0 : requireFrameIndex(args.start_frame, lastIndex);
    const endFrame = args.end_frame === undefined ? lastIndex : requireFrameIndex(args.end_frame, lastIndex);
    if (endFrame < startFrame) throw new Error("end_frame must be greater than or equal to start_frame.");
    const dryRun = booleanFlag(args.dry_run, true);
    const receipts = [];
    for (let index = startFrame; index <= endFrame; index += 1) {
      const rawPath = String(frames[index].path || "");
      const absolute = resolveAnimationFramePath(project, rawPath, animation);
      assertWritableAnimationFrame(
        project,
        animation,
        absolute,
        `Compress refused frame path outside the project workspace: ${rawPath || index}`,
      );
      if (!fs.existsSync(absolute)) {
        throw new Error(`Compress refused missing on-disk frame ${index}: ${rawPath || absolute}`);
      }
      const result = compressPngFile(absolute, { dryRun });
      receipts.push({
        index,
        path: reslash(path.relative(root, result.path)),
        bytesBefore: result.bytesBefore,
        bytesAfter: result.bytesAfter,
        wrote: result.wrote,
      });
    }
    if (!receipts.length) throw new Error("Compress found no on-disk frames to process.");
    const bytesBefore = receipts.reduce((sum, row) => sum + row.bytesBefore, 0);
    const bytesAfter = receipts.reduce((sum, row) => sum + row.bytesAfter, 0);
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId: String(animation.id || animation.name),
      dryRun,
      frameCount: receipts.length,
      rewritten: receipts.filter((row) => row.wrote).length,
      skipped: receipts.filter((row) => !row.wrote).length,
      bytesBefore,
      bytesAfter,
      savedBytes: Math.max(0, bytesBefore - bytesAfter),
      frames: receipts,
    };
  }

  async function exportGif(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot export an animation without frames.");
    const lastIndex = frames.length - 1;
    const startFrame = args.start_frame === undefined ? 0 : requireFrameIndex(args.start_frame, lastIndex);
    const endFrame = args.end_frame === undefined ? lastIndex : requireFrameIndex(args.end_frame, lastIndex);
    if (endFrame < startFrame) throw new Error("end_frame must be greater than or equal to start_frame.");
    const fps = resolveExportFps(animation, args.fps);
    const includeDisabled = booleanFlag(args.include_disabled);
    const animationId = String(animation.id || animation.name);
    const paths = projectStore.projectPaths(project);
    const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
    const playbackOverrides =
      tuning.frame_playback_overrides && typeof tuning.frame_playback_overrides === "object"
        ? tuning.frame_playback_overrides
        : {};
    const visualScales = bakedVisualScales(tuning, profile.id, animationId, frames.length);
    const framePaths = [];
    const selectedScales = [];
    const durations = [];
    let skippedDisabledFrames = 0;
    for (let index = startFrame; index <= endFrame; index += 1) {
      const key = frameBoxKey(profile.id, animationId, index);
      const override =
        playbackOverrides[key] && typeof playbackOverrides[key] === "object" ? playbackOverrides[key] : {};
      if (override.disabled === true && !includeDisabled) {
        skippedDisabledFrames += 1;
        continue;
      }
      const absolute = resolveAnimationFramePath(project, frames[index].path, animation);
      if (!absolute || !fs.existsSync(absolute)) {
        throw new Error(`Frame ${index} has no generated PNG on disk; import or regenerate frames first.`);
      }
      framePaths.push(absolute);
      selectedScales.push(visualScales[index]);
      durations.push(exportFrameDurationSeconds(frames[index], override, fps));
    }
    if (!framePaths.length) {
      throw new Error("No exportable frames in the selected range (all frames are disabled).");
    }
    const outputPath = resolveMcpArtifactPath(args.output_path, {
      root,
      artifactDir: currentArtifactDir(project),
      defaultName: `${profile.id}_${animationId}.gif`,
      extensionPattern: /\.gif$/i,
      extensionLabel: ".gif",
      allowOutsideRoot: true,
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const appliedVisual = selectedScales.some((scale) => scale !== 1);
    let encodePaths = framePaths;
    let visualTemp = null;
    let trailTemp = null;
    let flattenTemp = null;
    const exportedIndexes = [];
    for (let index = startFrame; index <= endFrame; index += 1) {
      const key = frameBoxKey(profile.id, animationId, index);
      const override =
        playbackOverrides[key] && typeof playbackOverrides[key] === "object" ? playbackOverrides[key] : {};
      if (override.disabled === true && !includeDisabled) continue;
      exportedIndexes.push(index);
    }
    let bakedTrails = false;
    let bakedAttachments = false;
    let trailIds = [];
    let attachmentIds = [];
    try {
      if (appliedVisual) {
        visualTemp = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-gif-visual-"));
        const decoded = framePaths.map((filePath) => decodePngRgba(filePath));
        const placed = placeFramesOnCanvas(decoded, decoded[0].width, decoded[0].height, {
          frameScales: selectedScales,
        });
        encodePaths = placed.map((frame, index) => {
          const filePath = path.join(visualTemp, `frame_${String(index + 1).padStart(4, "0")}.png`);
          fs.writeFileSync(filePath, encodePngRgba(frame.data, frame.width, frame.height));
          return filePath;
        });
      }
      const baked = await bakeTrailsOnto(
        { project, profile, animation },
        encodePaths,
        exportedIndexes,
        playbackDurations(tuning, profile.id, animationId, frames, fps),
        fps,
      );
      bakedTrails = baked.bakedTrails === true;
      bakedAttachments = baked.bakedAttachments === true;
      trailIds = baked.trailIds || [];
      attachmentIds = baked.attachmentIds || [];
      if (baked.bakedTrails || baked.bakedAttachments) {
        encodePaths = baked.framePaths;
        trailTemp = baked.tempDir;
      }
      const background = resolvePreviewBackground(args.background);
      if (background) {
        flattenTemp = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-gif-flat-"));
        encodePaths = encodePaths.map((filePath, index) => {
          const image = decodePngRgba(filePath);
          const flat = flattenFrameBackground(image, background);
          const dest = path.join(flattenTemp, `frame_${String(index + 1).padStart(4, "0")}.png`);
          fs.writeFileSync(dest, encodePngRgba(flat.data, flat.width, flat.height));
          return dest;
        });
      }
      await encodeGifImpl({
        framePaths: encodePaths,
        durations,
        fps,
        outputPath,
        background: args.background,
      });
    } finally {
      if (visualTemp) fs.rmSync(visualTemp, { recursive: true, force: true });
      if (trailTemp) fs.rmSync(trailTemp, { recursive: true, force: true });
      if (flattenTemp) fs.rmSync(flattenTemp, { recursive: true, force: true });
    }
    if (!fs.existsSync(outputPath)) throw new Error("GIF export produced no output file.");
    const copyTo = copyIfRequested(outputPath, args.copy_to);
    const suggestedGameFps = fps > 12 && fps <= 120 ? suggestGameFps(fps) : undefined;
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId,
      outputPath,
      copyTo,
      flattenedBackground: Boolean(resolvePreviewBackground(args.background)),
      frameCount: framePaths.length,
      skippedDisabledFrames,
      startFrame,
      endFrame,
      fps,
      suggestedGameFps,
      next:
        suggestedGameFps === undefined || suggestedGameFps === fps
          ? undefined
          : `pass fps=${suggestedGameFps} (suggestedGameFps) so the GIF is a game loop, not camera-rate flicker`,
      appliedVisual,
      bakedTrails,
      bakedAttachments,
      trailIds,
      attachmentIds,
      frameScales: appliedVisual ? selectedScales : undefined,
      totalDurationMs: Math.round(durations.reduce((sum, value) => sum + value, 0) * 1000),
      bytes: fs.statSync(outputPath).size,
      preview: { path: outputPath },
    };
  }

  /**
   * Exports a contact sheet that scales every source canvas into a shared cell.
   * @param {object} args Tool arguments.
   * @returns {object} Sheet receipt including `preview.path` for walk-lock visual QA.
   */
  async function exportSheet(args = {}) {
    const { project, profile, animation } = animationFor(args);
    const frames = animation.frames || [];
    if (!frames.length) throw new Error("Cannot export a sheet without frames.");
    const lastIndex = frames.length - 1;
    const startFrame = args.start_frame === undefined ? 0 : requireFrameIndex(args.start_frame, lastIndex);
    const endFrame = args.end_frame === undefined ? lastIndex : requireFrameIndex(args.end_frame, lastIndex);
    if (endFrame < startFrame) throw new Error("end_frame must be greater than or equal to start_frame.");
    const fps = resolveExportFps(animation);
    const paths = projectStore.projectPaths(project);
    const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
    const sourcePaths = [];
    const indexes = [];
    for (let index = startFrame; index <= endFrame; index += 1) {
      const absolute = resolveAnimationFramePath(project, frames[index].path, animation);
      if (!absolute || !fs.existsSync(absolute)) {
        throw new Error(`Frame ${index} has no generated PNG on disk; import or regenerate frames first.`);
      }
      sourcePaths.push(absolute);
      indexes.push(index);
    }
    const baked = await bakeTrailsOnto(
      { project, profile, animation },
      sourcePaths,
      indexes,
      playbackDurations(tuning, profile.id, String(animation.id || animation.name), frames, fps),
      fps,
    );
    let selected;
    try {
      selected = baked.framePaths.map((filePath) => {
        try {
          return decodePngRgba(filePath);
        } catch (error) {
          throw new Error(`Failed to decode sheet frame ${filePath}: ${error.message}`);
        }
      });
    } finally {
      if (baked.tempDir) fs.rmSync(baked.tempDir, { recursive: true, force: true });
    }
    const columns =
      args.columns === undefined ? Math.min(selected.length, 8) : Math.max(1, Number(args.columns));
    if (!Number.isFinite(columns) || columns < 1) {
      throw new Error("columns must be a finite number greater than 0.");
    }
    const grid = booleanFlag(args.grid, true);
    const maxEdge = selected.reduce(
      (edge, frame) => Math.max(edge, Number(frame.width || 0), Number(frame.height || 0)),
      8,
    );
    const cell =
      args.cell === undefined
        ? grid
          ? 220
          : Math.min(1024, Math.max(8, maxEdge))
        : Math.max(8, Number(args.cell));
    const pad = args.pad === undefined ? 8 : Math.max(1, Number(args.pad));
    const markFrame =
      args.mark_frame === undefined ? startFrame : requireFrameIndex(args.mark_frame, lastIndex);
    if (markFrame < startFrame || markFrame > endFrame) {
      throw new Error(`mark_frame must fall between start_frame ${startFrame} and end_frame ${endFrame}.`);
    }
    const anchorMode = String(animation.anchorMode || "canvas_bottom_center");
    const gridOptions = overlayGridOptions(args);
    const firstFrame = selected[0];
    const normalize = String(args.normalize || "none");
    const sheet = renderContactSheet(selected, {
      cell,
      pad,
      columns,
      startIndex: startFrame,
      markFrame,
      grid,
      labels: grid,
      normalize,
      guides: booleanFlag(args.guides),
      anchorMode,
      gridDensity: gridOptions.grid_density,
      gridDivs: gridOptions.grid_divs,
      gridX: gridOptions.grid_x,
      gridY: gridOptions.grid_y,
      gridScope: gridOptions.grid_scope,
    });
    const animationId = String(animation.id || animation.name);
    const defaultName = grid
      ? `${profile.id}_${animationId}_sheet.png`
      : `${profile.id}_${animationId}_sheet_view.png`;
    const outputPath = resolveMcpArtifactPath(args.output_path, {
      root,
      artifactDir: currentArtifactDir(project),
      defaultName,
      extensionPattern: /\.png$/i,
      extensionLabel: ".png",
      allowOutsideRoot: true,
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encodePngRgba(sheet.data, sheet.width, sheet.height));
    const rows = Math.ceil(selected.length / columns);
    fs.writeFileSync(
      outputPath.replace(/\.png$/i, ".sheet.json"),
      JSON.stringify({
        kind: "xsxb_contact_sheet",
        schemaVersion: 1,
        columns,
        rows,
        cell,
        pad,
        grid,
      }),
    );
    const copyTo = copyIfRequested(outputPath, args.copy_to);
    return {
      projectId: project.id,
      profileId: profile.id,
      animationId,
      outputPath,
      copyTo,
      normalize,
      frameCount: selected.length,
      startFrame,
      endFrame,
      indexes,
      markFrame,
      columns,
      rows,
      cell,
      pad,
      width: sheet.width,
      height: sheet.height,
      preview: { path: outputPath, width: sheet.width, height: sheet.height },
      bytes: fs.statSync(outputPath).size,
      fps,
      bakedTrails: baked.bakedTrails === true,
      bakedAttachments: baked.bakedAttachments === true,
      trailIds: baked.trailIds || [],
      attachmentIds: baked.attachmentIds || [],
      grid: grid
        ? describeGroupGrid(
            cell,
            firstFrame ? firstFrame.width : 0,
            firstFrame ? firstFrame.height : 0,
            anchorMode,
            {
              ...gridOptions,
              subject:
                String(args.grid_scope || "canvas") === "subject" && firstFrame
                  ? subjectAnchor(firstFrame.data, firstFrame.width, firstFrame.height)
                  : null,
            },
          )
        : { enabled: false, overlayOnly: true, reason: "grid disabled" },
    };
  }

  /**
   * Measures a weapon/sprite PNG's long axis and handle fractions.
   * @param {object} args Tool arguments.
   * @returns {object} Pommel, tip, and grip landmarks.
   */
  function measureImage(args = {}) {
    const absolute = requireExistingFile(args.file_path, "Sprite image");
    if (!/\.png$/i.test(absolute)) throw new Error("file_path must be a PNG.");
    const image = decodePngRgba(absolute);
    const anchor = String(args.anchor || "axis");
    if (anchor === "alpha_bottom") {
      return {
        filePath: absolute,
        ...measureAlphaBottom(image.data, image.width, image.height),
      };
    }
    if (anchor !== "axis") throw new Error(`anchor must be axis or alpha_bottom. Received: ${anchor}`);
    const t = parseGripT(args.t);
    const measured = measureLongAxis(image.data, image.width, image.height, { t });
    return {
      filePath: absolute,
      space: "image_pixels",
      note: "t=0 is the thicker pommel, t=1 is the thinner tip. localFromCenter is the grip relative to the image center. xsxb_add_attachment rotates and scales that vector before solving its offset from hand.",
      ...measured,
    };
  }

  /**
   * Resolves standalone or animation PNGs for code-first region perception.
   * @param {object} args Tool arguments.
   * @returns {{frames:object[],observation:object,artifactDir:string}}
   */
  function perceptionFrames(args = {}) {
    const decodePerceptionFrame = (filePath) => {
      const image = decodePngRgba(filePath);
      if (image.width * image.height > 16_777_216) {
        const error = new Error(
          `Perception image exceeds the 16 megapixel decoded-pixel limit: ${image.width}x${image.height}.`,
        );
        error.code = "PERCEPTION_PIXEL_LIMIT";
        throw error;
      }
      return image;
    };
    if (args.file_path) {
      const filePath = requireExistingFile(args.file_path, "Perception image");
      if (!/\.png$/i.test(filePath)) throw new Error("file_path must be a PNG.");
      if (!isInsideDirectory(filePath, root)) {
        throw new Error(`Perception image must stay inside the XSXB root: ${filePath}`);
      }
      const image = decodePerceptionFrame(filePath);
      return {
        frames: [{ ...image, filePath, frame: 0 }],
        observation: observeFile(
          filePath,
          { file: filePath },
          {
            grid_divs: args.grid_divs || null,
            grid_density: args.grid_density || null,
            grid_scope: args.grid_scope || "canvas",
          },
        ),
        revalidate: () =>
          observeFile(
            filePath,
            { file: filePath },
            {
              grid_divs: args.grid_divs || null,
              grid_density: args.grid_density || null,
              grid_scope: args.grid_scope || "canvas",
            },
          ),
        artifactDir: currentArtifactDir(),
      };
    }
    const selection = animationFor(args);
    const filePaths = collectFramePaths(selection.project, selection.animation);
    const requestedFrame =
      args.frame === undefined ? null : requireFrameIndex(args.frame, filePaths.length - 1);
    let indexes;
    if (requestedFrame !== null) indexes = [requestedFrame];
    else if (filePaths.length <= 24) indexes = filePaths.map((_filePath, index) => index);
    else {
      indexes = Array.from({ length: 24 }, (_unused, index) =>
        Math.round((index * (filePaths.length - 1)) / 23),
      );
    }
    const selectedPaths = indexes.map((index) => filePaths[index]);
    const observationInput = {
      scope: {
        kind: "animation",
        projectId: selection.project.id,
        profileId: selection.profile.id,
        animationId: String(selection.animation.id || selection.animation.name),
        frame: requestedFrame,
      },
      sources: selectedPaths.map((filePath, index) => ({ key: `frame_${indexes[index]}`, path: filePath })),
      view: {
        grid_divs: args.grid_divs || null,
        grid_density: args.grid_density || null,
        grid_scope: args.grid_scope || "canvas",
      },
    };
    const observation = createObservation(observationInput);
    return {
      frames: selectedPaths.map((filePath, index) => ({
        ...decodePerceptionFrame(filePath),
        filePath,
        frame: indexes[index],
      })),
      observation,
      revalidate: () => createObservation(observationInput),
      artifactDir: currentArtifactDir(selection.project),
    };
  }

  /**
   * Hashes the complete current animation basis used by observation-derived writes.
   * @param {object} args Animation selector.
   * @returns {object} Content-addressed animation observation.
   */
  function animationObservation(args = {}) {
    const selection = animationFor(args);
    const filePaths = collectFramePaths(selection.project, selection.animation);
    const paths = projectStore.projectPaths(selection.project);
    const tuning = projectStore.readJson(paths.tuning, EMPTY_TUNING);
    return createObservation({
      scope: {
        kind: "animation",
        projectId: selection.project.id,
        profileId: selection.profile.id,
        animationId: String(selection.animation.id || selection.animation.name),
      },
      sources: [
        ...filePaths.map((filePath, index) => ({ key: `frame_${index}`, path: filePath })),
        {
          key: "animation_manifest",
          hash: sha256(JSON.stringify(canonicalValue(selection.animation))),
        },
        {
          key: "tuning",
          hash: sha256(JSON.stringify(canonicalValue(tuning))),
        },
      ],
    });
  }

  /**
   * Runs the read-only, code-first perception tool.
   * @param {object} args Tool arguments.
   * @returns {Promise<object>} Detection receipt data.
   */
  async function detectRegionCandidates(args = {}) {
    const resolved = perceptionFrames(args);
    return detectRegions(args, {
      ...resolved,
      root,
      florence: florenceDetectImpl,
    });
  }

  /**
   * Paints a speakable overlay. Source PNG is unchanged.
   * @param {object} args Tool arguments.
   * @returns {object} Overlay receipt.
   */
  function overlayGrid(args = {}) {
    let artifactDir = currentArtifactDir();
    if (args.project_id) {
      artifactDir = currentArtifactDir(registryProject(args.project_id, false));
    }
    return overlayGridImage(args, { root, artifactDir });
  }

  /**
   * Composites one PNG onto another using generic anchors.
   * @param {object} args Tool arguments.
   * @returns {object} Placement receipt.
   */
  function placeImage(args = {}) {
    return placeImageOnTarget(args, { root, artifactDir: currentArtifactDir() });
  }

  /**
   * Compiles a still-image place brief (图度) without compositing.
   * @param {object} args Tool arguments.
   * @returns {object} Brief receipt.
   */
  function planPlace(args = {}) {
    return compilePlaceBrief(args, { root, artifactDir: currentArtifactDir() });
  }

  const authoring = createAuthoringTools({
    root,
    projectStore,
    animationFor,
    registryProject,
    currentArtifactDir,
    resolveAnimationFramePath,
    assertWritableAnimationFrame,
    synchronize,
    clearAnimationSelection() {
      context.profileId = "";
      context.animationId = "";
    },
  });

  const handlers = {
    ...authoring.handlers,
    xsxb_list_projects: listProjects,
    xsxb_get_project: projectSnapshot,
    xsxb_create_project: createProject,
    xsxb_import_video: importVideo,
    xsxb_slice_sheet: sliceSheetTool,
    xsxb_import_animation: importUnified,
    xsxb_get_animation: getAnimation,
    xsxb_find_loop: findLoop,
    xsxb_find_duplicates: findDuplicates,
    xsxb_find_motion: findMotion,
    xsxb_analyze: analyzeClip,
    xsxb_update_frame_boxes: updateFrameBoxes,
    xsxb_estimate_boxes: estimateBoxes,
    xsxb_update_timing: updateTiming,
    xsxb_set_visual_transform: setVisualTransform,
    xsxb_estimate_visual: estimateVisual,
    xsxb_measure_frames: measureFrames,
    xsxb_register_clip: registerClip,
    xsxb_replace_frame: replaceFrame,
    xsxb_shift_frames: shiftFrames,
    xsxb_plant_feet: plantFeet,
    xsxb_compress_frames: compressFrames,
    xsxb_export_gif: exportGif,
    xsxb_export_sheet: exportSheet,
    xsxb_export_overlay: exportOverlay,
    xsxb_export_pack_slot: exportPackSlot,
    xsxb_measure_image: measureImage,
    xsxb_detect_regions: detectRegionCandidates,
    xsxb_overlay_grid: overlayGrid,
    xsxb_plan_place: planPlace,
    xsxb_place_image: placeImage,
    xsxb_validate_project: validateProject,
    xsxb_validate_for_godot: validateForGodot,
    xsxb_diff_frames: diffFrames,
    xsxb_add_attack_trail: addAttackTrail,
    xsxb_plan_smear: compileSmearBrief,
    xsxb_add_attachment: addAttachment,
    xsxb_add_sfx: addSfx,
    xsxb_remove_binding: removeBinding,
    xsxb_reorganize_frames: reorganizeFrames,
    xsxb_delete_animation: removeAnimation,
    xsxb_sync_godot: syncGodot,
    xsxb_set_active_project: setActiveProject,
    xsxb_bind_godot: bindGodot,
    xsxb_cutout: cutoutAnimation,
  };

  // Keep the receipt envelope on internal definitions for tests. tools/list
  // omits it because every tools/call already returns the v2 receipt.
  const catalogTools = toolDefinitions();
  const tools = catalogTools.map(({ outputSchema, ...tool }) => tool);
  const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
  const definitions = new Map(tools.map((tool) => [tool.name, tool]));

  /**
   * Validates one public or internal service call before any observation lookup
   * or handler side effect.
   * @param {string} name Tool name.
   * @param {unknown} args Raw arguments.
   * @returns {object} Validated argument object.
   */
  function callArguments(name, args) {
    if (!MCP_TOOL_NAMES.includes(name) || !handlers[name]) {
      throw new Error(`Unknown XSXB MCP tool: ${name}`);
    }
    return validateToolArguments(name, schemas.get(name), args);
  }

  /**
   * Selects the execution route exposed by the v2 receipt.
   * @param {string} name Tool name.
   * @param {boolean} readOnly Whether the tool is declared read-only.
   * @returns {string} Closed route value.
   */
  function receiptRoute(name, readOnly) {
    if (readOnly) return "domain_read";
    if (/export_|import_video|sync_godot/u.test(name)) return "external_process";
    if (/place|plant|shift|register|measure|overlay|diff/u.test(name)) return "geometry";
    return "domain_mutation";
  }

  /**
   * Refuses still-image A1 addressing without the exact overlay stamp that was
   * shown to the Agent.
   * @param {string} name Tool name.
   * @param {object} args Tool arguments.
   * @returns {void}
   */
  function requireStillOverlayBasis(name, args) {
    const refuse = (label) => {
      const error = new Error(`${label} requires overlay_id from xsxb_overlay_grid.`);
      error.code = "MISSING_OVERLAY";
      throw error;
    };
    if (name === "xsxb_overlay_grid" && args.crop_from && !args.crop_from.overlay_id) {
      refuse("crop_from");
    }
    if (name !== "xsxb_place_image") return;
    for (const [label, anchor] of [
      ["target_anchor", args.target_anchor],
      ["object_anchor", args.object_anchor],
    ]) {
      if (containsCellToken(anchor) && !anchor?.overlay_id) refuse(label);
    }
    if (containsCellToken(args.scale?.target)) {
      const scaleView = canonicalValue(args.scale.target.view || null);
      const anchorView = canonicalValue(args.target_anchor?.view || null);
      const ownOverlay = args.scale.target.overlay_id;
      const inheritedOverlay =
        JSON.stringify(scaleView) === JSON.stringify(anchorView) ? args.target_anchor?.overlay_id : null;
      const overlayId = ownOverlay || inheritedOverlay;
      if (!overlayId) refuse("scale.target");
      assertOverlayId(
        requireExistingFile(args.target_path, "Target image"),
        args.scale.target.view,
        overlayId,
        "scale.target",
      );
    }
  }

  /**
   * Selects only coordinate-bearing fields so a project or animation literally
   * named "A1" cannot be mistaken for an overlay cell.
   * @param {string} name Tool name.
   * @param {object} args Tool arguments.
   * @returns {unknown} Coordinate subtree.
   */
  function cellCoordinateArguments(name, args) {
    if (name === "xsxb_update_frame_boxes") {
      return [args.hurtbox, args.collisionbox, args.hitbox, args.frames];
    }
    if (name === "xsxb_shift_frames") {
      return (args.frames || []).map((frame) => [frame.from, frame.to]);
    }
    if (name === "xsxb_plant_feet") return args.to;
    if (name === "xsxb_add_attack_trail") return args.sticks;
    if (name === "xsxb_add_attachment") return [args.hand, args.frames];
    return null;
  }

  /**
   * Calls one tool through the public MCP v2 receipt boundary.
   * @param {string} name Tool name.
   * @param {object} [args] Tool arguments.
   * @returns {Promise<object>} Versioned public receipt.
   */
  async function callMcpUnlocked(name, args = {}) {
    const callArgs = callArguments(name, args);
    // Cache the expensive full-frame digest for this request. Observation
    // checks and receipt assembly should share one pass over all PNG frames.
    let cachedAnimationObservation;
    const getAnimationObservation = () => {
      if (!cachedAnimationObservation) cachedAnimationObservation = animationObservation(callArgs);
      return cachedAnimationObservation;
    };
    requireStillOverlayBasis(name, callArgs);
    if (name === "xsxb_reorganize_frames" && Array.isArray(callArgs.order)) {
      assertObservation(callArgs.basis_snapshot_id, getAnimationObservation(), "frame reorganization");
    }
    const animationWriteTools = new Set(["xsxb_cutout"]);
    if (animationWriteTools.has(name) && !callArgs.file_path && !callArgs.directory && !callArgs.file_paths) {
      assertObservation(callArgs.basis_snapshot_id, getAnimationObservation(), `${name} observation`);
    }
    const cellDerivedTools = new Set([
      "xsxb_update_frame_boxes",
      "xsxb_shift_frames",
      "xsxb_plant_feet",
      "xsxb_add_attack_trail",
      "xsxb_add_attachment",
    ]);
    if (cellDerivedTools.has(name) && containsCellToken(cellCoordinateArguments(name, callArgs))) {
      assertObservation(callArgs.basis_snapshot_id, getAnimationObservation(), `${name} cell coordinates`);
    }
    const observationTools = new Set([
      "xsxb_get_animation",
      "xsxb_find_loop",
      "xsxb_find_duplicates",
      "xsxb_find_motion",
      "xsxb_analyze",
      "xsxb_measure_frames",
      "xsxb_export_sheet",
    ]);
    const beforeObservation =
      observationTools.has(name) && !callArgs.file_path && !callArgs.directory && !callArgs.file_paths
        ? getAnimationObservation()
        : null;
    const readOnlyObservation = Boolean(beforeObservation);
    const checkpoint = authoring.checkpoint(name, callArgs);
    let raw;
    let revisionId;
    try {
      raw = await handlers[name](callArgs);
    } finally {
      revisionId = authoring.finishCheckpoint(checkpoint, { succeeded: raw !== undefined, result: raw });
    }
    if (revisionId && raw && typeof raw === "object") raw.revisionId = revisionId;
    const definition = definitions.get(name);
    const metadata = raw && typeof raw === "object" ? raw.__mcp || {} : {};
    let observation = metadata.observation || null;
    if (!observation && name === "xsxb_overlay_grid" && callArgs.file_path) {
      observation = observeFile(
        requireExistingFile(callArgs.file_path, "Overlay image"),
        {
          file: path.resolve(String(callArgs.file_path)),
        },
        raw?.view || null,
      );
    }
    if (animationWriteTools.has(name) && !callArgs.file_path && !callArgs.directory && !callArgs.file_paths) {
      // Mutations invalidate the preflight digest; compute a fresh receipt
      // observation after the handler has committed its changes.
      cachedAnimationObservation = undefined;
      observation = getAnimationObservation();
    } else if (!observation && beforeObservation) {
      if (!readOnlyObservation) {
        const afterObservation = getAnimationObservation();
        assertObservation(beforeObservation.snapshotId, afterObservation, `${name} observation`);
      }
      observation = beforeObservation;
    }
    if (observation && typeof metadata.revalidate === "function" && !readOnlyObservation) {
      assertObservation(observation.snapshotId, metadata.revalidate(), `${name} observation`);
    }
    let verification = metadata.verification || null;
    let execution = metadata.execution || null;
    if (name === "xsxb_place_image" && raw?.verify) {
      const checks = Array.isArray(raw.verify.checks) ? raw.verify.checks : [];
      execution = {
        effect: "confirmed",
        route: "geometry",
        artifacts: [raw.output_path, raw.verify_overlay_path]
          .filter(Boolean)
          .map((artifactPath) => ({ kind: "image", path: artifactPath })),
      };
      verification = {
        status: checks.some((check) => check?.ok === false) ? "unsatisfied" : "unknown",
        checks,
        evidence: ["geometric_only_visual_fit_unproven"],
      };
    }
    const receiptOptions = {
      readOnly: definition?.annotations?.readOnlyHint === true && !metadata.execution,
      route: receiptRoute(name, definition?.annotations?.readOnlyHint === true),
      observation,
      execution,
      verification,
      escalation: metadata.escalation || null,
    };
    if (name === "xsxb_validate_for_godot" || name === "xsxb_validate_project") {
      return gateReceipt(name, raw, receiptOptions);
    }
    return successReceipt(name, raw, receiptOptions);
  }

  let serviceCallQueue = Promise.resolve();

  /**
   * Queues one service operation so raw compatibility calls cannot interleave
   * with freshness-checked MCP calls in the same process.
   * @param {()=>Promise<object>|object} operation Service operation.
   * @returns {Promise<object>} Operation result.
   */
  function enqueueServiceCall(operation) {
    const job = serviceCallQueue.then(operation);
    serviceCallQueue = job.catch(() => undefined);
    return job;
  }

  /**
   * Serializes public MCP calls so observation validation and the following
   * synchronous mutation cannot be interleaved by another service caller.
   * @param {string} name Tool name.
   * @param {object} [args] Tool arguments.
   * @returns {Promise<object>} Versioned public receipt.
   */
  function callMcp(name, args = {}) {
    return enqueueServiceCall(() => callMcpUnlocked(name, args));
  }

  const service = {
    tools,
    callMcp,
    close() {
      florenceDetectImpl?.close?.();
    },
    call(name, args = {}) {
      return enqueueServiceCall(() => {
        const callArgs = callArguments(name, args);
        return handlers[name](callArgs);
      });
    },
  };
  return service;
}

module.exports = {
  MCP_TOOL_NAMES,
  booleanFlag,
  classifyValidationMessage,
  createTestWav,
  createXsxbMcpService,
  extractVideoFrames,
  requireFps,
  requireFrameIndex,
  toolDefinitions,
};
