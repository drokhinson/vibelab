'use strict';

// Slim app-header used across every screen. Page title (left) + optional
// subtitle, then a vertically-centered action cluster on the right with
// (optionally) a Manage pill, plus the auth slot (sign-in or avatar pill).
// Pass `back: { onClick }` to surface the icon-only back button at the far
// left of the header. Pass `extraActions` for screen-specific buttons that
// belong in the right-side cluster (e.g. edit-mode toggle on the Sauce
// Manager). `manage: 'auto'` (default) shows the pill only for admins;
// `false` hides it; `true` forces it on.
function renderAppHeader({ title, subtitle, back, manage, extraActions, titleIcon, titleEmoji, titlePrefix, auth = true } = {}) {
  const prefixHTML = titlePrefix
    || (titleEmoji ? `<span class="header-emoji">${titleEmoji}</span>` : '')
    + (titleIcon ? `<i data-lucide="${titleIcon}"></i>` : '');
  const titleHTML = prefixHTML
    ? `${prefixHTML}<span>${title || ''}</span>`
    : (title || '');
  const backHTML = back
    ? `<button class="app-header__back" onclick="${back.onClick}" aria-label="Back"><i data-lucide="chevron-left"></i></button>`
    : '';
  const isAdmin = !!(currentUser && currentUser.is_admin);
  const showManage = auth !== false && (manage === true || (manage !== false && manage !== 'never' && isAdmin));
  const manageHTML = showManage
    ? `<button class="sauce-mgr-btn" onclick="openSauceManager()" aria-label="Manage dishes, ingredients, and sauces"><i data-lucide="settings-2"></i><span>Manage</span></button>`
    : '';
  return `
    <div class="app-header">
      ${backHTML}
      <div class="app-header__titles">
        <h1>${titleHTML}</h1>
        ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}
      </div>
      <div class="app-header__actions">
        ${extraActions || ''}
        ${manageHTML}
        ${auth !== false ? renderHeaderAuthSlot() : ''}
      </div>
    </div>
  `;
}

// Top-right slot in the app header. Shows "Sign in" when logged out, an
// avatar pill with display-name initials when logged in.
function renderHeaderAuthSlot() {
  if (!supabaseClient) return '';
  if (!currentUser) {
    return `<button class="auth-signin-btn" onclick="openAuthModal()" title="Sign in" aria-label="Sign in"><i data-lucide="log-in"></i></button>`;
  }
  const name = currentUser.display_name || 'Saucier';
  const initials = computeInitials(name);
  return `
    <details class="auth-pill">
      <summary class="auth-pill__summary" title="${name}">
        <span class="auth-pill__initials">${initials}</span>
        ${currentUser.is_admin ? '<span class="auth-pill__badge" title="Admin">★</span>' : ''}
      </summary>
      <div class="auth-pill__menu" role="menu">
        <p class="auth-pill__name">${name}</p>
        ${!currentUser.is_admin ? `<button class="auth-pill__item" onclick="navigate('settings')">Become admin</button>` : ''}
        <button class="auth-pill__item" onclick="handleLogout()">Sign out</button>
      </div>
    </details>
  `;
}
