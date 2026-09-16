"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { measureKeyedSubject } = require("../../mcp/xsxb_mcp_validate_godot");
const { HERO, HERO_COLORS, heroFrame, paintHero } = require("../acceptance_sprites");

test("paintHero is a standing figure whose keyed soles stay on the boot row", () => {
  const idle = heroFrame({ stride: 0, arm: 0 });
  const walk = heroFrame({ stride: 3, arm: -2, sword: true });
  const black = paintHero(HERO.width, HERO.height, {
    feetX: HERO.feetX,
    feetY: HERO.feetY,
    plate: [0, 0, 0, 255],
  });
  const slash = heroFrame({ sword: true, slash: true });
  const idleGeo = measureKeyedSubject(idle);
  const walkGeo = measureKeyedSubject(walk);
  const blackGeo = measureKeyedSubject({ data: black, width: HERO.width, height: HERO.height });
  const slashGeo = measureKeyedSubject(slash);
  assert.equal(idleGeo.feetY, HERO.feetY);
  assert.equal(walkGeo.feetY, HERO.feetY);
  assert.equal(blackGeo.feetY, HERO.feetY);
  assert.equal(slashGeo.feetY, HERO.feetY);
  assert.ok(idleGeo.bodyH >= 28, `hero body should be taller than a 14px block, got ${idleGeo.bodyH}`);
  assert.equal(walkGeo.bodyH, idleGeo.bodyH);
  let hair = 0;
  let skin = 0;
  let pant = 0;
  let boot = 0;
  for (let i = 0; i < idle.data.length; i += 4) {
    const pixel = idle.data.subarray(i, i + 4);
    if (pixel[0] === HERO_COLORS.hair[0] && pixel[2] === HERO_COLORS.hair[2]) hair += 1;
    if (pixel[0] === HERO_COLORS.skin[0] && pixel[1] === HERO_COLORS.skin[1]) skin += 1;
    if (pixel[0] === HERO_COLORS.pant[0] && pixel[2] === HERO_COLORS.pant[2]) pant += 1;
    if (pixel[0] === HERO_COLORS.boot[0] && pixel[1] === HERO_COLORS.boot[1]) boot += 1;
  }
  assert.ok(hair >= 20 && skin >= 20 && pant >= 20 && boot >= 16, { hair, skin, pant, boot });
});

test("wide walk stride keeps two separate boot clusters", () => {
  const walk = heroFrame({ stride: 5 });
  const xs = [];
  for (let y = 0; y < walk.height; y += 1) {
    for (let x = 0; x < walk.width; x += 1) {
      const i = (y * walk.width + x) * 4;
      if (
        walk.data[i] === HERO_COLORS.boot[0] &&
        walk.data[i + 1] === HERO_COLORS.boot[1] &&
        walk.data[i + 2] === HERO_COLORS.boot[2]
      ) {
        xs.push(x);
      }
    }
  }
  const span = Math.max(...xs) - Math.min(...xs);
  assert.ok(span >= 12, `walk boots must be planted apart, span=${span}`);
});
