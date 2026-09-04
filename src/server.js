import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { optionalEnv } from './config.js';
import { createAuthUrl, exchangeCode } from './oauth.js';
import { clearTokens, connectedAt, hasTokens, readTokens, writeTokens } from './token-store.js';
import { isAuthError } from './http.js';
import { ChatCollector } from './chat-collector.js';
import { analyzeFile, analyzeLogFile, listLogFiles } from './highlight.js';

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
  connection_lost: '연결 끊김(5분 초과)',
  auth_expired: '치지직 연결 만료'
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
    if (req.method === 'GET' && url.pathname === '/api/logs') return sendJson(res, listLogFiles(defaultOutputDir));
    if (req.method === 'POST' && url.pathname === '/api/analyze') return analyzeLog(req, res);

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
      if (reason === 'auth_expired') clearTokens();
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
    if (isAuthError(error)) {
      clearTokens();
      return sendHtml(res, renderMessage('치지직 연결 만료', '치지직 연결이 만료되었습니다. 계정을 다시 연결해 주세요.', '/'));
    }
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
  const files = collector ? collector.files : lastFiles;
  completion = {
    finishedAt: new Date().toISOString(),
    reason,
    csvPath: files ? path.resolve(files.csvPath) : '',
    jsonlPath: files ? path.resolve(files.jsonlPath) : '',
    highlights: files ? analyzeFile(path.resolve(files.csvPath)) : []
  };
  lastFiles = files;
  status = files
    ? `수집이 종료되었습니다 (${REASON_TEXT[reason] || reason}).`
    : `수집이 종료되었습니다 (${REASON_TEXT[reason] || reason}). 수집된 채팅이 없어 파일은 저장하지 않았습니다.`;
}

async function analyzeLog(req, res) {
  let target = '';
  try {
    target = JSON.parse(await readBody(req))?.path || '';
  } catch {
    target = '';
  }
  // 보안: 저장 폴더 안의 파일만 분석한다
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(defaultOutputDir) + path.sep)) {
    return sendJson(res, { ok: false, error: '저장 폴더 안의 파일만 분석할 수 있습니다.' });
  }
  sendJson(res, analyzeLogFile(resolved));
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
    connectedAt: connectedAt(),
    chatCount: collector?.chatCount ?? 0,
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
      <p class="muted">${connectedLabel(current.connectedAt)}</p>`
    : `<div class="row">
        <a class="button primary" href="/auth/start">치지직 계정 연결하기</a>
      </div>
      <p class="muted">치지직 로그인 화면으로 이동해 권한에 동의하면 자동으로 돌아옵니다. 처음 한 번만 하면 됩니다.</p>`;

  const hero = heroState(current);

  // 저장 설정은 접이식으로 내리고, 메인에는 버튼만 남긴다
  const settingsSection = `
      <label>저장할 파일 이름</label>
      <input form="collect-form" name="logFileName" value="${defaultFileName}" ${mode === 'idle' ? '' : 'disabled'}>
      <label>저장 위치</label>
      <div class="row" style="flex-wrap: nowrap;">
        <input id="outputDir" form="collect-form" name="outputDir" value="${escapeHtml(defaultOutputDir)}" readonly style="flex: 1; margin-bottom: 0;">
        <button class="ghost" type="button" onclick="pickFolder(this)" ${mode === 'idle' ? '' : 'disabled'}>폴더 선택</button>
        <button class="ghost" type="button" onclick="openPickedPath()">열기</button>
      </div>
      <details>
        <summary>다시보기 기준 시작 시간 (선택)</summary>
        <input form="collect-form" name="logStartDateTime" type="datetime-local" ${mode === 'idle' ? '' : 'disabled'}>
        <p class="muted">방송 시작 시각을 넣으면 각 채팅이 방송 몇 분 몇 초에 나왔는지도 함께 저장됩니다.</p>
      </details>`;

  let controls = '';
  if (mode === 'idle') {
    controls = `
      <form method="post" action="/api/collect/on" id="collect-form">
        <button class="primary big" type="submit" ${current.connected ? '' : 'disabled'}>로그 수집 ON</button>
      </form>
      <p class="warning" style="margin-top:12px;">지나간 채팅은 저장할 수 없어요. 방송 시작 전에 미리 켜두세요.</p>`;
  } else {
    const pauseOrResume = mode === 'paused'
      ? '<form method="post" action="/api/collect/resume"><button class="primary" type="submit">▶ 재개</button></form>'
      : '<form method="post" action="/api/collect/pause"><button class="ghost" type="submit">❚❚ 일시정지</button></form>';
    controls = `
      <div class="row">
        ${pauseOrResume}
        <form method="post" action="/api/collect/off"><button class="danger" type="submit">■ 수집 종료</button></form>
      </div>
      <p class="muted" style="margin-top:12px;">방송이 끝나면 종료를 눌러주세요. 치지직 API로는 방송 종료를 알 수 없어 자동으로 멈추지 않습니다.</p>`;
  }

  const resultCard = completion
    ? `<details class="fold">
        <summary>마지막 수집 결과 <span class="fold-hint">하이라이트 ${(completion.highlights || []).length}개</span></summary>
        <p class="muted">${escapeHtml(REASON_TEXT[completion.reason] || completion.reason)} · ${fmtTime(completion.finishedAt)}</p>
        <div class="filebox">
          <div class="filebox-title">CSV</div><code>${escapeHtml(completion.csvPath)}</code>
          <div class="filebox-title" style="margin-top:8px;">JSONL</div><code>${escapeHtml(completion.jsonlPath)}</code>
        </div>
        ${renderHighlights(completion.highlights)}
        <div class="row" style="margin-top:12px;">
          <button class="ghost" type="button" onclick="openFolder()">저장 폴더 열기</button>
        </div>
      </details>`
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
    .hero { padding: 24px 24px; }
    .hero-state { display: flex; align-items: center; gap: 13px; margin-bottom: 18px; }
    .hero-state .dot { width: 11px; height: 11px; flex-shrink: 0; }
    .hero-title { font-size: 17px; font-weight: 700; letter-spacing: -.3px; }
    .hero-sub { color: #7d8c85; font-size: 13px; margin-top: 2px; }
    .fold { background: #121715; border: 1px solid #232b28; border-radius: 14px; padding: 14px 24px; margin-bottom: 10px; }
    .fold > summary { cursor: pointer; list-style: none; font-size: 13.5px; font-weight: 600; color: #c9d6d0; display: flex; align-items: center; gap: 8px; }
    .fold > summary::-webkit-details-marker { display: none; }
    .fold > summary::before { content: '▸'; color: #566159; font-size: 11px; transition: transform .15s; }
    .fold[open] > summary::before { transform: rotate(90deg); }
    .fold[open] > summary { margin-bottom: 10px; }
    .fold-hint { margin-left: auto; color: #6f7f77; font-size: 12px; font-weight: 400; }
    .fold details { border: 0; padding: 0; }
    .stat-row { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 14px; }
    .stat { min-width: 72px; }
    .stat-value { font-size: 17px; font-weight: 700; color: #cfe0d8; }
    .stat-label { font-size: 11.5px; color: #6f7f77; }
    .spark { width: 100%; height: 56px; margin-top: 14px; display: block; }
    .spark rect { fill: #1d2522; }
    .spark rect.hot { fill: #00d9a5; }
    .hl-title { font-size: 13px; color: #c9d6d0; margin: 16px 0 0; }
    .hl-rank { width: 22px; height: 22px; border-radius: 6px; flex-shrink: 0; background: rgba(0,217,165,.12); color: #57e6c3; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="logo">🎬</div>
      <h1>CHZZK Clip Scout</h1>
    </header>
    <p class="subtitle">치지직 공식 API로 내 방송 채팅을 자동 저장합니다</p>

    <section class="card hero">
      <div class="hero-state">
        <span class="dot ${hero.dot}" id="hero-dot"></span>
        <div>
          <div class="hero-title" id="hero-title">${escapeHtml(hero.title)}</div>
          <div class="hero-sub" id="hero-sub">${escapeHtml(hero.sub)}</div>
        </div>
      </div>
      ${controls}
    </section>

    <details class="fold" ${current.connected ? '' : 'open'}>
      <summary>치지직 연결 <span class="fold-hint">${current.connected ? '연결됨' : '연결 필요'}</span></summary>
      ${connectSection}
    </details>

    <details class="fold">
      <summary>저장 설정 <span class="fold-hint">${mode === 'idle' ? '' : '수집 중에는 변경할 수 없습니다'}</span></summary>
      ${settingsSection}
    </details>

    ${resultCard}

    <details class="fold" id="fold-analyze" ontoggle="if (this.open) loadLogList()">
      <summary>저장된 로그 분석 <span class="fold-hint" id="analyze-hint"></span></summary>
      <div class="row" style="flex-wrap:nowrap;">
        <select id="log-select" style="flex:1;min-width:0;padding:10px 12px;border:1px solid #2c3733;border-radius:9px;background:#0e1311;color:#eef4f1;font-size:13px;font-family:inherit;"></select>
        <button class="ghost" type="button" onclick="analyzeLog()">분석</button>
      </div>
      <div id="analyze-result"></div>
    </details>

    <details class="fold">
      <summary>실시간 채팅 <span class="fold-hint" id="chat-hint">${current.chatCount ? `${current.chatCount.toLocaleString('ko-KR')}줄` : ''}</span></summary>
      <ul id="chat-list">${chats || '<li><span class="muted">아직 수집된 채팅이 없습니다.</span></li>'}</ul>
    </details>

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
    var REASON_TEXT = { broadcast_end: '방송 종료가 감지되어 자동으로 저장을 마쳤습니다.', connection_lost: '연결이 5분 이상 끊겨 수집을 종료했습니다.', auth_expired: '치지직 연결이 만료되었습니다. 계정을 다시 연결해 주세요.', user: '사용자가 종료했습니다.' };
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

    function esc(v) {
      var d = document.createElement('div');
      d.textContent = String(v == null ? '' : v);
      return d.innerHTML;
    }

    function fmtClock(iso) {
      try { return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false }); } catch (e) { return iso; }
    }

    function fmtBytes(n) {
      return n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'KB' : (n / 1048576).toFixed(1) + 'MB';
    }

    function fmtDur(sec) {
      var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = Math.floor(sec % 60);
      var mm = String(m).padStart(2, '0'), ss = String(s2).padStart(2, '0');
      return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
    }

    function loadLogList() {
      fetch('/api/logs').then(function (r) { return r.json(); }).then(function (logs) {
        var sel = document.getElementById('log-select');
        sel.innerHTML = logs.length
          ? logs.map(function (f) { return '<option value="' + esc(f.path) + '">' + esc(f.name) + ' · ' + fmtBytes(f.size) + '</option>'; }).join('')
          : '<option value="">저장된 로그가 없습니다</option>';
        document.getElementById('analyze-hint').textContent = logs.length ? logs.length + '개' : '';
      });
    }

    function analyzeLog() {
      var target = document.getElementById('log-select').value;
      if (!target) return;
      var box = document.getElementById('analyze-result');
      box.innerHTML = '<p class="muted" style="margin-top:12px;">분석 중...</p>';
      fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: target }) })
        .then(function (r) { return r.json(); })
        .then(function (result) {
          if (!result.ok) { box.innerHTML = '<p class="muted" style="margin-top:12px;">' + esc(result.error) + '</p>'; return; }
          var counts = result.timeline.counts;
          var max = Math.max.apply(null, counts.concat([1]));
          var avg = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
          var w = 100 / counts.length;
          var bars = counts.map(function (c, i) {
            var h = Math.max(1, (c / max) * 100);
            return '<rect x="' + (i * w).toFixed(3) + '" y="' + (100 - h).toFixed(2) + '" width="' + (w * 0.8).toFixed(3) + '" height="' + h.toFixed(2) + '"' + (c > avg * 2 ? ' class="hot"' : '') + '></rect>';
          }).join('');
          var stats = [[result.totalChats.toLocaleString('ko-KR'), '채팅'], [fmtDur(result.durationSec), '길이'], [result.speakers.toLocaleString('ko-KR'), '발화자'], [result.perMinute, '분당 평균']]
            .map(function (p) { return '<div class="stat"><div class="stat-value">' + p[0] + '</div><div class="stat-label">' + p[1] + '</div></div>'; }).join('');
          var hl = result.highlights.length
            ? '<h3 class="hl-title">하이라이트 ' + result.highlights.length + '개</h3><ul style="margin-top:8px;">' + result.highlights.map(function (h, i) {
                return '<li style="align-items:center;gap:12px;"><span class="hl-rank">' + (i + 1) + '</span><span style="min-width:0;"><span style="color:#cfe0d8;font-size:13px;">' + fmtDur(h.startSec) + ' ~ ' + fmtDur(h.endSec) + '</span> <span class="muted" style="font-size:12px;">' + h.durationSec + '초 · 분당 ' + h.baselinePerMin + '→' + h.peakPerMin + '개</span><br><span class="muted" style="font-size:12.5px;">' + h.topMessages.map(function (m) { return esc(m.content) + ' x' + m.count; }).join(' · ') + '</span></span></li>';
              }).join('') + '</ul>'
            : '<p class="muted" style="margin-top:12px;">하이라이트로 볼 만한 구간이 없습니다.</p>';
          box.innerHTML = '<div class="stat-row">' + stats + '</div><svg class="spark" viewBox="0 0 100 100" preserveAspectRatio="none">' + bars + '</svg>' + hl;
        });
    }

    function heroState(s) {
      if (!s.connected) return { dot: 'gray', title: '치지직 계정 연결이 필요합니다', sub: '아래 “치지직 연결”을 열어 연결해 주세요.' };
      if (s.mode === 'idle') return { dot: 'gray', title: '대기 중', sub: '수집을 켜두면 방송이 시작될 때 채팅이 저장됩니다.' };
      var saved = s.chatCount.toLocaleString('ko-KR') + '줄 저장됨';
      if (s.mode === 'paused') return { dot: 'yellow', title: '일시정지', sub: saved + ' · 재개하면 같은 파일에 이어서 저장합니다.' };
      if (!s.lastReceivedAt) return { dot: 'pulse', title: '수집 중 — 채팅 대기', sub: '방송이 시작되면 채팅이 저장됩니다.' };
      var quiet = Math.floor((Date.now() - new Date(s.lastReceivedAt).getTime()) / 1000);
      var tail = saved + ' · 마지막 수신 ' + timeAgo(s.lastReceivedAt);
      return quiet < 120
        ? { dot: 'pulse', title: '방송 채팅 수신 중', sub: tail }
        : { dot: 'pulse', title: '수집 중 — 채팅 없음', sub: tail };
    }

    function timeAgo(iso) {
      var sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
      if (sec < 60) return sec + '초 전';
      if (sec < 3600) return Math.floor(sec / 60) + '분 전';
      return Math.floor(sec / 3600) + '시간 전';
    }

    function poll() {
      fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
        var hero = heroState(s);
        document.getElementById('hero-dot').className = 'dot ' + hero.dot;
        document.getElementById('hero-title').textContent = hero.title;
        document.getElementById('hero-sub').textContent = hero.sub;

        document.getElementById('chat-hint').textContent = s.chatCount ? s.chatCount.toLocaleString('ko-KR') + '줄' : '';
        var list = document.getElementById('chat-list');
        if (list) {
          list.innerHTML = s.recentChats.length
            ? s.recentChats.map(function (c) {
                return '<li><time>' + fmtClock(c.time) + '</time><b>' + esc(c.nickname) + '</b><span>' + esc(c.content) + '</span></li>';
              }).join('')
            : '<li><span class="muted">아직 수집된 채팅이 없습니다.</span></li>';
        }

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

// 지금 무슨 일이 벌어지고 있는지 한 줄로. 채팅이 들어오면 방송 중인 것이 확실하지만,
// 조용하다고 방송이 끝난 것은 아니다(치지직 API로는 방송 여부를 알 수 없음).
function heroState(s) {
  if (!s.connected) return { dot: 'gray', title: '치지직 계정 연결이 필요합니다', sub: '아래 “치지직 연결”을 열어 연결해 주세요.' };
  if (s.mode === 'idle') return { dot: 'gray', title: '대기 중', sub: '수집을 켜두면 방송이 시작될 때 채팅이 저장됩니다.' };
  const saved = `${s.chatCount.toLocaleString('ko-KR')}줄 저장됨`;
  if (s.mode === 'paused') return { dot: 'yellow', title: '일시정지', sub: `${saved} · 재개하면 같은 파일에 이어서 저장합니다.` };
  if (!s.lastReceivedAt) return { dot: 'pulse', title: '수집 중 — 채팅 대기', sub: '방송이 시작되면 채팅이 저장됩니다.' };
  const quietSec = Math.floor((Date.now() - new Date(s.lastReceivedAt).getTime()) / 1000);
  const tail = `${saved} · 마지막 수신 ${fmtTime(s.lastReceivedAt)}`;
  return quietSec < 120
    ? { dot: 'pulse', title: '방송 채팅 수신 중', sub: tail }
    : { dot: 'pulse', title: '수집 중 — 채팅 없음', sub: tail };
}

function renderHighlights(list) {
  if (!list || !list.length) return '<p class="muted" style="margin-top:12px;">하이라이트로 볼 만한 구간이 없습니다.</p>';
  const items = list
    .map((h, i) => `<li style="display:flex;gap:12px;align-items:center;padding:7px 2px;border-bottom:1px solid #1a211e;">
        <span style="width:22px;height:22px;border-radius:6px;flex-shrink:0;background:rgba(0,217,165,.12);color:#57e6c3;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;">${i + 1}</span>
        <span style="min-width:0;">
          <span style="color:#cfe0d8;font-size:13px;">${fmtClock(h.startSec)} ~ ${fmtClock(h.endSec)}</span>
          <span class="muted" style="font-size:12px;margin-left:6px;">${h.durationSec}초 · 분당 ${h.baselinePerMin}→${h.peakPerMin}개</span>
          <br><span class="muted" style="font-size:12.5px;">${h.topMessages.map((m) => `${escapeHtml(m.content)} x${m.count}`).join(' · ')}</span>
        </span>
      </li>`)
    .join('');
  return `<h3 style="font-size:13px;color:#c9d6d0;margin:16px 0 0;">하이라이트 ${list.length}개</h3>
    <ul style="list-style:none;padding:0;margin:8px 0 0;">${items}</ul>`;
}

function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function connectedLabel(savedAt) {
  if (!savedAt) return '한 번 연결하면 앱을 다시 켜도 유지됩니다.';
  const days = Math.floor((Date.now() - new Date(savedAt).getTime()) / 86400000);
  const when = days === 0 ? '오늘' : days === 1 ? '어제' : `${days}일 전`;
  const base = `마지막 연결 ${when}`;
  return days < 14 ? base : `${base}. 수집이 안 되면 다시 연결해 주세요.`;
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
