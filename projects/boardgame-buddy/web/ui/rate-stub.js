// ui/rate-stub.js — "Rate {game}" on the Well played! wrap-up card.
//
// The polaroid above it is tonight's play; this stub, torn off along a
// perforation, is about the GAME. It only ever appears for a game the viewer
// has not ranked yet: a game played every week must not ask every week, and
// re-ranking lives on the game page. Tapping one of the three gut checks opens
// the ranking sheet on its first "which do you prefer?", and once the game is
// placed the stub says where it landed.
//
// Mounted from ui/polaroid-popup.js's wire(), which runs after every update()
// repaint — so what was just rated is remembered here, not in the markup.

(function () {
  /** "cardId|gameId" → RankEntry, for a game rated while that card was up. Keyed
   *  by card so the NEXT wrap-up of the same game shows no stub at all rather
   *  than this card's confirmation line. */
  const _justRated = {};
  const key = (host, gameId) => `${host.getAttribute("data-card-id") || ""}|${gameId}`;
  let _seq = 0;

  document.addEventListener("ranks-changed", (e) => {
    const gameId = e.detail && e.detail.gameId;
    if (!gameId) return;
    window.Rank.summary().then((ranks) => {
      const entry = ranks[gameId];
      if (!entry) return;
      document.querySelectorAll(`[data-rate-host][data-game-id="${CSS.escape(gameId)}"]`)
        .forEach((host) => {
          _justRated[key(host, gameId)] = entry;
          paint(host, host.__rateGame);
        });
    }).catch(() => {});
  });

  function paint(host, game) {
    const done = _justRated[key(host, game.id)];
    if (done) {
      const b = window.Rank.badge(done);
      const line = b.top
        ? `${escapeHtml(game.name)} is your <b>${b.num}${escapeHtml(b.rest)}</b> game`
        : `You rated ${escapeHtml(game.name)} <b>${b.num}${b.rest}</b>`;
      host.innerHTML = `
        <p class="polaroid-popup__rate-done">
          <span class="polaroid-popup__rate-check"><i data-icon="check" class="w-4 h-4"></i></span>
          <span>${line}</span>
        </p>`;
    } else {
      host.innerHTML = `
        <h4 class="polaroid-popup__rate-title">Rate ${escapeHtml(game.name)}</h4>
        <div class="polaroid-popup__rate-tiers">
          ${window.Rank.TIERS.map((t) => `
            <button type="button" class="polaroid-popup__rate-tier polaroid-popup__rate-tier--${t.id}"
                    data-rate-tier="${t.id}">
              <span class="polaroid-popup__rate-dot"><i data-icon="${t.icon}" class="w-4 h-4"></i></span>
              <span>${t.label}</span>
            </button>`).join("")}
        </div>`;
    }
    host.hidden = false;
    window.BgbIcons.render(host);
  }

  /**
   * @param {HTMLElement|null} host  the card's [data-rate-host] slot
   * @param {{id?:string, name?:string, is_expansion?:boolean}|null} game
   * @param {number|string} cardId  the popup card's id, stable across update()
   */
  function mount(host, game, cardId) {
    if (!host || !game || !game.id || game.is_expansion || !window.Rank) return;
    if (!(window.store && window.store.get("user"))) return;
    host.__rateGame = game;
    host.setAttribute("data-game-id", game.id);
    host.setAttribute("data-card-id", String(cardId));
    if (!host.__rateBound) {
      host.__rateBound = true;
      host.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-rate-tier]");
        if (!btn) return;
        window.RankSheet.open(
          { id: host.__rateGame.id, name: host.__rateGame.name },
          { tier: btn.getAttribute("data-rate-tier"), returnFocus: btn },
        );
      });
    }
    if (_justRated[key(host, game.id)]) { paint(host, game); return; }
    const seq = ++_seq;
    window.Rank.summary().then((ranks) => {
      // A later card (or an update() repaint) owns the slot now.
      if (seq !== _seq || !host.isConnected) return;
      if (ranks[game.id]) return;  // already rated: no stub at all
      paint(host, game);
    }).catch(() => {});
  }

  window.RateStub = { mount };
})();
