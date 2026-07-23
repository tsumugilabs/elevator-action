/**
 * Keyboard input handler.
 * Tracks the current pressed state of relevant keys and exposes edge-detection
 * (`pressed`) so single-fire actions like jump/shot don't auto-repeat.
 */
(function (global) {
  "use strict";

  var KEY_MAP = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    KeyZ: "jump",
    KeyX: "shoot",
    Space: "shoot",
    Enter: "start"
  };

  var down = {};   // currently held
  var last = {};   // held state at the end of the previous frame

  function onKey(e, isDown) {
    var action = KEY_MAP[e.code];
    if (!action) return;
    // Prevent the page from scrolling with arrows/space.
    e.preventDefault();
    down[action] = isDown;
  }

  window.addEventListener("keydown", function (e) { onKey(e, true); });
  window.addEventListener("keyup", function (e) { onKey(e, false); });
  // Release everything if the tab loses focus so keys don't "stick".
  window.addEventListener("blur", function () { down = {}; });

  var Input = {
    /** True while `action` is held. */
    held: function (action) { return !!down[action]; },

    /** True only on the frame `action` transitions from up to down. */
    pressed: function (action) { return !!down[action] && !last[action]; },

    /** Snapshot held-state; call once at the end of every frame. */
    endFrame: function () {
      for (var k in down) last[k] = down[k];
      for (var j in last) if (!(j in down)) last[j] = false;
    },

    reset: function () { down = {}; last = {}; },

    /**
     * Wire on-screen touch buttons to the same action states so the game is
     * playable on phones/tablets. Uses Pointer Events so multiple buttons
     * (e.g. move + shoot) can be held at once.
     */
    bindTouch: function () {
      var map = {
        "btn-left": "left", "btn-right": "right",
        "btn-up": "up", "btn-down": "down",
        "btn-jump": "jump", "btn-shoot": "shoot"
      };
      Object.keys(map).forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        var action = map[id];
        var set = function (v) {
          return function (e) {
            e.preventDefault();
            down[action] = v;
            el.classList.toggle("pressed", v);
          };
        };
        el.addEventListener("pointerdown", set(true));
        el.addEventListener("pointerup", set(false));
        el.addEventListener("pointercancel", set(false));
        el.addEventListener("pointerleave", set(false));
        el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
      });
    }
  };

  global.Input = Input;

  // Flag coarse-pointer (touch) devices so the on-screen pad can be shown,
  // then bind the buttons once the DOM is ready.
  function init() {
    var touch = ("ontouchstart" in window) ||
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    if (touch && document.body) document.body.classList.add("touch");
    Input.bindTouch();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
