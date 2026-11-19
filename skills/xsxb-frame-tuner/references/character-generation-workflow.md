# Character generation and XSXB import

Use the user-selected art workflow or an available image generator to create the requested source artwork. Preserve the character reference, facing, palette and scale across poses. When the weapon should move independently, provide a separate transparent weapon PNG and leave a visible grip on the character.

For an attack, plan the grip and the blade tip together in anticipation, acceleration, contact and recovery. Put the weight and shoulder turn into those poses. Leave enough space on the striking side for the full sweep. Stage an uppercut with a low starting hand and raised finish, or a heavy descending cut with a high wind-up and a grounded finish. Check that the unlit silhouettes communicate the action at playback speed before authoring the trail. Use the visual review in [刀光和拖影](../SKILL.md#刀光和拖影) when unlit poses and weapon placement are ready.

Inspect the actual sheet layout, alpha, feet and grip before slicing. A transparent sprite can go directly to import. If the source uses a colored plate, preview cutout and inspect fine edges before applying it. A set of concept poses still needs frame ordering and timing before it can play as an action.

Import a packed sheet with `xsxb_slice_sheet` and an `animation_id`, or import ordered PNGs with `xsxb_import_animation`. Check the resulting frame count and playback. Use the weapon-binding or crescent workflow in [SKILL.md](../SKILL.md#刀光和拖影) when the requested effect needs it.
