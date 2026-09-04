const fs = require("node:fs");
const path = require("node:path");
const { reslash } = require("./project_store");
const { actorScene, runtimeScript, testScene } = require("./godot_runtime_templates");

const GODOT_SYNC_ROOT = "xsxb_frame_tuner";

function validGodotProjectRoot(project) {
  const projectRoot = project?.projectRoot ? path.resolve(String(project.projectRoot)) : "";
  if (!projectRoot || !fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) return "";
  return projectRoot;
}

function firstRuntimeTarget(manifest) {
  for (const profile of Array.isArray(manifest?.profiles) ? manifest.profiles : []) {
    const animations = Array.isArray(profile.animations) ? profile.animations : [];
    if (!animations.length) continue;
    return {
      profileId: String(profile.id || "profile"),
      animationId: String(animations[0].id || animations[0].name || "idle"),
    };
  }
  return { profileId: "profile", animationId: "idle" };
}

function writeIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === content) return false;
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function ensureGodotRuntime(root, project, options = {}) {
  const projectRoot = validGodotProjectRoot(project);
  if (!projectRoot) return { wroteRuntime: false, runtimeFiles: [] };
  const target = firstRuntimeTarget(options.manifest);
  const runtimeDir = path.join(projectRoot, GODOT_SYNC_ROOT, "runtime");
  const files = [
    {
      path: path.join(runtimeDir, "xsxb_frame_actor.gd"),
      content: runtimeScript(project.id),
    },
    {
      path: path.join(runtimeDir, "xsxb_frame_actor.tscn"),
      content: actorScene(project.id, target),
    },
    {
      path: path.join(runtimeDir, "xsxb_runtime_test.tscn"),
      content: testScene(),
    },
    {
      path: path.join(runtimeDir, "xsxb_attack_trail_renderer.gd"),
      content: fs.readFileSync(path.join(__dirname, "runtime", "xsxb_attack_trail_renderer.gd"), "utf8"),
    },
    {
      path: path.join(runtimeDir, "xsxb_attack_trail.gdshader"),
      content: fs.readFileSync(path.join(__dirname, "runtime", "xsxb_attack_trail.gdshader"), "utf8"),
    },
  ];
  const runtimeFiles = [];
  for (const file of files) {
    if (writeIfChanged(file.path, file.content)) {
      runtimeFiles.push(reslash(path.relative(projectRoot, file.path)));
    }
  }
  return {
    wroteRuntime: runtimeFiles.length > 0,
    runtimeFiles,
  };
}

module.exports = {
  ensureGodotRuntime,
  runtimeScript,
};
