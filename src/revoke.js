import { OPEN_API_BASE_URL, requiredEnv } from './config.js';
import { apiFetch } from './http.js';

const args = parseArgs(process.argv.slice(2));
const token = args.token || process.env.CHZZK_REFRESH_TOKEN || process.env.CHZZK_ACCESS_TOKEN;
const tokenTypeHint = args.type || (process.env.CHZZK_REFRESH_TOKEN ? 'refresh_token' : 'access_token');

if (!token) {
  throw new Error('Usage: npm run auth:revoke -- --token TOKEN --type refresh_token');
}

await apiFetch(`${OPEN_API_BASE_URL}/auth/v1/token/revoke`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    clientId: requiredEnv('CHZZK_CLIENT_ID'),
    clientSecret: requiredEnv('CHZZK_CLIENT_SECRET'),
    token,
    tokenTypeHint
  })
});

console.log('Token revoked.');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      result[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return result;
}
