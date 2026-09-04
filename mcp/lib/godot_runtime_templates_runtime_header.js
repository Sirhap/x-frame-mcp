"use strict";

/**
 * Returns the runtime scriptHeader template chunk.
 * @returns {string} GDScript source fragment.
 */
function runtimeScriptHeader() {
  return String.raw`extends CharacterBody2D

signal animation_finished(animation_name: String)

const XSXB_PROJECT_ID: String = __XSXB_PROJECT_ID__
const FRAME_AUDIO_POOL_SIZE: int = 8

@export var frame_project_id: String = XSXB_PROJECT_ID
@export var frame_profile_id: String = ""
@export var frame_animation: String = ""
@export var autoplay: bool = true
@export var loop_animation: bool = true
@export var facing: int = 1
@export var source_faces_left: bool = false
@export var fallback_visual_scale: float = 1.0
@export var fallback_visual_offset: Vector2 = Vector2.ZERO
@export var use_frame_boxes: bool = true

var _animations: Dictionary = {}
var _tuning_values: Dictionary = {}
var _scene_settings: Dictionary = {}
var _frame_visual_overrides: Dictionary = {}
var _frame_playback_overrides: Dictionary = {}
var _frame_box_overrides: Dictionary = {}
var _frame_audio_bindings: Dictionary = {}
var _frame_image_attachments: Dictionary = {}
var _attack_trail_bindings: Dictionary = {}
var _texture_cache: Dictionary = {}
var _current_animation: String = ""
var _current_frame: int = 0
var _frame_clock: float = 0.0
var _runtime_ready: bool = false
var _animation_finished: bool = false
var _last_audio_key: String = ""
var _frame_visit_serial: int = 0
var _frame_audio_players: Array = []
var _frame_audio_cursor: int = 0
var _entered_hitbox_snapshots: Array = []
var _last_visual_state_key: String = ""

@onready var _visual_owner: Node2D = get_node_or_null("VisualOwner") as Node2D
@onready var _frame_sprite: Sprite2D = get_node_or_null("VisualOwner/FrameSprite") as Sprite2D
@onready var _attachments_below: Node2D = get_node_or_null("VisualOwner/AttachmentsBelow") as Node2D
@onready var _attachments_above: Node2D = get_node_or_null("VisualOwner/AttachmentsAbove") as Node2D
@onready var _attack_trails_behind: Node2D = get_node_or_null("AttackTrailsBehind") as Node2D
@onready var _attack_trails_front: Node2D = get_node_or_null("AttackTrailsFront") as Node2D
@onready var _body_collision: CollisionShape2D = get_node_or_null("CollisionShape2D") as CollisionShape2D
@onready var _hurtbox_area: Area2D = get_node_or_null("Hurtbox") as Area2D
@onready var _hurtbox_collision: CollisionShape2D = get_node_or_null("Hurtbox/CollisionShape2D") as CollisionShape2D
@onready var _hitbox_area: Area2D = get_node_or_null("Hitbox") as Area2D
@onready var _hitbox_collision: CollisionShape2D = get_node_or_null("Hitbox/CollisionShape2D") as CollisionShape2D
@onready var _frame_audio_player: AudioStreamPlayer = get_node_or_null("FrameAudioPlayer") as AudioStreamPlayer


func _ready() -> void:
	_ensure_runtime_nodes()
	_load_frame_runtime()
	if autoplay and _runtime_ready:
		play_frame_animation(frame_animation if frame_animation != "" else _first_animation_id(), loop_animation)


func _process(delta: float) -> void:
	if not _runtime_ready or _current_animation == "":
		return
	_frame_clock += delta
	while _frame_clock >= _current_frame_duration():
		_frame_clock -= _current_frame_duration()
		_current_frame += 1
		var frames: Array = _current_frames()
		if _current_frame >= frames.size():
			if loop_animation:
				_current_frame = 0
			else:
				_current_frame = max(0, frames.size() - 1)
				if not _animation_finished:
					_animation_finished = true
					animation_finished.emit(_current_animation)
		_frame_visit_serial += 1
		_record_entered_hitbox_snapshot()
		_play_current_frame_audio()
	_apply_frame_visual()


func play_frame_animation(animation_name: String, should_loop: bool = true, restart: bool = false) -> void:
	if not _animations.has(animation_name):
		return
	if _current_animation == animation_name and not restart:
		loop_animation = should_loop
		_apply_frame_visual()
		return
	_current_animation = animation_name
	_current_frame = 0
	_frame_clock = 0.0
	loop_animation = should_loop
	_animation_finished = false
	_last_audio_key = ""
	_entered_hitbox_snapshots.clear()
	_frame_visit_serial += 1
	_record_entered_hitbox_snapshot()
	_play_current_frame_audio()
	_apply_frame_visual()


func restart_frame_animation(animation_name: String, should_loop: bool = true) -> void:
	play_frame_animation(animation_name, should_loop, true)


func trail_frame_arrival_time(animation_name: String, frame_index: int, frame_phase: float) -> float:
	var animation: Dictionary = _animations.get(animation_name, {})
	var frames: Array = animation.get("frames", []) as Array
	var clamped_frame: int = clampi(frame_index, 0, maxi(0, frames.size() - 1))
	var elapsed := 0.0
	for index in range(clamped_frame):
		if not _frame_is_disabled(animation_name, index):
			elapsed += _frame_duration_for(animation_name, index)
	if not _frame_is_disabled(animation_name, clamped_frame):
		elapsed += _frame_duration_for(animation_name, clamped_frame) * clampf(frame_phase, 0.0, 1.0)
	return elapsed


func current_animation_elapsed() -> float:
	var elapsed := trail_frame_arrival_time(_current_animation, _current_frame, 0.0)
	return elapsed + clampf(_frame_clock, 0.0, _frame_duration_for(_current_animation, _current_frame))


func animation_duration(animation_name: String) -> float:
	if not _animations.has(animation_name):
		return 0.0
	var animation: Dictionary = _animations.get(animation_name, {})
	var frames: Array = animation.get("frames", []) as Array
	var duration_units: float = 0.0
	for index in range(frames.size()):
		var playback: Dictionary = _frame_playback_overrides.get(_frame_key(animation_name, index), {})
		if playback.get("disabled", false) == true:
			continue
		var frame_value: Variant = frames[index]
		var frame_duration: float = 1.0
		if frame_value is Dictionary:
			frame_duration = float(frame_value.get("duration", 1.0))
		duration_units += maxf(0.001, float(playback.get("duration", frame_duration)))
	return maxf(0.001, duration_units / _animation_fps(animation_name))


func animation_last_playable_frame_start(animation_name: String) -> float:
	var animation: Dictionary = _animations.get(animation_name, {})
	var frames: Array = animation.get("frames", []) as Array
	for index in range(frames.size() - 1, -1, -1):
		if not _frame_is_disabled(animation_name, index):
			return trail_frame_arrival_time(animation_name, index, 0.0)
	return 0.0


func current_animation_duration() -> float:
	return animation_duration(_current_animation)


func scene_scale() -> float:
	return maxf(0.001, _scene_scale_for_current_scene())


func render_facing() -> int:
	var logical_facing: int = -1 if facing < 0 else 1
	var source_sign: int = -1 if source_faces_left else 1
	return logical_facing * source_sign


func current_box_enabled(box_name: String, fallback_enabled: bool = true) -> bool:
	var box: Dictionary = _current_box(box_name)
	return not box.is_empty() and _box_is_enabled(box, fallback_enabled)


func current_box_size(box_name: String, fallback: Vector2 = Vector2(40.0, 90.0), fallback_enabled: bool = true) -> Vector2:
	var box: Dictionary = _current_box(box_name)
	if box.is_empty() or not _box_is_enabled(box, fallback_enabled):
		return Vector2.ZERO
	var transform: Dictionary = _combined_visual_transform(_current_animation, _current_frame)
	var runtime_scale: float = _character_scale() * scene_scale()
	return _box_actor_size(box, transform, runtime_scale, fallback)


func current_box_position(box_name: String, fallback_enabled: bool = true) -> Vector2:
	var box: Dictionary = _current_box(box_name)
	if box.is_empty() or not _box_is_enabled(box, fallback_enabled):
		return Vector2.ZERO
	var transform: Dictionary = _combined_visual_transform(_current_animation, _current_frame)
	var runtime_scale: float = _character_scale() * scene_scale()
	return _box_actor_position(box, transform, runtime_scale)


func current_box_rotation_degrees(box_name: String, fallback_enabled: bool = true) -> float:
	var box: Dictionary = _current_box(box_name)
	if box.is_empty() or not _box_is_enabled(box, fallback_enabled):
		return 0.0
	var transform: Dictionary = _combined_visual_transform(_current_animation, _current_frame)
	return (float(transform.get("rotation", 0.0)) + float(box.get("rotation", 0.0))) * float(render_facing())


func current_collision_box_enabled() -> bool:
	return current_box_enabled("collisionbox")


func current_collision_box_size() -> Vector2:
	return current_box_size("collisionbox", Vector2(40.0, 90.0))


func current_collision_box_position() -> Vector2:
	var box: Dictionary = _current_box("collisionbox")
	if box.is_empty() or not _box_is_enabled(box):
		return Vector2.ZERO
	var transform: Dictionary = _combined_visual_transform(_current_animation, _current_frame)
	var runtime_scale: float = _character_scale() * scene_scale()
	return _collision_box_actor_position(box, transform, runtime_scale)


func current_grounded_collision_box_position() -> Vector2:
	return current_collision_box_position()


func current_collision_box_rotation_degrees() -> float:
	return 0.0


func current_hurtbox_enabled() -> bool:
	return current_box_enabled("hurtbox")


func current_hurtbox_size() -> Vector2:
	return current_box_size("hurtbox", Vector2(44.0, 90.0))


func current_hurtbox_position() -> Vector2:
	return current_box_position("hurtbox")


func current_hurtbox_rotation_degrees() -> float:
	return current_box_rotation_degrees("hurtbox")


func current_hitbox_enabled() -> bool:
	return current_box_enabled("hitbox", false)


func current_hitbox_size() -> Vector2:
	return current_box_size("hitbox", Vector2(80.0, 40.0), false)


func current_hitbox_position() -> Vector2:
	return current_box_position("hitbox", false)


func current_hitbox_rotation_degrees() -> float:
	return current_box_rotation_degrees("hitbox", false)


func consume_entered_hitbox_snapshots() -> Array:
	var snapshots: Array = _entered_hitbox_snapshots.duplicate(true)
	_entered_hitbox_snapshots.clear()
	return snapshots


func _scene_scale_for_current_scene() -> float:
	if _scene_settings.has("scale"):
		return float(_scene_settings.get("scale", 1.0))
	var scene_path: String = _current_scene_path()
	var settings: Dictionary = {}
	if scene_path != "":
		var scene_value: Variant = _scene_settings.get(scene_path, {})
		if scene_value is Dictionary:
			settings = scene_value
	if settings.is_empty():
		var default_value: Variant = _scene_settings.get("default", {})
		if default_value is Dictionary:
			settings = default_value
	return float(settings.get("scale", 1.0)) if not settings.is_empty() else 1.0


func _current_scene_path() -> String:
	var tree: SceneTree = get_tree()
	if tree != null:
		var current_scene: Node = tree.current_scene
		if current_scene != null and current_scene.scene_file_path != "":
			return current_scene.scene_file_path
	var node: Node = self
	while node != null:
		if node.scene_file_path != "":
			return node.scene_file_path
		node = node.get_parent()
	return ""


func _ensure_runtime_nodes() -> void:
	if _visual_owner == null:
		_visual_owner = Node2D.new()
		_visual_owner.name = "VisualOwner"
		add_child(_visual_owner)
	if _attachments_below == null:
		_attachments_below = Node2D.new()
		_attachments_below.name = "AttachmentsBelow"
		_visual_owner.add_child(_attachments_below)
	if _attack_trails_behind == null:
		_attack_trails_behind = Node2D.new()
		_attack_trails_behind.name = "AttackTrailsBehind"
		_attack_trails_behind.set_script(load("res://xsxb_frame_tuner/runtime/xsxb_attack_trail_renderer.gd"))
		add_child(_attack_trails_behind)
		move_child(_attack_trails_behind, _visual_owner.get_index())
	if _frame_sprite == null:
		_frame_sprite = Sprite2D.new()
		_frame_sprite.name = "FrameSprite"
		_visual_owner.add_child(_frame_sprite)
	if _attachments_above == null:
		_attachments_above = Node2D.new()
		_attachments_above.name = "AttachmentsAbove"
		_visual_owner.add_child(_attachments_above)
	if _attack_trails_front == null:
		_attack_trails_front = Node2D.new()
		_attack_trails_front.name = "AttackTrailsFront"
		_attack_trails_front.set_script(load("res://xsxb_frame_tuner/runtime/xsxb_attack_trail_renderer.gd"))
		add_child(_attack_trails_front)
		move_child(_attack_trails_front, _visual_owner.get_index() + 1)
	if _body_collision == null:
		_body_collision = CollisionShape2D.new()
		_body_collision.name = "CollisionShape2D"
		add_child(_body_collision)
	if _hurtbox_area == null:
		_hurtbox_area = Area2D.new()
		_hurtbox_area.name = "Hurtbox"
		_hurtbox_area.monitoring = false
		_hurtbox_area.monitorable = true
		add_child(_hurtbox_area)
	if _hurtbox_collision == null:
		_hurtbox_collision = CollisionShape2D.new()
		_hurtbox_collision.name = "CollisionShape2D"
		_hurtbox_area.add_child(_hurtbox_collision)
	if _hitbox_area == null:
		_hitbox_area = Area2D.new()
		_hitbox_area.name = "Hitbox"
		add_child(_hitbox_area)
	if _hitbox_collision == null:
		_hitbox_collision = CollisionShape2D.new()
		_hitbox_collision.name = "CollisionShape2D"
		_hitbox_area.add_child(_hitbox_collision)
	if _frame_audio_player == null:
		_frame_audio_player = AudioStreamPlayer.new()
		_frame_audio_player.name = "FrameAudioPlayer"
		add_child(_frame_audio_player)
	_ensure_frame_audio_players()
`;
}

module.exports = {
  runtimeScriptHeader,
};
