// ui/achievement-popup.js — the "Achievement unlocked!" polaroid queue.
//
// domain/achievements.js announces unlocks on a window event; this module owns
// the two things that decide whether one can actually be shown right now.
//
// WAITING FOR A CLEAR SCREEN. The commonest way to earn a badge is to finish a
// game — which is also the one moment the app is already showing a polaroid:
// play-flow puts the "Well played!" wrap-up card up the instant the host taps
// Save, and PolaroidPopup is a singleton, so an achievement card fired a second
// later would REPLACE the wrap-up the user is still reading. So the queue only
// drains onto an empty screen, and every sheet and modal in this app rides
// `.polaroid-popup__backdrop` (bottom sheets included — see ui/bottom-sheet.js),
// which makes one selector the whole test.
//
// ONE AT A TIME. Logging a tenth play can clear several bars at once. They are
// shown in turn — dismissing one brings up the next, with a "2 of 3" counter —
// rather than collapsed into a summary card, because the point of the moment is
// the badge, and a badge you do not see the art for is a toast.

// @ts-check

(function () {
  // How often to re-check for a clear screen, and how long to keep trying. The
  // ceiling matters: a user who opens a sheet and leaves it open should not
  // find a celebration for a play from ten minutes ago waiting behind it. The
  // badge is not lost — it is on the shelf with a New ribbon, and the hub's
  // See-all dot is showing.
  const RETRY_MS = 700;
  const GIVE_UP_MS = 45000;

  /** @type {any[]} */
  let _queue = [];
  let _timer = null;
  let _waitingSince = 0;
  let _showing = false;

  /** Anything of this app's own on screen — a wrap-up polaroid, a confirm, a
   *  bottom sheet, one of the widget modals. */
  function _screenBusy() {
    return !!document.querySelector(".polaroid-popup__backdrop");
  }

  /** The one screen where a popup is noise: the badge is already in front of
   *  the user, ribboned, on the rail they are looking at. */
  function _onAchievementsScreen() {
    const r = window.store && window.store.get("currentRoute");
    return !!r && r.name === "achievements";
  }

  function _stop() {
    clearTimeout(_timer);
    _timer = null;
  }

  function _drain() {
    _stop();
    if (_showing || !_queue.length) return;

    if (_onAchievementsScreen()) { _queue = []; return; }

    if (_screenBusy()) {
      if (Date.now() - _waitingSince > GIVE_UP_MS) { _queue = []; return; }
      _timer = setTimeout(_drain, RETRY_MS);
      return;
    }

    const total = _queue.length;
    const a = _queue.shift();
    _showing = true;
    // `total` is what is left INCLUDING this one, so the counter counts down a
    // batch honestly even if another unlock lands mid-queue.
    const done = () => {
      _showing = false;
      _waitingSince = Date.now();
      // Let the card's removal settle before testing for a clear screen again,
      // or the next drain sees the node this dismissal is still removing.
      _timer = setTimeout(_drain, 250);
    };

    window.PolaroidPopup.achievement({
      name: a.name,
      description: a.tagline,
      spriteUrl: window.Achievements.spriteUrl(a.icon),
      index: 1,
      total,
      onView: () => {
        _queue = [];
        _showing = false;
        _stop();
        window.router.go("achievements");
      },
      onDismiss: done,
    });
  }

  const BgbAchievementPopup = {
    /**
     * Queue badges to celebrate. De-duplicated against what is already waiting:
     * two payload observations in quick succession (the check's own fetch, then
     * a screen that reads the same entry) must not double-queue the same badge.
     * @param {any[]} list
     */
    enqueue(list) {
      if (!Array.isArray(list) || !list.length) return;
      const pending = new Set(_queue.map((a) => a.id));
      for (const a of list) {
        if (a && a.id && !pending.has(a.id)) { _queue.push(a); pending.add(a.id); }
      }
      if (!_waitingSince) _waitingSince = Date.now();
      _drain();
    },

    /** Drop anything queued — called on sign-out, where the next account must
     *  not inherit the previous one's celebration. */
    reset() {
      _queue = [];
      _showing = false;
      _waitingSince = 0;
      _stop();
    },

    init() {
      window.addEventListener(window.Achievements.UNLOCK_EVENT, (ev) => {
        const detail = /** @type {any} */ (ev).detail;
        this.enqueue((detail && detail.unlocked) || []);
      });
    },
  };

  window.BgbAchievementPopup = BgbAchievementPopup;
})();
