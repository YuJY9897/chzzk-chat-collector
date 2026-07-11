import crypto from 'node:crypto';
import { ACCOUNT_INTERLOCK_URL, requiredEnv } from './config.js';

const state = crypto.randomBytes(16).toString('hex');
const url = new URL(ACCOUNT_INTERLOCK_URL);
url.searchParams.set('clientId', requiredEnv('CHZZK_CLIENT_ID'));
url.searchParams.set('redirectUri', requiredEnv('CHZZK_REDIRECT_URI'));
url.searchParams.set('state', state);

console.log('Open this URL in your browser:');
console.log(url.toString());
console.log('');
console.log('Save this state and compare it with the returned state:');
console.log(state);
