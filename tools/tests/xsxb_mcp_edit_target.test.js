"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createXsxbMcpService } = require("../../mcp/xsxb_mcp_service");
const { handleMessage } = require("../../mcp/xsxb_mcp_server");
const { encodePngRgba, decodePngRgba } = require("../../mcp/xsxb_mcp_cutout");

const red = [220, 20, 40, 255],
  green = [0, 255, 0, 255];
const png = encodePngRgba(new Uint8ClampedArray([...red, ...green]), 2, 1);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsxb-edit-target-test-"));
  const root = path.join(dir, "host");
  fs.mkdirSync(root);
  const service = createXsxbMcpService({ root, florenceDetectImpl: null });
  t.after(() => {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const raw = async (args) =>
    (
      await handleMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "xsxb_edit_target", arguments: args },
        },
        service,
      )
    ).result.structuredContent;
  const call = async (args) => {
    const receipt = await raw(args);
    assert.equal(receipt.ok, true, receipt.error?.message);
    return receipt.data;
  };
  return { dir, root, raw, call };
}
function rgba(file) {
  return [...decodePngRgba(file).data];
}
test("unregistered sequences preview then edit original PNGs in numeric order through public MCP", async (t) => {
  const { dir, root, call } = fixture(t);
  const sequence = path.join(dir, "frames");
  fs.mkdirSync(sequence);
  for (const name of ["10.png", "2.png"]) fs.writeFileSync(path.join(sequence, name), png);
  const args = { operation: "flip_horizontal", directory: sequence };
  const before = await call(args);
  assert.equal(before.dryRun, true);
  assert.deepEqual(
    before.animations[0].frames.map((f) => f.name),
    ["2.png", "10.png"],
  );
  assert.deepEqual(fs.readFileSync(path.join(sequence, "2.png")), png);
  await call({ ...args, dry_run: false });
  assert.deepEqual(rgba(path.join(sequence, "2.png")), [...green, ...red]);
  assert.deepEqual(rgba(path.join(sequence, "10.png")), [...green, ...red]);
  assert.deepEqual(fs.readdirSync(root), []);
});
test("ordered mixed items return transformed inline data and edit repeated disk textures once", async (t) => {
  const { dir, call } = fixture(t);
  const file = path.join(dir, "source.png");
  fs.writeFileSync(file, png);
  const result = await call({
    operation: "flip_horizontal",
    source: "items",
    items: [
      { file_path: file },
      { name: "embedded.png", data: "data:image/png;base64," + png.toString("base64") },
      { path: file },
    ],
    dry_run: false,
  });
  assert.equal(result.uniqueFrames, 2);
  assert.equal(result.frameCount, 3);
  assert.deepEqual(rgba(file), [...green, ...red]);
  const frame = result.animations[0].frames[1];
  assert.equal(frame.name, "embedded.png");
  assert.equal(frame.path, undefined);
  fs.writeFileSync(path.join(dir, "result.png"), Buffer.from(frame.data.split(",")[1], "base64"));
  assert.deepEqual(rgba(path.join(dir, "result.png")), [...green, ...red]);
});
test("failed batch leaves earlier original bytes in place and removes transaction files", async (t) => {
  const { dir, raw } = fixture(t);
  const a = path.join(dir, "a.png"),
    b = path.join(dir, "b.png");
  fs.writeFileSync(a, png);
  fs.writeFileSync(b, "corrupt");
  const r = await raw({ operation: "flip_horizontal", items: [{ path: a }, { path: b }], dry_run: false });
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readFileSync(a), png);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["a.png", "b.png", "host"]);
});
test("nested SpriteFrames resolves res://, honors the animation selector and preserves the resource", async (t) => {
  const { dir, call, raw } = fixture(t);
  fs.writeFileSync(path.join(dir, "project.godot"), "[application]\n");
  const sub = path.join(dir, "resources");
  fs.mkdirSync(sub);
  const a = path.join(dir, "a.png"),
    b = path.join(dir, "b.png");
  fs.writeFileSync(a, png);
  fs.writeFileSync(b, png);
  const resource = path.join(sub, "actor.tres");
  const text =
    '[gd_resource type="SpriteFrames" format=3]\n' +
    ["a", "b"].map((id) => `[ext_resource type="Texture2D" path="res://${id}.png" id="${id}"]`).join("\n") +
    "\n[resource]\nanimations = [" +
    ["a", "b"]
      .map(
        (id) =>
          `{"frames":[{"duration":2.0,"texture":ExtResource("${id}")}, {"duration":1.0,"texture":ExtResource("${id}")}],"loop":true,"name":&"${id}","speed":8.0}`,
      )
      .join(",") +
    "]\n";
  fs.writeFileSync(resource, text);
  const info = await call({ operation: "inspect", file_path: resource });
  assert.deepEqual(
    info.animations.map((x) => x.name),
    ["a", "b"],
  );
  assert.deepEqual(
    info.animations[0].frames.map((x) => x.duration),
    [2, 1],
  );
  await call({ operation: "flip_horizontal", file_path: resource, animation_id: "a", dry_run: false });
  assert.deepEqual(rgba(a), [...green, ...red]);
  assert.deepEqual(fs.readFileSync(b), png);
  assert.equal(fs.readFileSync(resource, "utf8"), text);
  fs.unlinkSync(b);
  const r = await raw({ operation: "flip_horizontal", file_path: resource, dry_run: false });
  assert.equal(r.ok, false);
  assert.deepEqual(rgba(a), [...green, ...red]);
});
test("standalone cutout can write a new PNG without modifying the input", async (t) => {
  const { dir, call } = fixture(t);
  const a = path.join(dir, "a.png"),
    out = path.join(dir, "out.png");
  const pixels = new Uint8ClampedArray(12 * 12 * 4);
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 12; x++)
      pixels.set(x >= 4 && x <= 7 && y >= 4 && y <= 7 ? red : green, (y * 12 + x) * 4);
  const bytes = encodePngRgba(pixels, 12, 12);
  fs.writeFileSync(a, bytes);
  await call({ operation: "cutout", file_path: a, output_path: out, key_color: "#00ff00", dry_run: false });
  assert.deepEqual(fs.readFileSync(a), bytes);
  assert.equal(rgba(out)[3], 0);
  assert.equal(rgba(out)[(5 * 12 + 5) * 4 + 3], 255);
});
test("video editing preserves audio packets and frame timestamps, and cutout retains transparency", async (t) => {
  const { dir, call, raw, root } = fixture(t);
  const movie = path.join(dir, "take.mp4");
  const ff = (...args) => execFileSync(process.env.XSXB_FFMPEG || "ffmpeg", ["-v", "error", ...args]);
  ff(
    "-f",
    "lavfi",
    "-i",
    "color=c=0x00ff00:s=32x24:r=6:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=500:duration=1",
    "-vf",
    "drawbox=x=0:y=4:w=8:h=8:color=red:t=fill,select=not(eq(n\\,2))",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    movie,
  );
  const audio = () => ff("-i", movie, "-map", "0:a:0", "-c", "copy", "-f", "hash", "-").toString();
  const pts = (file) =>
    execFileSync(
      process.env.XSXB_FFPROBE || "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "csv=p=0",
        file,
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)
      .map((x) => parseFloat(x))
      .filter(Number.isFinite);
  const originalTimes = pts(movie),
    originalAudio = audio(),
    originalBytes = fs.readFileSync(movie);
  assert.equal(originalTimes.length, 5);
  assert.ok(originalTimes[2] - originalTimes[1] > 0.3);
  assert.equal((await call({ operation: "inspect", file_path: movie })).audioStreams, 1);
  const analysis = await call({ operation: "analyze", file_path: movie });
  assert.equal(analysis.frameCount, originalTimes.length);
  assert.ok(analysis.analysis.duplicates);
  const invalid = await raw({ operation: "cutout", file_path: movie, output_path: movie, dry_run: false });
  assert.equal(invalid.ok, false);
  await call({ operation: "flip_horizontal", file_path: movie });
  assert.deepEqual(fs.readFileSync(movie), originalBytes);
  await call({ operation: "flip_horizontal", file_path: movie, dry_run: false });
  assert.equal(audio(), originalAudio);
  assert.deepEqual(pts(movie), originalTimes);
  const flipped = ff("-i", movie, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
  assert.ok(flipped[(6 * 32 + 28) * 3] > 180);
  assert.ok(flipped[(6 * 32 + 3) * 3 + 1] > 180);
  const beforeCut = fs.readFileSync(movie);
  const cut = await call({ operation: "cutout", file_path: movie, key_color: "#00ff00", dry_run: false });
  assert.deepEqual(fs.readFileSync(movie), beforeCut);
  assert.deepEqual(pts(cut.output_path), originalTimes);
  const rgba = ff("-i", cut.output_path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-");
  assert.equal(rgba[3], 0);
  assert.equal(rgba[(6 * 32 + 28) * 4 + 3], 255);
  const mkv = path.join(dir, "result.mkv");
  await call({
    operation: "cutout",
    file_path: cut.output_path,
    output_path: mkv,
    key_color: "#0000ff",
    dry_run: false,
  });
  const keyedAgain = ff("-i", mkv, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-");
  assert.equal(keyedAgain[3], 0, "an existing transparent area survives a second key");
  assert.equal(keyedAgain[(6 * 32 + 28) * 4 + 3], 255);
  assert.deepEqual(fs.readdirSync(root), []);
});
