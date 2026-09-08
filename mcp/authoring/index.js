"use strict";
const { createRevisionStore } = require("./revisions");
const { createAnimationManager } = require("./animation_management");
const { createCanvasTool } = require("./canvas");
const { createQualityTool } = require("./quality");
const { createAttachmentInterpolation } = require("./attachment_interpolation");
const { shouldCommit } = require("../xsxb_mcp_commit");

/** Connects domain modules to the existing project selection and synchronization seams. */
function createAuthoringTools(context) {
  const revisions = createRevisionStore(context);
  const project = (args) => context.registryProject(args.project_id, false);
  /**
   * Prunes after a committed edit and reports cleanup without masking the edit.
   * @param {object} selectedProject Project owning the checkpoints.
   * @param {object} result Successful local edit result.
   * @param {string} revisionId Recovery checkpoint to retain.
   * @returns {void}
   */
  function retainHistory(selectedProject, result, revisionId) {
    const retention = revisions.prune(selectedProject, { protectedRevisionIds: [revisionId] });
    if (result && typeof result === "object") result.retention = retention;
    for (const warning of retention.warnings) process.emitWarning(warning);
  }
  /**
   * Applies retention to authoring handlers which create their own checkpoints.
   * @param {Function} handler Synchronous authoring handler.
   * @returns {Function} Handler with post-commit cleanup.
   */
  function withRetention(handler) {
    return (args) => {
      const result = handler(args);
      if (result.revisionId && result.dryRun === false)
        retainHistory(project(args), result, result.revisionId);
      return result;
    };
  }
  /** Restores a checkpoint and optionally synchronizes the restored local state. */
  function restore(args) {
    const p = project(args),
      result = revisions.restore(p, args);
    if (result.restored) {
      context.clearAnimationSelection();
      result.sync = context.synchronize(p, args.sync === true);
    }
    return result;
  }
  const handlers = {
    xsxb_save_revision: (args) => ({
      projectId: project(args).id,
      ...revisions.save(project(args), args.label),
    }),
    xsxb_list_revisions: (args) => ({
      projectId: project(args).id,
      revisions: revisions.list(project(args)),
    }),
    xsxb_compare_revisions: (args) => revisions.compare(project(args), args),
    xsxb_restore_revision: restore,
    xsxb_undo: (args) => {
      const id = args.revision_id || revisions.list(project(args))[0]?.revisionId;
      if (!id) throw new Error("No revision to undo to.");
      return restore({ ...args, revision_id: id });
    },
    xsxb_manage_animation: withRetention(createAnimationManager(context, revisions)),
    xsxb_resize_canvas: withRetention(createCanvasTool(context, revisions)),
    xsxb_check_animation: createQualityTool(context),
    xsxb_interpolate_attachment: withRetention(createAttachmentInterpolation(context, revisions)),
  };
  const checkpointTools = new Set([
    "xsxb_import_video",
    "xsxb_import_animation",
    "xsxb_cutout",
    "xsxb_update_frame_boxes",
    "xsxb_update_timing",
    "xsxb_set_visual_transform",
    "xsxb_estimate_boxes",
    "xsxb_estimate_visual",
    "xsxb_register_clip",
    "xsxb_replace_frame",
    "xsxb_shift_frames",
    "xsxb_plant_feet",
    "xsxb_add_attachment",
    "xsxb_add_sfx",
    "xsxb_add_attack_trail",
    "xsxb_remove_binding",
    "xsxb_delete_animation",
    "xsxb_reorganize_frames",
  ]);
  /** Records recovery data only for project mutations, never standalone image operations. */
  function checkpoint(name, args) {
    if (!checkpointTools.has(name) || args.dry_run === true || (name === "xsxb_cutout" && args.file_path))
      return null;
    if (
      ["xsxb_register_clip", "xsxb_plant_feet", "xsxb_estimate_visual"].includes(name) &&
      !shouldCommit(args)
    )
      return null;
    if (name === "xsxb_reorganize_frames" && args.dry_run !== false) return null;
    const p = context.registryProject(args.project_id, false);
    return { project: p, revisionId: revisions.save(p, `before ${name}`, true, true).revisionId };
  }
  /** Keeps undo history focused on operations that actually changed authoring files. */
  function finishCheckpoint(checkpoint, options = {}) {
    if (!checkpoint) return null;
    try {
      if (revisions.discardUnchanged(checkpoint.project, checkpoint.revisionId)) return null;
      if (options.succeeded === true)
        retainHistory(checkpoint.project, options.result, checkpoint.revisionId);
      return checkpoint.revisionId;
    } catch (error) {
      process.emitWarning(`Checkpoint cleanup deferred: ${error.message}`);
      return checkpoint.revisionId;
    }
  }
  return { handlers, checkpoint, finishCheckpoint };
}
module.exports = { createAuthoringTools };
