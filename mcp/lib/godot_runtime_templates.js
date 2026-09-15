"use strict";

const { runtimeScriptHeader } = require("./godot_runtime_templates_runtime_header");
const { runtimeScriptCore } = require("./godot_runtime_templates_runtime_core");
const { runtimeScriptVisual } = require("./godot_runtime_templates_runtime_visual");

/**
 * Encodes a JavaScript value for a Godot string literal.
 * @param {unknown} value Source value.
 * @returns {string} JSON-quoted string literal.
 */
function gdString(value) {
  return JSON.stringify(String(value || ""));
}

/**
 * Creates the generated Godot runtime actor script.
 * @param {string} projectId Frame-tuner project identifier.
 * @returns {string} GDScript source.
 */
function runtimeScript(projectId) {
  const source = [runtimeScriptHeader(), runtimeScriptCore(), runtimeScriptVisual()].join("");
  return source.replace("__XSXB_PROJECT_ID__", gdString(projectId));
}
/**
 * Creates the generated Godot actor scene.
 * @param {string} projectId Frame-tuner project identifier.
 * @param {{profileId:string,animationId:string}} target Initial runtime target.
 * @returns {string} Godot scene source.
 */
function actorScene(projectId, target) {
  return `[gd_scene load_steps=6 format=3]

[ext_resource type="Script" path="res://x_frame/runtime/xsxb_frame_actor.gd" id="1_script"]
[ext_resource type="Script" path="res://x_frame/runtime/xsxb_attack_trail_renderer.gd" id="2_trail"]

[sub_resource type="RectangleShape2D" id="RectangleShape2D_body"]
size = Vector2(40, 90)

[sub_resource type="RectangleShape2D" id="RectangleShape2D_hurtbox"]
size = Vector2(44, 90)

[sub_resource type="RectangleShape2D" id="RectangleShape2D_hitbox"]
size = Vector2(80, 40)

[node name="XFrameActor" type="CharacterBody2D"]
script = ExtResource("1_script")
frame_project_id = ${gdString(projectId)}
frame_profile_id = ${gdString(target.profileId)}
frame_animation = ${gdString(target.animationId)}

[node name="AttackTrailsBehind" type="Node2D" parent="."]
script = ExtResource("2_trail")

[node name="VisualOwner" type="Node2D" parent="."]

[node name="AttachmentsBelow" type="Node2D" parent="VisualOwner"]

[node name="FrameSprite" type="Sprite2D" parent="VisualOwner"]

[node name="AttachmentsAbove" type="Node2D" parent="VisualOwner"]

[node name="AttackTrailsFront" type="Node2D" parent="."]
script = ExtResource("2_trail")

[node name="CollisionShape2D" type="CollisionShape2D" parent="."]
shape = SubResource("RectangleShape2D_body")

[node name="Hurtbox" type="Area2D" parent="."]
monitoring = false
monitorable = true

[node name="CollisionShape2D" type="CollisionShape2D" parent="Hurtbox"]
shape = SubResource("RectangleShape2D_hurtbox")

[node name="Hitbox" type="Area2D" parent="."]
monitoring = false
monitorable = false

[node name="CollisionShape2D" type="CollisionShape2D" parent="Hitbox"]
shape = SubResource("RectangleShape2D_hitbox")
disabled = true

[node name="FrameAudioPlayer" type="AudioStreamPlayer" parent="."]
`;
}

/**
 * Creates the generated Godot smoke-test scene.
 * @returns {string} Godot scene source.
 */
function testScene() {
  return `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://x_frame/runtime/xsxb_frame_actor.tscn" id="1_actor"]

[node name="XFrameRuntimeTest" type="Node2D"]

[node name="XFrameActor" parent="." instance=ExtResource("1_actor")]
position = Vector2(640, 640)
`;
}

module.exports = {
  actorScene,
  runtimeScript,
  testScene,
};
