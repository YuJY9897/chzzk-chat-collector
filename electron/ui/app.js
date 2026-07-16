let state = null;
let modalShownFor = '';

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

function todayFileName() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

const REASON_TEXT = {
  user: '사용자 종료',
  broadcast_end: '방송 종료가 감지되어 자동으로 저장을 마쳤습니다.',
  connection_lost: '연결이 5분 이상 끊겨 수집을 종료했습니다.'
};

function render(next) {
  const prevMode = state?.mode;
  state = next;
  const { mode } = state;

  // 상단 배지
  const badge = $('mode-badge');
  const dot = badge.querySelector('.dot');
  badge.className = 'badge' + (mode === 'on' ? ' live' : mode === 'paused' ? ' paused' : '');
  dot.className = 'dot ' + (mode === 'on' ? 'pulse' : mode === 'paused' ? 'yellow' : 'gray');
  $('mode-text').textContent = { idle: '꺼짐', on: '수집 중', paused: '일시정지' }[mode];

  $('status-text').textContent = state.status;

  // 연결 영역
  if (state.connected) {
    $('connect-area').innerHTML = `
      <div class="row">
        <button class="ghost" disabled>✓ 치지직 계정이 연결되어 있습니다</button>
        <button class="ghost small" id="logout-btn" ${mode === 'idle' ? '' : 'disabled'}>연결 끊기</button>
      </div>
      <p class="muted">한 번 연결하면 앱을 다시 켜도 유지됩니다.</p>`;
    $('logout-btn')?.addEventListener('click', async () => { await window.api.logout(); refresh(); });
  } else {
    $('connect-area').innerHTML = `
      <div class="row"><button class="primary" id="auth-btn">치지직 계정 연결하기</button></div>
      <p class="muted">브라우저가 열리면 치지직에 로그인하고 권한에 동의해 주세요. 처음 한 번만 하면 됩니다.</p>`;
    $('auth-btn')?.addEventListener('click', async () => { await window.api.startAuth(); refresh(); });
  }

  // 수집 영역: 모드가 바뀔 때만 다시 그려서 입력값 유지
  if (prevMode !== mode) renderCollectArea(mode);

  // 결과 카드
  if (state.completion) {
    $('result-card').classList.remove('hidden');
    $('result-meta').textContent = `${state.completion.reason === 'user' ? '사용자 종료' : (REASON_TEXT[state.completion.reason] || state.completion.reason)} · ${fmtTime(state.completion.finishedAt)}`;
    $('result-csv').textContent = state.completion.csvPath;
    $('result-jsonl').textContent = state.completion.jsonlPath;
  } else {
    $('result-card').classList.add('hidden');
  }

  // 종료 모달 (자동 종료일 때만)
  if (state.completion && state.completion.reason !== 'user' && modalShownFor !== state.completion.finishedAt) {
    modalShownFor = state.completion.finishedAt;
    $('modal-reason').textContent = REASON_TEXT[state.completion.reason] || state.completion.reason;
    $('modal-csv').textContent = state.completion.csvPath;
    $('modal-jsonl').textContent = state.completion.jsonlPath;
    $('end-modal').classList.remove('hidden');
  }

  // 실시간 채팅
  if (mode !== 'idle') {
    $('last-received').textContent = state.lastReceivedAt
      ? `마지막 수신 ${timeAgo(state.lastReceivedAt)}`
      : '방송이 켜지면 자동으로 수집을 시작합니다';
  } else {
    $('last-received').textContent = '';
  }
  const list = $('chat-list');
  if (state.recentChats.length) {
    list.innerHTML = state.recentChats
      .map((c) => `<li><time>${fmtTime(c.time)}</time><b>${esc(c.nickname)}</b><span>${esc(c.content)}</span></li>`)
      .join('');
  } else {
    list.innerHTML = '<li><span class="muted">아직 수집된 채팅이 없습니다.</span></li>';
  }
}

function renderCollectArea(mode) {
  const area = $('collect-area');
  if (mode === 'idle') {
    area.innerHTML = `
      <label>저장할 파일 이름</label>
      <input id="file-name" value="${todayFileName()}">
      <label>저장 위치</label>
      <div class="path-row">
        <input id="output-dir" readonly value="${esc(state.defaultOutputDir)}">
        <button class="ghost" id="pick-btn" type="button">폴더 선택</button>
        <button class="ghost" id="open-dir-btn" type="button">열기</button>
      </div>
      <details>
        <summary>고급 설정</summary>
        <label>다시보기 기준 시작 시간 (선택)</label>
        <input id="started-at" type="datetime-local">
        <p class="muted">방송 시작 시각을 넣으면 각 채팅이 방송 몇 분 몇 초에 나왔는지도 함께 저장됩니다.</p>
      </details>
      <div class="row mt16">
        <button class="primary big" id="on-btn" ${state.connected ? '' : 'disabled'}>로그 수집 ON</button>
      </div>
      <p class="muted">방송 전에 켜두면 방송이 시작될 때 자동으로 수집을 시작합니다. 이미 방송 중이면 바로 시작합니다.</p>`;

    $('pick-btn').addEventListener('click', async () => {
      const result = await window.api.pickFolder();
      if (result.path) $('output-dir').value = result.path;
    });
    $('open-dir-btn').addEventListener('click', () => window.api.openPath($('output-dir').value));
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
        <button class="danger" id="off-btn">■ 종료</button>
      </div>
      <p class="muted">일시정지 후 재개하면 같은 파일에 이어서 저장됩니다. 종료하면 파일이 완성됩니다.</p>
      ${state.lastFiles ? `<div class="filebox"><div class="filebox-title">저장 중인 파일</div><code>${esc(state.lastFiles.csvPath)}</code></div>` : ''}`;

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
  if (state?.lastReceivedAt && state.mode !== 'idle') {
    $('last-received').textContent = `마지막 수신 ${timeAgo(state.lastReceivedAt)}`;
  }
}, 5000);
