/**
 * Main game loop and state machine for Elevator Action (browser edition).
 * Owns the update/draw cycle, vertical camera, entity bookkeeping, collision
 * outcomes (doc pickup, hits, elevator carry/crush) and the HUD.
 */
(function (global) {
  "use strict";

  var C = global.LEVEL_CONST;
  var Input = global.Input;
  var Entities = global.Entities;

  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var overlay = document.getElementById("overlay");
  var startBtn = document.getElementById("start-btn");

  var hud = {
    score: document.getElementById("hud-score"),
    hi: document.getElementById("hud-hi"),
    docs: document.getElementById("hud-docs"),
    docsTotal: document.getElementById("hud-docs-total"),
    lives: document.getElementById("hud-lives")
  };

  var STATE = { MENU: 0, PLAY: 1, DEAD: 2, WIN: 3, OVER: 4 };

  var game = {
    state: STATE.MENU,
    level: null,
    player: null,
    enemies: [],
    bullets: [],
    camY: 0,
    score: 0,
    hi: Number(localStorage.getItem("ea_hi") || 0),
    lives: 3,
    docs: 0,
    msg: "",
    msgTimer: 0,
    spawnTimer: 0        // spawn-director countdown
  };

  var MAX_ENEMIES = 5;   // concurrent enemy cap

  function startGame() {
    game.level = new global.Level();
    game.player = new Entities.Player(game.level.playerStart.x, game.level.playerStart.y);
    game.enemies = [];
    game.bullets = [];
    game.score = 0;
    game.lives = 3;
    game.docs = 0;
    game.state = STATE.PLAY;
    game.spawnTimer = 300;                 // first director spawn ~5s in
    overlay.classList.add("hidden");
    hud.docsTotal.textContent = game.level.totalDocs;
    if (global.Sound) { global.Sound.resume(); global.Sound.startMusic(); }
    syncHud();
  }

  function respawn() {
    var p = game.player;
    p.reset(p.spawnX, p.spawnY);
    p.invuln = 90;
    game.bullets = game.bullets.filter(function (b) { return b.fromPlayer; });
    game.state = STATE.PLAY;
  }

  function loseLife() {
    game.lives--;
    syncHud();
    if (game.lives <= 0) {
      endGame(false);
    } else {
      flash("MISS");
      if (global.Sound) global.Sound.play("miss");
      game.state = STATE.DEAD;
      game.deadTimer = 60;
    }
  }

  function endGame(won) {
    game.state = won ? STATE.WIN : STATE.OVER;
    if (game.score > game.hi) {
      game.hi = game.score;
      localStorage.setItem("ea_hi", String(game.hi));
    }
    if (global.Sound) {
      global.Sound.stopMusic();
      global.Sound.play(won ? "win" : "over");
    }
    showOverlay(won);
  }

  function flash(text) { game.msg = text; game.msgTimer = 90; }

  function addScore(n) {
    game.score += n;
    if (game.score > game.hi) game.hi = game.score;
    syncHud();
  }

  // ---- Update -------------------------------------------------------------

  function update() {
    if (game.msgTimer > 0) game.msgTimer--;

    if (game.state === STATE.DEAD) {
      if (--game.deadTimer <= 0) respawn();
      return;
    }
    if (game.state !== STATE.PLAY) return;

    var level = game.level;
    var player = game.player;

    // Remember elevator positions before they move, to carry a rider.
    level.update();
    carryOnElevators(player);
    for (var e = 0; e < game.enemies.length; e++) carryOnElevators(game.enemies[e]);

    var solids = level.solids();
    player.update(Input, solids, game.bullets);
    checkCrush(player);

    // Doors: collect docs on contact; enemy doors start a telegraph instead
    // of spawning instantly, so the player gets a warning first.
    for (var d = 0; d < level.doors.length; d++) {
      var door = level.doors[d];
      if (!Entities.overlaps(player.hurtBox(), door.rect())) continue;
      if (door.kind === "doc" && !door.collected) {
        door.collected = true;
        game.docs++;
        addScore(500);
        flash("DOCUMENT!");
        if (global.Sound) global.Sound.play("pickup");
        syncHud();
      } else if (door.kind === "enemy" && !door.spawned && !door.arming) {
        door.spawned = true;              // ambush door: one-shot on contact
        armDoor(door, true);
      }
    }

    // Spawn director: at random intervals, an agent bursts from a nearby door
    // so encounters aren't tied to fixed positions. Skipped while capped.
    if (--game.spawnTimer <= 0) {
      directorSpawn(level, player);
      game.spawnTimer = 240 + Math.floor(Math.random() * 240); // 4–8s
    }

    // Count down every armed door; spawn the agent when its warning ends.
    for (var aw = 0; aw < level.doors.length; aw++) {
      var ad = level.doors[aw];
      if (ad.arming) {
        ad.warning--;
        if (ad.warning <= 0) {
          ad.arming = false;
          game.enemies.push(new Entities.Enemy(ad.x + 4, ad.y + 12));
        }
      }
    }

    for (var en = 0; en < game.enemies.length; en++) {
      game.enemies[en].update(player, solids, game.bullets);
    }

    updateBullets();
    resolveHits();

    // Reached the exit with every document → victory.
    if (game.docs >= level.totalDocs &&
        Entities.overlaps(player.hurtBox(), level.exitZone)) {
      addScore(3000 + game.lives * 1000);
      endGame(true);
      return;
    }

    // Fell out of the world (shouldn't happen, but safe-guard).
    if (player.y > level.height + 60) loseLife();

    updateCamera();
    syncHud();
  }

  /** Begin an enemy door's telegraph (blinking warning) before it spawns. */
  function armDoor(door, announce) {
    door.arming = true;
    door.warning = door.warnMax;
    if (announce) flash("CAUTION!");
    if (global.Sound) global.Sound.play("caution");
  }

  /** Pick a random non-objective door on-screen and have it spawn an agent. */
  function directorSpawn(level, player) {
    if (game.enemies.length >= MAX_ENEMIES) return;
    var top = game.camY - 24, bot = game.camY + C.VIEW_H + 24;
    var pool = [];
    for (var i = 0; i < level.doors.length; i++) {
      var dr = level.doors[i];
      if (dr.kind === "doc" || dr.arming) continue;      // never from objectives
      if (dr.y < top || dr.y > bot) continue;            // must be visible
      if (Math.abs(dr.x - player.x) < 40) continue;      // not right on top of us
      pool.push(dr);
    }
    if (!pool.length) return;
    armDoor(pool[Math.floor(Math.random() * pool.length)], false);
  }

  /** If an actor rests on an elevator, move it by the elevator's delta. */
  function carryOnElevators(ent) {
    for (var i = 0; i < game.level.elevators.length; i++) {
      var el = game.level.elevators[i];
      var onTop = ent.x + ent.w > el.x && ent.x < el.x + el.w &&
                  Math.abs((ent.y + ent.h) - el.y) < 4;
      if (onTop) {
        ent.y += (el.y - el.prevY);
        break;
      }
    }
  }

  /** Kill the player if an ascending elevator pins them against a slab. */
  function checkCrush(player) {
    for (var i = 0; i < game.level.elevators.length; i++) {
      var el = game.level.elevators[i];
      var pinned = el.vy < 0 &&
        player.x + player.w > el.x && player.x < el.x + el.w &&
        el.y < player.y + player.h && el.y > player.y &&   // elevator inside body
        player.onGround === false && player.vy === 0;
      if (pinned && player.invuln === 0) {
        loseLife();
        return;
      }
    }
  }

  function updateBullets() {
    for (var i = 0; i < game.bullets.length; i++) game.bullets[i].update();
    // Remove bullets that hit solid geometry (walls/slabs/doors).
    var solids = game.level.staticSolids;
    for (var b = 0; b < game.bullets.length; b++) {
      var bl = game.bullets[b];
      for (var s = 0; s < solids.length; s++) {
        if (Entities.overlaps(bl, solids[s])) { bl.dead = true; break; }
      }
    }
    game.bullets = game.bullets.filter(function (x) { return !x.dead; });
  }

  function resolveHits() {
    var player = game.player;

    for (var b = 0; b < game.bullets.length; b++) {
      var bl = game.bullets[b];
      if (bl.fromPlayer) {
        for (var en = 0; en < game.enemies.length; en++) {
          var foe = game.enemies[en];
          if (!foe.dead && Entities.overlaps(bl, foe)) {
            foe.dead = true;
            bl.dead = true;
            addScore(300);
            if (global.Sound) global.Sound.play("explode");
            break;
          }
        }
      } else if (player.invuln === 0 && Entities.overlaps(bl, player.hurtBox())) {
        bl.dead = true;
        loseLife();
        return;
      }
    }

    // Touching an enemy is lethal too.
    if (player.invuln === 0) {
      for (var e = 0; e < game.enemies.length; e++) {
        if (!game.enemies[e].dead &&
            Entities.overlaps(player.hurtBox(), game.enemies[e])) {
          loseLife();
          break;
        }
      }
    }

    game.enemies = game.enemies.filter(function (x) { return !x.dead; });
    game.bullets = game.bullets.filter(function (x) { return !x.dead; });
  }

  function updateCamera() {
    var target = game.player.y + game.player.h / 2 - C.VIEW_H / 2;
    var maxY = game.level.height - C.VIEW_H;
    game.camY += (clamp(target, 0, maxY) - game.camY) * 0.15;
    game.camY = clamp(game.camY, 0, maxY);
  }

  // ---- Draw ---------------------------------------------------------------

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (game.state === STATE.MENU) return;

    ctx.save();
    ctx.translate(0, -Math.round(game.camY));

    game.level.draw(ctx);
    for (var e = 0; e < game.enemies.length; e++) game.enemies[e].draw(ctx);
    for (var b = 0; b < game.bullets.length; b++) game.bullets[b].draw(ctx);
    if (game.state === STATE.PLAY || game.state === STATE.DEAD) {
      game.player.draw(ctx);
    }

    ctx.restore();

    if (game.msgTimer > 0) drawFlash();
  }

  function drawFlash() {
    ctx.fillStyle = "rgba(255,255,255," + Math.min(1, game.msgTimer / 40) + ")";
    ctx.font = "bold 22px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.fillText(game.msg, canvas.width / 2, 60);
    ctx.textAlign = "left";
  }

  // ---- HUD / overlay ------------------------------------------------------

  function syncHud() {
    hud.score.textContent = game.score;
    hud.hi.textContent = game.hi;
    hud.docs.textContent = game.docs;
    hud.lives.textContent = Math.max(0, game.lives);
  }

  function showOverlay(won) {
    overlay.classList.remove("hidden");
    overlay.innerHTML =
      '<h1>' + (won ? "MISSION COMPLETE" : "GAME OVER") + '</h1>' +
      '<p class="subtitle">SCORE ' + game.score + ' &nbsp;/&nbsp; HI ' + game.hi + '</p>' +
      '<button id="start-btn">' + (won ? "PLAY AGAIN" : "RETRY") + '</button>';
    document.getElementById("start-btn").addEventListener("click", startGame);
  }

  // ---- Loop ---------------------------------------------------------------

  function frame() {
    update();
    draw();
    Input.endFrame();
    requestAnimationFrame(frame);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  startBtn.addEventListener("click", startGame);
  window.addEventListener("keydown", function (e) {
    if (e.code === "Enter" && game.state !== STATE.PLAY) startGame();
    if (e.code === "KeyM") toggleSound();
  });

  // Sound on/off toggle (button + M key).
  var soundBtn = document.getElementById("sound-toggle");
  function toggleSound() {
    if (!global.Sound) return;
    var next = !global.Sound.isMuted();
    global.Sound.setMuted(next);
    if (soundBtn) soundBtn.textContent = next ? "🔇" : "🔊";
  }
  if (soundBtn) soundBtn.addEventListener("click", function () {
    global.Sound && global.Sound.resume();
    toggleSound();
  });

  // Seed HUD totals so the menu isn't blank.
  hud.hi.textContent = game.hi;

  requestAnimationFrame(frame);
  global.__EA = game; // expose for debugging
})(window);
