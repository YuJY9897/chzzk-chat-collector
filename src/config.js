import 'dotenv/config';

export const OPEN_API_BASE_URL = 'https://openapi.chzzk.naver.com';
export const ACCOUNT_INTERLOCK_URL = 'https://chzzk.naver.com/account-interlock';

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function optionalEnv(name, fallback = '') {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export function clientHeaders() {
  return {
    'Client-Id': requiredEnv('CHZZK_CLIENT_ID'),
    'Client-Secret': requiredEnv('CHZZK_CLIENT_SECRET'),
    'Content-Type': 'application/json'
  };
}

export function bearerHeaders(accessToken = requiredEnv('CHZZK_ACCESS_TOKEN')) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
}
