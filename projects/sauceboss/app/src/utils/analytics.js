// Fire-and-forget analytics ping on app open. Mirrors web/helpers.js 41-45.

import { BASE_API_URL } from '../api/client';

export function trackAppOpen() {
  fetch(`${BASE_API_URL}/api/v1/analytics/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'sauceboss', event: 'app_open' }),
  }).catch(() => {
    // ignore — analytics must not block boot
  });
}
