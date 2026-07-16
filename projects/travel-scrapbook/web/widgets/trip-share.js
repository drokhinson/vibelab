// widgets/trip-share.js — the trip crew modal: invite by username (owner),
// manage roles, remove members, or leave the trip.
'use strict';

const TripShare = {
  open(trip, { isOwner = true } = {}) {
    document.getElementById('share-modal')?.remove();
    const tripId = trip.id;
    const user = window.store.get('user');
    const meId = user ? user.user_id : null;
    const ROLE_LABEL = { owner: 'Owner', collaborator: 'Collaborator', viewer: 'Viewer' };

    const modal = document.createElement('div');
    modal.className = 'ts-modal';
    modal.id = 'share-modal';
    document.body.appendChild(modal);
    const close = () => modal.remove();

    const memberRow = (m) => {
      const initial = (m.display_name || '?').trim().charAt(0).toUpperCase() || '?';
      const pending = m.status === 'pending';
      const canManage = isOwner && m.role !== 'owner';
      return `
        <div class="crew-row" data-user-id="${escapeAttr(m.user_id)}">
          <span class="crew-avatar">${escapeHtml(initial)}</span>
          <div style="min-width:0;flex:1;">
            <div style="font-weight:700;">${escapeHtml(m.display_name)}${m.user_id === meId ? ' <span class="scrap-card__sub" style="font-weight:600;">(you)</span>' : ''}</div>
            <div class="scrap-card__sub">@${escapeHtml(m.username || '')}${pending ? ' · invite pending' : ''}</div>
          </div>
          ${canManage ? `
            <select class="ts-input crew-role" data-user-id="${escapeAttr(m.user_id)}" style="width:auto;padding:0.3rem 0.5rem;margin:0;">
              <option value="collaborator" ${m.role === 'collaborator' ? 'selected' : ''}>Collaborator</option>
              <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option>
            </select>
            <button class="crew-remove" data-user-id="${escapeAttr(m.user_id)}" aria-label="Remove ${escapeAttr(m.display_name)}"><i data-lucide="x"></i></button>`
            : `<span class="crew-role-badge">${ROLE_LABEL[m.role] || m.role}</span>`}
        </div>`;
    };

    const paint = () => {
      const members = window.store.get('members:' + tripId) || [];
      modal.innerHTML = `
        <div class="ts-modal__backdrop"></div>
        <div class="ts-modal__card" role="dialog" aria-modal="true" aria-label="Share trip">
          <button class="ts-modal__close" aria-label="Close"><i data-lucide="x"></i></button>
          <h2 class="ts-modal__title">Trip crew</h2>
          <p class="scrap-card__sub" style="margin-top:-0.4rem;">Everyone here can add their vibe on each place; collaborators can also add places.</p>
          <div class="crew-list">${members.map(memberRow).join('')}</div>
          ${isOwner ? `
            <form id="invite-form" style="margin-top:1rem;">
              <label class="ts-label" for="invite-username">Invite by username</label>
              <div style="display:flex;gap:0.5rem;align-items:flex-end;">
                <input class="ts-input" id="invite-username" placeholder="their @username" maxlength="30" style="flex:1;margin:0;" />
                <select class="ts-input" id="invite-role" style="width:auto;margin:0;">
                  <option value="collaborator">Collaborator</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <button class="ts-btn ts-btn--mint" type="submit" style="width:100%;margin-top:0.8rem;">
                <i data-lucide="user-plus"></i>Send invite
              </button>
            </form>`
          : `
            <button class="ts-btn ts-btn--ghost" id="leave-trip" style="width:100%;margin-top:1rem;color:#E4557A;border-color:var(--blush);">
              <i data-lucide="log-out"></i>Leave this trip
            </button>`}
        </div>`;
      window.lucide?.createIcons({ root: modal });
      bind();
    };

    const bind = () => {
      modal.querySelector('.ts-modal__backdrop')?.addEventListener('click', close);
      modal.querySelector('.ts-modal__close')?.addEventListener('click', close);

      modal.querySelector('#invite-form')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const username = modal.querySelector('#invite-username').value.trim().replace(/^@/, '');
        const role = modal.querySelector('#invite-role').value;
        if (!username) return;
        try {
          await window.ShareDomain.invite(tripId, username, role);
          toast(`Invited @${username}`);
          paint();
        } catch (err) { toast(err.message || 'Could not invite', { error: true }); }
      });

      modal.querySelectorAll('.crew-role').forEach((sel) => {
        sel.addEventListener('change', async () => {
          try {
            await window.ShareDomain.changeRole(tripId, sel.dataset.userId, sel.value);
            toast('Role updated');
            paint();
          } catch (err) { toast(err.message, { error: true }); paint(); }
        });
      });

      modal.querySelectorAll('.crew-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirmDestructive('Remove this traveler from the trip?')) return;
          try {
            await window.ShareDomain.removeMember(tripId, btn.dataset.userId);
            toast('Removed');
            paint();
          } catch (err) { toast(err.message, { error: true }); }
        });
      });

      modal.querySelector('#leave-trip')?.addEventListener('click', async () => {
        if (!confirmDestructive(`Leave "${trip.name}"? You'll lose access unless you're re-invited.`)) return;
        try {
          await window.ShareDomain.removeMember(tripId, meId);
          await window.TripDomain.loadAll();
          close();
          toast('You left the trip');
          window.router.go('trips');
        } catch (err) { toast(err.message, { error: true }); }
      });
    };

    paint();
    // Refresh the crew from the server in case it changed since the trip loaded.
    window.ShareDomain.loadMembers(tripId).then(paint).catch(() => {});
  },
};
window.TripShare = TripShare;
