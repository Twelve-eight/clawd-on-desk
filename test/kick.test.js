"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const initKick = require("../src/kick");
const { resolveKick, advanceBody, collideWithBounds, constants } = initKick;

const PET = { left: 400, top: 400, right: 520, bottom: 520 };

describe("resolveKick", () => {
  it("returns null when the rects only touch or are apart", () => {
    assert.strictEqual(resolveKick(PET, { left: 520, top: 400, right: 700, bottom: 520 }, { x: 0, y: 0 }), null);
    assert.strictEqual(resolveKick(PET, { left: 900, top: 900, right: 1000, bottom: 1000 }, { x: 0, y: 0 }), null);
  });

  it("always throws the pet upward and out of the window, from every side", () => {
    const sides = {
      fromLeft: { left: 300, top: 380, right: 410, bottom: 540 },
      fromRight: { left: 510, top: 380, right: 700, bottom: 540 },
      pressedFromBelow: { left: 380, top: 510, right: 540, bottom: 700 },
      pressedFromAbove: { left: 380, top: 300, right: 540, bottom: 410 },
    };
    for (const [name, win] of Object.entries(sides)) {
      const r = resolveKick(PET, win, { x: 0, y: 0 }, () => 0.5);
      assert.ok(r, name);
      assert.ok(r.vy < 0, `${name}: vy ${r.vy} must be upward`);
      const moved = {
        left: PET.left + r.dx, right: PET.right + r.dx,
        top: PET.top + r.dy, bottom: PET.bottom + r.dy,
      };
      const ox = Math.min(moved.right, win.right) - Math.max(moved.left, win.left);
      const oy = Math.min(moved.bottom, win.bottom) - Math.max(moved.top, win.top);
      assert.ok(ox <= 1e-9 || oy <= 1e-9, `${name}: still overlapping after separation`);
    }
  });

  it("pushes sideways away from the window centre", () => {
    const left = resolveKick(PET, { left: 300, top: 380, right: 410, bottom: 540 }, { x: 0, y: 0 }, () => 0.5);
    const right = resolveKick(PET, { left: 510, top: 380, right: 700, bottom: 540 }, { x: 0, y: 0 }, () => 0.5);
    assert.ok(left.vx > 0 && left.dx > 0);
    assert.ok(right.vx < 0 && right.dx < 0);
  });

  it("kicks harder when the window is moving fast, within the cap", () => {
    const win = { left: 300, top: 380, right: 410, bottom: 540 };
    const slow = resolveKick(PET, win, { x: 0, y: 0 }, () => 0.5);
    const fast = resolveKick(PET, win, { x: 1500, y: -800 }, () => 0.5);
    assert.ok(fast.vy < slow.vy);
    assert.ok(fast.vy >= -2200);
    assert.ok(Math.abs(fast.vx) <= 1400);
  });
});

describe("ball physics", () => {
  it("a default kick reaches a sensible apex and falls back", () => {
    const r = resolveKick(PET, { left: 300, top: 380, right: 410, bottom: 540 }, { x: 0, y: 0 }, () => 0.5);
    const body = { x: 0, y: 0, vx: 0, vy: r.vy };
    let minY = 0;
    let t = 0;
    while (body.vy < 0 || body.y < 0) {
      advanceBody(body, 0.016);
      minY = Math.min(minY, body.y);
      t += 0.016;
      assert.ok(t < 5, "never came back down");
    }
    assert.ok(minY < -150 && minY > -600, `apex ${minY}`);
  });

  it("bounces off the floor with energy loss and rests when slow", () => {
    const body = { x: 0, y: 130, vx: 0, vy: 900 };
    const floor = { x: 0, y: 100 };
    const hit = collideWithBounds(body, floor);
    assert.strictEqual(body.y, 100);
    assert.ok(body.vy < 0 && body.vy > -900 * 0.5);
    assert.strictEqual(hit.onFloor, false);
    const slow = { x: 0, y: 130, vx: 0, vy: 100 };
    const rest = collideWithBounds(slow, floor);
    assert.strictEqual(slow.vy, 0);
    assert.strictEqual(rest.onFloor, true);
  });

  it("reflects horizontally off a wall", () => {
    const body = { x: -50, y: 0, vx: -500, vy: 0 };
    collideWithBounds(body, { x: 0, y: 0 });
    assert.strictEqual(body.x, 0);
    assert.ok(body.vx > 0 && body.vx < 500);
  });
});

function makeHarness({ windowRects }) {
  let clock = 1000;
  let petBounds = { x: 400, y: 800, width: 120, height: 120 };
  const applied = [];
  const states = [];
  let currentState = "idle";
  let released = 0;
  const probe = () => {
    const rect = windowRects.shift();
    return rect === undefined ? null : rect && { id: "w1", rect };
  };
  probe.supported = true;
  const kick = initKick({
    now: () => clock,
    random: () => 0.5,
    setTimeout: () => 0,
    clearTimeout: () => {},
    win: { isDestroyed: () => false, isVisible: () => true },
    dragLocked: false,
    probe,
    getPetWindowBounds: () => ({ ...petBounds }),
    applyPetWindowBounds: (b) => { petBounds = { ...b }; applied.push({ ...b }); },
    getHitRectScreen: (b) => ({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height }),
    clampToScreenVisual: (x, y, w, h) => ({
      x: Math.max(-30, Math.min(x, 1920 - w + 30)),
      y: Math.max(0, Math.min(y, 1000 - h)),
    }),
    getCurrentState: () => currentState,
    resolveDisplayState: () => "idle",
    applyState: (s) => { currentState = s; states.push(s); },
    setState: (s) => { currentState = s; states.push(s); },
    releaseReconcileProtection: () => { released += 1; },
  });
  return {
    kick,
    applied,
    states,
    get released() { return released; },
    get pet() { return petBounds; },
    advance(ms) { clock += ms; },
  };
}

describe("kick controller", () => {
  it("stays idle without a dragged window", () => {
    const h = makeHarness({ windowRects: [] });
    h.kick.setEnabled(true);
    h.kick._step();
    assert.strictEqual(h.kick.isAnimating(), false);
    assert.strictEqual(h.applied.length, 0);
  });

  it("a window hitting the pet launches it upward, then it lands and the visual is restored", () => {
    // Window sweeping in from the left, overlapping the pet on the first sample,
    // then moving away.
    const rects = [{ left: 300, top: 820, right: 420, bottom: 920 }];
    const h = makeHarness({ windowRects: rects });
    h.kick.setEnabled(true);
    h.kick._step();
    assert.strictEqual(h.kick.isAnimating(), true);
    assert.deepStrictEqual(h.states, ["juggling"]);

    let minY = h.pet.y;
    for (let i = 0; i < 400 && h.kick.isAnimating(); i += 1) {
      h.advance(16);
      h.kick._step();
      minY = Math.min(minY, h.pet.y);
    }
    assert.ok(minY < 800 - 100, `pet rose only to y=${minY}`);
    assert.strictEqual(h.kick.isAnimating(), false, "pet never settled");
    assert.strictEqual(h.pet.y, 1000 - 120, "pet should rest on the floor");
    assert.strictEqual(h.states[h.states.length - 1], "idle");
    assert.strictEqual(h.released, 1);
  });

  it("repeated hits during flight re-launch the pet (hacky sack)", () => {
    const hit = () => ({ left: 300, top: 820, right: 420, bottom: 920 });
    const rects = [hit()];
    const h = makeHarness({ windowRects: rects });
    h.kick.setEnabled(true);
    h.kick._step();
    // Let the pet fall for a few frames, then put the window under it again.
    for (let i = 0; i < 40; i += 1) { h.advance(16); h.kick._step(); }
    const yBefore = h.pet.y;
    assert.ok(yBefore < 800, "pet should be airborne");
    rects.push({ left: h.pet.x - 40, top: h.pet.y + 80, right: h.pet.x + 160, bottom: h.pet.y + 260 });
    h.advance(16);
    h.kick._step();
    // The pet was pushed out of the window and given upward velocity again.
    let rose = false;
    let prev = h.pet.y;
    for (let i = 0; i < 6; i += 1) {
      h.advance(16);
      h.kick._step();
      if (h.pet.y < prev) rose = true;
      prev = h.pet.y;
    }
    assert.ok(rose, "second hit did not send the pet upward");
  });


  it("a window parked on the pet pushes it out but does not re-kick", () => {
    const parked = () => ({ left: 300, top: 820, right: 420, bottom: 920 });
    const rects = [parked()];
    const h = makeHarness({ windowRects: rects });
    h.kick.setEnabled(true);
    h.kick._step();
    let kicks = 0;
    let prevVy = null;
    for (let i = 0; i < 12; i += 1) {
      // Same rect every frame: stationary overlap, window speed 0.
      rects.push({ left: 300, top: h.pet.y + 20, right: h.pet.x + 20, bottom: h.pet.y + 120 });
      h.advance(16);
      h.kick._step();
      const vyNow = h.pet.y;
      if (prevVy !== null && vyNow < prevVy - 30) kicks += 1;
      prevVy = vyNow;
    }
    assert.strictEqual(kicks, 0, "stationary overlap must not keep launching the pet");
  });


  it("a gate closing mid-flight drops the pet to the floor instead of freezing it in the air", () => {
    let imeActive = false;
    let clock = 1000;
    let petBounds = { x: 400, y: 800, width: 120, height: 120 };
    const rects = [{ left: 300, top: 820, right: 420, bottom: 920 }];
    const probe = Object.assign(() => { const r = rects.shift(); return r ? { id: "w", rect: r } : null; }, { supported: true });
    const kick = initKick({
      now: () => clock,
      random: () => 0.5,
      setTimeout: () => 0,
      clearTimeout: () => {},
      win: { isDestroyed: () => false, isVisible: () => true },
      probe,
      isImeEditingActive: () => imeActive,
      getPetWindowBounds: () => ({ ...petBounds }),
      applyPetWindowBounds: (b) => { petBounds = { ...b }; },
      clampToScreenVisual: (x, y, w, h) => ({ x, y: Math.max(0, Math.min(y, 1000 - h)) }),
    });
    kick.setEnabled(true);
    kick._step();
    for (let i = 0; i < 12; i += 1) { clock += 16; kick._step(); }
    assert.ok(petBounds.y < 800 - 50, "pet should be airborne before the gate closes");
    imeActive = true;
    clock += 16;
    kick._step();
    assert.strictEqual(kick.isAnimating(), false);
    assert.strictEqual(petBounds.y, 1000 - 120, "pet must land on the floor");
  });

  it("does nothing while the user is dragging the pet itself", () => {
    const kick = initKick({
      now: () => 1000,
      setTimeout: () => 0,
      clearTimeout: () => {},
      win: { isDestroyed: () => false, isVisible: () => true },
      dragLocked: true,
      probe: Object.assign(() => ({ id: "w", rect: { left: 300, top: 820, right: 420, bottom: 920 } }), { supported: true }),
      getPetWindowBounds: () => ({ x: 400, y: 800, width: 120, height: 120 }),
      applyPetWindowBounds: () => { throw new Error("must not move the pet"); },
      clampToScreenVisual: (x, y) => ({ x, y }),
    });
    kick.setEnabled(true);
    kick._step();
    assert.strictEqual(kick.isAnimating(), false);
  });

  it("refuses to enable when the probe is unsupported", () => {
    const probe = Object.assign(() => null, { supported: false });
    const kick = initKick({ probe, setTimeout: () => 0, clearTimeout: () => {} });
    kick.setEnabled(true);
    assert.strictEqual(kick.enabled, false);
  });
});

describe("constants", () => {
  it("scan interval is fast enough to catch a swept window", () => {
    assert.ok(constants.SCAN_MS <= 80);
  });
});
