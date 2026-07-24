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
    lives: document.getElementById("hud-lives"),
    stage: document.getElementById("hud-stage"),
    power: document.getElementById("hud-power")
  };

  var STATE = { MENU: 0, PLAY: 1, DEAD: 2, WIN: 3, OVER: 4, STAGECLEAR: 5 };

  // Per-stage difficulty. `shooters`: how many enemies may fire —
  // 0 none, "lowest1" one agent spawned on the lowest floor, N a numeric cap,
  // Infinity everyone. `fall`: enemies may leave their floor (drop/ride).
  var STAGES = [
    { name: "TUTORIAL",   docs: 3, maxEnemies: 1, chase: false, shooters: 0,        fall: false },
    { name: "BEGINNER",   docs: 4, maxEnemies: 2, chase: false, shooters: 0,        fall: false },
    { name: "EASY",       docs: 5, maxEnemies: 3, chase: true,  shooters: 0,        fall: false },
    { name: "NORMAL",     docs: 6, maxEnemies: 3, chase: true,  shooters: "lowest1", fall: true },
    { name: "HARD",       docs: 7, maxEnemies: 4, chase: true,  shooters: 2,        fall: true },
    { name: "EXPERT",     docs: 8, maxEnemies: 5, chase: true,  shooters: Infinity, fall: true }
  ];
  var LAST_STAGE = STAGES.length - 1;

  var game = {
    state: STATE.MENU,
    level: null,
    player: null,
    enemies: [],
    bullets: [],
    items: [],
    camY: 0,
    score: 0,
    hi: Number(localStorage.getItem("ea_hi") || 0),
    lives: 2,
    docs: 0,
    stage: 0,
    pendingLoadout: null,   // loadout chosen on the stage-clear screen
    snipe: null,            // active OKB 13 sniper-kill animation
    msg: "",
    msgTimer: 0,
    spawnTimer: 0        // spawn-director countdown
  };

  function cfg() { return STAGES[game.stage]; }

  // Start a fresh run at stage 1. Two spare lives — the 3rd hit ends the run.
  function startGame() {
    game.score = 0;
    game.lives = 2;
    game.stage = 0;
    game.pendingLoadout = null;
    if (global.Sound) global.Sound.resume();
    loadStage();
  }

  // Build the current stage (keeps score/lives) and begin play.
  function loadStage() {
    var c = cfg();
    game.level = new global.Level(c.docs);
    game.player = new Entities.Player(game.level.playerStart.x, game.level.playerStart.y);
    game.enemies = [];
    game.bullets = [];
    game.items = [];
    game.docs = 0;
    game.camY = 0;
    game.snipe = null;
    game.state = STATE.PLAY;
    game.spawnTimer = 240;                  // first director spawn ~4s in

    // Apply the loadout chosen on the previous stage-clear screen.
    if (game.pendingLoadout === "machinegun") game.player.mg = true;
    else if (game.pendingLoadout === "vest") game.player.armor = 3;
    else if (game.pendingLoadout === "okb") game.player.okb = 3;
    game.pendingLoadout = null;

    overlay.classList.add("hidden");
    hud.docsTotal.textContent = game.level.totalDocs;
    flash("STAGE " + (game.stage + 1) + " — " + c.name);
    if (global.Sound) global.Sound.startMusic();
    syncHud();
  }

  // A hit that isn't absorbed by a vest: lose a life, or end the run on the
  // final hit. The player keeps playing in place (brief invulnerability).
  function loseLife() {
    if (game.lives <= 0) { endGame(false); return; }
    game.lives--;
    game.player.invuln = 90;
    game.player.mg = false;
    flash("MISS");
    if (global.Sound) global.Sound.play("miss");
    syncHud();
  }

  // Cleared the exit: advance to the next stage, or win the whole game.
  function clearStage() {
    addScore(2000 + game.lives * 500);
    if (game.stage >= LAST_STAGE) {
      endGame(true);
      return;
    }
    game.state = STATE.STAGECLEAR;
    if (game.score > game.hi) { game.hi = game.score; localStorage.setItem("ea_hi", String(game.hi)); }
    if (global.Sound) { global.Sound.stopMusic(); global.Sound.play("win"); }
    syncHud();

    // Loadout selection for the next stage. OKB 13 unlocks entering stage 5+.
    var next = game.stage + 1;                 // 0-indexed next stage
    var okbEligible = next >= 4;
    var choices =
      '<button class="loadout" data-load="machinegun">🔫 マシンガン</button>' +
      '<button class="loadout" data-load="vest">🛡 防弾チョッキ</button>' +
      (okbEligible ? '<button class="loadout okb" data-load="okb">🎯 OKB 13</button>' : '') +
      '<button class="loadout none" data-load="none">なし</button>';
    overlay.classList.remove("hidden");
    overlay.innerHTML =
      '<h1>STAGE ' + (game.stage + 1) + ' CLEAR</h1>' +
      '<p class="subtitle">SCORE ' + game.score + '<br>NEXT: STAGE ' + (next + 1) +
      ' — ' + STAGES[next].name + '<br>装備を選択（次ステージ開始）</p>' +
      '<div class="loadout-grid">' + choices + '</div>';
    var btns = overlay.querySelectorAll(".loadout");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function () {
        game.pendingLoadout = this.getAttribute("data-load");
        nextStage();
      });
    }
  }

  function nextStage() {
    game.stage++;
    loadStage();
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

    // OKB 13: time freezes during the sniper-kill sequence.
    if (game.snipe) { updateSnipe(); return; }
    if (game.state !== STATE.PLAY) return;

    var level = game.level;
    var player = game.player;

    level.update();

    // Collide only against static geometry; elevators are handled separately
    // as ride-on-top platforms so a rider can never be shoved sideways.
    var solids = level.staticSolids;
    player.update(Input, solids, game.bullets);
    if (rideElevators(player, true)) return;   // returns true if crushed → died

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
      } else if (door.kind === "enemy" && !door.spawned && !door.arming &&
                 activeThreat() < cfg().maxEnemies) {
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
          spawnEnemyFromDoor(ad);
        }
      }
    }

    for (var en = 0; en < game.enemies.length; en++) {
      game.enemies[en].update(player, solids, game.bullets);
      if (game.enemies[en].canFall) rideElevators(game.enemies[en], false);
    }

    updateBullets();
    resolveHits();
    updateItems(player);

    // Reached the exit with every document → clear the stage.
    if (game.docs >= level.totalDocs &&
        Entities.overlaps(player.hurtBox(), level.exitZone)) {
      clearStage();
      return;
    }

    // Fell out of the world: cost a life and return to the stage start.
    if (player.y > level.height + 60) {
      loseLife();
      if (game.state === STATE.PLAY) {
        player.x = player.spawnX; player.y = player.spawnY;
        player.vx = 0; player.vy = 0;
      }
    }

    updateCamera();
    syncHud();
  }

  /** Live threats = agents already out + doors mid-telegraph (both count). */
  function activeThreat() {
    var n = game.enemies.length;
    for (var i = 0; i < game.level.doors.length; i++) if (game.level.doors[i].arming) n++;
    return n;
  }

  /** How many agents are currently allowed to fire, per stage rules. */
  function currentShooters() {
    var n = 0;
    for (var i = 0; i < game.enemies.length; i++) if (game.enemies[i].canShoot) n++;
    return n;
  }

  /** Spawn an agent from a door and stamp it with this stage's capabilities. */
  function spawnEnemyFromDoor(door) {
    var c = cfg();
    var e = new Entities.Enemy(door.x + 4, door.y + 12);
    e.canChase = c.chase;
    e.canFall = c.fall;
    if (c.shooters === Infinity) e.canShoot = true;
    else if (c.shooters === 0) e.canShoot = false;
    else if (c.shooters === "lowest1") {
      e.canShoot = door.floor === game.level.numFloors - 1 && currentShooters() < 1;
    } else {
      e.canShoot = currentShooters() < c.shooters;
    }
    game.enemies.push(e);
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
    if (activeThreat() >= cfg().maxEnemies) return;
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

  /**
   * Elevator interaction as a one-way "ride on top" platform.
   * Elevators are NOT part of the generic solid list, so they can never eject
   * a rider horizontally (that was the teleport bug). Standing on top snaps the
   * actor to the platform each frame, which also carries them as it moves.
   * Returns true if the player was crushed (from an elevator pressing down
   * onto them while they're grounded).
   */
  function rideElevators(ent, isPlayer) {
    for (var i = 0; i < game.level.elevators.length; i++) {
      var el = game.level.elevators[i];
      var horiz = ent.x + ent.w > el.x + 1 && ent.x < el.x + el.w - 1;
      if (!horiz) continue;

      var feet = ent.y + ent.h;
      // Landing on / riding the top: feet near the platform surface, descending.
      if (ent.vy >= 0 && feet >= el.y - 2 && feet <= el.y + el.h) {
        ent.y = el.y - ent.h;
        ent.vy = 0;
        ent.onGround = true;
        continue;                       // riding this one; it won't also crush us
      }

      // Crush: elevator bearing down from above while the actor is grounded.
      var elBottom = el.y + el.h;
      var pinned = el.y <= ent.y + 4 && elBottom > ent.y + 4 &&
                   ent.onGround && el.vy >= 0;
      if (isPlayer && pinned && ent.invuln === 0) {
        loseLife();
        return true;
      }
    }
    return false;
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
            maybeDropItem(foe.x + foe.w / 2 - 8, foe.y);
            break;
          }
        }
      } else if (player.invuln === 0 && Entities.overlaps(bl, player.hurtBox())) {
        bl.dead = true;
        if (hitPlayer()) return;      // returns true if it cost a life
      }
    }

    // Touching an enemy hurts too.
    if (player.invuln === 0) {
      for (var e = 0; e < game.enemies.length; e++) {
        if (!game.enemies[e].dead &&
            Entities.overlaps(player.hurtBox(), game.enemies[e])) {
          if (hitPlayer()) break;
          break;
        }
      }
    }

    game.enemies = game.enemies.filter(function (x) { return !x.dead; });
    game.bullets = game.bullets.filter(function (x) { return !x.dead; });
  }

  /** Apply damage to the player: a vest hit is absorbed; otherwise a life is
   *  lost. Returns true only when it cost a life (so callers can stop). */
  function hitPlayer() {
    var p = game.player;
    if (p.invuln > 0) return false;
    p.mg = false;               // taking any damage drops the machine gun
    if (p.armor > 0) {
      p.armor--;
      p.invuln = 45;
      flash("BLOCK!");
      if (global.Sound) global.Sound.play("block");
      syncHud();
      return false;
    }
    loseLife();
    return true;
  }

  var DROP_CHANCE = 0.30;
  function maybeDropItem(x, y) {
    if (Math.random() >= DROP_CHANCE) return;
    var type = Math.random() < 0.5 ? "machinegun" : "vest";
    game.items.push(new Entities.Item(x, y, type));
  }

  function updateItems(player) {
    for (var i = 0; i < game.items.length; i++) {
      var it = game.items[i];
      it.update(game.level.staticSolids);
      if (!it.dead && Entities.overlaps(player.hurtBox(), it)) {
        applyItem(it.type);
        it.dead = true;
      }
    }
    game.items = game.items.filter(function (x) { return !x.dead; });
  }

  function applyItem(type) {
    var p = game.player;
    if (type === "machinegun") { p.mg = true; flash("MACHINE GUN!"); }
    else { p.armor = 3; flash("VEST x3"); }
    if (global.Sound) global.Sound.play("powerup");
    syncHud();
  }

  // ---- OKB 13 (tap-to-snipe) ---------------------------------------------

  var SNIPE = { zoom: 22, aim: 38, fire: 16 };

  /** A tap on the play-field: if OKB 13 is loaded and an agent is under the
   *  pointer, begin the dramatic sniper-kill sequence. */
  function trySnipe(clientX, clientY) {
    if (game.state !== STATE.PLAY || game.snipe) return;
    var p = game.player;
    if (!p || p.okb <= 0) return;
    var rect = canvas.getBoundingClientRect();
    var wx = (clientX - rect.left) * (canvas.width / rect.width);
    var wy = (clientY - rect.top) * (canvas.height / rect.height) + game.camY;
    for (var i = 0; i < game.enemies.length; i++) {
      var e = game.enemies[i];
      if (wx >= e.x - 4 && wx <= e.x + e.w + 4 && wy >= e.y - 4 && wy <= e.y + e.h + 4) {
        game.snipe = { enemy: e, phase: "zoom", t: 0 };
        if (global.Sound) global.Sound.play("lock");
        return;
      }
    }
  }

  function updateSnipe() {
    var s = game.snipe;
    s.t++;
    if (s.phase === "zoom" && s.t >= SNIPE.zoom) {
      s.phase = "aim"; s.t = 0;
      if (global.Sound) global.Sound.play("lock");
    } else if (s.phase === "aim" && s.t >= SNIPE.aim) {
      s.phase = "fire"; s.t = 0;
      if (global.Sound) global.Sound.play("snipe");
    } else if (s.phase === "fire" && s.t >= SNIPE.fire) {
      s.enemy.dead = true;
      game.enemies = game.enemies.filter(function (x) { return !x.dead; });
      addScore(1500);
      if (global.Sound) global.Sound.play("explode");
      game.player.okb--;
      game.snipe = null;
      syncHud();
    }
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
    for (var it = 0; it < game.items.length; it++) game.items[it].draw(ctx);
    for (var e = 0; e < game.enemies.length; e++) game.enemies[e].draw(ctx);
    for (var b = 0; b < game.bullets.length; b++) game.bullets[b].draw(ctx);
    if (game.state === STATE.PLAY) game.player.draw(ctx);

    ctx.restore();

    if (game.snipe) drawScope(game.snipe);
    if (game.msgTimer > 0) drawFlash();
  }

  /** Dramatic OKB 13 sniper scope, drawn in screen space over the frozen world. */
  function drawScope(s) {
    var W = canvas.width, H = canvas.height;
    var e = s.enemy;
    var tx = e.x + e.w / 2;
    var ty = e.y + 6 - game.camY;              // aim at the head
    if (s.phase === "aim") { tx += Math.sin(s.t / 5) * 3; ty += Math.cos(s.t / 6) * 2; }

    var full = Math.max(W, H) * 1.1, rMin = 82;
    var r = s.phase === "zoom" ? full - (full - rMin) * (s.t / SNIPE.zoom) : rMin;

    // Dark vignette with a circular hole punched at the target.
    ctx.save();
    ctx.fillStyle = "rgba(2,3,8,0.92)";
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(tx, ty, r, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    // Scope rings.
    ctx.lineWidth = 10; ctx.strokeStyle = "#04050a";
    ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = "#2a3350";
    ctx.beginPath(); ctx.arc(tx, ty, r - 5, 0, Math.PI * 2); ctx.stroke();

    // Reticle, clipped to the lens.
    ctx.save();
    ctx.beginPath(); ctx.arc(tx, ty, r - 5, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = "rgba(230,70,70,0.85)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tx - r, ty); ctx.lineTo(tx + r, ty);
    ctx.moveTo(tx, ty - r); ctx.lineTo(tx, ty + r);
    ctx.stroke();
    for (var k = -5; k <= 5; k++) {
      if (!k) continue;
      ctx.beginPath();
      ctx.moveTo(tx + k * 9, ty - 3); ctx.lineTo(tx + k * 9, ty + 3);
      ctx.moveTo(tx - 3, ty + k * 9); ctx.lineTo(tx + 3, ty + k * 9);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,50,50,0.95)"; ctx.fillRect(tx - 2, ty - 2, 4, 4);
    ctx.restore();

    ctx.textAlign = "center";
    if (s.phase === "zoom" || s.phase === "aim") {
      ctx.fillStyle = "#ff5a5a"; ctx.font = "bold 13px 'Courier New', monospace";
      ctx.fillText("O K B  1 3", tx, ty - r + 20);
      if (s.phase === "aim" && Math.floor(s.t / 8) % 2 === 0) {
        ctx.fillStyle = "#ffd166"; ctx.font = "bold 15px 'Courier New', monospace";
        ctx.fillText("TARGET LOCKED", W / 2, H - 34);
      }
    }
    if (s.phase === "fire") {
      var a = 1 - s.t / SNIPE.fire;
      ctx.fillStyle = "rgba(255,255,255," + (a * 0.9) + ")"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ff2a2a";
      for (var b = 0; b < 10; b++) {
        var ang = b * Math.PI / 5, len = 6 + s.t * 2.4;
        ctx.fillRect(tx + Math.cos(ang) * len - 2, ty + Math.sin(ang) * len - 2, 4, 4);
      }
      ctx.fillStyle = "#fff"; ctx.font = "bold 22px 'Courier New', monospace";
      ctx.fillText("HEADSHOT!", W / 2, 52);
    }
    ctx.textAlign = "left";
    ctx.restore();
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
    if (hud.stage) hud.stage.textContent = game.stage + 1;
    if (hud.power) {
      var parts = [];
      var p = game.player;
      if (p && p.mg) parts.push("🔫");
      if (p && p.armor > 0) parts.push("🛡" + p.armor);
      if (p && p.okb > 0) parts.push("🎯" + p.okb);
      hud.power.textContent = parts.join(" ");
    }
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
    if (e.code === "Enter") {
      if (game.state === STATE.STAGECLEAR) nextStage();
      else if (game.state !== STATE.PLAY) startGame();
    }
    if (e.code === "KeyM") toggleSound();
  });

  // Tap/click the play-field to fire OKB 13 at an agent under the pointer.
  canvas.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    trySnipe(e.clientX, e.clientY);
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
