import { OPEN_API_BASE_URL, bearerHeaders, requiredEnv } from './config.js';
import { apiFetch } from './http.js';

const me = await apiFetch(`${OPEN_API_BASE_URL}/open/v1/users/me`, {
  headers: bearerHeaders(requiredEnv('CHZZK_ACCESS_TOKEN'))
});

console.log(JSON.stringify(me, null, 2));
