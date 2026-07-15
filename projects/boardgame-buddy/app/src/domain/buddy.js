// src/domain/buddy.js — Buddy graph. Phase 2 needs only sendRequest (the feed's
// "Buddies you may know" Add button); the rest lands in Phase 4.

import { api } from '../api/client';
import { bgbCache } from '../cache';

export const Buddy = {
  sendRequest(targetUserId) {
    return api.post('/buddies/request', { target_user_id: targetUserId })
      .then((r) => { bgbCache.delete('buddy', 'all'); return r; });
  },
  invalidate() {
    bgbCache.delete('buddy', 'all');
  },
};
