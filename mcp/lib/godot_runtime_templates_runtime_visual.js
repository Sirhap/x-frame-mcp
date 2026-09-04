"use strict";

/**
 * Returns the runtime scriptVisual template chunk.
 * @returns {string} GDScript source fragment.
 */
function runtimeScriptVisual() {
  return String.raw`

func _visual_state_key(
	frame_key: String,
	frame_size: Vector2,
	anchor: Vector2,
	transform: Dictionary,
	runtime_scale: float,
	render_facing_value: float,
) -> String:
	var visual_offset: Vector2 = transform.get("offset", Vector2.ZERO)
	return "%s|%f|%f|%f|%f|%f|%f|%f|%f|%f|%f|%f|%d" % [
		frame_key,
		frame_size.x,
		frame_size.y,
		anchor.x,
		anchor.y,
		float(transform.get("scale_x", 1.0)),
		float(transform.get("scale_y", 1.0)),
		visual_offset.x,
		visual_offset.y,
		float(transform.get("rotation", 0.0)),
		runtime_scale,
		render_facing_value,
		1 if use_frame_boxes else 0,
	]


func _source_anchor(anchor_mode: String, frame_size: Vector2) -> Vector2:
	if anchor_mode == "canvas_left_bottom":
		return Vector2(0.0, frame_size.y)
	if anchor_mode == "canvas_bottom_center":
		return Vector2(frame_size.x * 0.5, frame_size.y)
	return Vector2(frame_size.x * 0.5, frame_size.y)


func _combined_visual_transform(animation_name: String, frame_index: int) -> Dictionary:
	var character_scale: float = _character_scale()
	var character_scale_vector: Vector2 = _scale_vector_from_value(_tuning_values.get("profiles.%s.character.visual_scale" % frame_profile_id, {}), Vector2(character_scale, character_scale))
	var axis: Vector2 = Vector2.ONE
	if character_scale != 0.0:
		axis = character_scale_vector / character_scale

	var group_base: String = "profiles.%s.groups.%s" % [frame_profile_id, animation_name]
	var group_scale: float = float(_tuning_values.get("%s.visual_size" % group_base, 1.0))
	var group_scale_vector: Vector2 = _scale_vector_from_value(_tuning_values.get("%s.visual_scale" % group_base, {}), Vector2(group_scale, group_scale))
	var group_offset: Vector2 = _vector_from_value(_tuning_values.get("%s.offset" % group_base, {}), Vector2.ZERO)
	var group_rotation: float = float(_tuning_values.get("%s.rotation" % group_base, 0.0))

	var frame_override: Dictionary = _frame_visual_overrides.get(_frame_key(animation_name, frame_index), {})
	if not frame_override.is_empty():
		group_scale = float(frame_override.get("visual_size", group_scale))
		group_scale_vector = _scale_vector_from_value(frame_override.get("visual_scale", {}), group_scale_vector)
		group_offset = _vector_from_value(frame_override.get("offset", group_offset), group_offset)
		group_rotation = float(frame_override.get("rotation", group_rotation))

	return {
		"scale_x": group_scale_vector.x * axis.x,
		"scale_y": group_scale_vector.y * axis.y,
		"offset": _character_offset() + group_offset,
		"rotation": _character_rotation() + group_rotation,
	}


func _character_scale() -> float:
	return maxf(0.001, float(_tuning_values.get("profiles.%s.character.visual_size" % frame_profile_id, fallback_visual_scale)))


func _character_offset() -> Vector2:
	return _vector_from_value(_tuning_values.get("profiles.%s.character.offset" % frame_profile_id, {}), fallback_visual_offset)


func _character_rotation() -> float:
	return float(_tuning_values.get("profiles.%s.character.rotation" % frame_profile_id, 0.0))


func _box_for_frame(frame_key: String, box_name: String) -> Dictionary:
	var entry: Variant = _frame_box_overrides.get(frame_key, {})
	if not entry is Dictionary:
		return {}
	var box: Variant = entry.get(box_name, {})
	return box if box is Dictionary else {}


func _box_is_enabled(box: Dictionary, fallback: bool = true) -> bool:
	return bool(box.get("enabled", fallback))


func _box_actor_position(box: Dictionary, transform: Dictionary, runtime_scale: float) -> Vector2:
	var visual_offset: Vector2 = transform.get("offset", Vector2.ZERO)
	var box_offset: Vector2 = _vector_from_value(box.get("offset", {}), Vector2.ZERO)
	var sprite_scale_x: float = runtime_scale * float(transform.get("scale_x", 1.0))
	var sprite_scale_y: float = runtime_scale * float(transform.get("scale_y", 1.0))
	var render_facing_value: float = float(render_facing())
	var anchor_offset: Vector2 = Vector2(visual_offset.x * runtime_scale * render_facing_value, visual_offset.y * runtime_scale)
	var local_offset: Vector2 = Vector2(box_offset.x * sprite_scale_x * render_facing_value, box_offset.y * sprite_scale_y)
	return anchor_offset + local_offset.rotated(deg_to_rad(float(transform.get("rotation", 0.0)) * render_facing_value))


func _collision_box_actor_position(box: Dictionary, transform: Dictionary, runtime_scale: float) -> Vector2:
	var box_position: Vector2 = _box_actor_position(box, transform, runtime_scale)
	var box_size: Vector2 = _box_actor_size(box, transform, runtime_scale, Vector2(40.0, 90.0))
	return Vector2(box_position.x, -box_size.y * 0.5)


func _box_actor_size(box: Dictionary, transform: Dictionary, runtime_scale: float, fallback: Vector2) -> Vector2:
	var size: Vector2 = _vector_from_value(box.get("size", {}), fallback)
	var sprite_scale_x: float = absf(runtime_scale * float(transform.get("scale_x", 1.0)))
	var sprite_scale_y: float = absf(runtime_scale * float(transform.get("scale_y", 1.0)))
	return Vector2(maxf(1.0, absf(size.x) * sprite_scale_x), maxf(1.0, absf(size.y) * sprite_scale_y))


func _ensure_rectangle_shape(collision: CollisionShape2D) -> RectangleShape2D:
	var rect_shape: RectangleShape2D = collision.shape as RectangleShape2D
	if rect_shape == null:
		rect_shape = RectangleShape2D.new()
		collision.shape = rect_shape
	return rect_shape


func _apply_frame_collision_box(frame_key: String, transform: Dictionary, runtime_scale: float) -> void:
	if _body_collision == null:
		return
	var box: Dictionary = _box_for_frame(frame_key, "collisionbox")
	if box.is_empty() or not _box_is_enabled(box):
		_body_collision.disabled = true
		return
	var rect_shape: RectangleShape2D = _ensure_rectangle_shape(_body_collision)
	rect_shape.size = _box_actor_size(box, transform, runtime_scale, Vector2(40.0, 90.0))
	_body_collision.position = _collision_box_actor_position(box, transform, runtime_scale)
	_body_collision.rotation_degrees = 0.0
	_body_collision.disabled = false


func _apply_frame_hurtbox(frame_key: String, transform: Dictionary, runtime_scale: float) -> void:
	if _hurtbox_area == null or _hurtbox_collision == null:
		return
	var box: Dictionary = _box_for_frame(frame_key, "hurtbox")
	if box.is_empty() or not _box_is_enabled(box):
		_hurtbox_area.monitorable = false
		_hurtbox_collision.disabled = true
		return
	var rect_shape: RectangleShape2D = _ensure_rectangle_shape(_hurtbox_collision)
	rect_shape.size = _box_actor_size(box, transform, runtime_scale, Vector2(44.0, 90.0))
	_hurtbox_collision.position = _box_actor_position(box, transform, runtime_scale)
	_hurtbox_collision.rotation_degrees = (float(transform.get("rotation", 0.0)) + float(box.get("rotation", 0.0))) * float(render_facing())
	_hurtbox_collision.disabled = false
	_hurtbox_area.monitorable = true


func _apply_frame_hitbox(frame_key: String, transform: Dictionary, runtime_scale: float) -> void:
	if _hitbox_area == null or _hitbox_collision == null:
		return
	var box: Dictionary = _box_for_frame(frame_key, "hitbox")
	if box.is_empty() or not _box_is_enabled(box, false):
		_hitbox_area.monitoring = false
		_hitbox_collision.disabled = true
		return
	var rect_shape: RectangleShape2D = _ensure_rectangle_shape(_hitbox_collision)
	rect_shape.size = _box_actor_size(box, transform, runtime_scale, Vector2(80.0, 40.0))
	_hitbox_collision.position = _box_actor_position(box, transform, runtime_scale)
	_hitbox_collision.rotation_degrees = (float(transform.get("rotation", 0.0)) + float(box.get("rotation", 0.0))) * float(render_facing())
	_hitbox_collision.disabled = false
	_hitbox_area.monitoring = true


func _play_frame_audio(frame_key: String) -> void:
	var trigger_key: String = "%s#%d" % [frame_key, _frame_visit_serial]
	if trigger_key == _last_audio_key:
		return
	_last_audio_key = trigger_key
	if not _frame_audio_bindings.has(frame_key):
		return
	var stream: AudioStream = _frame_audio_bindings.get(frame_key) as AudioStream
	if stream == null:
		return
	var player: AudioStreamPlayer = _next_frame_audio_player()
	if player == null:
		return
	player.stream = stream
	player.play()


func _next_frame_audio_player() -> AudioStreamPlayer:
	if _frame_audio_players.is_empty():
		return _frame_audio_player
	for offset in range(_frame_audio_players.size()):
		var index: int = (_frame_audio_cursor + offset) % _frame_audio_players.size()
		var player: AudioStreamPlayer = _frame_audio_players[index] as AudioStreamPlayer
		if player != null and not player.playing:
			_frame_audio_cursor = (index + 1) % _frame_audio_players.size()
			return player
	var fallback: AudioStreamPlayer = _frame_audio_players[_frame_audio_cursor] as AudioStreamPlayer
	_frame_audio_cursor = (_frame_audio_cursor + 1) % _frame_audio_players.size()
	return fallback


func _play_current_frame_audio() -> void:
	if _current_animation == "" or _frame_is_disabled(_current_animation, _current_frame):
		return
	_play_frame_audio(_frame_key(_current_animation, _current_frame))


func _apply_frame_image_attachments(frame_key: String) -> void:
	var attachments: Array = []
	for attachment_value in _frame_image_attachments.get(frame_key, []):
		if attachment_value is Dictionary:
			attachments.append(attachment_value)
	attachments.sort_custom(Callable(self, "_sort_frame_image_attachment"))
	_sync_frame_image_attachment_layer(attachments, _attachments_below, true)
	_sync_frame_image_attachment_layer(attachments, _attachments_above, false)


func _sync_frame_image_attachment_layer(
	attachments: Array,
	parent: Node2D,
	below: bool,
) -> void:
	if parent == null:
		return
	var active_count: int = 0
	for attachment_value in attachments:
		if not attachment_value is Dictionary:
			continue
		var attachment: Dictionary = attachment_value
		var layer_order: float = _frame_image_attachment_layer_order(attachment)
		if (layer_order < 0.0) != below:
			continue
		var sprite: Sprite2D = null
		if active_count < parent.get_child_count():
			sprite = parent.get_child(active_count) as Sprite2D
		if sprite == null:
			sprite = Sprite2D.new()
			parent.add_child(sprite)
		_configure_frame_image_attachment(sprite, attachment)
		sprite.visible = sprite.texture != null
		active_count += 1
	for child_index in range(active_count, parent.get_child_count()):
		var pooled_sprite: Sprite2D = parent.get_child(child_index) as Sprite2D
		if pooled_sprite != null:
			pooled_sprite.visible = false


func _sort_frame_image_attachment(a: Variant, b: Variant) -> bool:
	var attachment_a: Dictionary = a if a is Dictionary else {}
	var attachment_b: Dictionary = b if b is Dictionary else {}
	return _frame_image_attachment_layer_order(attachment_a) < _frame_image_attachment_layer_order(attachment_b)


func _frame_image_attachment_layer_order(attachment: Dictionary) -> float:
	if attachment.has("layerOrder"):
		var order: float = float(attachment.get("layerOrder", 1.0))
		if absf(order) > 0.0001:
			return order
	return -1.0 if String(attachment.get("layer", "above")) == "below" else 1.0


func _configure_frame_image_attachment(sprite: Sprite2D, attachment: Dictionary) -> void:
	var image_path: String = _res_path(String(attachment.get("path", "")))
	var texture: Texture2D = _load_texture(image_path)
	sprite.texture = texture
	sprite.centered = true
	var local: Dictionary = attachment.get("transform", {}) if attachment.get("transform", {}) is Dictionary else {}
	sprite.position = _vector_from_value(local.get("offset", {}), Vector2.ZERO)
	sprite.scale = _scale_vector_from_value(local.get("visual_scale", local.get("scale", {})), Vector2.ONE)
	sprite.rotation_degrees = float(local.get("rotation", 0.0))


func _clear_children(node: Node) -> void:
	if node == null:
		return
	for child in node.get_children():
		child.queue_free()


func _vector_from_value(value: Variant, fallback: Vector2) -> Vector2:
	if value is Dictionary:
		return Vector2(float(value.get("x", fallback.x)), float(value.get("y", fallback.y)))
	if value is Vector2:
		return value
	if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT:
		return Vector2(float(value), float(value))
	return fallback


func _scale_vector_from_value(value: Variant, fallback: Vector2) -> Vector2:
	if value is Dictionary:
		var x: float = float(value.get("x", fallback.x))
		var y: float = float(value.get("y", fallback.y))
		if x == 0.0 and y == 0.0:
			return fallback
		return Vector2(maxf(0.001, x), maxf(0.001, y))
	if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT:
		var scalar: float = maxf(0.001, float(value))
		return Vector2(scalar, scalar)
	return fallback
`;
}

module.exports = {
  runtimeScriptVisual,
};
