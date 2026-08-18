export async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok || isErrorPayload(payload)) {
    const message = payload?.message || (text ? text.slice(0, 200) : response.statusText) || 'Request failed';
    const code = payload?.code || response.status;
    throw new Error(`${options.method || 'GET'} ${url} failed: ${code} ${message}`);
  }

  return payload?.content ?? payload;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isErrorPayload(payload) {
  return payload && typeof payload.code !== 'undefined' && payload.code !== 200;
}

// 401 / INVALID_TOKEN = 치지직 연결(토큰) 만료
export function isAuthError(error) {
  return /(^|\D)401(\D|$)|INVALID_TOKEN/i.test(error?.message || '');
}

// 채팅 구독 요청의 404 = 방송 중이 아님
export function isNotFoundError(error) {
  return /(^|\D)404(\D|$)|NOT_FOUND/i.test(error?.message || '');
}
