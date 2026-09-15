(function attachXFrameAttachmentUtils(root, factory) {
  "use strict";

  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XFrameAttachmentUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (root) => {
  "use strict";

  /**
   * Creates a stable local identifier without requiring a crypto API.
   * @param {string} [prefix="id"] Identifier prefix.
   * @returns {string} New local identifier.
   */
  function newLocalId(prefix = "id") {
    if (root.crypto?.randomUUID) return `${prefix}_${root.crypto.randomUUID().replaceAll("-", "")}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  /**
   * Normalizes an attached image transform.
   * @param {{scale?:number,scaleX?:number,scaleY?:number,visual_scale?:{x?:number,y?:number},offset?:{x?:number,y?:number},rotation?:number}} [transform]
   * Raw transform.
   * @returns {{scale:number,scaleX:number,scaleY:number,offset:{x:number,y:number},rotation:number}}
   * Normalized transform.
   */
  function normalizeAttachmentTransform(transform = {}) {
    const rawScale = transform.scale;
    const scaleFromVector =
      rawScale && typeof rawScale === "object" ? Number(rawScale.x ?? rawScale.y) : Number(rawScale);
    const scale = Math.max(
      0.001,
      Number.isFinite(scaleFromVector) && scaleFromVector > 0 ? scaleFromVector : 1,
    );
    return {
      scale,
      scaleX: Math.max(
        0.001,
        Number(transform.scaleX ?? transform.visual_scale?.x ?? (rawScale && rawScale.x) ?? scale),
      ),
      scaleY: Math.max(
        0.001,
        Number(transform.scaleY ?? transform.visual_scale?.y ?? (rawScale && rawScale.y) ?? scale),
      ),
      offset: {
        x: Number(transform.offset?.x || 0),
        y: Number(transform.offset?.y || 0),
      },
      rotation: Number(transform.rotation || 0),
    };
  }

  /**
   * Places an attachment under a VisualOwner the way Tuner/Godot do:
   * owner visual_size/scale multiplies offset, flipH mirrors facing, owner rotation is added.
   * @param {object} local Normalized local transform.
   * @param {{visual_size?:number,scale?:number,scaleX?:number,scaleY?:number,runtimeScale?:number,worldScale?:number,flipH?:boolean,rotation?:number}} [owner]
   * Owner render transform.
   * @returns {{originX:number,originY:number,scaleX:number,scaleY:number,rotation:number,flipH:boolean}}
   */
  function attachmentOwnerPlacement(local, owner = {}) {
    const transform = normalizeAttachmentTransform(local);
    const ownerScale = Number(owner.visual_size ?? owner.scale ?? 1);
    const scaleX = Number(owner.scaleX ?? ownerScale);
    const scaleY = Number(owner.scaleY ?? ownerScale);
    const runtimeScale = Number(owner.runtimeScale ?? 1);
    const worldScale = Number(owner.worldScale ?? 1);
    const facing = owner.flipH ? -1 : 1;
    const ownerRotation = Number(owner.rotation || 0);
    const ox = transform.offset.x * scaleX * runtimeScale * worldScale * facing;
    const oy = transform.offset.y * scaleY * runtimeScale * worldScale;
    const ownerRotationRadians = (ownerRotation * facing * Math.PI) / 180;
    return {
      originX: ox * Math.cos(ownerRotationRadians) - oy * Math.sin(ownerRotationRadians),
      originY: ox * Math.sin(ownerRotationRadians) + oy * Math.cos(ownerRotationRadians),
      scaleX: Math.max(0.001, runtimeScale * scaleX * transform.scaleX * worldScale),
      scaleY: Math.max(0.001, runtimeScale * scaleY * transform.scaleY * worldScale),
      rotation: (ownerRotation + transform.rotation) * facing,
      flipH: Boolean(owner.flipH),
    };
  }

  /**
   * Normalizes the signed layer order used by attachment sorting.
   * @param {{layerOrder?:number,layer?:string}|null|undefined} source Raw attachment.
   * @returns {number} Signed layer order.
   */
  function normalizeAttachmentLayerOrder(source = {}) {
    const parsed = Number(source.layerOrder);
    if (Number.isFinite(parsed) && Math.abs(parsed) > 0.0001) return parsed;
    return source.layer === "below" ? -1 : 1;
  }

  /**
   * Normalizes a persisted attached image record.
   * @param {object|null|undefined} raw Raw attachment record.
   * @returns {object} Normalized attachment record.
   */
  function normalizeFrameImageAttachment(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
    const key = String(source.key || source.frameKey || "");
    const layerOrder = normalizeAttachmentLayerOrder(source);
    return {
      id: String(source.id || newLocalId("layer")),
      key,
      frameKey: key,
      metadata,
      name: String(source.name || "image"),
      path: String(source.path || ""),
      assetId: String(source.assetId || source.automation?.assetId || ""),
      assetHash: String(source.assetHash || ""),
      type: String(source.type || ""),
      width: Number(source.width || 0),
      height: Number(source.height || 0),
      layer: layerOrder < 0 ? "below" : "above",
      layerOrder,
      transform: normalizeAttachmentTransform(source.transform),
      automation:
        source.automation && typeof source.automation === "object"
          ? structuredClone(source.automation)
          : undefined,
    };
  }

  /**
   * Creates a clipboard-safe attachment copy without project identity fields.
   * @param {object} attachment Normalized attachment.
   * @returns {object} Clipboard attachment payload.
   */
  function frameImageAttachmentClipboardItem(attachment) {
    return {
      name: attachment.name,
      path: attachment.path,
      ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
      assetHash: attachment.assetHash,
      type: attachment.type,
      width: attachment.width,
      height: attachment.height,
      layer: attachment.layer === "below" ? "below" : "above",
      layerOrder: normalizeAttachmentLayerOrder(attachment),
      transform: structuredClone(normalizeAttachmentTransform(attachment.transform)),
    };
  }

  return {
    attachmentLayerOrder: normalizeAttachmentLayerOrder,
    frameImageAttachmentClipboardItem,
    attachmentOwnerPlacement,
    newLocalId,
    normalizeAttachmentLayerOrder,
    normalizeAttachmentTransform,
    normalizeFrameImageAttachment,
  };
});
