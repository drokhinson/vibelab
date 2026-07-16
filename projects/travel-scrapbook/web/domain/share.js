// domain/share.js — trip sharing (members + invitations), store-backed.
'use strict';

const ShareDomain = {
  // Members of a trip; cached under members:<tripId> so the share panel re-renders.
  async loadMembers(tripId) {
    const res = await window.api.listMembers(tripId);
    window.store.set('members:' + tripId, res.members);
    return res.members;
  },

  async invite(tripId, username, role) {
    const member = await window.api.inviteMember(tripId, { username, role });
    await this.loadMembers(tripId);
    return member;
  },

  async changeRole(tripId, userId, role) {
    await window.api.updateMember(tripId, userId, { role });
    await this.loadMembers(tripId);
  },

  // Remove a member (owner) or leave the trip yourself (member).
  async removeMember(tripId, userId) {
    await window.api.removeMember(tripId, userId);
    await this.loadMembers(tripId);
  },

  // Pending invitations addressed to the current user, cached under 'invitations'.
  async loadInvitations() {
    const res = await window.api.listInvitations();
    window.store.set('invitations', res.invitations);
    return res.invitations;
  },

  // Accept/decline; on accept the trip appears in the caller's trip list.
  async respond(tripId, action) {
    await window.api.respondInvitation(tripId, action);
    await this.loadInvitations();
    if (action === 'accept') await window.TripDomain.loadAll();
  },
};
window.ShareDomain = ShareDomain;
