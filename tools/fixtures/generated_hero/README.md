# generated_hero

1024×1024 RGB plates downsampled to 256×256 (nearest-neighbor long-edge cap, no grid) for playbook / MCP session fixtures.

## Sequences (256×256)

| Sequence | Frames | Source plates |
| --- | --- | --- |
| `idle/` | `00.png`, `01.png` | `hero_idle_a.png`, `hero_idle_b.png` (sword idle) |
| `walk/` | `00.png`, `01.png`, `02.png`, `03.png` | `hero_walk.png`, `hero_walk_b.png` (opposite contact, right foot forward), `hero_walk_c.png` (mid-walk, left passing), `hero_walk_d.png` (recover contact) |
| `jump/` | `00.png`, `01.png`, `02.png`, `03.png` | `hero_jump_crouch.png`, `hero_jump.png` (takeoff), `hero_jump_b.png` (apex), `hero_jump_land.png` |
| `attack/` | `00.png`, `01.png`, `02.png`, `03.png` | `hero_attack_windup.png`, `hero_attack.png` (slash + gold crescent), `hero_attack_followthrough.png`, `hero_attack_recover.png` |
| `hurt/` | `00.png`, `01.png` | `hero_hurt.png` (raised-hands flinch), `hero_hurt_b.png` (clutch-side stagger) |
| `hit_vfx/` | `00.png`, `01.png` | `hero_vfx_burst.png`, `hero_vfx_burst_b.png` |
| `ink_idle/` | `00.png`, `01.png` | `hero_idle_black.png` (same black-plate idle, duplicated) |

## Raw plates (1024×1024)

`raw/` holds the authoring plates:

- `hero_idle_a.png`
- `hero_idle_b.png`
- `hero_idle_black.png`
- `hero_walk.png`
- `hero_walk_b.png` (GenerateImage, walk + idle_a references)
- `hero_walk_c.png` (mid-walk, left passing)
- `hero_walk_d.png` (recover contact)
- `hero_jump_crouch.png` (pre-jump crouch)
- `hero_jump.png`
- `hero_jump_b.png` (GenerateImage, jump + idle_a references)
- `hero_jump_land.png` (landing absorb)
- `hero_attack.png`
- `hero_attack_followthrough.png`
- `hero_attack_windup.png`
- `hero_attack_recover.png`
- `hero_hurt.png` (grounded hit reaction)
- `hero_hurt_b.png` (clutch-side stagger)
- `hero_vfx_burst.png`
- `hero_vfx_burst_b.png` (GenerateImage, burst reference)
