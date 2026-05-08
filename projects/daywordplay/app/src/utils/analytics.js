// Fire-and-forget analytics ping. Mirrors web/state.js.
import { BASE_API_URL } from '../api/client';

export function trackAppOpen() {
  fetch(`${BASE_API_URL}/api/v1/analytics/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'daywordplay', event: 'app_open' }),
  }).catch(() => {});
}
