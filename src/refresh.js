import { OPEN_API_BASE_URL, requiredEnv } from './config.js';
import { apiFetch } from './http.js';

export async function refreshAccessToken(refreshToken = requiredEnv('CHZZK_REFRESH_TOKEN')) {
  return apiFetch(`${OPEN_API_BASE_URL}/auth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'refresh_token',
      refreshToken,
      clientId: requiredEnv('CHZZK_CLIENT_ID'),
      clientSecret: requiredEnv('CHZZK_CLIENT_SECRET')
    })
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const token = await refreshAccessToken();
  console.log(JSON.stringify(token, null, 2));
}
