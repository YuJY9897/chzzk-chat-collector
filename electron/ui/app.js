let state = null;
let modalShownFor = '';
let settingsReady = false;

const $ = (id) => document.getElementById(id);

function esc(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false });
  } catch {
    return iso;
  }
}

function timeAgo(iso) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  return `${Math.floor(sec / 3600)}시간 전`;
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function todayFileName() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

const REASON_TEXT = {
  user: '사용자 종료',
  broadcast_end: '방송 종료가 감지되어 자동으로 저장을 마쳤습니다.',
  connection_lost: '연결이 5분 이상 끊겨 수집을 종료했습니다.',
  auth_expired: '치지직 연결이 만료되었습니다. 계정을 다시 연결해 주세요.'
};

function connectedLabel(savedAt) {
  if (!savedAt) return '한 번 연결하면 앱을 다시 켜도 유지됩니다.';
  const days = Math.floor((Date.now() - new Date(savedAt).getTime()) / 86400000);
  const when = days === 0 ? '오늘' : days === 1 ? '어제' : `${days}일 전`;
  const base = `마지막 연결 ${when}`;
  return days < 14 ? base : `${base}. 수집이 안 되면 다시 연결해 주세요.`;
}

// 지금 무슨 일이 벌어지고 있는지 한 줄로. 채팅이 들어오면 방송 중인 것이 확실하지만,
// 조용하다고 방송이 끝난 것은 아니다(치지직 API로는 방송 여부를 알 수 없음).
function heroState(s) {
  if (!s.connected) {
    return { dot: 'gray', title: '치지직 계정 연결이 필요합니다', sub: '아래 “치지직 연결”을 열어 연결해 주세요.' };
  }
  if (s.mode === 'idle') {
    return { dot: 'gray', title: '대기 중', sub: '수집을 켜두면 방송이 시작될 때 채팅이 저장됩니다.' };
  }
  const saved = `${s.chatCount.toLocaleString('ko-KR')}줄 저장됨`;
  if (s.mode === 'paused') {
    return { dot: 'yellow', title: '일시정지', sub: `${saved} · 재개하면 같은 파일에 이어서 저장합니다.` };
  }
  if (!s.lastReceivedAt) {
    return { dot: 'pulse', title: '수집 중 — 채팅 대기', sub: '방송이 시작되면 채팅이 저장됩니다.' };
  }
  const quietSec = Math.floor((Date.now() - new Date(s.lastReceivedAt).getTime()) / 1000);
  if (quietSec < 120) {
    return { dot: 'pulse', title: '방송 채팅 수신 중', sub: `${saved} · 마지막 수신 ${timeAgo(s.lastReceivedAt)}` };
  }
  return { dot: 'pulse', title: '수집 중 — 채팅 없음', sub: `${saved} · 마지막 수신 ${timeAgo(s.lastReceivedAt)}` };
}

function renderHighlights(list) {
  if (!list || !list.length) return '<p class="muted mt12">하이라이트로 볼 만한 구간이 없습니다.</p>';
  const items = list
    .map((h, i) => `
      <li class="hl">
        <span class="hl-rank">${i + 1}</span>
        <div class="hl-body">
          <div class="hl-time">${fmtDuration(h.startSec)} ~ ${fmtDuration(h.endSec)}
            <span class="muted">${h.durationSec}초 · 분당 ${h.baselinePerMin}→${h.peakPerMin}개</span>
          </div>
          <div class="hl-msg">${h.topMessages.map((m) => `${esc(m.content)} <span class="muted">x${m.count}</span>`).join(' · ')}</div>
        </div>
      </li>`)
    .join('');
  return `<h3 class="hl-title">하이라이트 ${list.length}개</h3><ul class="hl-list">${items}</ul>`;
}

function render(next) {
  const prevMode = state?.mode;
  state = next;
  const { mode } = state;

  // 상단 배지
  const badge = $('mode-badge');
  badge.className = 'badge' + (mode === 'on' ? ' live' : mode === 'paused' ? ' paused' : '');
  badge.querySelector('.dot').className = 'dot ' + (mode === 'on' ? 'pulse' : mode === 'paused' ? 'yellow' : 'gray');
  $('mode-text').textContent = { idle: '꺼짐', on: '수집 중', paused: '일시정지' }[mode];

  // 메인 상태
  const hero = heroState(state);
  $('hero-dot').className = 'dot ' + hero.dot;
  $('hero-title').textContent = hero.title;
  $('hero-sub').textContent = hero.sub;

  if (prevMode !== mode) renderControls(mode);
  renderConnect(mode);
  renderSettings(mode);

  // 결과
  if (state.completion) {
    $('result-card').classList.remove('hidden');
    const reason = state.completion.reason === 'user' ? '사용자 종료' : (REASON_TEXT[state.completion.reason] || state.completion.reason);
    $('result-meta').textContent = `${reason} · ${fmtTime(state.completion.finishedAt)}`;
    $('result-csv').textContent = state.completion.csvPath;
    $('result-jsonl').textContent = state.completion.jsonlPath;
    $('highlight-area').innerHTML = renderHighlights(state.completion.highlights);
    $('result-hint').textContent = `하이라이트 ${(state.completion.highlights || []).length}개`;
  } else {
    $('result-card').classList.add('hidden');
  }

  if (state.completion && state.completion.reason !== 'user' && modalShownFor !== state.completion.finishedAt) {
    modalShownFor = state.completion.finishedAt;
    $('modal-reason').textContent = REASON_TEXT[state.completion.reason] || state.completion.reason;
    $('modal-csv').textContent = state.completion.csvPath;
    $('modal-jsonl').textContent = state.completion.jsonlPath;
    $('end-modal').classList.remove('hidden');
  }

  // 실시간 채팅
  $('chat-hint').textContent = state.chatCount ? `${state.chatCount.toLocaleString('ko-KR')}줄` : '';
  const list = $('chat-list');
  if (state.recentChats.length) {
    list.innerHTML = state.recentChats
      .map((c) => `<li><time>${fmtTime(c.time)}</time><b>${esc(c.nickname)}</b><span>${esc(c.content)}</span></li>`)
      .join('');
  } else {
    list.innerHTML = '<li><span class="muted">아직 수집된 채팅이 없습니다.</span></li>';
  }
}

function renderConnect(mode) {
  $('connect-hint').textContent = state.connected ? '연결됨' : '연결 필요';
  if (state.connected) {
    $('connect-area').innerHTML = `
      <div class="row">
        <button class="ghost" disabled>✓ 치지직 계정이 연결되어 있습니다</button>
        <button class="ghost small" id="logout-btn" ${mode === 'idle' ? '' : 'disabled'}>연결 끊기</button>
      </div>
      <p class="muted">${connectedLabel(state.connectedAt)}</p>`;
    $('logout-btn')?.addEventListener('click', async () => { await window.api.logout(); refresh(); });
  } else {
    $('connect-area').innerHTML = `
      <div class="row"><button class="primary" id="auth-btn">치지직 계정 연결하기</button></div>
      <p class="muted">브라우저가 열리면 치지직에 로그인하고 권한에 동의해 주세요. 처음 한 번만 하면 됩니다.</p>`;
    $('auth-btn')?.addEventListener('click', async () => { await window.api.startAuth(); refresh(); });
    $('fold-connect').open = true;
  }
}

// 입력값이 날아가지 않도록 한 번만 만들고, 이후에는 잠그기만 한다
function renderSettings(mode) {
  if (!settingsReady) {
    $('settings-area').innerHTML = `
      <label>저장할 파일 이름</label>
      <input id="file-name" value="${todayFileName()}">
      <label>저장 위치</label>
      <div class="path-row">
        <input id="output-dir" readonly value="${esc(state.defaultOutputDir)}">
        <button class="ghost" id="pick-btn" type="button">폴더 선택</button>
        <button class="ghost" id="open-dir-btn" type="button">열기</button>
      </div>
      <details class="mt12">
        <summary>다시보기 기준 시작 시간 (선택)</summary>
        <input id="started-at" type="datetime-local">
        <p class="muted">방송 시작 시각을 넣으면 각 채팅이 방송 몇 분 몇 초에 나왔는지도 함께 저장됩니다.</p>
      </details>`;
    $('pick-btn').addEventListener('click', async () => {
      const result = await window.api.pickFolder();
      if (result.path) $('output-dir').value = result.path;
    });
    $('open-dir-btn').addEventListener('click', () => window.api.openPath($('output-dir').value));
    settingsReady = true;
  }
  const locked = mode !== 'idle';
  $('settings-hint').textContent = locked ? '수집 중에는 변경할 수 없습니다' : '';
  for (const id of ['file-name', 'pick-btn', 'open-dir-btn', 'started-at']) {
    const el = $(id);
    if (el) el.disabled = locked;
  }
}

function renderControls(mode) {
  const area = $('control-area');
  if (mode === 'idle') {
    area.innerHTML = `
      <button class="primary big" id="on-btn" ${state.connected ? '' : 'disabled'}>로그 수집 ON</button>
      <p class="warning">지나간 채팅은 저장할 수 없어요. 방송 시작 전에 미리 켜두세요.</p>`;
    $('on-btn').addEventListener('click', async () => {
      const result = await window.api.collectOn({
        fileName: $('file-name').value.trim() || 'broadcast',
        outputDir: $('output-dir').value,
        startedAt: $('started-at').value
      });
      if (!result.ok) alert(result.error);
      refresh();
    });
  } else {
    const pauseOrResume = mode === 'paused'
      ? '<button class="primary" id="resume-btn">▶ 재개</button>'
      : '<button class="ghost" id="pause-btn">❚❚ 일시정지</button>';
    area.innerHTML = `
      <div class="row">
        ${pauseOrResume}
        <button class="danger" id="off-btn">■ 수집 종료</button>
      </div>
      <p class="muted">방송이 끝나면 종료를 눌러주세요. 치지직 API로는 방송 종료를 알 수 없어 자동으로 멈추지 않습니다.</p>`;
    $('pause-btn')?.addEventListener('click', async () => { await window.api.pause(); refresh(); });
    $('resume-btn')?.addEventListener('click', async () => { await window.api.resume(); refresh(); });
    $('off-btn').addEventListener('click', async () => { await window.api.off(); refresh(); });
  }
}

async function refresh() {
  render(await window.api.getState());
}

$('reveal-btn').addEventListener('click', () => window.api.revealFiles());
$('modal-reveal').addEventListener('click', () => window.api.revealFiles());
$('modal-close').addEventListener('click', () => $('end-modal').classList.add('hidden'));

window.api.onState(render);
refresh();

// "N초 전" 표기를 주기적으로 갱신
setInterval(() => {
  if (state && state.mode !== 'idle') {
    const hero = heroState(state);
    $('hero-title').textContent = hero.title;
    $('hero-sub').textContent = hero.sub;
  }
}, 5000);
