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

  // Optional custom art for the GUILTY cut. Drop your own licensed image at
  // assets/guilty.png and it is used automatically; otherwise the built-in
  // vector illustration is drawn. (Blocked by CSP in the single-file build,
  // where it silently falls back.)
  var guiltyImg = new Image();
  var guiltyReady = false;
  guiltyImg.onload = function () { guiltyReady = true; };
  guiltyImg.onerror = function () { guiltyReady = false; };
  guiltyImg.src = global.GUILTY_IMG_SRC || "assets/guilty.png";

  var STATE = { MENU: 0, PLAY: 1, DEAD: 2, WIN: 3, OVER: 4, STAGECLEAR: 5, TAUNT: 6 };

  // Continue-screen taunts (author-supplied). English shows first; the Japanese
  // translation fades in after 3s.
  var TAUNTS = [
    { en: "Harder than your job today?", jp: "今日の君の仕事より難しかった？" },
    { en: "Gameplay Tip! The jump button isn't on your butt… unless that's how you play?", jp: "操作のヒント！ジャンプボタンはお尻にありません！……でも、まさかあなたの場合……？" },
    { en: "The enemies must really like you. They keep meeting you.", jp: "敵は君のことが大好きみたいですね。何度も会いに来てますよ。" },
    { en: "Was that dodge… or were you aiming for the hit?", jp: "その回避、わざと当たりに行きました？" },
    { en: "Don't worry. That failure has been safely recorded.", jp: "安心してください。今の失敗はちゃんと記録されています。" },
    { en: "Trying to unlock every Game Over animation?", jp: "ゲームオーバーの演出、全部コンプリートする気ですか？" },
    { en: "The enemy AI says, \"Thanks!\"", jp: "敵AIから『ありがとうございます』と伝言です。" },
    { en: "Lowering the difficulty won't lower your pride. Probably.", jp: "難易度を下げてもプライドは減りません。たぶん。" },
    { en: "Going down. Along with your reputation.", jp: "下へ参ります。あなたの評価と一緒に。" },
    { en: "The elevator can go up. Your skill cannot.", jp: "エレベーターは上がれます。あなたの腕前は上がりません。" },
    { en: "Back to the bottom floor. You seem quite at home there.", jp: "また最下階です。ずいぶん居心地が良さそうですね。" },
    { en: "Was it your body caught in the doors, or your judgment?", jp: "ドアに挟まれたのは体ですか？ 判断力ですか？" },
    { en: "A message from security: they'll be waiting in the same spot next time.", jp: "警備員から伝言です。次も同じ場所で待っているそうです。" },
    { en: "There is no emergency button. You are the emergency.", jp: "非常ボタンはありません。あなた自身が非常事態なので。" },
    { en: "Bodies are transported to the basement. Conveniently, that's your next stop.", jp: "死体の搬送先は地下です。ちょうど次の目的地ですね。" }
  ];

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
    mines: [],
    blasts: [],
    camY: 0,
    score: 0,
    hi: Number(localStorage.getItem("ea_hi") || 0),
    lives: 2,
    docs: 0,
    stage: 0,
    pendingLoadout: null,   // loadout chosen on the stage-clear screen
    snipe: null,            // active OKB 13 sniper-kill animation
    taunt: null,            // active continue taunt
    tauntTimer: 0,
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
    game.mines = [];
    game.blasts = [];
    game.docs = 0;
    game.camY = 0;
    game.snipe = null;
    game.state = STATE.PLAY;
    game.spawnTimer = 240;                  // first director spawn ~4s in

    // Apply the loadout chosen on the previous stage-clear screen.
    if (game.pendingLoadout === "machinegun") game.player.mg = true;
    else if (game.pendingLoadout === "vest") game.player.armor = 3;
    else if (game.pendingLoadout === "okb") game.player.okb = Infinity;  // unlimited (for now)
    else if (game.pendingLoadout === "mine") game.player.mines = 8;
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
      '<button class="loadout" data-load="mine">💣 地雷</button>' +
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
        beginWithLoadout(nextStage);
      });
    }
  }

  function nextStage() {
    game.stage++;
    loadStage();
  }

  // Show the OKB 13 how-to before starting when it's the chosen loadout.
  function beginWithLoadout(proceed) {
    if (game.pendingLoadout === "okb") showOkbHelp(proceed);
    else proceed();
  }

  var pendingProceed = null;
  function showOkbHelp(onStart) {
    pendingProceed = onStart;
    game.state = STATE.MENU;
    if (global.Sound) global.Sound.stopMusic();
    overlay.classList.remove("hidden");
    overlay.innerHTML =
      '<h1 style="font-size:22px;letter-spacing:1px">🎯 OKB 13</h1>' +
      '<p class="subtitle">一撃必殺のスナイパー装備</p>' +
      '<div class="okb-help">' +
        '<div class="okb-step"><span class="okb-ico">👆</span><span>画面の敵を<b>タップ / クリック</b>で狙撃</span></div>' +
        '<div class="okb-step"><span class="okb-ico">🎯</span><span>スコープがロックオン → <b>一撃で撃破</b></span></div>' +
        '<div class="okb-step"><span class="okb-ico">🎬</span><span>発動中は<b>時間が止まる</b>（演出のあと再開）</span></div>' +
        '<div class="okb-note">弾数 <b>∞</b> ・ 移動は十字キー/ボタンのまま</div>' +
      "</div>" +
      '<button id="okb-start">START</button>';
    document.getElementById("okb-start").addEventListener("click", function () {
      pendingProceed = null; onStart();
    });
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

    // Continue taunt: EN for 3s, then the JP translation fades in; resume at 6s.
    if (game.state === STATE.TAUNT) {
      game.tauntTimer++;
      if (game.tauntTimer === 180) {
        var jp = document.getElementById("taunt-jp");
        if (jp) jp.classList.add("show");
      }
      if (game.tauntTimer >= 360) { game.lives = 2; loadStage(); }  // keep score/stage
      return;
    }

    // OKB 13: time freezes during the sniper-kill sequence.
    if (game.snipe) { updateSnipe(); return; }
    if (game.state !== STATE.PLAY) return;

    var level = game.level;
    var player = game.player;

    level.update();

    // Collide only against static geometry; elevators are handled separately
    // as ride-on-top platforms so a rider can never be shoved sideways.
    var solids = level.staticSolids;
    if (player.onStair) {
      advanceStair(player);                    // scripted stair traversal
    } else {
      player.update(Input, solids, game.bullets);
      if (rideElevators(player, true)) return; // returns true if crushed → died
      tryStairs(player, level);
      tryDeployMine(player);
    }

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
    updateMines();
    updateBlasts();

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

  // ---- Landmines ----------------------------------------------------------

  function tryDeployMine(player) {
    if (player.mines <= 0) return;
    if (player.mineCd > 0) { player.mineCd--; return; }
    if (Input.pressed("shoot")) {
      var mx = player.x + player.w / 2 - 8;
      game.mines.push(new Entities.Mine(mx, player.y + player.h - 7));
      player.mines--;
      player.mineCd = 14;
      if (global.Sound) global.Sound.play("jump");
      syncHud();
    }
  }

  function updateMines() {
    for (var i = 0; i < game.mines.length; i++) {
      var m = game.mines[i];
      m.update();
      if (!m.armed()) continue;
      for (var e = 0; e < game.enemies.length; e++) {
        var foe = game.enemies[e];
        if (!foe.dead && Entities.overlaps(m, foe)) { detonate(m); break; }
      }
    }
    game.mines = game.mines.filter(function (x) { return !x.dead; });
  }

  function detonate(m) {
    m.dead = true;
    var cx = m.x + m.w / 2, cy = m.y + m.h / 2;
    game.blasts.push({ x: cx, y: cy, r: 6, max: m.blast, t: 0 });
    if (global.Sound) global.Sound.play("explode");
    // Kill every agent within the blast radius.
    for (var e = 0; e < game.enemies.length; e++) {
      var foe = game.enemies[e];
      if (foe.dead) continue;
      var dx = (foe.x + foe.w / 2) - cx, dy = (foe.y + foe.h / 2) - cy;
      if (dx * dx + dy * dy <= m.blast * m.blast) { foe.dead = true; addScore(300); }
    }
    // A player caught in the blast takes a hit too (mind your own mines).
    var p = game.player;
    if (p.invuln === 0) {
      var pdx = (p.x + p.w / 2) - cx, pdy = (p.y + p.h / 2) - cy;
      if (pdx * pdx + pdy * pdy <= m.blast * m.blast) hitPlayer();
    }
    game.enemies = game.enemies.filter(function (x) { return !x.dead; });
    syncHud();
  }

  function updateBlasts() {
    for (var i = 0; i < game.blasts.length; i++) {
      var bl = game.blasts[i];
      bl.t++;
      bl.r = bl.max * Math.min(1, bl.t / 10);
      if (bl.t > 22) bl.done = true;
    }
    game.blasts = game.blasts.filter(function (x) { return !x.done; });
  }

  // ---- Stairs -------------------------------------------------------------

  function tryStairs(player, level) {
    if (!player.onGround) return;
    var pcx = player.x + player.w / 2, feet = player.y + player.h;
    for (var i = 0; i < level.stairs.length; i++) {
      var s = level.stairs[i];
      if (Math.abs(feet - (s.topY + player.h)) < 8 &&
          Math.abs(pcx - (s.topX + player.w / 2)) < 16 && Input.pressed("down")) {
        player.onStair = { fromX: s.topX, fromY: s.topY, toX: s.botX, toY: s.botY, t: 0, dur: 24 };
        return;
      }
      if (Math.abs(feet - (s.botY + player.h)) < 8 &&
          Math.abs(pcx - (s.botX + player.w / 2)) < 16 && Input.pressed("up")) {
        player.onStair = { fromX: s.botX, fromY: s.botY, toX: s.topX, toY: s.topY, t: 0, dur: 24 };
        return;
      }
    }
  }

  function advanceStair(player) {
    var s = player.onStair;
    s.t++;
    var u = smooth(s.t / s.dur);
    player.x = s.fromX + (s.toX - s.fromX) * u;
    player.y = s.fromY + (s.toY - s.fromY) * u;
    player.vx = 0; player.vy = 0;
    if (s.t >= s.dur) {
      player.x = s.toX; player.y = s.toY;
      player.onGround = true; player.onStair = null;
    }
  }

  // ---- OKB 13 (tap-to-snipe) ---------------------------------------------

  // ~3s dramatic sequence + a ~0.75s afterglow: slow zoom, lock-on,
  // a 1s "GUILTY" cut, headshot, then lingering slow-mo before play resumes.
  var SNIPE = { zoom: 54, aim: 44, guilty: 62, fire: 20, after: 46 };

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
      s.phase = "guilty"; s.t = 0;
      if (global.Sound) global.Sound.play("guilty");
    } else if (s.phase === "guilty" && s.t >= SNIPE.guilty) {
      s.phase = "fire"; s.t = 0;
      if (global.Sound) global.Sound.play("snipe");
    } else if (s.phase === "fire" && s.t >= SNIPE.fire) {
      // The shot lands: remove the agent, then hold on the aftermath.
      s.enemy.dead = true;
      game.enemies = game.enemies.filter(function (x) { return !x.dead; });
      addScore(1500);
      if (global.Sound) global.Sound.play("explode");
      if (game.player.okb !== Infinity) game.player.okb--;
      s.phase = "after"; s.t = 0;
      syncHud();
    } else if (s.phase === "after" && s.t >= SNIPE.after) {
      game.snipe = null;                 // resume play
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
    // During a snipe, zoom the whole world in on the target for extra drama.
    var sn = game.snipe;
    if (sn && sn.phase !== "guilty") {
      var z = snipeZoom(sn);
      var zx = sn.enemy.x + sn.enemy.w / 2;
      var zy = sn.enemy.y + 8 - game.camY;
      var shake = sn.phase === "fire" ? (Math.random() - 0.5) * 6 : 0;
      ctx.translate(zx + shake, zy + shake);
      ctx.scale(z, z);
      ctx.translate(-zx, -zy);
    }
    ctx.translate(0, -Math.round(game.camY));

    game.level.draw(ctx);
    for (var mi = 0; mi < game.mines.length; mi++) game.mines[mi].draw(ctx);
    for (var it = 0; it < game.items.length; it++) game.items[it].draw(ctx);
    for (var e = 0; e < game.enemies.length; e++) game.enemies[e].draw(ctx);
    for (var b = 0; b < game.bullets.length; b++) game.bullets[b].draw(ctx);
    if (game.state === STATE.PLAY) game.player.draw(ctx);
    drawBlasts(ctx);

    ctx.restore();

    if (game.snipe) {
      if (game.snipe.phase === "guilty") drawGuiltyCut(game.snipe.t);
      else if (game.snipe.phase === "after") drawAfterglow(game.snipe);
      else drawScope(game.snipe);
    }
    if (game.msgTimer > 0) drawFlash();
  }

  /** Lingering aftermath after the shot: fading vignette + slow-mo pull-back. */
  function drawAfterglow(s) {
    var W = canvas.width, H = canvas.height;
    var u = clamp(s.t / SNIPE.after, 0, 1);
    var fade = 1 - smooth(u);
    ctx.save();
    ctx.fillStyle = "rgba(50,90,170," + (0.10 * fade) + ")"; ctx.fillRect(0, 0, W, H);
    var g = ctx.createRadialGradient(W / 2, H / 2, 70, W / 2, H / 2, W * 0.85);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0," + (0.5 * fade) + ")");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (u < 0.85) {
      ctx.globalAlpha = clamp(1 - u / 0.85, 0, 1);
      ctx.fillStyle = "#ff5a5a"; ctx.font = "bold 22px 'Courier New', monospace";
      ctx.textAlign = "center"; ctx.fillText("TARGET DOWN", W / 2, 58);
      ctx.globalAlpha = 1; ctx.textAlign = "left";
    }
    ctx.restore();
  }

  function drawBlasts(ctx) {
    for (var i = 0; i < game.blasts.length; i++) {
      var b = game.blasts[i];
      var a = clamp(1 - b.t / 22, 0, 1);
      ctx.fillStyle = "rgba(255,180,60," + (a * 0.5) + ")";
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,90,40," + a + ")";
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255," + a + ")";
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.25, 0, Math.PI * 2); ctx.fill();
    }
  }

  function snipeZoom(s) {
    var Z = 2.7;
    if (s.phase === "zoom") return 1 + (Z - 1) * smooth(s.t / SNIPE.zoom);
    if (s.phase === "after") return 1 + (Z - 1) * (1 - smooth(s.t / SNIPE.after)); // pull back
    return Z;                              // aim / fire hold zoomed in
  }

  /** Dramatic OKB 13 sniper scope, drawn in screen space over the frozen world. */
  function drawScope(s) {
    var W = canvas.width, H = canvas.height;
    var e = s.enemy;
    var tx = e.x + e.w / 2;
    var ty = e.y + 8 - game.camY;              // aim at the head (world is zoomed)
    var sway = s.phase === "aim" ? 2.5 : 0;    // slow breathing sway
    tx += Math.sin(s.t / 9) * sway;
    ty += Math.cos(s.t / 11) * sway;

    var full = Math.max(W, H) * 1.15, rMin = 96;
    var r = s.phase === "zoom"
      ? full - (full - rMin) * smooth(s.t / SNIPE.zoom)
      : rMin;

    ctx.save();

    // Slow-motion blue tint during the lead-up.
    if (s.phase === "zoom" || s.phase === "aim") {
      ctx.fillStyle = "rgba(50,90,170,0.12)";
      ctx.fillRect(0, 0, W, H);
    }

    // Dark vignette with a circular hole punched at the target.
    ctx.fillStyle = "rgba(2,3,8,0.93)";
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(tx, ty, r, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    // Scope rings.
    ctx.lineWidth = 12; ctx.strokeStyle = "#04050a";
    ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = "#2a3350";
    ctx.beginPath(); ctx.arc(tx, ty, r - 6, 0, Math.PI * 2); ctx.stroke();

    // Reticle, clipped to the lens.
    ctx.save();
    ctx.beginPath(); ctx.arc(tx, ty, r - 6, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = "rgba(235,70,70,0.85)"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tx - r, ty); ctx.lineTo(tx + r, ty);
    ctx.moveTo(tx, ty - r); ctx.lineTo(tx, ty + r);
    ctx.stroke();
    for (var k = -6; k <= 6; k++) {
      if (!k) continue;
      ctx.beginPath();
      ctx.moveTo(tx + k * 10, ty - 3); ctx.lineTo(tx + k * 10, ty + 3);
      ctx.moveTo(tx - 3, ty + k * 10); ctx.lineTo(tx + 3, ty + k * 10);
      ctx.stroke();
    }
    // Pulsing lock ring during aim (heartbeat).
    if (s.phase === "aim") {
      var pr = 26 + (Math.sin(s.t / 5) + 1) * 8;
      ctx.strokeStyle = "rgba(255,80,80,0.7)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tx, ty, pr, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,50,50,0.95)"; ctx.fillRect(tx - 2, ty - 2, 4, 4);
    ctx.restore();

    // HUD text inside/under the scope.
    ctx.textAlign = "center";
    if (s.phase === "zoom" || s.phase === "aim") {
      ctx.fillStyle = "#ff6a6a"; ctx.font = "bold 13px 'Courier New', monospace";
      ctx.fillText("O K B   1 3", tx, ty - r + 22);
      ctx.fillStyle = "rgba(180,200,230,0.7)"; ctx.font = "11px 'Courier New', monospace";
      ctx.fillText("RANGE 1200m  WIND 3", tx, ty + r - 14);
      if (s.phase === "aim" && Math.floor(s.t / 8) % 2 === 0) {
        ctx.fillStyle = "#ffd166"; ctx.font = "bold 16px 'Courier New', monospace";
        ctx.fillText("TARGET LOCKED", W / 2, H - 30);
      }
    }
    if (s.phase === "fire") {
      var a = 1 - s.t / SNIPE.fire;
      ctx.fillStyle = "rgba(255,255,255," + (a * 0.95) + ")"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ff2a2a";
      for (var b = 0; b < 12; b++) {
        var ang = b * Math.PI / 6, len = 6 + s.t * 3;
        ctx.fillRect(tx + Math.cos(ang) * len - 2, ty + Math.sin(ang) * len - 2, 5, 5);
      }
      ctx.fillStyle = "#fff"; ctx.font = "bold 24px 'Courier New', monospace";
      ctx.fillText("HEADSHOT!", W / 2, 54);
    }
    ctx.textAlign = "left";
    ctx.restore();
  }

  function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }

  /**
   * 1-second gekiga-style cut: a stern OKB 13 sniper in high-contrast ink with
   * focus lines and a jagged "ギルティ" speech burst, just before the shot.
   */
  function drawGuiltyCut(t) {
    var W = canvas.width, H = canvas.height;
    var intro = clamp(t / 9, 0, 1);            // slam-in
    var shake = t < 9 ? (1 - intro) * 7 : 0;

    ctx.save();
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    // Slight settle-in zoom.
    var zc = 1 + (1 - smooth(intro)) * 0.08;
    ctx.translate(W / 2, H / 2); ctx.scale(zc, zc); ctx.translate(-W / 2, -H / 2);

    // Custom user-supplied art takes over the whole panel when present.
    if (guiltyReady) {
      ctx.fillStyle = "#000"; ctx.fillRect(-30, -30, W + 60, H + 60);
      var isc = Math.max(W / guiltyImg.width, H / guiltyImg.height) * (1 + (1 - smooth(intro)) * 0.06);
      var dw = guiltyImg.width * isc, dh = guiltyImg.height * isc;
      ctx.drawImage(guiltyImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
      if (t < 6) { ctx.fillStyle = "rgba(255,255,255," + (1 - t / 6) * 0.55 + ")"; ctx.fillRect(-30, -30, W + 60, H + 60); }
      ctx.restore();
      return;
    }

    // ---- Sky ----
    ctx.fillStyle = "#cbd1db"; ctx.fillRect(-30, -30, W + 60, H + 60);
    // Dark ragged clouds with hatching.
    ctx.fillStyle = "#3c414d";
    inkCloud(60, 54, 150, 40); inkCloud(280, 38, 180, 52); inkCloud(470, 96, 150, 46);
    hatch(0, 0, W, 150, 7, -1, "rgba(20,22,28,0.30)");
    // Faint action lines from the muzzle.
    ctx.strokeStyle = "rgba(20,22,28,0.18)"; ctx.lineWidth = 1;
    for (var a = 0; a < 22; a++) {
      var yy0 = 150 + a * 16;
      ctx.beginPath(); ctx.moveTo(W, 250); ctx.lineTo(-20, yy0); ctx.stroke();
    }

    // ---- City skyline ----
    ctx.fillStyle = "#242932";
    var bx = [-10, 40, 78, 120, 150, 196, 250, 300, 470, 500];
    var bh = [120, 165, 96, 140, 80, 130, 100, 150, 90, 130];
    for (var c = 0; c < bx.length; c++) ctx.fillRect(bx[c], 372 - bh[c], (bx[c + 1] || W) - bx[c] - 4, bh[c] + 20);
    // A tall lattice tower on the right (Tokyo-tower-ish, original).
    drawTower(430, 214, 372);
    // window speckle
    ctx.fillStyle = "rgba(200,208,220,0.5)";
    for (var wy = 262; wy < 366; wy += 10) for (var wx = 20; wx < 320; wx += 12)
      if ((wx + wy) % 3 === 0) ctx.fillRect(wx, wy, 3, 4);

    // ---- Parapet (foreground concrete) ----
    ctx.fillStyle = "#b3b9c4"; ctx.fillRect(-20, 366, W + 40, H - 360);
    ctx.fillStyle = "#8b929e"; ctx.fillRect(-20, 366, W + 40, 5);
    ctx.strokeStyle = "#7c8390"; ctx.lineWidth = 2;
    for (var sx = 26; sx < W; sx += 74) { ctx.beginPath(); ctx.moveTo(sx, 372); ctx.lineTo(sx, H); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, 420); ctx.lineTo(W, 420); ctx.stroke();
    hatch(0, 366, W, H - 366, 8, 1, "rgba(60,66,76,0.22)");

    // ---- Rifle (large, resting on the parapet, muzzle to the right) ----
    drawSniperRifle();

    // ---- Sniper (upper-left, sighting down the scope) ----
    drawSniperHead(t);

    // ---- Speech bubble: 有罪（ギルティ） ----
    if (t > 10) drawGuiltyBubble(W - 92, 92, smooth(clamp((t - 10) / 8, 0, 1)));

    // Entry flash.
    if (t < 6) { ctx.fillStyle = "rgba(255,255,255," + (1 - t / 6) * 0.55 + ")"; ctx.fillRect(-30, -30, W + 60, H + 60); }

    // Corner caption.
    ctx.fillStyle = "rgba(10,11,14,0.82)"; ctx.fillRect(0, H - 24, 132, 24);
    ctx.fillStyle = "#e6e9ef"; ctx.font = "bold 12px 'Courier New', monospace";
    ctx.textAlign = "left"; ctx.fillText("OKB 13  NO MISS", 8, H - 8);
    ctx.restore();
  }

  // -- gekiga helpers (all original vector art) --

  function inkCloud(x, y, w, h) {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.bezierCurveTo(x - w * 0.3, y + h * 0.2, x + w * 0.2, y - h, x + w * 0.5, y);
    ctx.bezierCurveTo(x + w * 0.8, y - h * 0.9, x + w * 1.4, y + h * 0.4, x + w, y + h);
    ctx.closePath(); ctx.fill();
  }

  function hatch(x, y, w, h, gap, dir, color) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    for (var i = -h; i < w + h; i += gap) {
      ctx.beginPath();
      ctx.moveTo(x + i, y); ctx.lineTo(x + i + dir * h, y + h); ctx.stroke();
    }
    ctx.restore();
  }

  function drawTower(cx, top, base) {
    ctx.strokeStyle = "#20242c"; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, top); ctx.lineTo(cx - 34, base);      // left leg
    ctx.moveTo(cx, top); ctx.lineTo(cx + 34, base);      // right leg
    ctx.stroke();
    ctx.lineWidth = 2;
    for (var i = 1; i < 6; i++) {
      var y = top + (base - top) * (i / 6), wte = 6 + i * 5;
      ctx.beginPath(); ctx.moveTo(cx - wte, y); ctx.lineTo(cx + wte, y); ctx.stroke();
    }
    ctx.fillStyle = "#20242c"; ctx.fillRect(cx - 3, top - 22, 6, 24); // mast
  }

  function drawSniperRifle() {
    // Barrel.
    ctx.fillStyle = "#14161c"; ctx.fillRect(300, 244, 168, 11);
    ctx.fillStyle = "#3a404c"; ctx.fillRect(300, 245, 168, 2);      // top glint
    // Muzzle brake.
    ctx.fillStyle = "#0c0e13"; ctx.fillRect(452, 238, 36, 22);
    ctx.fillStyle = "#cbd1db";
    for (var m = 0; m < 3; m++) ctx.fillRect(458 + m * 10, 240, 3, 18); // slots
    // Perforated handguard.
    ctx.fillStyle = "#1b1f27"; ctx.fillRect(300, 234, 130, 30);
    ctx.fillStyle = "#cbd1db";
    for (var hgx = 312; hgx < 424; hgx += 18) { ctx.beginPath(); ctx.arc(hgx, 249, 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#1b1f27";
    for (var hgx2 = 312; hgx2 < 424; hgx2 += 18) { ctx.beginPath(); ctx.arc(hgx2, 249, 2.4, 0, Math.PI * 2); ctx.fill(); }
    // Receiver body.
    ctx.fillStyle = "#1c212b"; ctx.fillRect(168, 236, 138, 46);
    ctx.fillStyle = "#0e1116"; ctx.fillRect(168, 236, 138, 4);      // top rail
    // Scope.
    ctx.fillStyle = "#12151b"; ctx.fillRect(214, 214, 96, 16);     // tube
    ctx.beginPath(); ctx.arc(214, 222, 12, 0, Math.PI * 2); ctx.fill(); // ocular bell
    ctx.beginPath(); ctx.arc(312, 222, 13, 0, Math.PI * 2); ctx.fill(); // objective bell
    ctx.fillStyle = "#3a404c"; ctx.fillRect(214, 216, 96, 2);
    ctx.fillStyle = "#0e1116"; ctx.fillRect(238, 208, 10, 22); ctx.fillRect(276, 208, 10, 22); // rings
    ctx.fillStyle = "#5b93b8"; ctx.beginPath(); ctx.arc(312, 222, 7, 0, Math.PI * 2); ctx.fill(); // lens glint
    // Magazine.
    ctx.fillStyle = "#161a22"; ctx.fillRect(196, 282, 34, 46);
    // Bipod.
    ctx.strokeStyle = "#0e1116"; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(360, 258); ctx.lineTo(338, 372); ctx.moveTo(360, 258); ctx.lineTo(392, 372); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = "#3a404c";
    ctx.beginPath(); ctx.moveTo(360, 258); ctx.lineTo(392, 372); ctx.stroke();
    // Stock behind the shoulder.
    ctx.fillStyle = "#161a22"; ctx.fillRect(120, 244, 52, 30);
  }

  function drawSniperHead(t) {
    var H = canvas.height;
    // Coat shoulders.
    ctx.fillStyle = "#0e1015";
    ctx.beginPath();
    ctx.moveTo(0, H); ctx.lineTo(0, 300); ctx.lineTo(70, 262);
    ctx.lineTo(150, 300); ctx.lineTo(210, 300); ctx.lineTo(230, H); ctx.closePath(); ctx.fill();
    // Neck + jaw (pale).
    ctx.fillStyle = "#dee2e9";
    ctx.beginPath();
    ctx.moveTo(64, 300); ctx.lineTo(150, 300); ctx.lineTo(196, 250);
    ctx.lineTo(196, 236); ctx.lineTo(120, 208); ctx.lineTo(70, 232); ctx.closePath(); ctx.fill();
    // Face profile (facing right toward the scope).
    ctx.fillStyle = "#e7ebf1";
    ctx.beginPath();
    ctx.moveTo(70, 232);                 // hairline temple
    ctx.lineTo(150, 214);
    ctx.quadraticCurveTo(206, 214, 208, 236);   // brow to nose bridge
    ctx.lineTo(214, 252);                // nose tip (near ocular)
    ctx.lineTo(196, 258);                // under nose
    ctx.lineTo(196, 286);                // lips/chin
    ctx.lineTo(150, 300);
    ctx.lineTo(96, 288);
    ctx.closePath(); ctx.fill();
    // Jaw/cheek shadow (hatched).
    hatch(120, 250, 90, 52, 6, 1, "rgba(90,98,112,0.5)");
    // Brow + stern eye sighting.
    ctx.fillStyle = "#14161c";
    ctx.fillRect(150, 236, 44, 5);                 // heavy brow
    ctx.beginPath(); ctx.moveTo(168, 246); ctx.lineTo(190, 244);
    ctx.lineTo(190, 251); ctx.lineTo(168, 252); ctx.closePath(); ctx.fill(); // narrowed eye
    ctx.fillStyle = "#c9d0da"; ctx.fillRect(180, 246, 4, 3);        // cold catchlight
    // Grim mouth.
    ctx.strokeStyle = "#3a404c"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(168, 276); ctx.lineTo(192, 272); ctx.stroke();
    // Blond swept hair (light with strand lines).
    ctx.fillStyle = "#eef1f6";
    ctx.beginPath();
    ctx.moveTo(58, 250);
    ctx.quadraticCurveTo(20, 150, 120, 150);
    ctx.quadraticCurveTo(178, 150, 172, 210);
    ctx.lineTo(150, 214); ctx.quadraticCurveTo(120, 196, 84, 214);
    ctx.lineTo(70, 232); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#aeb5c1"; ctx.lineWidth = 1.5;
    for (var s = 0; s < 8; s++) {
      ctx.beginPath();
      ctx.moveTo(60 + s * 13, 156 + (s % 2) * 6);
      ctx.quadraticCurveTo(70 + s * 12, 190, 78 + s * 12, 220);
      ctx.stroke();
    }
    // Gloved hands on grip/foregrip.
    ctx.fillStyle = "#14161c";
    ctx.beginPath(); ctx.arc(186, 300, 20, 0, Math.PI * 2); ctx.fill();     // trigger hand
    ctx.beginPath(); ctx.arc(300, 300, 18, 0, Math.PI * 2); ctx.fill();     // foregrip hand
    ctx.fillStyle = "#2a2f3a"; ctx.fillRect(292, 268, 16, 34);             // forearm
  }

  /** Oval manga bubble reading "有罪（ギルティ）". */
  function drawGuiltyBubble(cx, cy, sc) {
    if (sc <= 0) return;
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(sc, sc);
    ctx.beginPath();
    ctx.ellipse(0, 0, 76, 58, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#f6f7fa"; ctx.fill();
    ctx.lineWidth = 3.5; ctx.strokeStyle = "#111"; ctx.stroke();
    // tail toward the sniper (lower-left).
    ctx.beginPath();
    ctx.moveTo(-40, 34); ctx.lineTo(-92, 96); ctx.lineTo(-20, 44); ctx.closePath();
    ctx.fillStyle = "#f6f7fa"; ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#111"; ctx.textAlign = "center";
    ctx.font = "bold 34px 'Yu Mincho','Hiragino Mincho ProN',serif";
    ctx.fillText("有罪", 0, -2);
    ctx.font = "bold 15px 'Hiragino Kaku Gothic ProN',sans-serif";
    ctx.fillText("（ギルティ）", 0, 30);
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
      if (p && p.okb > 0) parts.push("🎯" + (p.okb === Infinity ? "∞" : p.okb));
      if (p && p.mines > 0) parts.push("💣" + p.mines);
      hud.power.textContent = parts.join(" ");
    }
  }

  function showOverlay(won) {
    overlay.classList.remove("hidden");
    var cont = won ? "" :
      '<button id="continue-btn">CONTINUE<small>ステージ再開</small></button>';
    overlay.innerHTML =
      '<h1>' + (won ? "MISSION COMPLETE" : "GAME OVER") + '</h1>' +
      '<p class="subtitle">SCORE ' + game.score + ' &nbsp;/&nbsp; HI ' + game.hi + '</p>' +
      '<div class="over-btns">' + cont +
      '<button id="start-btn" class="' + (won ? "" : "secondary") + '">' +
      (won ? "PLAY AGAIN" : "1面から") + '</button></div>';
    document.getElementById("start-btn").addEventListener("click", startGame);
    var cb = document.getElementById("continue-btn");
    if (cb) cb.addEventListener("click", continueGame);
  }

  // Continue from the current stage, preceded by a 6s taunt (EN, then JP).
  function continueGame() {
    game.taunt = TAUNTS[Math.floor(Math.random() * TAUNTS.length)];
    game.tauntTimer = 0;
    game.state = STATE.TAUNT;
    if (global.Sound) global.Sound.stopMusic();
    overlay.classList.remove("hidden");
    overlay.innerHTML =
      '<div class="taunt">' +
        '<p class="taunt-label">CONTINUE?</p>' +
        '<p class="taunt-en">' + escapeHtml(game.taunt.en) + '</p>' +
        '<p class="taunt-jp" id="taunt-jp">' + escapeHtml(game.taunt.jp) + '</p>' +
      '</div>';
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---- Debug menu ---------------------------------------------------------

  var dbg = { stage: 0, weapon: "none" };
  var WEAPONS = [
    { id: "none", label: "なし" },
    { id: "machinegun", label: "🔫 マシンガン" },
    { id: "vest", label: "🛡 防弾チョッキ" },
    { id: "mine", label: "💣 地雷" },
    { id: "okb", label: "🎯 OKB 13" }
  ];

  function openDebug() {
    game.state = STATE.MENU;                 // pause the world
    if (global.Sound) global.Sound.stopMusic();
    overlay.classList.remove("hidden");
    renderDebug();
  }

  function renderDebug() {
    var stageBtns = "";
    for (var i = 0; i < STAGES.length; i++) {
      stageBtns += '<button class="dbg-cell dbg-stage' + (i === dbg.stage ? " sel" : "") +
        '" data-i="' + i + '">' + (i + 1) + "<small>" + STAGES[i].name + "</small></button>";
    }
    var wBtns = "";
    for (var w = 0; w < WEAPONS.length; w++) {
      wBtns += '<button class="dbg-cell dbg-weap' + (WEAPONS[w].id === dbg.weapon ? " sel" : "") +
        '" data-w="' + WEAPONS[w].id + '">' + WEAPONS[w].label + "</button>";
    }
    overlay.innerHTML =
      '<h1 style="font-size:22px;letter-spacing:2px">DEBUG</h1>' +
      '<p class="subtitle" style="margin-bottom:8px">STAGE</p>' +
      '<div class="dbg-row">' + stageBtns + "</div>" +
      '<p class="subtitle" style="margin:14px 0 8px">WEAPON</p>' +
      '<div class="dbg-row">' + wBtns + "</div>" +
      '<button id="dbg-go" style="margin-top:18px">GO</button>';
    var i, cells = overlay.querySelectorAll(".dbg-stage");
    for (i = 0; i < cells.length; i++) cells[i].addEventListener("click", function () {
      dbg.stage = +this.getAttribute("data-i"); renderDebug();
    });
    var wcells = overlay.querySelectorAll(".dbg-weap");
    for (i = 0; i < wcells.length; i++) wcells[i].addEventListener("click", function () {
      dbg.weapon = this.getAttribute("data-w"); renderDebug();
    });
    document.getElementById("dbg-go").addEventListener("click", function () {
      game.score = 0;
      game.lives = 2;
      game.stage = dbg.stage;
      game.pendingLoadout = dbg.weapon;
      if (global.Sound) global.Sound.resume();
      beginWithLoadout(loadStage);
    });
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
      if (pendingProceed) { var f = pendingProceed; pendingProceed = null; f(); }
      else if (game.state === STATE.STAGECLEAR) nextStage();
      else if (game.state === STATE.TAUNT) { /* let the taunt play out */ }
      else if (game.state !== STATE.PLAY) startGame();
    }
    if (e.code === "KeyM") toggleSound();
    if (e.code === "Backquote") { e.preventDefault(); openDebug(); }   // ` opens debug
  });

  // Debug button — hidden unless the URL asks for it (e.g. .../#debug), handy
  // on touch devices that have no backquote key.
  var debugBtn = document.getElementById("debug-btn");
  if (debugBtn) {
    if (/debug/i.test(location.hash + location.search)) debugBtn.style.display = "";
    debugBtn.addEventListener("click", openDebug);
  }

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
