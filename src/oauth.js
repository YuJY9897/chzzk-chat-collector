import crypto from 'node:crypto';
import { ACCOUNT_INTERLOCK_URL, OPEN_API_BASE_URL, requiredEnv } from './config.js';
import { apiFetch } from './http.js';

export function createAuthUrl(redirectUri, state = crypto.randomBytes(16).toString('hex')) {
  const url = new URL(ACCOUNT_INTERLOCK_URL);
  url.searchParams.set('clientId', requiredEnv('CHZZK_CLIENT_ID'));
  url.searchParams.set('redirectUri', redirectUri);
  url.searchParams.set('state', state);
  return { url: url.toString(), state };
}

export async function exchangeCode({ code, state }) {
  return apiFetch(`${OPEN_API_BASE_URL}/auth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'authorization_code',
      clientId: requiredEnv('CHZZK_CLIENT_ID'),
      clientSecret: requiredEnv('CHZZK_CLIENT_SECRET'),
      code,
      state
    })
  });
}
