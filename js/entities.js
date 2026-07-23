/**
 * Game actors: Player, Enemy, Bullet, plus shared AABB physics helpers.
 * All entities use top-left (x, y) origin with axis-aligned bounding boxes.
 */
(function (global) {
  "use strict";

  var GRAVITY = 0.5;
  var TERMINAL_VY = 9;

  // ---- AABB helpers -------------------------------------------------------

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  /** True if point (px, py) sits inside any solid — used for ledge detection. */
  function groundBelow(solids, px, py) {
    for (var i = 0; i < solids.length; i++) {
      var s = solids[i];
      if (px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h) return true;
    }
    return false;
  }

  /**
   * Move an entity by its velocity, resolving collisions against a list of
   * solid rectangles one axis at a time. Sets `onGround` and `groundRef`
   * (the solid the entity is resting on, used for elevator carrying).
   */
  function moveAndCollide(ent, solids) {
    ent.onGround = false;
    ent.groundRef = null;

    // Horizontal.
    ent.x += ent.vx;
    for (var i = 0; i < solids.length; i++) {
      var s = solids[i];
      if (!overlaps(ent, s)) continue;
      if (ent.vx > 0) ent.x = s.x - ent.w;
      else if (ent.vx < 0) ent.x = s.x + s.w;
      ent.vx = 0;
    }

    // Vertical.
    ent.y += ent.vy;
    for (var j = 0; j < solids.length; j++) {
      var t = solids[j];
      if (!overlaps(ent, t)) continue;
      if (ent.vy > 0) {              // falling — land on top
        ent.y = t.y - ent.h;
        ent.onGround = true;
        ent.groundRef = t;
      } else if (ent.vy < 0) {       // rising — bonk head
        ent.y = t.y + t.h;
      }
      ent.vy = 0;
    }
  }

  function applyGravity(ent) {
    ent.vy += GRAVITY;
    if (ent.vy > TERMINAL_VY) ent.vy = TERMINAL_VY;
  }

  // ---- Bullet -------------------------------------------------------------

  function Bullet(x, y, dir, fromPlayer) {
    this.w = 6; this.h = 3;
    this.x = x; this.y = y;
    this.vx = dir * 7;
    this.fromPlayer = fromPlayer;
    this.dead = false;
  }
  Bullet.prototype.update = function () {
    this.x += this.vx;
    if (this.x < -20 || this.x > 532) this.dead = true;
  };
  Bullet.prototype.draw = function (ctx) {
    ctx.fillStyle = this.fromPlayer ? "#ffe86b" : "#ff6b6b";
    ctx.fillRect(this.x, this.y, this.w, this.h);
  };

  // ---- Player -------------------------------------------------------------

  function Player(x, y) {
    this.spawnX = x; this.spawnY = y;
    this.w = 16; this.h = 28;
    this.reset(x, y);
  }
  Player.prototype.reset = function (x, y) {
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.dir = 1;             // facing: 1 right, -1 left
    this.onGround = false;
    this.groundRef = null;
    this.crouching = false;
    this.shootCd = 0;
    this.dead = false;
    this.invuln = 0;          // frames of spawn invulnerability
    this.animT = 0;           // walk-cycle timer
    this.muzzle = 0;          // frames the muzzle flash stays lit
  };
  Player.prototype.hurtBox = function () {
    // Crouching shrinks the vertical hurt box.
    var h = this.crouching ? 18 : this.h;
    return { x: this.x, y: this.y + (this.h - h), w: this.w, h: h };
  };
  Player.prototype.update = function (input, solids, bullets) {
    var SPEED = 2.2, JUMP = 9;

    this.crouching = this.onGround && input.held("down");
    var move = this.crouching ? 0 : SPEED;

    this.vx = 0;
    if (input.held("left"))  { this.vx = -move; this.dir = -1; }
    if (input.held("right")) { this.vx =  move; this.dir =  1; }

    if (input.pressed("jump") && this.onGround && !this.crouching) {
      this.vy = -JUMP;
      if (global.Sound) global.Sound.play("jump");
    }

    applyGravity(this);
    moveAndCollide(this, solids);

    if (this.shootCd > 0) this.shootCd--;
    if (input.pressed("shoot") && this.shootCd === 0) {
      var by = this.y + (this.crouching ? 16 : 8);
      var bx = this.dir > 0 ? this.x + this.w : this.x - 6;
      bullets.push(new Bullet(bx, by, this.dir, true));
      this.shootCd = 12;
      this.muzzle = 5;
      if (global.Sound) global.Sound.play("shoot");
    }

    if (this.invuln > 0) this.invuln--;
    if (this.muzzle > 0) this.muzzle--;
    this.animT++;
  };
  // Spy sprite palette.
  var P = {
    hat: "#141b2e", band: "#e0b23c", coat: "#3f7fd6", coatDk: "#2a5aa0",
    skin: "#f1c197", scarf: "#d94f4f", shoe: "#0e1118", gun: "#20242e",
    flash: "#ffe066"
  };

  function px(ctx, x, y, w, h) { ctx.fillRect(x | 0, y | 0, w, h); }

  Player.prototype.draw = function (ctx) {
    if (this.invuln > 0 && Math.floor(this.invuln / 4) % 2 === 0) return; // blink
    var x = this.x, y = this.y, dir = this.dir;
    var walking = this.onGround && this.vx !== 0;
    var frame = walking ? Math.floor(this.animT / 5) % 2 : 0;
    var flip = dir < 0;

    // Mirror horizontally for left-facing so the sprite is drawn once.
    ctx.save();
    if (flip) { ctx.translate(x + this.w, 0); ctx.scale(-1, 1); ctx.translate(-x, 0); }

    if (this.crouching) {
      var cy = y + 10;                        // feet stay on the ground
      ctx.fillStyle = P.shoe;  px(ctx, x + 2, y + 24, 6, 4); px(ctx, x + 9, y + 24, 5, 4);
      ctx.fillStyle = P.coat;  px(ctx, x + 2, cy + 4, 12, 12);
      ctx.fillStyle = P.coatDk; px(ctx, x + 2, cy + 4, 3, 12);
      ctx.fillStyle = P.scarf; px(ctx, x + 5, cy + 3, 6, 2);
      ctx.fillStyle = P.skin;  px(ctx, x + 4, cy - 1, 8, 6);
      ctx.fillStyle = P.hat;   px(ctx, x + 1, cy - 3, 14, 3); px(ctx, x + 4, cy - 6, 9, 3);
      ctx.fillStyle = P.band;  px(ctx, x + 4, cy - 3, 9, 1);
      ctx.fillStyle = P.hat;   px(ctx, x + 10, cy + 1, 2, 2); // eye
    } else {
      // Legs (alternate on the walk cycle).
      ctx.fillStyle = P.shoe;
      if (frame === 0) { px(ctx, x + 3, y + 23, 4, 5); px(ctx, x + 9, y + 23, 4, 5); }
      else { px(ctx, x + 2, y + 23, 4, 5); px(ctx, x + 10, y + 23, 4, 5); }
      // Trench coat with shaded side and a scarf accent.
      ctx.fillStyle = P.coat;   px(ctx, x + 2, y + 11, 12, 13);
      ctx.fillStyle = P.coatDk; px(ctx, x + 2, y + 11, 3, 13);
      ctx.fillStyle = P.scarf;  px(ctx, x + 6, y + 11, 5, 2);
      // Head + eye.
      ctx.fillStyle = P.skin;   px(ctx, x + 4, y + 5, 8, 6);
      ctx.fillStyle = P.hat;    px(ctx, x + 9, y + 7, 2, 2);
      // Fedora.
      ctx.fillStyle = P.hat;    px(ctx, x + 2, y + 3, 12, 3); px(ctx, x + 4, y, 9, 3);
      ctx.fillStyle = P.band;   px(ctx, x + 4, y + 3, 9, 1);
      // Outstretched gun arm.
      ctx.fillStyle = P.coat;   px(ctx, x + 11, y + 13, 4, 3);
      ctx.fillStyle = P.gun;    px(ctx, x + 14, y + 13, 4, 3);
      if (this.muzzle > 0) { ctx.fillStyle = P.flash; px(ctx, x + 18, y + 12, 3, 5); }
    }
    ctx.restore();
  };

  // ---- Enemy --------------------------------------------------------------

  function Enemy(x, y) {
    this.w = 16; this.h = 28;
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.dir = -1;
    this.onGround = false;
    this.groundRef = null;
    this.dead = false;
    this.shootCd = 60 + Math.floor(Math.random() * 60);
    this.homeX = x;
    // Per-enemy variety so a room of agents doesn't move in lockstep.
    this.speed = 0.8 + Math.random() * 0.7;
    this.patrol = 30 + Math.floor(Math.random() * 45);
    this.animT = Math.floor(Math.random() * 20);
    this.muzzle = 0;
    // Behavior blend: alternates between chasing the player and wandering, so
    // movement isn't rigidly tied to the player's every step.
    this.mode = "wander";
    this.modeTimer = 0;
    this.moveDir = Math.random() < 0.5 ? -1 : 1;
    // Per-stage capabilities (defaults = hardest stage; overridden on spawn).
    this.canChase = true;   // follow the player vs pure wander
    this.canShoot = true;   // may fire bullets
    this.canFall = true;    // may leave its floor (drop through gaps / ride)
  }
  Enemy.prototype.update = function (player, solids, bullets) {
    // Periodically re-roll behavior: ~50% chase, ~50% wander (chase only if
    // this stage allows following; otherwise always wander).
    if (--this.modeTimer <= 0) {
      this.mode = this.canChase && Math.random() < 0.5 ? "chase" : "wander";
      this.modeTimer = 45 + Math.floor(Math.random() * 90);   // 0.75–2.25s
      if (this.mode === "wander" && Math.random() < 0.5) this.moveDir = -this.moveDir;
    }

    if (this.mode === "chase") {
      this.moveDir = player.x + player.w / 2 < this.x + this.w / 2 ? -1 : 1;
    }
    // Turn back at the patrol bounds so it lingers near its door either way.
    if (this.x + this.moveDir * this.speed < this.homeX - this.patrol) this.moveDir = 1;
    if (this.x + this.moveDir * this.speed > this.homeX + this.patrol) this.moveDir = -1;

    // Floor-bound enemies turn around at ledges so they never fall into shafts.
    if (!this.canFall && this.onGround) {
      var leadX = this.moveDir > 0 ? this.x + this.w + 1 : this.x - 1;
      if (!groundBelow(solids, leadX, this.y + this.h + 3)) this.moveDir = -this.moveDir;
    }

    this.vx = this.moveDir * this.speed;
    this.dir = this.moveDir;                 // face the way it's moving

    applyGravity(this);
    moveAndCollide(this, solids);
    this.animT++;
    if (this.muzzle > 0) this.muzzle--;

    // Shoot toward the player when roughly on the same floor band (it can still
    // fire even while wandering the other way).
    if (this.shootCd > 0) this.shootCd--;
    var sameRow = Math.abs((this.y + this.h) - (player.y + player.h)) < 24;
    if (this.canShoot && this.shootCd === 0 && sameRow) {
      var aim = player.x + player.w / 2 < this.x + this.w / 2 ? -1 : 1;
      var by = this.y + 12;
      var bx = aim > 0 ? this.x + this.w : this.x - 6;
      bullets.push(new Bullet(bx, by, aim, false));
      this.muzzle = 5;
      this.dir = aim;                        // face the player as it fires
      this.shootCd = 70 + Math.floor(Math.random() * 50);
    }
  };

  // Enemy agent palette (menacing crimson suit + shades).
  var E = {
    suit: "#d0334a", suitDk: "#8f2033", skin: "#e7a877",
    shade: "#111318", hat: "#1a1016", band: "#d0334a", shoe: "#0c0e14",
    gun: "#20242e", flash: "#ffd166"
  };

  Enemy.prototype.draw = function (ctx) {
    var x = this.x, y = this.y, dir = this.dir;
    var walking = this.onGround && this.vx !== 0;
    var frame = walking ? Math.floor(this.animT / 5) % 2 : 0;
    var flip = dir < 0;

    ctx.save();
    if (flip) { ctx.translate(x + this.w, 0); ctx.scale(-1, 1); ctx.translate(-x, 0); }

    // Legs.
    ctx.fillStyle = E.shoe;
    if (frame === 0) { px(ctx, x + 3, y + 23, 4, 5); px(ctx, x + 9, y + 23, 4, 5); }
    else { px(ctx, x + 2, y + 23, 4, 5); px(ctx, x + 10, y + 23, 4, 5); }
    // Suit torso with shaded side.
    ctx.fillStyle = E.suit;   px(ctx, x + 2, y + 11, 12, 13);
    ctx.fillStyle = E.suitDk; px(ctx, x + 2, y + 11, 3, 13);
    ctx.fillStyle = E.shade;  px(ctx, x + 8, y + 12, 2, 11); // lapel line
    // Head.
    ctx.fillStyle = E.skin;   px(ctx, x + 4, y + 5, 8, 6);
    // Sunglasses visor.
    ctx.fillStyle = E.shade;  px(ctx, x + 4, y + 7, 8, 2);
    // Hat.
    ctx.fillStyle = E.hat;    px(ctx, x + 2, y + 3, 12, 3); px(ctx, x + 4, y, 9, 3);
    ctx.fillStyle = E.band;   px(ctx, x + 4, y + 3, 9, 1);
    // Gun arm.
    ctx.fillStyle = E.suit;   px(ctx, x + 11, y + 13, 4, 3);
    ctx.fillStyle = E.gun;    px(ctx, x + 14, y + 13, 4, 3);
    if (this.muzzle > 0) { ctx.fillStyle = E.flash; px(ctx, x + 18, y + 12, 3, 5); }
    ctx.restore();
  };

  global.Entities = {
    Player: Player,
    Enemy: Enemy,
    Bullet: Bullet,
    overlaps: overlaps,
    moveAndCollide: moveAndCollide
  };
})(window);
