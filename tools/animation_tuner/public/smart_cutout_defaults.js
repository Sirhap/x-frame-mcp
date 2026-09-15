(function attachSmartCutoutDefaults(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XFrameSmartCutoutDefaults = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  /**
   * Workbench slider idle values. Smart-cutout overlays plate or chroma knobs
   * on top of this table instead of inventing a second full profile.
   */
  const REGULAR_AUTO_BACKGROUND_PARAMETERS = Object.freeze({
    backgroundColor: "#ffffff",
    connected: false,
    perceptual: false,
    tolerance: 1,
    feather: 0,
    alphaThreshold: 0,
    chromaFeather: 0,
    edgeBoost: 10,
    blendStrength: 0,
    blendMode: "blend",
    alphaLow: 0,
    alphaHigh: 0,
    despillStrength: 0,
    despillMode: "general",
    edgeDespillRadius: 0,
    edgeRecoveryStrength: 0,
    backgroundRadius: 0,
    blurRadius: 0,
    protectionTolerance: 0,
  });

  const PLATE_SMART_OVERRIDES = Object.freeze({
    tolerance: 1,
    edgeBoost: 10,
  });

  const BLACK_PLATE_OVERRIDES = Object.freeze({
    tolerance: 12,
  });

  const CHROMA_SMART_OVERRIDES = Object.freeze({
    tolerance: -1,
    edgeBoost: 10,
    blendStrength: 100,
    despillStrength: 100,
  });

  const BLACK_PLATE_MAX = 24;

  /**
   * Reads an RGB sample from a hex string or channel object.
   * @param {object|string|undefined} color Background sample.
   * @returns {{r:number,g:number,b:number}} RGB channels.
   */
  function parseBackgroundColor(color) {
    if (color && typeof color === "object") {
      return { r: Number(color.r), g: Number(color.g), b: Number(color.b) };
    }
    const hex = String(color || "")
      .trim()
      .replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }
    return { r: 255, g: 255, b: 255 };
  }

  /**
   * Classifies a detected background as a neutral plate or a chroma field.
   * White, gray, and black share the plate profile. Green and other hues share
   * the chroma profile.
   * @param {object|string|undefined} color Background sample.
   * @returns {"plate"|"chroma"} Smart-cutout class.
   */
  function classifySmartBackground(color) {
    const { r, g, b } = parseBackgroundColor(color);
    if (![r, g, b].every(Number.isFinite)) return "chroma";
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min <= 24) return "plate";
    return "chroma";
  }

  /**
   * True when a plate is near-black. A black reference shares the RGB axis
   * with transparent replacement, so chroma-key cannot derive opacity.
   * @param {object|string|undefined} color Background sample.
   * @returns {boolean} Whether the sample is a black plate.
   */
  function isBlackPlate(color) {
    const { r, g, b } = parseBackgroundColor(color);
    return [r, g, b].every(Number.isFinite) && Math.max(r, g, b) <= BLACK_PLATE_MAX;
  }

  /**
   * Whether the reference blend should run as a chroma key.
   * @param {object|string|undefined} color Background sample.
   * @param {boolean} perceptual OKLab / YCbCr flag.
   * @returns {boolean} Chroma-key flag.
   */
  function referenceChromaKeyFor(color, perceptual) {
    return !perceptual && !isBlackPlate(color);
  }

  /**
   * Layers detected smart defaults under explicit workset/persisted sliders.
   * @param {object|undefined} existing Requested sliders.
   * @param {object|string|undefined} color Detected background.
   * @returns {object} Merged processing parameters.
   */
  function overlaySmartCutoutParameters(existing, color) {
    return {
      ...resolveSmartCutoutParameters(color),
      ...(existing && typeof existing === "object" ? existing : {}),
    };
  }

  /**
   * Resolves the shared smart-cutout slider profile for one detected background.
   * @param {object|string|undefined} color Background sample.
   * @returns {object} Workbench-compatible processing parameters.
   */
  function resolveSmartCutoutParameters(color) {
    const parsed = parseBackgroundColor(color);
    const kind = classifySmartBackground(parsed);
    const overrides =
      kind === "plate"
        ? isBlackPlate(parsed)
          ? { ...PLATE_SMART_OVERRIDES, ...BLACK_PLATE_OVERRIDES }
          : PLATE_SMART_OVERRIDES
        : CHROMA_SMART_OVERRIDES;
    return {
      ...REGULAR_AUTO_BACKGROUND_PARAMETERS,
      ...overrides,
      backgroundColor: `#${[parsed.r, parsed.g, parsed.b]
        .map((channel) =>
          Math.max(0, Math.min(255, Math.round(Number(channel) || 0)))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`,
    };
  }

  /**
   * Raises the idle plate tolerance when the sampled color is a black plate.
   * A user-cranked tolerance is left alone.
   * @param {object|undefined} existing Current sliders.
   * @param {object|string|undefined} color Newly sampled background.
   * @returns {object} Parameters with an updated background color.
   */
  function adjustParametersForBackgroundColor(existing, color) {
    const current = existing && typeof existing === "object" ? existing : {};
    const resolved = resolveSmartCutoutParameters(color);
    const next = { ...current, backgroundColor: resolved.backgroundColor };
    if (isBlackPlate(color) && Number(current.tolerance) <= PLATE_SMART_OVERRIDES.tolerance) {
      next.tolerance = resolved.tolerance;
    }
    return next;
  }

  return Object.freeze({
    BLACK_PLATE_MAX,
    BLACK_PLATE_OVERRIDES,
    CHROMA_SMART_OVERRIDES,
    PLATE_SMART_OVERRIDES,
    REGULAR_AUTO_BACKGROUND_PARAMETERS,
    adjustParametersForBackgroundColor,
    classifySmartBackground,
    isBlackPlate,
    overlaySmartCutoutParameters,
    referenceChromaKeyFor,
    resolveSmartCutoutParameters,
  });
});
