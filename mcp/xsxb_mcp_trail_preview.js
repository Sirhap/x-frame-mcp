"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { encodePngRgba } = require("./xsxb_mcp_cutout");
const { trailUsesHermiteMesh } = require("./xsxb_mcp_plant");
const { drawSweepLayer, sweepSegments } = require("./xsxb_mcp_sweep");
const { createSoftwareDom, SoftwareImage } = require("./lib/xsxb_software_canvas");
const {
  attachmentOwnerPlacement,
  normalizeAttachmentTransform,
} = require("./lib/animation_tuner/public/app_attachment_utils");

const EDITOR_SCRIPT = path.join(__dirname, "lib/animation_tuner/public/attack_trails.js");
const FALLBACK_TEXTURE = path.join(
  __dirname,
  "lib/animation_tuner/public/presets/attack_trails/dynamic_trail_luma.png",
);

/**
 * Segments that the Tuner mesh will actually draw.
 * @param {object} trails Normalized attack_trails.json.
 * @param {string} bindingKey profile/animation key.
 * @returns {object[]} Segments with at least two sticks.
 */
function usableTrailSegments(trails, bindingKey) {
  return (trails?.bindings?.[bindingKey] || []).filter(
    (segment) =>
      segment &&
      segment.enabled !== false &&
      segment.generated !== false &&
      segment.renderMode !== "sweep" &&
      trailUsesHermiteMesh(segment) &&
      Array.isArray(segment.sticks) &&
      segment.sticks.length >= 2,
  );
}

/**
 * Signed layer order: negative draws below the frame, positive above.
 * @param {object|null|undefined} attachment Attachment record.
 * @returns {number} Layer order.
 */
function attachmentLayerOrder(attachment) {
  const parsed = Number(attachment?.layerOrder);
  if (Number.isFinite(parsed) && Math.abs(parsed) > 0.0001) return parsed;
  return String(attachment?.layer || "above") === "below" ? -1 : 1;
}

/**
 * Resolves an attachment PNG from the XSXB root.
 * @param {string} requested Repo-relative or absolute path.
 * @param {string} root XSXB root.
 * @returns {string} Existing file path, or empty when missing.
 */
function resolveAttachmentFile(requested, root) {
  if (!requested) return "";
  const candidates = [path.isAbsolute(requested) ? requested : "", root ? path.resolve(root, requested) : ""];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
}

/**
 * Parses MCP `profile/animation:frame` keys and Tuner 7-part keys
 * (`project:tuningTarget:profile:type:name:source:frame`).
 * @param {string} key Attachment key.
 * @returns {{profileId:string,animation:string,frame:number}|null} Parsed fields.
 */
function parseAttachmentBinding(key) {
  const text = String(key || "");
  const parts = text.split(":");
  if (parts.length >= 7) {
    const frame = Number(parts[parts.length - 1]);
    if (!Number.isFinite(frame)) return null;
    return {
      profileId: parts[2] || "",
      animation: parts[4] || "",
      frame,
    };
  }
  const colon = text.lastIndexOf(":");
  if (colon < 0) return null;
  const left = text.slice(0, colon);
  const frame = Number(text.slice(colon + 1));
  if (!Number.isFinite(frame)) return null;
  const slash = left.indexOf("/");
  return {
    profileId: slash >= 0 ? left.slice(0, slash) : "",
    animation: slash >= 0 ? left.slice(slash + 1) : left,
    frame,
  };
}

/**
 * Attachments bound to one exported frame.
 * @param {object[]} bindings All frame image attachments.
 * @param {string} bindingKey profile/animation key.
 * @param {number} frameIndex Absolute frame index.
 * @returns {object[]} Matching attachments.
 */
function attachmentsForFrame(bindings, bindingKey, frameIndex) {
  const frameKey = `${bindingKey}:${frameIndex}`;
  const animationId =
    String(bindingKey || "")
      .split("/")
      .slice(1)
      .join("/") || String(bindingKey || "");
  return (Array.isArray(bindings) ? bindings : []).filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const key = String(entry.key || entry.frameKey || "");
    if (key && key === frameKey) return true;
    const parsed = parseAttachmentBinding(key);
    const meta = entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
    const frame = Number(Number.isFinite(Number(parsed?.frame)) ? parsed.frame : (entry.frame ?? meta.frame));
    if (frame !== frameIndex) return false;
    const clip = String(meta.animation || parsed?.animation || "");
    if (!clip) return true;
    return clip === bindingKey || clip === animationId || parsed?.animation === animationId;
  });
}

function drawAttachment(ctx, image, origin, attachment, owner = {}) {
  if (!image || !ctx) return;
  const local = normalizeAttachmentTransform(attachment.transform);
  const placed = attachmentOwnerPlacement(local, owner);
  ctx.save();
  ctx.translate(origin.x + placed.originX, origin.y + placed.originY);
  ctx.rotate((placed.rotation * Math.PI) / 180);
  if (placed.flipH) ctx.scale(-1, 1);
  ctx.scale(placed.scaleX, placed.scaleY);
  ctx.drawImage(image, -image.width / 2, -image.height / 2, image.width, image.height);
  ctx.restore();
}

/**
 * Resolves a trail texture PNG from the XSXB root, then the built-in preset.
 * @param {string} requested Repo-relative or absolute path.
 * @param {string} root XSXB root.
 * @returns {string} Existing file path.
 */
function resolveTextureFile(requested, root) {
  const candidates = [
    requested && path.isAbsolute(requested) ? requested : "",
    requested && root ? path.resolve(root, requested) : "",
    FALLBACK_TEXTURE,
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Attack trail texture is missing. Looked for: ${requested || FALLBACK_TEXTURE}`);
}

/**
 * Encodes a local PNG as a data URL for the headless compositor.
 * @param {string} filePath PNG path.
 * @returns {string} data:image/png;base64,…
 */
function dataUrl(filePath) {
  return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
}

let softwareDom;
let AttackTrailEditorCtor;

/**
 * Installs a software DOM on the current process so AttackTrailEditor can
 * create canvases without a browser.
 * @returns {{window:object,document:object,Image:Function}} Software DOM.
 */
function ensureSoftwareDom() {
  if (!softwareDom) {
    softwareDom = createSoftwareDom();
    globalThis.document = softwareDom.document;
    globalThis.window = softwareDom.window;
    globalThis.Image = softwareDom.Image;
  }
  return softwareDom;
}

/**
 * Loads AttackTrailEditor against the software DOM. Playwright is never required.
 * @returns {Function} Editor constructor.
 */
function loadAttackTrailEditor() {
  if (AttackTrailEditorCtor) return AttackTrailEditorCtor;
  if (!fs.existsSync(EDITOR_SCRIPT)) {
    throw new Error(`AttackTrailEditor script is missing: ${EDITOR_SCRIPT}`);
  }
  ensureSoftwareDom();
  vm.runInThisContext(fs.readFileSync(EDITOR_SCRIPT, "utf8"), { filename: EDITOR_SCRIPT });
  AttackTrailEditorCtor = globalThis.window.AttackTrailEditor;
  if (typeof AttackTrailEditorCtor !== "function") {
    throw new Error("AttackTrailEditor did not load.");
  }
  return AttackTrailEditorCtor;
}

/**
 * Loads a PNG file into a software Image.
 * @param {string} filePath PNG path.
 * @returns {Promise<object>} Image-like source.
 */
function loadPngImage(filePath) {
  const image = new SoftwareImage();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = (error) => reject(error || new Error(`Failed to load ${filePath}`));
    image.src = dataUrl(filePath);
  });
}

/**
 * Composites Tuner attack-trail meshes onto animation frames.
 * When the binding has no drawable trail, the source paths are returned unchanged.
 *
 * @param {object} job Composite job.
 * @param {string[]} job.framePaths Source PNG paths in export order.
 * @param {number[]} job.frameIndexes Absolute 0-based indexes for those paths.
 * @param {number[]} job.durations Per-absolute-frame durations in seconds.
 * @param {number} job.fps Playback fps.
 * @param {object} job.trails Normalized attack_trails.json.
 * @param {string} job.bindingKey profile/animation key.
 * @param {string} job.root XSXB root used to resolve textures.
 * @returns {Promise<{framePaths:string[],bakedTrails:boolean,bakedAttachments:boolean,trailIds:string[],attachmentIds:string[],tempDir:?string}>}
 */
async function compositeAttackTrails(job) {
  const framePaths = Array.isArray(job.framePaths) ? job.framePaths : [];
  const bindingKey = String(job.bindingKey || "");
  const meshSegments = usableTrailSegments(job.trails, bindingKey);
  const temporalSweeps = sweepSegments(job.trails, bindingKey);
  const trailIds = [...meshSegments, ...temporalSweeps].map((segment) => String(segment.id));
  const empty = {
    framePaths,
    bakedTrails: false,
    bakedAttachments: false,
    trailIds: [],
    attachmentIds: [],
    tempDir: null,
  };
  if (!framePaths.length) return empty;
  const frameIndexes = Array.isArray(job.frameIndexes)
    ? job.frameIndexes
    : framePaths.map((_, index) => index);
  if (frameIndexes.length !== framePaths.length) {
    throw new Error("frameIndexes must align with framePaths.");
  }
  const frameAttachments = frameIndexes.map((frameIndex) =>
    attachmentsForFrame(job.attachments, bindingKey, frameIndex).filter((entry) =>
      resolveAttachmentFile(entry.path, job.root),
    ),
  );
  const attachmentIds = [
    ...new Set(frameAttachments.flat().map((entry) => String(entry.id || entry.name || "attachment"))),
  ];
  if (!meshSegments.length && !temporalSweeps.length && !attachmentIds.length) return empty;
  const first = framePaths[0];
  if (!fs.existsSync(first)) throw new Error(`Cannot composite trails: missing frame ${first}`);
  const fps = Number(job.fps) > 0 ? Number(job.fps) : 12;
  const durations = Array.isArray(job.durations) && job.durations.length ? job.durations : [];
  const [profileId, animationId] = bindingKey.split("/");
  const textureByPath = {};
  for (const segment of meshSegments) {
    const requested = segment.texture?.path || job.trails?.presetTexture?.path || FALLBACK_TEXTURE;
    const absolute = resolveTextureFile(requested, job.root);
    textureByPath[segment.texture?.path || requested] = dataUrl(absolute);
  }
  const { document } = ensureSoftwareDom();
  const heroes = await Promise.all(framePaths.map((filePath) => loadPngImage(filePath)));
  const loadedTextures = {};
  await Promise.all(
    Object.entries(textureByPath).map(async ([key, src]) => {
      const image = new SoftwareImage();
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = (error) => reject(error || new Error("texture load failed"));
        image.src = src;
      });
      loadedTextures[key] = image;
    }),
  );
  const attachmentImages = {};
  await Promise.all(
    [...new Set(frameAttachments.flat().map((entry) => resolveAttachmentFile(entry.path, job.root)))].map(
      async (filePath) => {
        attachmentImages[filePath] = await loadPngImage(filePath);
      },
    ),
  );
  const width = heroes[0].width;
  const height = heroes[0].height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const indexes = frameIndexes;
  const frameDurations =
    durations.length >= Math.max(...indexes) + 1 ? durations : framePaths.map(() => 1 / fps);
  const profile = profileId || "profile";
  const animation = animationId || "animation";
  let selectedFrame = indexes[0] || 0;
  let elapsed = 0;
  const origin = { x: width / 2, y: height };
  const arrival = (frame, phase) => {
    const target = Math.min(
      Math.max(0, Math.round(Number(frame) || 0)),
      Math.max(0, frameDurations.length - 1),
    );
    let time = 0;
    for (let index = 0; index < target; index += 1) time += frameDurations[index] || 0;
    time += (frameDurations[target] || 1 / fps) * Number(phase || 0);
    return time;
  };
  const drawFrameAttachments = (layer, exportedIndex) => {
    const side = layer === "below" ? -1 : 1;
    const list = frameAttachments[exportedIndex]
      .filter((entry) => Math.sign(attachmentLayerOrder(entry)) === side)
      .sort(
        (left, right) =>
          attachmentLayerOrder(left) - attachmentLayerOrder(right) ||
          String(left.id || "").localeCompare(String(right.id || "")),
      );
    for (const entry of list) {
      const filePath = resolveAttachmentFile(entry.path, job.root);
      const absoluteIndex = frameIndexes[exportedIndex];
      const ownerScale = Number((job.ownerScales || [])[absoluteIndex] || job.ownerScale || 1);
      drawAttachment(ctx, attachmentImages[filePath], origin, entry, {
        visual_size: ownerScale,
        scaleX: ownerScale,
        scaleY: ownerScale,
        flipH: job.flipH === true,
        rotation: Number(job.ownerRotation || 0),
      });
    }
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-trail-preview-"));
  try {
    let editor = null;
    if (meshSegments.length) {
      const AttackTrailEditor = loadAttackTrailEditor();
      editor = new AttackTrailEditor({
        ctx,
        projectId: () => "export",
        projectKind: () => "godot",
        group: () => ({
          profileId: profile,
          animationId: animation,
          name: animation,
          runtimeAnimation: `${profile}/${animation}`,
        }),
        groups: () => [],
        selectedFrame: () => selectedFrame,
        currentImage: () => heroes[Math.max(0, indexes.indexOf(selectedFrame))],
        loadTexture: async (texture) =>
          loadedTextures[texture?.path] || loadedTextures[Object.keys(loadedTextures)[0]],
        frameArrival: arrival,
        animationElapsed: () => elapsed,
        animationTiming: () => {
          const total = frameDurations.reduce((sum, value) => sum + (value || 0), 0);
          return {
            duration: total || heroes.length / fps,
            lastPlayableFrameStart: Math.max(0, total - (frameDurations.at(-1) || 1 / fps)),
          };
        },
        localToScreen: (point) => ({ x: origin.x + point.x, y: origin.y + point.y }),
        screenToLocal: (point) => ({ x: point.x - origin.x, y: point.y - origin.y }),
        stagePoint: () => ({ x: 0, y: 0 }),
        dpr: () => 1,
        markDirty: () => {},
        pushUndo: () => {},
        draw: () => {},
        status: () => {},
        translate: (key) => key,
      });
      editor.load(job.trails);
      editor.enabled = true;
      editor.gpuRenderer = null;
      for (const [key, image] of Object.entries(loadedTextures)) editor.images.set(key, image);
      await editor.prepareExport();
    }
    const written = [];
    for (let index = 0; index < heroes.length; index += 1) {
      selectedFrame = indexes[index];
      elapsed = arrival(selectedFrame, 0.99);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawFrameAttachments("below", index);
      editor?.drawLayer("behind", selectedFrame, 1);
      drawSweepLayer(ctx, temporalSweeps, elapsed, frameDurations, origin, "behind");
      ctx.drawImage(heroes[index], 0, 0);
      drawFrameAttachments("above", index);
      editor?.drawLayer("front", selectedFrame, 1);
      drawSweepLayer(ctx, temporalSweeps, elapsed, frameDurations, origin, "front");
      const pixels = ctx.getImageData(0, 0, width, height).data;
      const filePath = path.join(tempDir, `frame_${String(index + 1).padStart(4, "0")}.png`);
      fs.writeFileSync(filePath, encodePngRgba(pixels, width, height));
      written.push(filePath);
    }
    return {
      framePaths: written,
      bakedTrails: Boolean(meshSegments.length || temporalSweeps.length),
      bakedAttachments: Boolean(attachmentIds.length),
      trailIds,
      attachmentIds,
      tempDir,
    };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Failed to bake attack trails or attachments into the export: ${error.message}`);
  }
}

module.exports = {
  compositeAttackTrails,
  resolveTextureFile,
  usableTrailSegments,
};
