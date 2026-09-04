# Character Generation Workflow

Use this reference when a request starts from a character concept, style reference, pose reference, or action idea instead of ready animation frames.

## Route the request

- Use `$2DCS s` for three simplification levels from one character image.
- Use `$2DCS ct` for a character concept plus a target-style reference.
- Use `$2DCS p` for one locked appearance reference plus one or more pose references.
- Use `$2DCS sq` for walk, run, jump, attack, and dash exploration frames.
- Use `$2DCS cs` for low, medium, and high-complexity right-facing idle starters.

Treat `p` and `sq` results as visual exploration, not pixel-aligned animation sequences. Do not claim seamless playback until a real ordered sequence has been authored and inspected.

## Continue into XSXB

1. Confirm the generated result is a single character on the expected 3:2 green background.
2. Import the chosen result into Batch Cutout and sample the background color for chroma removal.
3. Inspect edges, hands, weapons, cloth, and semi-transparent effects before exporting or replacing any existing frame.
4. Use Frame Organizer for ordering, reduction, flipping, and package export.
5. Only create or replace a Godot animation after the intended frame set and order are explicit.
