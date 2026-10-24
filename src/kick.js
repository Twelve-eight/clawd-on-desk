"use strict";

// src/kick.js — "keepy-uppy": a window dragged into the pet kicks it upward.
//
// While the user drags another application's window (system move loop,
// detected by win-moving-window.js), the pet is treated as a ball:
//   • Overlap between the dragged window's frame and the pet's visible hit
//     rect separates the two bodies and gives the pet an upward velocity
//     (plus a sideways push away from the window, plus part of the window's own
//     velocity), so repeated contact keeps it in the air like a shuttlecock.
//   • Between kicks the pet follows gravity, bounces off the work-area floor
//     and side walls, and settles on the floor once it stops moving.
//   • Movement goes through applyPetWindowBounds with the size frozen at kick
//     start (same #569 rule as roam.js), and counts as a reconcile protection
//     period exactly like a roam walk.
// The module owns its own scan timer: tick.js slows to 1s in low-power idle,
// which is far too coarse to notice a window sweeping past.

const GRAVITY = 2600; // px/s^2
const KICK_UP_MIN = 1000; // px/s, ~190px apex at GRAVITY
const KICK_UP_MAX = 1900;
const KICK_UP_WINDOW_GAIN = 0.45; // faster window => higher kick
const KICK_SIDE_BASE = 220;
const KICK_WINDOW_VX_GAIN = 0.6;
const KICK_JITTER = 160; // total width of the random sideways spread
const MAX_SPEED_X = 1400;
const MAX_SPEED_UP = 2200;
const MAX_SPEED_DOWN = 2600;
const RESTITUTION_FLOOR = 0.42;
const RESTITUTION_WALL = 0.6;
const CEILING_ABSORB = 0.3;
const REST_SPEED = 160; // below this a floor hit does not bounce
const FLOOR_FRICTION_PER_S = 6;
const KICK_COOLDOWN_MS = 110;
const KICK_MIN_WINDOW_SPEED = 250; // px/s; slower overlap only separates, never re-kicks
const SETTLE_MS = 350;
const SETTLE_VX = 25;
const FRAME_MS = 16;
const SCAN_MS = 60;
const MAX_DT_S = 0.04;
const MIN_SAMPLE_DT_MS = 6;
const WINDOW_VELOCITY_SMOOTHING = 0.5;
const KICK_VISUAL_STATE = "juggling";

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Overlap of two {left,top,right,bottom} rects, or null when they only touch.
function overlapOf(a, b) {
  const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (!(ox > 0) || !(oy > 0)) return null;
  return { ox, oy };
}

// Contact response. `pet` and `win` are rects, `winVel` the window velocity in
// px/s. Returns the translation that separates the pet from the window plus the
// pet's new velocity, or null when the rects do not overlap. Every outcome has
// vy < 0 (upward).
function resolveKick(pet, win, winVel, rng = Math.random) {
  const overlap = overlapOf(pet, win);
  if (!overlap) return null;
  const wvx = Number.isFinite(winVel && winVel.x) ? winVel.x : 0;
  const wvy = Number.isFinite(winVel && winVel.y) ? winVel.y : 0;
  const petCx = (pet.left + pet.right) / 2;
  const petCy = (pet.top + pet.bottom) / 2;
  const winCx = (win.left + win.right) / 2;
  const winCy = (win.top + win.bottom) / 2;
  const dirX = petCx >= winCx ? 1 : -1;
  const speed = Math.hypot(wvx, wvy);
  const up = clamp(KICK_UP_MIN + speed * KICK_UP_WINDOW_GAIN, KICK_UP_MIN, KICK_UP_MAX);
  const jitter = (rng() - 0.5) * KICK_JITTER;
  let vx = dirX * KICK_SIDE_BASE + wvx * KICK_WINDOW_VX_GAIN + jitter;
  let vy = -up - Math.max(0, -wvy) * 0.5;
  let dx = 0;
  let dy = 0;
  if (overlap.ox <= overlap.oy) {
    dx = dirX * overlap.ox;
  } else if (petCy < winCy) {
    dy = -overlap.oy; // pet rides on top of the window
  } else {
    // Pet is under the window: push it out downward and throw it sideways so
    // the upward arc does not re-enter the same window next frame.
    dy = overlap.oy;
    vy = -up * 0.6;
    vx = dirX * Math.max(Math.abs(vx), 420);
  }
  return {
    dx,
    dy,
    vx: clamp(vx, -MAX_SPEED_X, MAX_SPEED_X),
    vy: clamp(vy, -MAX_SPEED_UP, MAX_SPEED_UP),
  };
}

// Semi-implicit Euler step; mutates and returns `body` ({x,y,vx,vy}).
function advanceBody(body, dtS) {
  body.vy = clamp(body.vy + GRAVITY * dtS, -MAX_SPEED_UP, MAX_SPEED_DOWN);
  body.x += body.vx * dtS;
  body.y += body.vy * dtS;
  return body;
}

// Reconcile a body with the position the screen clamp allows for it. The clamp
// pulls y up at the floor (allowed y < wanted y), down at the ceiling, and x
// inward at a wall. Returns { onFloor }.
function collideWithBounds(body, allowed) {
  let onFloor = false;
  if (allowed.y < body.y) {
    body.y = allowed.y;
    if (body.vy > 0) {
      if (body.vy < REST_SPEED) body.vy = 0;
      else body.vy = -body.vy * RESTITUTION_FLOOR;
    }
    onFloor = body.vy === 0;
  } else if (allowed.y > body.y) {
    body.y = allowed.y;
    if (body.vy < 0) body.vy = -body.vy * CEILING_ABSORB;
  }
  if (allowed.x !== body.x) {
    body.x = allowed.x;
    body.vx = -body.vx * RESTITUTION_WALL;
  }
  return { onFloor };
}

module.exports = function initKick(ctx) {
  const now = typeof ctx.now === "function" ? ctx.now : Date.now;
  const rng = typeof ctx.random === "function" ? ctx.random : Math.random;
  const setTimer = ctx.setTimeout || setTimeout;
  const clearTimer = ctx.clearTimeout || clearTimeout;

  let enabled = false;
  let timer = null;
  let active = false;
  let body = null;
  let size = null; // { width, height } frozen for the whole flight
  let lastFrameAt = 0;
  let lastKickAt = 0;
  let restingSince = 0;
  let visualApplied = false;
  let tracker = null; // { id, rect, at, vx, vy } of the dragged window
  let wasOverlapping = false;

  function debug(message) {
    if (typeof ctx.debugLog === "function") ctx.debugLog(message);
  }

  // Returns why the kick loop must stand down right now, or null when it may run.
  function closedReason() {
    const win = ctx.win;
    if (!win || win.isDestroyed()) return "no-window";
    if (typeof win.isVisible === "function" && !win.isVisible()) return "pet-hidden";
    if (ctx.dragLocked) return "pet-drag-locked";
    if (ctx.getMiniMode && ctx.getMiniMode()) return "mini-mode";
    if (ctx.miniTransitioning) return "mini-transition";
    if (typeof ctx.isSizePreviewActive === "function" && ctx.isSizePreviewActive()) return "size-preview";
    if (typeof ctx.isImeEditingActive === "function" && ctx.isImeEditingActive()) return "ime-editing";
    return null;
  }

  // Latest dragged-window rect in DIPs with a smoothed velocity, or null.
  function sampleWindow(at) {
    const raw = ctx.probe ? ctx.probe() : null;
    if (!raw || !raw.rect) {
      tracker = null;
      return null;
    }
    const rect = ctx.screenToDipRect ? ctx.screenToDipRect(raw.rect) : raw.rect;
    if (!rect) {
      tracker = null;
      return null;
    }
    if (tracker && tracker.id === raw.id) {
      const dtMs = at - tracker.at;
      if (dtMs >= MIN_SAMPLE_DT_MS) {
        const dtS = dtMs / 1000;
        const rvx = ((rect.left + rect.right) - (tracker.rect.left + tracker.rect.right)) / 2 / dtS;
        const rvy = ((rect.top + rect.bottom) - (tracker.rect.top + tracker.rect.bottom)) / 2 / dtS;
        const k = WINDOW_VELOCITY_SMOOTHING;
        tracker = {
          id: raw.id,
          rect,
          at,
          vx: tracker.vx * (1 - k) + rvx * k,
          vy: tracker.vy * (1 - k) + rvy * k,
        };
      } else {
        tracker = { ...tracker, rect };
      }
    } else {
      tracker = { id: raw.id, rect, at, vx: 0, vy: 0 };
      debug(`dragged window seen id=${raw.id} rect=${rect.left},${rect.top},${rect.right},${rect.bottom}`);
    }
    return tracker;
  }

  function petRectAt(x, y, width, height) {
    const bounds = { x: Math.round(x), y: Math.round(y), width, height };
    const hit = ctx.getHitRectScreen ? ctx.getHitRectScreen(bounds) : null;
    if (hit && Number.isFinite(hit.left) && hit.right > hit.left && hit.bottom > hit.top) return hit;
    return { left: bounds.x, top: bounds.y, right: bounds.x + width, bottom: bounds.y + height };
  }

  function applyBounds() {
    ctx.applyPetWindowBounds({
      x: Math.round(body.x),
      y: Math.round(body.y),
      width: size.width,
      height: size.height,
    });
    if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
    if (typeof ctx.repositionAnchoredSurfaces === "function") ctx.repositionAnchoredSurfaces();
    if (
      typeof ctx.repositionBubbles === "function"
      && ctx.bubbleFollowPet
      && ctx.pendingPermissions
      && ctx.pendingPermissions.length
    ) {
      ctx.repositionBubbles();
    }
  }

  function begin(at, bounds, contact) {
    if (typeof ctx.cancelRoam === "function") ctx.cancelRoam();
    const effective = typeof ctx.getEffectiveCurrentPixelSize === "function"
      ? ctx.getEffectiveCurrentPixelSize()
      : null;
    size = {
      width: effective && effective.width > 0 ? effective.width : bounds.width,
      height: effective && effective.height > 0 ? effective.height : bounds.height,
    };
    body = { x: bounds.x + contact.dx, y: bounds.y + contact.dy, vx: contact.vx, vy: contact.vy };
    active = true;
    lastFrameAt = at;
    lastKickAt = at;
    restingSince = 0;
    wasOverlapping = true;
    debug(`kick start vx=${Math.round(contact.vx)} vy=${Math.round(contact.vy)}`);
    const state = ctx.getCurrentState ? ctx.getCurrentState() : "idle";
    if ((state === "idle" || state === "roam") && typeof ctx.applyState === "function") {
      ctx.applyState(KICK_VISUAL_STATE);
      visualApplied = true;
    }
  }

  function finish(reason) {
    if (!active) return;
    debug(`finish: ${reason || "landed-or-stopped"}`);
    active = false;
    body = null;
    wasOverlapping = false;
    restingSince = 0;
    if (typeof ctx.releaseReconcileProtection === "function") ctx.releaseReconcileProtection();
    if (visualApplied) {
      visualApplied = false;
      if (
        typeof ctx.getCurrentState === "function"
        && ctx.getCurrentState() === KICK_VISUAL_STATE
        && typeof ctx.setState === "function"
      ) {
        const resolved = typeof ctx.resolveDisplayState === "function" ? ctx.resolveDisplayState() : "idle";
        ctx.setState(resolved, undefined, { bypassMinDisplay: true });
      }
    }
  }

  function step() {
    const at = now();
    const closed = closedReason();
    if (closed) {
      tracker = null;
      finish(`gate:${closed}`);
      return;
    }
    const sample = sampleWindow(at);

    if (!active) {
      if (!sample) return;
      const bounds = ctx.getPetWindowBounds();
      if (!bounds) return;
      const contact = resolveKick(
        petRectAt(bounds.x, bounds.y, bounds.width, bounds.height),
        sample.rect,
        { x: sample.vx, y: sample.vy },
        rng,
      );
      if (!contact) return;
      begin(at, bounds, contact);
      applyBounds();
      return;
    }

    if (sample) {
      const contact = resolveKick(
        petRectAt(body.x, body.y, size.width, size.height),
        sample.rect,
        { x: sample.vx, y: sample.vy },
        rng,
      );
      if (contact) {
        // A window parked on the pet must not machine-gun kicks: a new kick
        // needs a fresh contact or a window that is actually moving. Overlap
        // alone still pushes the pet out of the window.
        const speed = Math.hypot(sample.vx, sample.vy);
        const fresh = !wasOverlapping || speed >= KICK_MIN_WINDOW_SPEED;
        body.x += contact.dx;
        body.y += contact.dy;
        if (fresh && at - lastKickAt >= KICK_COOLDOWN_MS) {
          body.vx = contact.vx;
          body.vy = contact.vy;
          lastKickAt = at;
          restingSince = 0;
          debug(`kick vx=${Math.round(contact.vx)} vy=${Math.round(contact.vy)} winSpeed=${Math.round(speed)}`);
        }
      }
      wasOverlapping = !!contact;
    } else {
      wasOverlapping = false;
    }

    const dtS = clamp((at - lastFrameAt) / 1000, 0, MAX_DT_S);
    lastFrameAt = at;
    advanceBody(body, dtS);
    const allowed = ctx.clampToScreenVisual(body.x, body.y, size.width, size.height);
    const { onFloor } = collideWithBounds(body, allowed);
    if (onFloor) body.vx *= Math.exp(-FLOOR_FRICTION_PER_S * dtS);
    applyBounds();

    if (onFloor && Math.abs(body.vx) < SETTLE_VX) {
      if (!restingSince) restingSince = at;
      if (at - restingSince >= SETTLE_MS && !sample) {
        finish("landed");
        return;
      }
    } else {
      restingSince = 0;
    }
  }

  function loop() {
    timer = null;
    if (!enabled) return;
    try {
      step();
    } catch (err) {
      if (typeof ctx.onError === "function") ctx.onError(err);
      finish("exception");
    }
    if (enabled) timer = setTimer(loop, active ? FRAME_MS : SCAN_MS);
  }

  function setEnabled(value) {
    const next = !!value && !!(ctx.probe && ctx.probe.supported !== false);
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      timer = setTimer(loop, SCAN_MS);
    } else {
      if (timer) clearTimer(timer);
      timer = null;
      tracker = null;
      finish("disabled");
    }
  }

  return {
    setEnabled,
    isAnimating: () => active,
    stop: () => finish("stop"),
    get enabled() {
      return enabled;
    },
    // Test hook: run one scan/physics step synchronously.
    _step: step,
  };
};

module.exports.resolveKick = resolveKick;
module.exports.advanceBody = advanceBody;
module.exports.collideWithBounds = collideWithBounds;
module.exports.overlapOf = overlapOf;
module.exports.constants = {
  GRAVITY,
  KICK_UP_MIN,
  KICK_UP_MAX,
  KICK_COOLDOWN_MS,
  SETTLE_MS,
  FRAME_MS,
  SCAN_MS,
};
