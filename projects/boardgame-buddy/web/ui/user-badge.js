// ui/user-badge.js — Single source of truth for rendering a user's badge.
//
// A badge is a colored circle holding either the user's initials or one of
// a small library of board-game-themed icons. The user picks their badge
// in settings (see PolaroidPopup.avatarCustomizer in polaroid-popup.js);
// every surface that shows a player renders via BgbBadge.render() so the
// customization shows up consistently.
//
// Ghost players (free-text names without an account) and users who haven't
// customized their badge yet (avatar == null) render the BGB default:
// brown background + gold initials.

// @ts-check

(function () {

  // BGB default = brown badge + gold initials. Null avatar from the API
  // resolves to this client-side.
  const DEFAULT_AVATAR = Object.freeze({
    icon: "initials",
    iconColor: "#C9922A",
    bgColor: "#2a1812",
  });

  // 12-swatch palette offered in the customizer. `light` controls the
  // contrast color of the check mark on the active swatch — see CSS.
  const PALETTE = [
    { hex: "#f7f0df", light: true },
    { hex: "#ffffff", light: true },
    { hex: "#e0a02e", light: true },
    { hex: "#c79a5b", light: true },
    { hex: "#3f7d4a", light: false },
    { hex: "#2a8a7a", light: false },
    { hex: "#2f6a93", light: false },
    { hex: "#7a5293", light: false },
    { hex: "#b23b34", light: false },
    { hex: "#d2691e", light: false },
    { hex: "#2a2014", light: false },
    { hex: "#39424f", light: false },
  ];

  // Icon library. Each entry is a single <path> with fill="currentColor"
  // so the badge's iconColor (applied via inline style) paints it.
  // viewBox is 24×24 everywhere; the slot CSS scales to badge size.
  const ICONS = {
    buddy: '<path fill="currentColor" d="M12 1.6c-2.6 0-4.7 2.1-4.7 4.7 0 1.6.8 3 2 3.9-2.8.9-4.8 3.5-4.8 6.6v4.8c0 .5.4.9.9.9h13.2c.5 0 .9-.4.9-.9v-4.8c0-3.1-2-5.7-4.8-6.6 1.2-.9 2-2.3 2-3.9 0-2.6-2.1-4.7-4.7-4.7Zm-1.8 5.7a.9.9 0 1 1 1.8 0 .9.9 0 0 1-1.8 0Zm2.7 0a.9.9 0 1 1 1.8 0 .9.9 0 0 1-1.8 0Zm-3.4 3.3c.5.9 1.4 1.5 2.5 1.5s2-.6 2.5-1.5"/>',
    meeple: '<path fill="currentColor" d="M12 2c-1.5 0-2.7 1.2-2.7 2.7 0 .9.5 1.8 1.2 2.3-1.3.4-2.5 1-3.6 1.8C5.4 9.7 3.7 10 3.7 11.4c0 .9.8 1.4 1.7 1.4.8 0 1.6-.2 2.3-.6-.7 1.6-1.3 3.2-1.3 4.7 0 1.4 1.2 1.6 2.5 1.6h6.2c1.3 0 2.5-.2 2.5-1.6 0-1.5-.6-3.1-1.3-4.7.7.4 1.5.6 2.3.6.9 0 1.7-.5 1.7-1.4 0-1.4-1.7-1.7-3.2-2.6-1.1-.8-2.3-1.4-3.6-1.8.7-.5 1.2-1.4 1.2-2.3C14.7 3.2 13.5 2 12 2z"/>',
    die: '<path fill="currentColor" fill-rule="evenodd" d="M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm1 3.6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM8 14.4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>',
    sword: '<path fill="currentColor" d="M12 1.4 13.4 4v9.2h-2.8V4L12 1.4ZM7.4 13.7h9.2v2.3H7.4v-2.3ZM11 16.4h2v3.8h-2v-3.8Zm1 4a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"/>',
    shield: '<path fill="currentColor" d="M12 1.8 3.6 4.9v6.2c0 5.2 3.6 8.9 8.4 11.1 4.8-2.2 8.4-5.9 8.4-11.1V4.9L12 1.8Z"/>',
    crown: '<path fill="currentColor" d="M2 7.5 6.6 11 12 3.6 17.4 11 22 7.5l-2 12H4l-2-12Zm2.5 13.5h15v1.5h-15V21Z"/>',
    spade: '<path fill="currentColor" d="M12 2C9 6.2 3.6 9 3.6 13.4A3.9 3.9 0 0 0 10.5 16c-.2 2.2-1 3.5-2.2 4.6h7.4c-1.2-1.1-2-2.4-2.2-4.6a3.9 3.9 0 0 0 6.9-2.6C20.4 9 15 6.2 12 2Z"/>',
    heart: '<path fill="currentColor" d="M12 21.3 4.3 14C1.4 11 2.6 6 6.4 5.2c2-.4 3.8.6 4.8 2.1 1-1.5 2.8-2.5 4.8-2.1C19.8 6 21 11 18.1 14L12 21.3Z"/>',
    rook: '<path fill="currentColor" d="M6 3.5h2.4v2h2.1v-2h2.6v2h2.1v-2H18v4.2l-2 1.8v6.8h2v3H6v-3h2V9.5L6 7.7V3.5Z"/>',
    hourglass: '<path fill="currentColor" d="M5 2h14v2H5V2Zm2 3h10v2.6l-3.6 4.4 3.6 4.4V19H7v-2.6l3.6-4.4L7 7.6V5ZM5 20h14v2H5v-2Z"/>',
  };

  // Carousel order. `initials` is always first; `buddy` (the BGB mascot)
  // comes next as the project's signature icon, then the generic set.
  const ITEMS = [
    { key: "initials",  name: "Initials" },
    { key: "buddy",     name: "Buddy" },
    { key: "meeple",    name: "Meeple" },
    { key: "die",       name: "Die" },
    { key: "sword",     name: "Sword" },
    { key: "shield",    name: "Shield" },
    { key: "crown",     name: "Crown" },
    { key: "spade",     name: "Spade" },
    { key: "heart",     name: "Heart" },
    { key: "rook",      name: "Rook" },
    { key: "hourglass", name: "Hourglass" },
  ];

  /**
   * Compute the 1-2 letter initials shown inside an initials-badge.
   * Two-word names → first + last initial. Single word → first 2 chars.
   * Empty → "?".
   * @param {string|null|undefined} name
   * @returns {string}
   */
  function initialsOf(name) {
    const parts = String(name || "").trim().split(/[\s.]+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return (parts[0] || "?").slice(0, 2).toUpperCase();
  }

  /**
   * @typedef {{icon: string, iconColor: string, bgColor: string}} Avatar
   *
   * @typedef {Object} BadgeOpts
   * @property {Avatar|null=} avatar       Customization. null → BGB default.
   * @property {string=}      displayName  Used to compute initials.
   * @property {'xs'|'sm'|'md'|'lg'=} size Defaults to 'sm'.
   * @property {boolean=}     isGhost      Ghost player → baseline badge + initials.
   * @property {boolean=}     isMe         Adds a subtle highlight ring.
   * @property {string=}      extraClass   Caller-supplied class(es).
   */

  /**
   * Return HTML for a user badge. Ghosts and uncustomized users get the
   * BGB default brown + gold initials look; customized users get their
   * chosen icon (or initials) painted in their chosen colors.
   * @param {BadgeOpts} opts
   * @returns {string}
   */
  function render(opts) {
    const size = opts.size || "sm";
    const isGhost = !!opts.isGhost;
    // Ghost players never have a customized avatar — always default.
    const av = isGhost ? DEFAULT_AVATAR : (opts.avatar || DEFAULT_AVATAR);
    const initials = initialsOf(opts.displayName);
    const classes = [
      "user-badge",
      `user-badge--${size}`,
      isGhost ? "user-badge--ghost" : "",
      opts.isMe ? "user-badge--me" : "",
      opts.extraClass || "",
    ].filter(Boolean).join(" ");
    const styleBg = `background:${escapeAttr(av.bgColor)}`;
    const styleColor = `color:${escapeAttr(av.iconColor)}`;
    const inner = (av.icon === "initials" || !ICONS[av.icon])
      ? `<span class="user-badge__initials">${escape(initials)}</span>`
      : `<svg class="user-badge__icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[av.icon]}</svg>`;
    return `<span class="${classes}" style="${styleBg};${styleColor}" aria-label="${escapeAttr(opts.displayName || "")}">${inner}</span>`;
  }

  function escape(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) { return escape(s); }

  window.BgbBadge = {
    render,
    initialsOf,
    DEFAULT: DEFAULT_AVATAR,
    PALETTE,
    ICONS,
    ITEMS,
  };
})();
