"use strict";

/**
 * Returns the runtime scriptCore template chunk.
 * @returns {string} GDScript source fragment.
 */
function runtimeScriptCore() {
  return String.raw`

func _ensure_frame_audio_players() -> void:
	_frame_audio_players.clear()
	if _frame_audio_player != null:
		_frame_audio_players.append(_frame_audio_player)
	for index in range(1, FRAME_AUDIO_POOL_SIZE):
		var player_name: String = "FrameAudioPlayer%d" % index
		var player: AudioStreamPlayer = get_node_or_null(player_name) as AudioStreamPlayer
		if player == null:
			player = AudioStreamPlayer.new()
			player.name = player_name
			add_child(player)
		_frame_audio_players.append(player)


func _load_frame_runtime() -> void:
	_animations.clear()
	_tuning_values.clear()
	_scene_settings.clear()
	_frame_visual_overrides.clear()
	_frame_playback_overrides.clear()
	_frame_box_overrides.clear()
	_frame_audio_bindings.clear()
	_frame_image_attachments.clear()
	_attack_trail_bindings.clear()
	_texture_cache.clear()
	_last_visual_state_key = ""
	_runtime_ready = false

	var data_dir: String = "res://xsxb_frame_tuner/data/projects/%s" % frame_project_id
	var manifest: Dictionary = _read_json_dict("%s/animation_manifest.json" % data_dir)
	var tuning: Dictionary = _read_json_dict("%s/animation_tuning.json" % data_dir)
	var profile: Dictionary = _select_profile(manifest)
	if profile.is_empty():
		return
	if frame_profile_id == "":
		frame_profile_id = String(profile.get("id", ""))
	_load_profile_animations(profile)
	_tuning_values = _dict_from(tuning.get("values", {}))
	_scene_settings = _dict_from(tuning.get("scene_settings", {}))
	_frame_visual_overrides = _dict_from(tuning.get("frame_visual_overrides", {}))
	_frame_playback_overrides = _dict_from(tuning.get("frame_playback_overrides", {}))
	_frame_box_overrides = _dict_from(tuning.get("frame_box_overrides", {}))
	_load_frame_audio_bindings("%s/frame_audio_bindings.json" % data_dir)
	_load_frame_image_attachments("%s/frame_image_attachments.json" % data_dir)
	var attack_trails: Dictionary = _read_json_dict("%s/attack_trails.json" % data_dir)
	_attack_trail_bindings = _dict_from(attack_trails.get("bindings", {}))
	_configure_attack_trails()
	_runtime_ready = not _animations.is_empty()


func _read_json_dict(file_path: String) -> Dictionary:
	if not FileAccess.file_exists(file_path):
		return {}
	var file: FileAccess = FileAccess.open(file_path, FileAccess.READ)
	if file == null:
		return {}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	return parsed if parsed is Dictionary else {}


func _read_json_array(file_path: String) -> Array:
	if not FileAccess.file_exists(file_path):
		return []
	var file: FileAccess = FileAccess.open(file_path, FileAccess.READ)
	if file == null:
		return []
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	return parsed if parsed is Array else []


func _dict_from(value: Variant) -> Dictionary:
	return value if value is Dictionary else {}


func _select_profile(manifest: Dictionary) -> Dictionary:
	var profiles: Array = manifest.get("profiles", []) as Array
	for profile_value in profiles:
		if profile_value is Dictionary and (frame_profile_id == "" or String(profile_value.get("id", "")) == frame_profile_id):
			return profile_value
	return {}


func _load_profile_animations(profile: Dictionary) -> void:
	var animations: Array = profile.get("animations", []) as Array
	for animation_value in animations:
		if not animation_value is Dictionary:
			continue
		var animation: Dictionary = animation_value
		var animation_id: String = String(animation.get("id", animation.get("name", "")))
		if animation_id == "":
			continue
		var frames: Array = []
		for frame_value in animation.get("frames", []) as Array:
			if not frame_value is Dictionary:
				continue
			var frame: Dictionary = frame_value
			var texture_path: String = _res_path(String(frame.get("path", "")))
			var texture: Texture2D = _load_texture(texture_path)
			if texture == null:
				continue
			frames.append({
				"texture": texture,
				"duration": float(frame.get("duration", 1.0)),
				"width": float(frame.get("width", texture.get_width())),
				"height": float(frame.get("height", texture.get_height())),
			})
		if frames.is_empty():
			continue
		_animations[animation_id] = {
			"fps": float(animation.get("fps", 12.0)),
			"anchor_mode": String(animation.get("anchorMode", "canvas_bottom_center")),
			"frames": frames,
		}


func _res_path(raw_path: String) -> String:
	if raw_path.begins_with("res://"):
		return raw_path
	return "res://%s" % raw_path.trim_prefix("/")


func _load_texture(file_path: String) -> Texture2D:
	if _texture_cache.has(file_path):
		var cached_texture: Texture2D = _texture_cache.get(file_path) as Texture2D
		if cached_texture != null:
			return cached_texture
	if ResourceLoader.exists(file_path, "Texture2D"):
		var texture: Texture2D = ResourceLoader.load(file_path, "Texture2D") as Texture2D
		if texture != null:
			_texture_cache[file_path] = texture
			return texture
	var disk_path: String = ProjectSettings.globalize_path(file_path) if file_path.begins_with("res://") else file_path
	var image: Image = Image.new()
	var error: int = image.load(disk_path)
	if error != OK:
		return null
	var image_texture: ImageTexture = ImageTexture.create_from_image(image)
	_texture_cache[file_path] = image_texture
	return image_texture


func _load_frame_audio_bindings(file_path: String) -> void:
	for binding_value in _read_json_array(file_path):
		if not binding_value is Dictionary:
			continue
		var binding: Dictionary = binding_value
		var key: String = _stable_binding_key(binding)
		var stream_path: String = _res_path(String(binding.get("path", binding.get("file", ""))))
		if key == "" or stream_path == "res://":
			continue
		var stream: AudioStream = ResourceLoader.load(stream_path, "AudioStream") as AudioStream
		if stream != null:
			_frame_audio_bindings[key] = stream


func _load_frame_image_attachments(file_path: String) -> void:
	for attachment_value in _read_json_array(file_path):
		if not attachment_value is Dictionary:
			continue
		var attachment: Dictionary = attachment_value
		var key: String = _stable_binding_key(attachment)
		if key == "":
			continue
		if not _frame_image_attachments.has(key):
			_frame_image_attachments[key] = []
		_frame_image_attachments[key].append(attachment)


func _stable_binding_key(binding: Dictionary) -> String:
	if binding.has("key"):
		return String(binding.get("key", ""))
	var animation: String = String(binding.get("animation", ""))
	var profile_id: String = String(binding.get("profileId", frame_profile_id))
	if animation != "" and not animation.contains("/"):
		animation = "%s/%s" % [profile_id, animation]
	if animation == "":
		return ""
	return "%s:%d" % [animation, int(binding.get("frame", 0))]


func _first_animation_id() -> String:
	for key in _animations.keys():
		return String(key)
	return ""


func _current_frames() -> Array:
	var animation: Dictionary = _animations.get(_current_animation, {})
	return animation.get("frames", []) as Array


func _current_frame_data() -> Dictionary:
	var frames: Array = _current_frames()
	if frames.is_empty():
		return {}
	return frames[clampi(_current_frame, 0, frames.size() - 1)] as Dictionary


func _current_frame_duration() -> float:
	var frame_data: Dictionary = _current_frame_data()
	if _frame_is_disabled(_current_animation, _current_frame):
		return 0.001
	var playback: Dictionary = _frame_playback_overrides.get(_frame_key(_current_animation, _current_frame), {})
	return maxf(0.001, float(playback.get("duration", frame_data.get("duration", 1.0))) / _animation_fps(_current_animation))


func _frame_is_disabled(animation_name: String, frame_index: int) -> bool:
	var playback: Dictionary = _frame_playback_overrides.get(_frame_key(animation_name, frame_index), {})
	return playback.get("disabled", false) == true


func _animation_fps(animation_name: String) -> float:
	var animation: Dictionary = _animations.get(animation_name, {})
	var group_playback: Dictionary = _frame_playback_overrides.get(_group_playback_key(animation_name), {})
	return maxf(0.001, float(group_playback.get("fps", animation.get("fps", 12.0))))


func _frame_key(animation_name: String, frame_index: int) -> String:
	return "%s/%s:%d" % [frame_profile_id, animation_name, frame_index]


func _frame_duration_for(animation_name: String, frame_index: int) -> float:
	var animation: Dictionary = _animations.get(animation_name, {})
	var frames: Array = animation.get("frames", []) as Array
	if frame_index < 0 or frame_index >= frames.size():
		return 0.0
	var frame_data: Dictionary = frames[frame_index] as Dictionary
	var playback: Dictionary = _frame_playback_overrides.get(_frame_key(animation_name, frame_index), {})
	return maxf(0.001, float(playback.get("duration", frame_data.get("duration", 1.0))) / _animation_fps(animation_name))


func _group_playback_key(animation_name: String) -> String:
	return "%s/%s:__group" % [frame_profile_id, animation_name]


func _current_box(box_name: String) -> Dictionary:
	if _current_animation == "":
		return {}
	return _box_for_frame(_frame_key(_current_animation, _current_frame), box_name)


func _box_snapshot(box_name: String, fallback: Vector2, fallback_enabled: bool = true) -> Dictionary:
	var box: Dictionary = _current_box(box_name)
	if box.is_empty() or not _box_is_enabled(box, fallback_enabled):
		return {}
	var transform: Dictionary = _combined_visual_transform(_current_animation, _current_frame)
	var runtime_scale: float = _character_scale() * scene_scale()
	return {
		"position": _box_actor_position(box, transform, runtime_scale),
		"size": _box_actor_size(box, transform, runtime_scale, fallback),
		"rotation": (float(transform.get("rotation", 0.0)) + float(box.get("rotation", 0.0))) * float(render_facing()),
	}


func _record_entered_hitbox_snapshot() -> void:
	var snapshot: Dictionary = _box_snapshot("hitbox", Vector2(80.0, 40.0), false)
	if not snapshot.is_empty():
		_entered_hitbox_snapshots.append(snapshot)


func _apply_frame_visual() -> void:
	if _frame_sprite == null or _visual_owner == null:
		return
	var frame_data: Dictionary = _current_frame_data()
	var texture: Texture2D = frame_data.get("texture") as Texture2D
	if texture == null:
		return
	var animation: Dictionary = _animations.get(_current_animation, {})
	var frame_size: Vector2 = Vector2(float(frame_data.get("width", texture.get_width())), float(frame_data.get("height", texture.get_height())))
	var transform: Dictionary = _combined_visual_transform(_current_animation, _current_frame)
	var runtime_scale: float = _character_scale() * scene_scale()
	var sprite_scale_x: float = runtime_scale * float(transform.get("scale_x", 1.0))
	var sprite_scale_y: float = runtime_scale * float(transform.get("scale_y", 1.0))
	var visual_offset: Vector2 = transform.get("offset", Vector2.ZERO)
	var anchor: Vector2 = _source_anchor(String(animation.get("anchor_mode", "canvas_bottom_center")), frame_size)
	var render_facing_value: float = float(render_facing())
	var frame_key: String = _frame_key(_current_animation, _current_frame)
	var visual_state_key: String = _visual_state_key(
		frame_key,
		frame_size,
		anchor,
		transform,
		runtime_scale,
		render_facing_value,
	)
	_apply_attack_trail_transform(frame_size, anchor, transform, runtime_scale, render_facing_value)
	_update_attack_trails()
	if visual_state_key == _last_visual_state_key:
		return
	_last_visual_state_key = visual_state_key

	_visual_owner.position = Vector2(
		(visual_offset.x * runtime_scale * render_facing_value) + ((frame_size.x * 0.5 - anchor.x) * sprite_scale_x * render_facing_value),
		(visual_offset.y * runtime_scale) + ((frame_size.y * 0.5 - anchor.y) * sprite_scale_y)
	)
	_visual_owner.scale = Vector2(render_facing_value * sprite_scale_x, sprite_scale_y)
	_visual_owner.rotation_degrees = float(transform.get("rotation", 0.0)) * render_facing_value
	_frame_sprite.texture = texture
	_frame_sprite.centered = true
	_frame_sprite.visible = true

	_apply_frame_image_attachments(frame_key)
	if use_frame_boxes:
		_apply_frame_collision_box(frame_key, transform, runtime_scale)
		_apply_frame_hurtbox(frame_key, transform, runtime_scale)
		_apply_frame_hitbox(frame_key, transform, runtime_scale)


func _configure_attack_trails() -> void:
	if _attack_trails_behind != null and _attack_trails_behind.has_method("configure"):
		_attack_trails_behind.call("configure", self, _attack_trail_bindings, "behind")
	if _attack_trails_front != null and _attack_trails_front.has_method("configure"):
		_attack_trails_front.call("configure", self, _attack_trail_bindings, "front")


func _update_attack_trails() -> void:
	var elapsed := current_animation_elapsed()
	if _attack_trails_behind != null and _attack_trails_behind.has_method("update_for_animation"):
		_attack_trails_behind.call("update_for_animation", _current_animation, elapsed)
	if _attack_trails_front != null and _attack_trails_front.has_method("update_for_animation"):
		_attack_trails_front.call("update_for_animation", _current_animation, elapsed)


func _apply_attack_trail_transform(
	frame_size: Vector2,
	anchor: Vector2,
	transform: Dictionary,
	runtime_scale: float,
	render_facing_value: float,
) -> void:
	var scale_x: float = runtime_scale * float(transform.get("scale_x", 1.0))
	var scale_y: float = runtime_scale * float(transform.get("scale_y", 1.0))
	var visual_offset: Vector2 = transform.get("offset", Vector2.ZERO)
	var trail_position := Vector2(
		(visual_offset.x * runtime_scale * render_facing_value) + ((frame_size.x * 0.5 - anchor.x) * scale_x * render_facing_value),
		(visual_offset.y * runtime_scale) + ((frame_size.y * 0.5 - anchor.y) * scale_y)
	)
	for trail_node in [_attack_trails_behind, _attack_trails_front]:
		if trail_node == null:
			continue
		trail_node.position = trail_position
		trail_node.scale = Vector2(render_facing_value * scale_x, scale_y)
		trail_node.rotation_degrees = float(transform.get("rotation", 0.0)) * render_facing_value
`;
}

module.exports = {
  runtimeScriptCore,
};
