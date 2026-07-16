import { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, Notification } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 포터블 exe는 실행 파일 옆 폴더를, 개발 모드는 프로젝트 루트를 기준으로 동작
// (.env, tokens.json, data/ 가 모두 이 기준의 상대 경로)
const baseDir = process.env.PORTABLE_EXECUTABLE_DIR
  || (app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..'));
process.chdir(baseDir);

// dotenv가 올바른 폴더의 .env를 읽도록 chdir 이후에 로드
const { ChatCollector } = await import('../src/chat-collector.js');
const { createAuthUrl, exchangeCode } = await import('../src/oauth.js');
const { clearTokens, hasTokens, readTokens, writeTokens } = await import('../src/token-store.js');

const SETTINGS_PATH = path.join(baseDir, 'settings.json');
const REASON_TEXT = {
  user: '사용자 종료',
  broadcast_end: '방송 종료 감지',
  connection_lost: '연결 끊김(5분 초과)'
};

let win = null;
let tray = null;
let quitting = false;
let collector = null;
let statusText = '대기 중입니다.';
let lastFiles = null;
let completion = null;
let lastReceivedAt = null;
const recentChats = [];
let stateDirty = false;
let authServer = null;

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function getMode() {
  if (!collector?.running) return 'idle';
  return collector.paused ? 'paused' : 'on';
}

function getState() {
  return {
    connected: hasTokens(),
    mode: getMode(),
    subscribed: Boolean(collector?.subscribed),
    status: statusText,
    lastFiles,
    completion,
    lastReceivedAt: lastReceivedAt ? lastReceivedAt.toISOString() : null,
    recentChats,
    defaultOutputDir: path.resolve('./data')
  };
}

function pushState() {
  stateDirty = false;
  if (win && !win.isDestroyed()) win.webContents.send('state', getState());
}

function setStatus(message) {
  statusText = message;
  pushState();
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
  statusText = `수집이 종료되었습니다 (${REASON_TEXT[reason] || reason}).`;
  updateTrayMenu();
  pushState();

  if (reason !== 'user') {
    const notice = new Notification({
      title: 'CHZZK Clip Scout — 수집 종료',
      body: `${REASON_TEXT[reason] || reason}\n${completion.csvPath}`
    });
    notice.on('click', () => showWindow());
    notice.show();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 800,
    minWidth: 660,
    minHeight: 560,
    backgroundColor: '#0b0f0e',
    icon: path.join(__dirname, 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    handleCloseRequest();
  });
}

async function handleCloseRequest() {
  const settings = loadSettings();
  let action = settings.closeAction;

  if (action !== 'tray' && action !== 'quit') {
    const collecting = getMode() !== 'idle';
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'CHZZK Clip Scout',
      message: '창을 닫으면 어떻게 할까요?',
      detail: collecting
        ? '지금 채팅을 수집하는 중입니다. 백그라운드로 유지하면 수집이 계속되고, 트레이 아이콘에서 다시 열 수 있습니다.'
        : '백그라운드로 유지하면 트레이 아이콘에서 다시 열 수 있습니다.',
      buttons: ['백그라운드로 유지', '완전히 종료', '취소'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '이 선택을 기억하고 다시 묻지 않기',
      noLink: true
    });
    if (result.response === 2) return;
    action = result.response === 0 ? 'tray' : 'quit';
    if (result.checkboxChecked) {
      settings.closeAction = action;
      saveSettings(settings);
    }
  }

  if (action === 'tray') {
    win.hide();
    tray?.displayBalloon({
      title: 'CHZZK Clip Scout',
      content: '백그라운드에서 계속 실행 중입니다. 트레이 아이콘을 더블클릭하면 다시 열립니다.',
      iconType: 'info'
    });
  } else {
    quitApp();
  }
}

function quitApp() {
  quitting = true;
  if (collector?.running) {
    lastFiles = collector.stop();
    finishCollection('user');
  }
  if (authServer) {
    authServer.close();
    authServer = null;
  }
  app.quit();
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('CHZZK Clip Scout');
  tray.on('double-click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const mode = getMode();
  const modeLabel = { idle: '수집 꺼짐', on: '수집 중', paused: '일시정지' }[mode];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `상태: ${modeLabel}`, enabled: false },
    { type: 'separator' },
    { label: '열기', click: showWindow },
    {
      label: '닫기 동작 다시 묻기',
      click: () => {
        const settings = loadSettings();
        delete settings.closeAction;
        saveSettings(settings);
      }
    },
    { type: 'separator' },
    { label: '앱 종료', click: quitApp }
  ]));
  tray.setToolTip(`CHZZK Clip Scout — ${modeLabel}`);
}

// ---------- OAuth ----------

function startAuthCallbackServer(port, expectedState) {
  return new Promise((resolve, reject) => {
    if (authServer) authServer.close();
    authServer = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404); res.end('Not found');
          return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>연결 실패: 값이 올바르지 않습니다. 앱에서 다시 시도해 주세요.</h3>');
          return;
        }
        const tokens = await exchangeCode({ code, state });
        writeTokens(tokens);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<body style="font-family:sans-serif;background:#0b0f0e;color:#eef4f1;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>연결 완료</h2><p>이 창을 닫고 앱으로 돌아가세요.</p></div></body>');
        authServer.close();
        authServer = null;
        setStatus('치지직 계정 연결 완료');
        showWindow();
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h3>연결 실패: ${error.message}</h3>`);
        setStatus(`연결 실패: ${error.message}`);
      }
    });
    authServer.on('error', reject);
    authServer.listen(port, resolve);
  });
}

// ---------- IPC ----------

ipcMain.handle('state:get', () => getState());

ipcMain.handle('auth:start', async () => {
  try {
    const port = Number(process.env.PORT || 3000);
    const redirectUri = process.env.CHZZK_REDIRECT_URI || `http://localhost:${port}/callback`;
    const auth = createAuthUrl(redirectUri);
    await startAuthCallbackServer(port, auth.state);
    await shell.openExternal(auth.url);
    setStatus('브라우저에서 치지직 로그인을 완료해 주세요.');
    return { ok: true };
  } catch (error) {
    const message = error.code === 'EADDRINUSE'
      ? '3000 포트가 사용 중입니다. 웹 버전 앱이 켜져 있다면 먼저 종료해 주세요.'
      : error.message;
    setStatus(`연결 실패: ${message}`);
    return { ok: false, error: message };
  }
});

ipcMain.handle('auth:logout', () => {
  if (getMode() !== 'idle') {
    setStatus('수집 중에는 연결을 끊을 수 없습니다. 먼저 종료해 주세요.');
    return { ok: false };
  }
  clearTokens();
  setStatus('연결 해제 완료');
  return { ok: true };
});

ipcMain.handle('collect:on', async (_event, options) => {
  if (!hasTokens()) return { ok: false, error: '먼저 치지직 계정을 연결해 주세요.' };
  if (getMode() !== 'idle') return { ok: false, error: '이미 수집 중입니다.' };

  const broadcastTitle = options?.fileName || 'broadcast';
  const broadcastStartedAt = options?.startedAt ? `${options.startedAt}:00+09:00` : '';
  const outputDir = options?.outputDir || path.resolve('./data');

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    return { ok: false, error: `저장 경로를 만들 수 없습니다: ${error.message}` };
  }

  lastReceivedAt = null;
  recentChats.length = 0;
  completion = null;

  collector = new ChatCollector({
    tokens: readTokens(),
    onTokens: writeTokens,
    onStatus: (message) => setStatus(message),
    onEnd: (reason) => {
      if (reason !== 'user') finishCollection(reason);
      updateTrayMenu();
    },
    onChat: (chat) => {
      lastReceivedAt = new Date();
      recentChats.unshift({ time: chat.message_time, nickname: chat.nickname, content: chat.content });
      if (recentChats.length > 20) recentChats.pop();
      stateDirty = true;
    }
  });

  try {
    lastFiles = await collector.start({ broadcastTitle, broadcastStartedAt, outputDir });
  } catch (error) {
    collector = null;
    return { ok: false, error: error.message };
  }
  updateTrayMenu();
  pushState();
  return { ok: true, files: lastFiles };
});

ipcMain.handle('collect:pause', () => {
  collector?.pause();
  updateTrayMenu();
  pushState();
  return { ok: true };
});

ipcMain.handle('collect:resume', async () => {
  try {
    await collector?.resume();
  } catch (error) {
    setStatus(`재개 실패: ${error.message}`);
    return { ok: false, error: error.message };
  }
  updateTrayMenu();
  pushState();
  return { ok: true };
});

ipcMain.handle('collect:off', () => {
  if (collector?.running) {
    lastFiles = collector.stop();
    finishCollection('user');
  }
  updateTrayMenu();
  pushState();
  return { ok: true };
});

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '채팅 로그를 저장할 폴더 선택',
    defaultPath: path.resolve('./data'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0] };
});

ipcMain.handle('shell:openPath', async (_event, dir) => {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, error: '폴더를 찾을 수 없습니다.' };
  }
  await shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle('shell:reveal', () => {
  const target = completion?.csvPath || (lastFiles ? path.resolve(lastFiles.csvPath) : '');
  if (target && fs.existsSync(target)) {
    shell.showItemInFolder(target);
  } else {
    shell.openPath(path.resolve('./data'));
  }
  return { ok: true };
});

// ---------- 앱 라이프사이클 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    createWindow();
    createTray();

    // 채팅이 몰릴 때 IPC 폭주를 막기 위한 상태 푸시 스로틀
    setInterval(() => { if (stateDirty) pushState(); }, 500);

    if (process.env.SMOKE_TEST) {
      console.log('SMOKE', JSON.stringify({ ready: true, connected: hasTokens(), baseDir }));
      win.webContents.on('did-finish-load', () => console.log('SMOKE renderer loaded'));
      win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) console.log('SMOKE renderer console:', message);
      });
      setTimeout(async () => {
        try {
          const probe = await win.webContents.executeJavaScript(
            "JSON.stringify({ statusText: document.getElementById('status-text').textContent, modeText: document.getElementById('mode-text').textContent, hasOnBtn: !!document.getElementById('on-btn'), connectArea: document.getElementById('connect-area').textContent.slice(0, 40) })"
          );
          console.log('SMOKE probe', probe);
        } catch (error) {
          console.log('SMOKE probe error', error.message);
        }
        quitting = true;
        app.quit();
      }, 4000);
    }
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 트레이 상주를 위해 자동 종료하지 않음 */ });
}
