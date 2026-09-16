# generated_hero

1024×1024 RGB plates downsampled to 256×256 (LANCZOS, no grid) for playbook / MCP session fixtures.

## Sequences (256×256)

| Sequence | Frames | Source plates |
| --- | --- | --- |
| `idle/` | `00.png`, `01.png` | `hero_idle_a.png`, `hero_idle_b.png` (sword idle) |
| `walk/` | `00.png`, `01.png` | `hero_walk.png`, `hero_walk_b.png` (opposite contact, right foot forward) |
| `jump/` | `00.png`, `01.png` | `hero_jump.png`, `hero_jump_b.png` |
| `attack/` | `00.png`, `01.png` | `hero_attack.png`, `hero_idle_b.png` |
| `hit_vfx/` | `00.png`, `01.png` | `hero_vfx_burst.png`, `hero_vfx_burst_b.png` |
| `ink_idle/` | `00.png`, `01.png` | `hero_idle_black.png` (same black-plate idle, duplicated) |

## Raw plates (1024×1024)

`raw/` holds the authoring plates:

- `hero_idle_a.png`
- `hero_idle_b.png`
- `hero_idle_black.png`
- `hero_walk.png`
- `hero_walk_b.png` (GenerateImage, walk + idle_a references)
- `hero_jump.png`
- `hero_jump_b.png` (GenerateImage, jump + idle_a references)
- `hero_attack.png`
- `hero_vfx_burst.png`
- `hero_vfx_burst_b.png` (GenerateImage, burst reference)
