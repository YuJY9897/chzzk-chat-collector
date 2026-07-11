import http from 'node:http';
import { URL } from 'node:url';
import { requiredEnv, optionalEnv } from './config.js';
import { createAuthUrl, exchangeCode } from './oauth.js';
import { clearTokens, hasTokens, readTokens, writeTokens } from './token-store.js';
import { ChatCollector } from './chat-collector.js';

const port = Number(optionalEnv('PORT', '3000'));
const redirectUri = optionalEnv('CHZZK_REDIRECT_URI', `http://localhost:${port}/callback`);
let expectedState = null;
let collector = null;
let status = '대기 중';
let lastFiles = null;
let standby = null;
let activeMode = 'idle';
let lastReceivedAt = null;
const recentChats = [];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, renderHome());
    if (req.method === 'GET' && url.pathname === '/auth/start') return startAuth(res);
    if (req.method === 'GET' && url.pathname === '/callback') return handleCallback(url, res);
    if (req.method === 'POST' && url.pathname === '/api/collect/stop') return stopCollect(res);
    if (req.method === 'POST' && url.pathname === '/api/standby/start') return startStandby(req, res);
    if (req.method === 'POST' && url.pathname === '/api/standby/stop') return stopStandby(res);
    if (req.method === 'POST' && url.pathname === '/api/logout') return logout(res);
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, getStatus());

    sendText(res, 'Not found', 404);
  } catch (error) {
    status = `오류: ${error.message}`;
    sendText(res, error.message, 500);
  }
});

server.listen(port, () => {
  console.log('');
  console.log('============================================================');
  console.log(' CHZZK Clip Scout 실행 중');
  console.log(' 채팅 로그를 수집하는 동안 이 CMD 창을 닫지 마세요.');
  console.log(' 이 창을 닫으면 수집도 중지됩니다.');
  console.log('============================================================');
  console.log('');
  console.log(`Open http://localhost:${port}`);
  console.log(`Redirect URI: ${redirectUri}`);
});

function startAuth(res) {
  const auth = createAuthUrl(redirectUri);
  expectedState = auth.state;
  sendRedirect(res, auth.url);
}

async function handleCallback(url, res) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) return sendHtml(res, renderMessage('연결 실패', 'code 또는 state가 없습니다.'));
  if (state !== expectedState) return sendHtml(res, renderMessage('연결 실패', 'state 값이 일치하지 않습니다. 다시 연결해 주세요.'));

  const tokens = await exchangeCode({ code, state });
  writeTokens(tokens);
  expectedState = null;
  status = '치지직 계정 연결 완료';
  sendHtml(res, renderMessage('연결 완료', '토큰은 화면에 표시하지 않고 로컬 tokens.json에 저장했습니다.', '/'));
}

async function startStandby(req, res) {
  if (!hasTokens()) return sendJson(res, { ok: false, error: '먼저 치지직 계정을 연결해 주세요.' }, 400);
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  standby = {
    enabled: true,
    broadcastTitle: params.get('logFileName') || 'broadcast',
    broadcastStartedAt: toIsoWithTimezone(params.get('logStartDateTime') || ''),
    retryMs: 30000,
    timer: null,
    lastError: ''
  };
  activeMode = 'standby';
  status = '자동 저장 예약 중입니다. 방송 중이면 지금부터 저장하고, 아니면 방송이 켜질 때까지 기다립니다.';
  await tryStandbyStart();
  sendRedirect(res, '/');
}

function stopStandby(res) {
  stopStandbyTimer();
  standby = null;
  activeMode = 'idle';
  status = '자동 저장 예약을 취소했습니다.';
  sendRedirect(res, '/');
}

function stopCollect(res) {
  stopStandbyTimer();
  if (standby) standby.enabled = false;
  if (collector) {
    lastFiles = collector.stop();
  }
  activeMode = 'idle';
  sendRedirect(res, '/');
}

function logout(res) {
  stopStandbyTimer();
  standby = null;
  if (collector?.running) collector.stop();
  clearTokens();
  activeMode = 'idle';
  status = '연결 해제 완료';
  sendRedirect(res, '/');
}

function getStatus() {
  return {
    connected: hasTokens(),
    collecting: Boolean(collector?.running),
    waiting: Boolean(standby?.enabled),
    activeMode,
    status,
    lastFiles,
    recentChats,
    lastReceivedAt: lastReceivedAt ? lastReceivedAt.toISOString() : null
  };
}

async function createAndStartCollector({ broadcastTitle, broadcastStartedAt, restartFromStandby }) {
  lastReceivedAt = null;
  recentChats.length = 0;
  collector = new ChatCollector({
    tokens: readTokens(),
    onTokens: writeTokens,
    onStatus: (message) => { status = message; },
    onEnd: () => {
      if (standby?.enabled) {
        activeMode = 'standby';
        status = '방송 종료 또는 연결 종료를 감지했습니다. 다시 자동 저장 예약 상태로 돌아갑니다.';
        scheduleStandbyRetry();
      } else {
        activeMode = 'idle';
      }
    },
    onChat: (chat) => {
      lastReceivedAt = new Date();
      recentChats.unshift({ time: chat.message_time, nickname: chat.nickname, content: chat.content });
      if (recentChats.length > 20) recentChats.pop();
    }
  });

  const files = await collector.start({ broadcastTitle, broadcastStartedAt });
  if (restartFromStandby) {
    activeMode = 'collecting';
    status = '방송 감지. 채팅 저장을 시작했습니다.';
  }
  return files;
}

async function tryStandbyStart() {
  if (!standby?.enabled || collector?.running) return;
  try {
    lastFiles = await createAndStartCollector({
      broadcastTitle: standby.broadcastTitle,
      broadcastStartedAt: standby.broadcastStartedAt,
      restartFromStandby: true
    });
  } catch (error) {
    standby.lastError = error.message;
    status = `아직 채팅 저장을 시작하지 못했습니다. 30초 후 다시 시도합니다. (${error.message})`;
    scheduleStandbyRetry();
  }
}

function scheduleStandbyRetry() {
  if (!standby?.enabled) return;
  stopStandbyTimer();
  standby.timer = setTimeout(() => {
    tryStandbyStart().catch((error) => {
      status = `자동 저장 예약 재시도 오류: ${error.message}`;
      scheduleStandbyRetry();
    });
  }, standby.retryMs);
}

function stopStandbyTimer() {
  if (standby?.timer) {
    clearTimeout(standby.timer);
    standby.timer = null;
  }
}

function toIsoWithTimezone(localDateTime) {
  if (!localDateTime) return '';
  return `${localDateTime}:00+09:00`;
}

function renderHome() {
  const current = getStatus();
  const connectedText = current.connected ? '연결됨' : '연결 안 됨';
  const collectingText = current.collecting ? '저장 중' : '저장 안 함';
  const waitingText = current.waiting ? '예약됨' : '예약 안 함';
  const defaultFileName = formatDateForFilename(new Date());
  const chats = current.recentChats.map((chat) => `<li><time>${escapeHtml(chat.time)}</time> <b>${escapeHtml(chat.nickname)}</b> ${escapeHtml(chat.content)}</li>`).join('');
  const files = current.lastFiles ? `<p class="muted">저장 위치<br>CSV: ${escapeHtml(current.lastFiles.csvPath)}<br>JSONL: ${escapeHtml(current.lastFiles.jsonlPath)}</p>` : '<p class="muted">저장 파일은 이 앱 폴더의 data 폴더에 만들어집니다.</p>';
  const lastReceivedText = current.collecting
    ? (current.lastReceivedAt
      ? `<p class="muted">마지막 채팅 수신: ${formatElapsed(current.lastReceivedAt)} (새로고침을 눌러 다시 확인하세요)</p>`
      : '<p class="muted">아직 채팅을 받지 못했습니다. 방송에 채팅이 올라오는지 확인해 주세요.</p>')
    : '';
  const isBusy = current.collecting || current.waiting;
  const disabled = isBusy ? 'disabled' : '';
  const busyNote = isBusy ? '<p class="muted">채팅 저장 또는 자동 저장 예약 중에는 설정을 바꿀 수 없습니다. 변경하려면 먼저 멈추거나 예약을 취소하세요.</p>' : '';
  const connectedSections = current.connected ? `
    <section>
      <h2>2. 자동 저장 예약</h2>
      <p class="warning">과거 채팅은 저장할 수 없습니다. 방송 시작 전에 꼭 채팅 저장을 시작하세요.</p>
      ${busyNote}
      <p class="muted">방송 전이라면 방송이 켜질 때까지 기다리고, 이미 방송 중이라면 버튼을 누른 시점부터 바로 저장합니다.</p>
      <form method="post" action="/api/standby/start">
        <label>저장할 파일 이름</label>
        <input name="logFileName" value="${defaultFileName}" placeholder="예: ${defaultFileName}" ${disabled}>
        <label>언제부터 채팅을 저장할까요?</label>
        <input name="logStartDateTime" type="datetime-local" ${disabled}>
        <p class="muted">비워두면 실제 채팅 시각만 저장됩니다. 값을 넣으면 다시보기 기준 시간, 예: 00:15:30 계산에 사용됩니다.</p>
        <div class="row">
          <button type="submit" ${disabled}>자동 저장 예약하기</button>
        </div>
      </form>
      <form method="post" action="/api/collect/stop" style="margin-top: 12px;"><button class="secondary" type="submit">채팅 저장 멈추기</button></form>
      <form method="post" action="/api/standby/stop" style="margin-top: 12px;"><button class="secondary" type="submit">예약 취소하기</button></form>
      ${files}
      ${lastReceivedText}
    </section>
    <section>
      <h2>최근 채팅</h2>
      <ul>${chats || '<li class="muted">아직 수집된 채팅이 없습니다.</li>'}</ul>
    </section>` : `
    <section>
      <p class="muted">채팅 저장을 시작하려면 먼저 치지직 계정을 연결해 주세요.</p>
    </section>`;

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CHZZK Clip Scout</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #101312; color: #f2f5f3; }
    main { max-width: 920px; margin: 0 auto; padding: 40px 20px; }
    h1 { font-size: 32px; margin: 0 0 8px; }
    section { border-top: 1px solid #2b302e; padding: 24px 0; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .pill { padding: 8px 12px; border: 1px solid #37413d; border-radius: 6px; background: #171b19; }
    a.button, button { border: 0; border-radius: 6px; background: #00d9a5; color: #07110e; padding: 12px 16px; font-weight: 700; text-decoration: none; cursor: pointer; }
    button.secondary { background: #303633; color: #f2f5f3; }
    input { width: min(460px, 100%); padding: 12px; border: 1px solid #37413d; border-radius: 6px; background: #171b19; color: #f2f5f3; }
    label { display: block; margin: 12px 0 6px; color: #c8d0cc; }
    .muted { color: #a5afaa; line-height: 1.5; }
    .warning { color: #f6d36d; line-height: 1.5; font-weight: 700; }
    input:disabled, button:disabled { opacity: .55; cursor: not-allowed; }
    li { margin: 8px 0; color: #dde5e1; }
    time { color: #8ad8c0; margin-right: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>CHZZK Clip Scout</h1>
    <p class="muted">공식 API로 권한을 받은 방송 채팅을 저장하는 로컬 수집기입니다.</p>
    <section>
      <div class="row">
        <span class="pill">계정: ${connectedText}</span>
        <span class="pill">채팅 저장: ${collectingText}</span>
        <span class="pill">자동 저장: ${waitingText}</span>
        <span class="pill">${escapeHtml(current.status)}</span>
      </div>
    </section>
    <section>
      <h2>1. 치지직 연결</h2>
      <p class="muted">처음 한 번만 연결하면 됩니다. 위 상태가 "계정: 연결됨"이면 다시 누르지 않아도 됩니다.</p>
      <div class="row">
        <a class="button" href="/auth/start">치지직 계정 연결하기</a>
        <form method="post" action="/api/logout"><button class="secondary" type="submit">계정 연결 끊기</button></form>
      </div>
    </section>
    ${connectedSections}
  </main>
</body>
</html>`;
}

function renderMessage(title, body, backHref = '') {
  const back = backHref ? `<p><a href="${backHref}">돌아가기</a></p>` : '';
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${escapeHtml(title)}</title><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${back}</body></html>`;
}

function sendHtml(res, html, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, value, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function sendText(res, text, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatElapsed(isoString) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  return `${Math.floor(minutes / 60)}시간 전`;
}

function formatDateForFilename(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
