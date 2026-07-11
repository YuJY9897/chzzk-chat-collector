import fs from 'node:fs';

const TOKEN_PATH = './tokens.json';

export function readTokens() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
}

export function writeTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
}

export function clearTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    fs.unlinkSync(TOKEN_PATH);
  }
}

export function hasTokens() {
  const tokens = readTokens();
  return Boolean(tokens?.accessToken && tokens?.refreshToken);
}
