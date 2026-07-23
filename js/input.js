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

    reset: function () { down = {}; last = {}; }
  };

  global.Input = Input;
})(window);
