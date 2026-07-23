/**
 * Level geometry: floors, elevator shafts, doors and the exit.
 * Builds the list of solid rectangles the physics uses each frame and draws
 * the building. Coordinates are in world space (the camera scrolls vertically).
 */
(function (global) {
  "use strict";

  var WIDTH = 512;
  var FLOOR_H = 104;   // vertical span of one floor band
  var SLAB_H = 14;     // thickness of the walkable floor slab
  var NUM_FLOORS = 6;
  var EXIT_H = 96;     // basement / getaway-car area below the lowest floor

  var SHAFT_W = 52;
  var SHAFTS = [110, 350];  // left-edge x of each elevator shaft

  var WORLD_H = NUM_FLOORS * FLOOR_H + EXIT_H;

  // y of the walkable surface of floor `i` (0 = top floor).
  function surfaceY(i) { return (i + 1) * FLOOR_H - SLAB_H; }

  function inShaft(x, w) {
    for (var s = 0; s < SHAFTS.length; s++) {
      if (x + w > SHAFTS[s] && x < SHAFTS[s] + SHAFT_W) return true;
    }
    return false;
  }

  function Elevator(shaftX) {
    this.w = SHAFT_W - 8;
    this.h = 12;
    this.x = shaftX + 4;
    this.minY = FLOOR_H - SLAB_H - this.h + 2;
    this.maxY = surfaceY(NUM_FLOORS - 1) - this.h;
    this.y = this.minY + Math.random() * (this.maxY - this.minY);
    this.vy = (Math.random() < 0.5 ? -1 : 1) * 1.2;
    this.prevY = this.y;
  }
  Elevator.prototype.update = function () {
    this.prevY = this.y;
    this.y += this.vy;
    if (this.y <= this.minY) { this.y = this.minY; this.vy = Math.abs(this.vy); }
    if (this.y >= this.maxY) { this.y = this.maxY; this.vy = -Math.abs(this.vy); }
  };
  Elevator.prototype.rect = function () {
    return { x: this.x, y: this.y, w: this.w, h: this.h, elevator: true };
  };
  Elevator.prototype.draw = function (ctx) {
    ctx.fillStyle = "#c9a94b";
    ctx.fillRect(this.x, this.y, this.w, this.h);
    ctx.fillStyle = "#6b5a24";
    ctx.fillRect(this.x, this.y + this.h - 3, this.w, 3);
  };

  function Door(x, floor, kind) {
    this.w = 26; this.h = 40;
    this.x = x;
    this.y = surfaceY(floor) - this.h;
    this.floor = floor;
    this.kind = kind;                 // "doc" | "enemy" | "plain"
    this.collected = false;
    this.spawned = false;
    this.arming = false;              // enemy door: telegraphing a spawn
    this.warning = 0;                 // frames left until the enemy emerges
    this.warnMax = 150;               // ~2.5s telegraph at 60fps
  }
  Door.prototype.rect = function () {
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  };
  Door.prototype.draw = function (ctx) {
    var color = "#3a4568";
    if (this.kind === "doc") color = this.collected ? "#3a4568" : "#e23b3b";
    ctx.fillStyle = color;
    ctx.fillRect(this.x, this.y, this.w, this.h);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(this.x + 2, this.y + 2, this.w - 4, this.h - 4);
    // Knob.
    ctx.fillStyle = "#d9c56a";
    ctx.fillRect(this.x + this.w - 7, this.y + this.h / 2, 3, 3);
    if (this.kind === "doc" && !this.collected) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(this.x + this.w / 2 - 3, this.y + 10, 6, 4);
    }

    // Enemy telegraph: pulsing outline + a warning sign above the door,
    // blinking faster as the spawn approaches.
    if (this.kind === "enemy" && this.warning > 0 && !this.spawned) {
      var ratio = this.warning / this.warnMax;      // 1 -> 0
      var blink = ratio > 0.35 ? 12 : 6;            // speeds up near the end
      var on = Math.floor(this.warning / blink) % 2 === 0;

      ctx.lineWidth = 2;
      ctx.strokeStyle = on ? "#ff8a3a" : "#7a3a12";
      ctx.strokeRect(this.x - 1, this.y - 1, this.w + 2, this.h + 2);

      if (on) {
        var cx = this.x + this.w / 2;
        var by = this.y - 20;
        ctx.fillStyle = "#ff9a2e";                  // warning triangle
        ctx.beginPath();
        ctx.moveTo(cx, by - 4);
        ctx.lineTo(cx + 8, by + 9);
        ctx.lineTo(cx - 8, by + 9);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#1a0e00";                  // exclamation mark
        ctx.fillRect(cx - 1, by + 1, 2, 5);
        ctx.fillRect(cx - 1, by + 7, 2, 2);
      }
    }
  };

  function Level() {
    this.width = WIDTH;
    this.height = WORLD_H;
    this.floorH = FLOOR_H;
    this.numFloors = NUM_FLOORS;
    this.elevators = SHAFTS.map(function (sx) { return new Elevator(sx); });
    this.doors = [];
    this.staticSolids = [];
    this.build();

    this.exitZone = { x: WIDTH / 2 - 40, y: WORLD_H - 34, w: 80, h: 34 };
    this.playerStart = { x: 40, y: surfaceY(0) - 28 };
  }

  Level.prototype.build = function () {
    var self = this;

    // Floor slabs, split around the elevator shafts so the player can pass.
    for (var i = 0; i < NUM_FLOORS; i++) {
      var y = surfaceY(i);
      addSlabRow(self.staticSolids, y);
    }
    // Basement floor (exit level) — solid all the way across.
    self.staticSolids.push({ x: 0, y: WORLD_H - SLAB_H, w: WIDTH, h: SLAB_H });

    // Outer walls.
    self.staticSolids.push({ x: -8, y: 0, w: 8, h: WORLD_H });
    self.staticSolids.push({ x: WIDTH, y: 0, w: 8, h: WORLD_H });

    // Doors. Red (doc) doors are the objective; a few enemy doors add threat.
    var layout = [
      [ [70, "doc"],  [200, "enemy"], [430, "plain"] ],
      [ [170, "doc"], [300, "plain"], [450, "enemy"] ],
      [ [60, "enemy"],[240, "doc"],   [430, "doc"] ],
      [ [180, "plain"],[300, "enemy"],[450, "doc"] ],
      [ [70, "doc"],  [230, "plain"], [420, "enemy"] ],
      [ [200, "doc"], [300, "doc"],   [450, "plain"] ]
    ];
    for (var f = 0; f < layout.length; f++) {
      for (var d = 0; d < layout[f].length; d++) {
        var spec = layout[f][d];
        self.doors.push(new Door(spec[0], f, spec[1]));
      }
    }

    this.totalDocs = this.doors.filter(function (dr) {
      return dr.kind === "doc";
    }).length;
  };

  function addSlabRow(out, y) {
    // Walk across the width, emitting slab segments and skipping shaft gaps.
    var cuts = [];
    for (var s = 0; s < SHAFTS.length; s++) {
      cuts.push([SHAFTS[s], SHAFTS[s] + SHAFT_W]);
    }
    cuts.sort(function (a, b) { return a[0] - b[0]; });
    var x = 0;
    for (var c = 0; c < cuts.length; c++) {
      if (cuts[c][0] > x) {
        out.push({ x: x, y: y, w: cuts[c][0] - x, h: SLAB_H });
      }
      x = Math.max(x, cuts[c][1]);
    }
    if (x < WIDTH) out.push({ x: x, y: y, w: WIDTH - x, h: SLAB_H });
  }

  /** Current solids for physics: static geometry + live elevator rects. */
  Level.prototype.solids = function () {
    var list = this.staticSolids.slice();
    for (var i = 0; i < this.elevators.length; i++) {
      list.push(this.elevators[i].rect());
    }
    return list;
  };

  Level.prototype.update = function () {
    for (var i = 0; i < this.elevators.length; i++) this.elevators[i].update();
  };

  Level.prototype.draw = function (ctx) {
    // Building backdrop bands.
    for (var i = 0; i < NUM_FLOORS; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#141a2c" : "#111626";
      ctx.fillRect(0, i * FLOOR_H, WIDTH, FLOOR_H);
    }
    ctx.fillStyle = "#0c1830";
    ctx.fillRect(0, NUM_FLOORS * FLOOR_H, WIDTH, EXIT_H);

    // Elevator shafts.
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    for (var s = 0; s < SHAFTS.length; s++) {
      ctx.fillRect(SHAFTS[s], 0, SHAFT_W, NUM_FLOORS * FLOOR_H);
      ctx.strokeStyle = "rgba(120,140,190,0.25)";
      ctx.strokeRect(SHAFTS[s] + 0.5, 0, SHAFT_W, NUM_FLOORS * FLOOR_H);
    }

    // Doors, then elevators (elevators draw over shaft).
    for (var d = 0; d < this.doors.length; d++) this.doors[d].draw(ctx);
    for (var e = 0; e < this.elevators.length; e++) this.elevators[e].draw(ctx);

    // Floor slabs.
    ctx.fillStyle = "#39456b";
    for (var k = 0; k < this.staticSolids.length; k++) {
      var r = this.staticSolids[k];
      if (r.w >= WIDTH && r.h === SLAB_H) continue; // basement drawn below
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // Basement slab + exit marker.
    ctx.fillStyle = "#39456b";
    ctx.fillRect(0, WORLD_H - SLAB_H, WIDTH, SLAB_H);
    ctx.fillStyle = "#2fd06b";
    ctx.fillRect(this.exitZone.x, this.exitZone.y, this.exitZone.w, 4);
    ctx.fillStyle = "#eaffef";
    ctx.font = "10px 'Courier New', monospace";
    ctx.fillText("EXIT", this.exitZone.x + 26, this.exitZone.y + 20);
  };

  global.Level = Level;
  global.LEVEL_CONST = {
    WIDTH: WIDTH, WORLD_H: WORLD_H, FLOOR_H: FLOOR_H, VIEW_H: 480
  };
})(window);
