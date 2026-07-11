import { OPEN_API_BASE_URL, requiredEnv } from './config.js';
import { apiFetch } from './http.js';

const args = parseArgs(process.argv.slice(2));
const code = args.code;
const state = args.state;

if (!code || !state) {
  throw new Error('Usage: npm run auth:token -- --code YOUR_CODE --state YOUR_STATE');
}

const token = await apiFetch(`${OPEN_API_BASE_URL}/auth/v1/token`, {
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

console.log(JSON.stringify(token, null, 2));

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
