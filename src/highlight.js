import fs from 'node:fs';

// 채팅 로그에서 하이라이트 구간을 찾는다.
// 채팅량만 보면 방송 초반 인사나 꾸준한 수다에도 걸리므로
// (1) 채팅 폭증 (2) 반응성 표현 비율 (3) 참여자 수 급증 을 함께 본다.

const WINDOW_SEC = 15; // 판정 단위
const BASELINE_SEC = 600; // 평상시 기준을 잡는 범위 (앞뒤 10분)
const MERGE_GAP_SEC = 20; // 이만큼 떨어진 구간은 하나로 합침
const MIN_DURATION_SEC = 10;
const LEAD_IN_SEC = 20; // 클립 시작을 조금 앞당겨 맥락을 담는다
const LEAD_OUT_SEC = 5;

// 놀람·웃음·클립 요청 같은 "터졌을 때" 나오는 표현
const REACTION = /ㅋ{3,}|ㅠ{3,}|ㅎ{3,}|클립|헐|대박|미친|레전드|소름|지렸|박제|실화|개웃|와+아+|ㅗㅜㅑ|[?!]{2,}|뭐야|뭐임/;

export function detectHighlights(rows, options = {}) {
  const {
    threshold = 3, // 평상시 대비 몇 배부터 하이라이트로 볼지
    // 채팅이 적은 방송에서는 몇 줄만 몰려도 배수가 튄다. 절대량 하한을 함께 둔다.
    minChats = 10,
    topN = 10
  } = options;

  if (!rows.length) return [];

  const endSec = Math.max(...rows.map((r) => r.sec));
  const perSec = new Array(endSec + 1).fill(0);
  const reactionPerSec = new Array(endSec + 1).fill(0);
  const chattersPerSec = Array.from({ length: endSec + 1 }, () => new Set());

  for (const row of rows) {
    perSec[row.sec] += 1;
    if (REACTION.test(row.content)) reactionPerSec[row.sec] += 1;
    chattersPerSec[row.sec].add(row.sender);
  }

  // 창 단위 집계
  const windows = [];
  for (let start = 0; start + WINDOW_SEC <= endSec + 1; start += WINDOW_SEC) {
    let count = 0;
    let reactions = 0;
    const chatters = new Set();
    for (let s = start; s < start + WINDOW_SEC; s += 1) {
      count += perSec[s];
      reactions += reactionPerSec[s];
      for (const id of chattersPerSec[s]) chatters.add(id);
    }
    windows.push({ start, count, reactions, chatters: chatters.size });
  }

  // 평상시 기준선: 앞뒤 10분의 중앙값 (방송 중 시청자 증감을 따라간다)
  const half = Math.floor(BASELINE_SEC / WINDOW_SEC / 2);
  const scored = windows.map((win, i) => {
    const near = windows.slice(Math.max(0, i - half), i + half + 1).map((w) => w.count);
    const baseline = median(near) || 1;
    const baseChatters = median(
      windows.slice(Math.max(0, i - half), i + half + 1).map((w) => w.chatters)
    ) || 1;

    const volumeRatio = win.count / baseline;
    const chatterRatio = win.chatters / baseChatters;
    const reactionRate = win.count ? win.reactions / win.count : 0;

    // 반응성 표현이 많고 참여자도 함께 늘면 가산점
    const score = volumeRatio * (1 + reactionRate) * (0.7 + 0.3 * chatterRatio);
    return { ...win, baseline, volumeRatio, chatterRatio, reactionRate, score };
  });

  // 임계값을 넘는 창을 이어붙인다
  const segments = [];
  let current = null;
  for (const win of scored) {
    if (win.score >= threshold && win.count >= minChats) {
      if (current && win.start - (current.end + WINDOW_SEC) <= MERGE_GAP_SEC) {
        current.end = win.start;
        current.windows.push(win);
      } else {
        if (current) segments.push(current);
        current = { start: win.start, end: win.start, windows: [win] };
      }
    }
  }
  if (current) segments.push(current);

  return segments
    .map((seg) => {
      const endOfSeg = seg.end + WINDOW_SEC;
      const peak = seg.windows.reduce((a, b) => (b.score > a.score ? b : a));
      const inRange = rows.filter((r) => r.sec >= seg.start && r.sec < endOfSeg);
      return {
        startSec: Math.max(0, seg.start - LEAD_IN_SEC),
        endSec: endOfSeg + LEAD_OUT_SEC,
        peakSec: peak.start,
        durationSec: endOfSeg + LEAD_OUT_SEC - Math.max(0, seg.start - LEAD_IN_SEC),
        score: Number(peak.score.toFixed(2)),
        chats: inRange.length,
        peakPerMin: Math.round((peak.count / WINDOW_SEC) * 60),
        baselinePerMin: Math.round((peak.baseline / WINDOW_SEC) * 60),
        reactionRate: Number(peak.reactionRate.toFixed(2)),
        topMessages: topMessages(inRange)
      };
    })
    .filter((seg) => seg.durationSec >= MIN_DURATION_SEC)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

// 구간에서 가장 많이 반복된 반응 (무슨 일이 있었는지 요약용)
function topMessages(rows, limit = 3) {
  const counter = new Map();
  for (const row of rows) {
    const key = row.content.replace(/\s+/g, ' ').trim();
    if (!key) continue;
    counter.set(key, (counter.get(key) || 0) + 1);
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([content, count]) => ({ content, count }));
}

function median(list) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 수집이 끝난 파일을 분석한다. 앱에서 쓰므로 어떤 이유로도 던지지 않는다.
export function analyzeFile(csvPath, options = {}) {
  try {
    if (!csvPath || !fs.existsSync(csvPath)) return [];
    return detectHighlights(loadRowsFromCsv(csvPath), { topN: 5, ...options });
  } catch {
    return [];
  }
}

export function loadRowsFromCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const header = parseCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);
  const out = [];
  let firstTime = null;

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    const time = new Date(cols[idx('message_time')]).getTime();
    if (firstTime === null) firstTime = time;
    // elapsed_seconds가 비어 있으면(방송 시작 시각 미입력) 첫 채팅 기준으로 계산
    const elapsed = cols[idx('elapsed_seconds')];
    out.push({
      sec: elapsed === '' ? Math.floor((time - firstTime) / 1000) : Number(elapsed),
      sender: cols[idx('sender_channel_id')],
      nickname: cols[idx('nickname')],
      content: cols[idx('content')]
    });
  }
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        value += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(value);
      value = '';
    } else {
      value += ch;
    }
  }
  out.push(value);
  return out;
}
