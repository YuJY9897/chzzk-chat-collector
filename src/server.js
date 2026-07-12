import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { optionalEnv } from './config.js';
import { createAuthUrl, exchangeCode } from './oauth.js';
import { clearTokens, hasTokens, readTokens, writeTokens } from './token-store.js';
import { ChatCollector } from './chat-collector.js';

const port = Number(optionalEnv('PORT', '3000'));
const redirectUri = optionalEnv('CHZZK_REDIRECT_URI', `http://localhost:${port}/callback`);
const defaultOutputDir = path.resolve('./data');
let expectedState = null;
let collector = null;
let status = '대기 중입니다.';
let lastFiles = null;
let completion = null; // { finishedAt, reason, csvPath, jsonlPath }
let lastReceivedAt = null;
const recentChats = [];

const REASON_TEXT = {
  user: '사용자 종료',
  broadcast_end: '방송 종료 감지',
  connection_lost: '연결 끊김(5분 초과)'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, renderHome());
    if (req.method === 'GET' && url.pathname === '/auth/start') return startAuth(res);
    if (req.method === 'GET' && url.pathname === '/callback') return handleCallback(url, res);
    if (req.method === 'POST' && url.pathname === '/api/collect/on') return collectOn(req, res);
    if (req.method === 'POST' && url.pathname === '/api/collect/pause') return collectPause(res);
    if (req.method === 'POST' && url.pathname === '/api/collect/resume') return collectResume(res);
    if (req.method === 'POST' && url.pathname === '/api/collect/off') return collectOff(res);
    if (req.method === 'POST' && url.pathname === '/api/open-folder') return openFolder(res);
    if (req.method === 'POST' && url.pathname === '/api/pick-folder') return pickFolder(res);
    if (req.method === 'POST' && url.pathname === '/api/open-path') return openPath(req, res);
    if (req.method === 'POST' && url.pathname === '/api/logout') return logout(res);
    if (req.method === 'POST' && url.pathname === '/api/app/quit') return quitApp(res);
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, getStatus());

    sendText(res, 'Not found', 404);
  } catch (error) {
    status = `오류: ${error.message}`;
    sendText(res, error.message, 500);
  }
});

server.listen(port, () => {
  console.log('CHZZK Clip Scout 백그라운드 실행 중');
  console.log(`Open http://localhost:${port}`);
  console.log('종료는 웹 화면의 "앱 종료" 버튼을 사용하세요.');
});

function getMode() {
  if (!collector?.running) return 'idle';
  return collector.paused ? 'paused' : 'on';
}

function startAuth(res) {
  const auth = createAuthUrl(redirectUri);
  expectedState = auth.state;
  sendRedirect(res, auth.url);
}

async function handleCallback(url, res) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) return sendHtml(res, renderMessage('연결 실패', 'code 또는 state가 없습니다.', '/'));
  if (state !== expectedState) return sendHtml(res, renderMessage('연결 실패', 'state 값이 일치하지 않습니다. 다시 연결해 주세요.', '/'));

  const tokens = await exchangeCode({ code, state });
  writeTokens(tokens);
  expectedState = null;
  status = '치지직 계정 연결 완료';
  sendHtml(res, renderMessage('연결 완료', '계정이 연결되었습니다. 이제 로그 수집을 시작할 수 있습니다.', '/'));
}

async function collectOn(req, res) {
  if (!hasTokens()) return sendHtml(res, renderMessage('시작 실패', '먼저 치지직 계정을 연결해 주세요.', '/'));
  if (getMode() !== 'idle') return sendRedirect(res, '/');

  const params = new URLSearchParams(await readBody(req));
  const broadcastTitle = params.get('logFileName') || 'broadcast';
  const broadcastStartedAt = toIsoWithTimezone(params.get('logStartDateTime') || '');
  const outputDir = (params.get('outputDir') || defaultOutputDir).trim() || defaultOutputDir;

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    return sendHtml(res, renderMessage('시작 실패', `저장 경로를 만들 수 없습니다: ${error.message}`, '/'));
  }

  lastReceivedAt = null;
  recentChats.length = 0;
  completion = null;

  collector = new ChatCollector({
    tokens: readTokens(),
    onTokens: writeTokens,
    onStatus: (message) => { status = message; },
    onEnd: (reason) => {
      if (reason !== 'user') finishCollection(reason);
    },
    onChat: (chat) => {
      lastReceivedAt = new Date();
      recentChats.unshift({ time: chat.message_time, nickname: chat.nickname, content: chat.content });
      if (recentChats.length > 20) recentChats.pop();
    }
  });

  try {
    lastFiles = await collector.start({ broadcastTitle, broadcastStartedAt, outputDir });
  } catch (error) {
    collector = null;
    return sendHtml(res, renderMessage('시작 실패', error.message, '/'));
  }

  sendRedirect(res, '/');
}

function collectPause(res) {
  collector?.pause();
  sendRedirect(res, '/');
}

async function collectResume(res) {
  try {
    await collector?.resume();
  } catch (error) {
    status = `재개 실패: ${error.message}`;
  }
  sendRedirect(res, '/');
}

function collectOff(res) {
  if (collector?.running) {
    lastFiles = collector.stop();
    finishCollection('user');
  }
  sendRedirect(res, '/');
}

function finishCollection(reason) {
  if (completion) return;
  const files = collector?.files || lastFiles;
  completion = {
    finishedAt: new Date().toISOString(),
    reason,
    csvPath: files ? path.resolve(files.csvPath) : '',
    jsonlPath: files ? path.resolve(files.jsonlPath) : ''
  };
  lastFiles = files;
  status = `수집이 종료되었습니다 (${REASON_TEXT[reason] || reason}).`;
}

function openFolder(res) {
  // 보안: 클라이언트가 보낸 경로가 아니라 서버가 기억하는 저장 파일 위치만 연다
  const target = completion?.csvPath || (lastFiles ? path.resolve(lastFiles.csvPath) : defaultOutputDir);
  const arg = fs.existsSync(target) ? `/select,"${target}"` : `"${defaultOutputDir}"`;
  exec(`explorer.exe ${arg}`);
  sendJson(res, { ok: true });
}

function pickFolder(res) {
  // Windows 기본 폴더 선택 창을 띄우고 선택 결과를 돌려준다
  const psScript = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '채팅 로그를 저장할 폴더를 선택하세요'`,
    `$dialog.SelectedPath = '${defaultOutputDir.replace(/'/g, "''")}'`,
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }'
  ].join('; ');
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], { windowsHide: true }, (error, stdout) => {
    const picked = (stdout || '').trim();
    if (error || !picked) return sendJson(res, { canceled: true });
    sendJson(res, { path: picked });
  });
}

async function openPath(req, res) {
  let dir = '';
  try {
    dir = JSON.parse(await readBody(req))?.dir || '';
  } catch {
    dir = '';
  }
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return sendJson(res, { ok: false, error: '폴더를 찾을 수 없습니다.' }, 400);
  }
  execFile('explorer.exe', [dir], () => {});
  sendJson(res, { ok: true });
}

function logout(res) {
  if (getMode() !== 'idle') {
    status = '수집 중에는 연결을 끊을 수 없습니다. 먼저 종료해 주세요.';
    return sendRedirect(res, '/');
  }
  clearTokens();
  status = '연결 해제 완료';
  sendRedirect(res, '/');
}

function quitApp(res) {
  if (collector?.running) {
    lastFiles = collector.stop();
    finishCollection('user');
  }
  sendHtml(res, renderMessage('앱 종료', 'CHZZK Clip Scout를 종료했습니다. 이 창을 닫아주세요.'));
  setTimeout(() => process.exit(0), 300);
}

function getStatus() {
  return {
    connected: hasTokens(),
    mode: getMode(),
    subscribed: Boolean(collector?.subscribed),
    status,
    lastFiles,
    recentChats,
    lastReceivedAt: lastReceivedAt ? lastReceivedAt.toISOString() : null,
    completion
  };
}

function toIsoWithTimezone(localDateTime) {
  if (!localDateTime) return '';
  return `${localDateTime}:00+09:00`;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  } catch {
    return iso;
  }
}

function renderHome() {
  const current = getStatus();
  const mode = current.mode;
  const defaultFileName = formatDateForFilename(new Date());

  const modeBadge = {
    idle: '<span class="badge"><span class="dot gray"></span>꺼짐</span>',
    on: '<span class="badge live"><span class="dot pulse"></span>수집 중</span>',
    paused: '<span class="badge paused"><span class="dot yellow"></span>일시정지</span>'
  }[mode];

  const accountBadge = current.connected
    ? '<span class="badge ok"><span class="dot green"></span>계정 연결됨</span>'
    : '<span class="badge"><span class="dot gray"></span>계정 연결 안 됨</span>';

  const connectSection = current.connected
    ? `<div class="row">
        <button class="ghost" disabled>✓ 치지직 계정이 연결되어 있습니다</button>
        <form method="post" action="/api/logout"><button class="ghost small" type="submit" ${mode === 'idle' ? '' : 'disabled'}>연결 끊기</button></form>
      </div>
      <p class="muted">한 번 연결하면 앱을 다시 켜도 유지됩니다.</p>`
    : `<div class="row">
        <a class="button primary" href="/auth/start">치지직 계정 연결하기</a>
      </div>
      <p class="muted">치지직 로그인 화면으로 이동해 권한에 동의하면 자동으로 돌아옵니다. 처음 한 번만 하면 됩니다.</p>`;

  let controls = '';
  if (mode === 'idle') {
    controls = `
      <form method="post" action="/api/collect/on">
        <label>저장할 파일 이름</label>
        <input name="logFileName" value="${defaultFileName}">
        <label>저장 위치</label>
        <div class="row" style="flex-wrap: nowrap;">
          <input id="outputDir" name="outputDir" value="${escapeHtml(defaultOutputDir)}" readonly style="flex: 1; margin-bottom: 0;">
          <button class="ghost" type="button" onclick="pickFolder(this)">폴더 선택</button>
          <button class="ghost" type="button" onclick="openPickedPath()">열기</button>
        </div>
        <p class="muted" style="margin-top: 6px;">폴더 선택을 누르면 선택 창이 열립니다. 열기를 누르면 지정한 폴더를 탐색기로 보여줍니다.</p>
        <details>
          <summary>고급 설정</summary>
          <label>다시보기 기준 시작 시간 (선택)</label>
          <input name="logStartDateTime" type="datetime-local">
          <p class="muted">방송 시작 시각을 넣으면 각 채팅이 방송 몇 분 몇 초에 나왔는지(예: 00:15:30)도 함께 저장됩니다. 비워둬도 됩니다.</p>
        </details>
        <div class="row" style="margin-top: 16px;">
          <button class="primary big" type="submit" ${current.connected ? '' : 'disabled'}>로그 수집 ON</button>
        </div>
      </form>
      <p class="muted">방송 전에 켜두면 방송이 시작될 때 자동으로 수집을 시작합니다. 이미 방송 중이면 바로 시작합니다.</p>`;
  } else {
    const pauseOrResume = mode === 'paused'
      ? '<form method="post" action="/api/collect/resume"><button class="primary" type="submit">▶ 재개</button></form>'
      : '<form method="post" action="/api/collect/pause"><button class="ghost" type="submit">❚❚ 일시정지</button></form>';
    controls = `
      <div class="row">
        ${pauseOrResume}
        <form method="post" action="/api/collect/off"><button class="danger" type="submit">■ 종료</button></form>
      </div>
      <p class="muted">일시정지 후 재개하면 같은 파일에 이어서 저장됩니다. 종료하면 파일이 완성됩니다.</p>
      ${current.lastFiles ? `<div class="filebox"><div class="filebox-title">저장 중인 파일</div><code>${escapeHtml(path.resolve(current.lastFiles.csvPath))}</code></div>` : ''}
      <p class="muted" id="last-received">${current.lastReceivedAt
        ? `마지막 채팅 수신: ${fmtTime(current.lastReceivedAt)}`
        : '아직 저장된 채팅이 없습니다. 방송 전이라면 방송이 켜질 때까지 자동으로 기다립니다.'}</p>`;
  }

  const resultCard = completion
    ? `<section class="card">
        <h2>마지막 수집 결과</h2>
        <p class="muted">${escapeHtml(REASON_TEXT[completion.reason] || completion.reason)} · ${fmtTime(completion.finishedAt)}</p>
        <div class="filebox">
          <div class="filebox-title">CSV</div><code>${escapeHtml(completion.csvPath)}</code>
          <div class="filebox-title" style="margin-top:8px;">JSONL</div><code>${escapeHtml(completion.jsonlPath)}</code>
        </div>
        <div class="row" style="margin-top:12px;">
          <button class="ghost" type="button" onclick="openFolder()">저장 폴더 열기</button>
        </div>
      </section>`
    : '';

  const chats = current.recentChats
    .map((chat) => `<li><time>${fmtTime(chat.time)}</time><b>${escapeHtml(chat.nickname)}</b><span>${escapeHtml(chat.content)}</span></li>`)
    .join('');

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CHZZK Clip Scout</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; background: #0b0f0e; color: #eef4f1; line-height: 1.55; }
    main { max-width: 720px; margin: 0 auto; padding: 36px 20px 60px; }
    header { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
    .logo { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, #00d9a5, #00b4d8); display: flex; align-items: center; justify-content: center; font-size: 19px; }
    h1 { font-size: 22px; margin: 0; letter-spacing: -.3px; }
    .subtitle { color: #93a29b; font-size: 13.5px; margin: 0 0 22px 48px; }
    .card { background: #121715; border: 1px solid #232b28; border-radius: 14px; padding: 22px 24px; margin-bottom: 14px; }
    h2 { font-size: 15px; margin: 0 0 14px; color: #c9d6d0; letter-spacing: -.2px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .badge { display: inline-flex; align-items: center; gap: 7px; padding: 7px 13px; border-radius: 999px; background: #1a211e; border: 1px solid #2a332f; font-size: 13px; color: #b7c4be; }
    .badge.live { background: rgba(0,217,165,.1); border-color: rgba(0,217,165,.35); color: #57e6c3; }
    .badge.paused { background: rgba(246,211,109,.08); border-color: rgba(246,211,109,.3); color: #f6d36d; }
    .badge.ok { color: #8fd8bf; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot.gray { background: #566159; }
    .dot.green { background: #00d9a5; }
    .dot.yellow { background: #f6d36d; }
    .dot.pulse { background: #00d9a5; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(0,217,165,.5); } 50% { box-shadow: 0 0 0 6px rgba(0,217,165,0); } }
    #status-pill { margin-top: 12px; font-size: 13.5px; color: #93a29b; }
    a.button, button { border: 0; border-radius: 9px; padding: 11px 18px; font-weight: 600; font-size: 14px; text-decoration: none; cursor: pointer; font-family: inherit; transition: filter .15s, background .15s; }
    .primary { background: #00d9a5; color: #06231b; }
    .primary:hover:not(:disabled) { filter: brightness(1.1); }
    .primary.big { padding: 13px 26px; font-size: 15px; }
    .ghost { background: #1d2522; color: #cfe0d8; border: 1px solid #2c3733; }
    .ghost:hover:not(:disabled) { background: #232d29; }
    .ghost.small { padding: 8px 14px; font-size: 13px; }
    .danger { background: #3a1d1d; color: #ff9e9e; border: 1px solid #5c2b2b; }
    .danger:hover { background: #4a2222; }
    button:disabled { opacity: .5; cursor: default; }
    input { width: 100%; padding: 12px 14px; border: 1px solid #2c3733; border-radius: 9px; background: #0e1311; color: #eef4f1; font-size: 14px; font-family: inherit; margin-bottom: 4px; }
    input:focus { outline: none; border-color: #00d9a5; }
    label { display: block; margin: 14px 0 7px; color: #a9b8b1; font-size: 13px; font-weight: 600; }
    details { margin-top: 14px; border: 1px solid #232b28; border-radius: 9px; padding: 10px 14px; }
    summary { cursor: pointer; color: #93a29b; font-size: 13px; font-weight: 600; }
    .muted { color: #7d8c85; font-size: 13px; }
    .warning { color: #f6d36d; font-size: 13px; font-weight: 600; }
    .filebox { background: #0e1311; border: 1px solid #232b28; border-radius: 9px; padding: 12px 14px; margin-top: 12px; }
    .filebox-title { font-size: 11.5px; font-weight: 700; color: #6f7f77; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 3px; }
    .filebox code { font-size: 12.5px; color: #9fd9c5; word-break: break-all; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { display: flex; gap: 10px; padding: 8px 2px; border-bottom: 1px solid #1a211e; font-size: 13.5px; align-items: baseline; }
    li:last-child { border-bottom: 0; }
    li time { color: #5f9c88; font-size: 12px; flex-shrink: 0; }
    li b { color: #cfe0d8; flex-shrink: 0; }
    li span { color: #a9b8b1; word-break: break-all; }
    footer { text-align: center; margin-top: 28px; }
    .overlay { position: fixed; inset: 0; background: rgba(5,8,7,.72); display: flex; align-items: center; justify-content: center; z-index: 10; }
    .modal { background: #121715; border: 1px solid #2c3733; border-radius: 16px; padding: 28px; max-width: 480px; width: calc(100% - 40px); box-shadow: 0 24px 60px rgba(0,0,0,.5); }
    .modal h3 { margin: 0 0 8px; font-size: 17px; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="logo">🎬</div>
      <h1>CHZZK Clip Scout</h1>
    </header>
    <p class="subtitle">치지직 공식 API로 내 방송 채팅을 자동 저장합니다</p>

    <section class="card">
      <div class="row">
        ${modeBadge}
        ${accountBadge}
      </div>
      <div id="status-pill">${escapeHtml(current.status)}</div>
    </section>

    <section class="card">
      <h2>1. 치지직 연결</h2>
      ${connectSection}
    </section>

    <section class="card">
      <h2>2. 로그 수집</h2>
      <p class="warning">지나간 채팅은 저장할 수 없어요. 방송 시작 전에 미리 켜두세요.</p>
      ${controls}
    </section>

    ${resultCard}

    <section class="card">
      <h2>최근 채팅</h2>
      <div class="row" style="margin-bottom: 10px;">
        <button class="ghost small" type="button" onclick="location.reload()">↻ 새로고침</button>
        <span class="muted">원할 때 눌러서 수집 상태를 확인하세요.</span>
      </div>
      <ul>${chats || '<li><span class="muted">아직 수집된 채팅이 없습니다.</span></li>'}</ul>
    </section>

    <footer>
      <form method="post" action="/api/app/quit" onsubmit="return confirm('앱을 완전히 종료할까요? 수집 중이면 저장 후 종료됩니다.')">
        <button class="ghost small" type="submit">앱 종료</button>
      </form>
      <p class="muted">앱은 백그라운드로 실행됩니다. 완전히 끄려면 위 버튼을 누르세요.</p>
    </footer>
  </main>

  <div class="overlay hidden" id="end-modal">
    <div class="modal">
      <h3>수집이 종료되었습니다</h3>
      <p class="muted" id="modal-reason"></p>
      <div class="filebox">
        <div class="filebox-title">CSV</div><code id="modal-csv"></code>
        <div class="filebox-title" style="margin-top:8px;">JSONL</div><code id="modal-jsonl"></code>
      </div>
      <div class="row" style="margin-top:16px;">
        <button class="ghost" type="button" onclick="openFolder()">저장 폴더 열기</button>
        <button class="primary" type="button" onclick="location.reload()">확인</button>
      </div>
    </div>
  </div>

  <script>
    var REASON_TEXT = { broadcast_end: '방송 종료가 감지되어 자동으로 저장을 마쳤습니다.', connection_lost: '연결이 5분 이상 끊겨 수집을 종료했습니다.', user: '사용자가 종료했습니다.' };
    var renderedMode = ${JSON.stringify(mode)};
    var lastCompletion = ${JSON.stringify(completion ? completion.finishedAt : '')};

    function openFolder() {
      fetch('/api/open-folder', { method: 'POST' });
    }

    function pickFolder(btn) {
      btn.disabled = true;
      btn.textContent = '선택 창 열림...';
      fetch('/api/pick-folder', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (j.path) document.getElementById('outputDir').value = j.path; })
        .catch(function () {})
        .then(function () { btn.disabled = false; btn.textContent = '폴더 선택'; });
    }

    function openPickedPath() {
      fetch('/api/open-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: document.getElementById('outputDir').value })
      });
    }

    function timeAgo(iso) {
      var sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
      if (sec < 60) return sec + '초 전';
      if (sec < 3600) return Math.floor(sec / 60) + '분 전';
      return Math.floor(sec / 3600) + '시간 전';
    }

    function poll() {
      fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
        var pill = document.getElementById('status-pill');
        if (pill) pill.textContent = s.status;

        var lr = document.getElementById('last-received');
        if (lr && s.lastReceivedAt) lr.textContent = '마지막 채팅 수신: ' + timeAgo(s.lastReceivedAt);

        if (s.completion && s.completion.finishedAt !== lastCompletion) {
          lastCompletion = s.completion.finishedAt;
          if (s.completion.reason !== 'user') {
            document.getElementById('modal-reason').textContent = REASON_TEXT[s.completion.reason] || s.completion.reason;
            document.getElementById('modal-csv').textContent = s.completion.csvPath;
            document.getElementById('modal-jsonl').textContent = s.completion.jsonlPath;
            document.getElementById('end-modal').classList.remove('hidden');
            return;
          }
          location.reload();
          return;
        }

        var modalOpen = !document.getElementById('end-modal').classList.contains('hidden');
        if (s.mode !== renderedMode && !modalOpen) location.reload();
      }).catch(function () { /* 서버 종료 등은 무시 */ });
    }
    setInterval(poll, 8000);
  </script>
</body>
</html>`;
}

function renderMessage(title, body, backHref = '') {
  const back = backHref ? `<a class="button primary" href="${backHref}" style="display:inline-block;margin-top:16px;">돌아가기</a>` : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
    body { margin:0; font-family:'Segoe UI','Malgun Gothic',sans-serif; background:#0b0f0e; color:#eef4f1; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .box { background:#121715; border:1px solid #232b28; border-radius:16px; padding:36px 40px; max-width:440px; text-align:center; }
    h1 { font-size:19px; margin:0 0 10px; } p { color:#93a29b; font-size:14px; margin:0; }
    a.button { border-radius:9px; padding:11px 20px; font-weight:600; font-size:14px; text-decoration:none; background:#00d9a5; color:#06231b; }
  </style></head><body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${back}</div></body></html>`;
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

function formatDateForFilename(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
