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
      if (global.Sound) global.Sound.play("shoot");
    }

    if (this.invuln > 0) this.invuln--;
  };
  Player.prototype.draw = function (ctx) {
    if (this.invuln > 0 && Math.floor(this.invuln / 4) % 2 === 0) return; // blink
    var hb = this.hurtBox();
    ctx.fillStyle = "#4fd0ff";                     // body (trench coat)
    ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
    ctx.fillStyle = "#ffd9a8";                     // head
    ctx.fillRect(hb.x + 3, hb.y - (this.crouching ? 0 : 0) + 0, 10, 8);
    ctx.fillStyle = "#1b2233";                     // hat brim
    ctx.fillRect(hb.x + 1, hb.y, 14, 3);
    // Gun muzzle direction cue.
    ctx.fillStyle = "#222";
    var gx = this.dir > 0 ? hb.x + hb.w : hb.x - 4;
    ctx.fillRect(gx, hb.y + hb.h * 0.4, 4, 3);
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
    this.patrol = 40;
  }
  Enemy.prototype.update = function (player, solids, bullets) {
    var SPEED = 1.0;

    // Face and drift toward the player, bounded to a patrol range.
    this.dir = player.x + player.w / 2 < this.x + this.w / 2 ? -1 : 1;
    var target = this.x + this.dir * SPEED;
    if (Math.abs((target) - this.homeX) <= this.patrol) {
      this.vx = this.dir * SPEED;
    } else {
      this.vx = 0;
    }

    applyGravity(this);
    moveAndCollide(this, solids);

    // Shoot when roughly on the same floor band as the player.
    if (this.shootCd > 0) this.shootCd--;
    var sameRow = Math.abs((this.y + this.h) - (player.y + player.h)) < 24;
    if (this.shootCd === 0 && sameRow) {
      var by = this.y + 12;
      var bx = this.dir > 0 ? this.x + this.w : this.x - 6;
      bullets.push(new Bullet(bx, by, this.dir, false));
      this.shootCd = 70 + Math.floor(Math.random() * 50);
    }
  };
  Enemy.prototype.draw = function (ctx) {
    ctx.fillStyle = "#ff5a5a";                    // red agent
    ctx.fillRect(this.x, this.y, this.w, this.h);
    ctx.fillStyle = "#ffd9a8";
    ctx.fillRect(this.x + 3, this.y, 10, 8);
    ctx.fillStyle = "#111";
    ctx.fillRect(this.x + 1, this.y, 14, 3);
  };

  global.Entities = {
    Player: Player,
    Enemy: Enemy,
    Bullet: Bullet,
    overlaps: overlaps,
    moveAndCollide: moveAndCollide
  };
})(window);
