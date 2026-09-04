// 방송 없이 수집 한 판을 통째로 돌려본다.
// 치지직 소켓만 가짜로 두고 나머지(파일 생성 → 채팅 기록 → 일시정지/재개 → 종료 → 하이라이트 분석)는
// 실제 코드 그대로 실행한다. 방송을 켜지 않고도 회귀를 잡기 위한 도구.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChatCollector } from '../src/chat-collector.js';
import { analyzeFile, formatTime } from '../src/highlight.js';

const outputDir = process.argv[2] || './test-data/sim';

const CHANNEL_ID = crypto.randomBytes(16).toString('hex');
const CHAT_CHANNEL_ID = 'N2sim1';
const BADGE = (name) => ({ imageUrl: `https://ssl.pstatic.net/static/nng/glive/icon/${name}.png` });
const VIEWERS = ['과출', '고양이집사', '새벽감성', '라면요정', '별헤는밤', '민초단', '토마토', '판다수집가'];
const CALM = ['안녕하세요', 'ㅎㅇ', '오늘 뭐하세요?', '방송 잘보고있어요', 'ㅇㅇ', '그쵸', '오 신박하네', '보통 도파민 터지는곳 은 사운드 가 커지는 경향이 있거든요'];
const HYPE = ['ㅋㅋㅋㅋㅋ', 'ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', '헐', '대박', '클립 ㄱㄱ', '이거 레전드다', '와 소름', '미친', 'ㅗㅜㅑ', '아니 이걸 한다고?'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

function chatEvent(speaker, content, at) {
  return {
    channelId: CHANNEL_ID,
    chatChannelId: CHAT_CHANNEL_ID,
    senderChannelId: crypto.createHash('md5').update(speaker).digest('hex'),
    profile: {
      nickname: speaker,
      verifiedMark: false,
      badges: speaker === '유자주' ? [BADGE('streamer')] : [],
      userRoleCode: speaker === '유자주' ? 'streamer' : 'common_user'
    },
    content,
    emojis: {},
    messageTime: at,
    eventSentAt: new Date(at + 60).toISOString()
  };
}

// 소켓만 가짜로 두고 start()는 실제 코드를 태운다
async function newCollector(label) {
  const logs = [];
  const collector = new ChatCollector({
    tokens: { accessToken: 'sim', refreshToken: '' },
    onStatus: (m) => logs.push(m)
  });
  collector.connect = async () => { collector.subscribed = true; };
  const files = await collector.start({ broadcastTitle: label, outputDir });
  return { collector, files, logs };
}

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

fs.rmSync(outputDir, { recursive: true, force: true });

// ---------- 1. 채팅이 들어오는 정상 수집 ----------
console.log('1. 정상 수집 (조용한 구간 + 폭발 구간)');
const { collector, files, logs } = await newCollector('sim');
const t0 = collector.startedAt.getTime();

for (let sec = 0; sec < 600; sec += 1) {
  const burst = (sec >= 200 && sec < 240) || (sec >= 420 && sec < 470);
  const perSec = burst ? 2 : Math.random() < 0.15 ? 1 : 0;
  for (let i = 0; i < perSec; i += 1) {
    const speaker = Math.random() < 0.15 ? '유자주' : pick(VIEWERS);
    collector.writeChat(chatEvent(speaker, burst ? pick(HYPE) : pick(CALM), t0 + sec * 1000 + i * 400));
  }
  if (sec === 300) collector.logGapMarker('pause');
  if (sec === 310) collector.logGapMarker('resume');
}

check('파일 생성됨', fs.existsSync(files.csvPath) && fs.existsSync(files.jsonlPath));
check('채팅 기록됨', collector.chatCount > 100, `${collector.chatCount}줄`);

const stopped = collector.stop();
check('종료 후 파일 유지', Boolean(stopped) && fs.existsSync(files.csvPath));

const csv = fs.readFileSync(files.csvPath, 'utf8').trim().split('\n');
const header = csv[0].split(',');
check('CSV 헤더 최신', header.includes('chat_channel_id') && header.includes('badges') && !header.includes('badge_count'), header.length + '개 컬럼');
check('줄 수 일치', csv.length - 1 === collector.chatCount, `CSV ${csv.length - 1} / 카운터 ${collector.chatCount}`);

const sample = csv[1].split(',');
check('elapsed_seconds 채워짐', sample[2] !== '' && Number.isFinite(Number(sample[2])), `첫 줄 ${sample[2]}초`);
check('user_role 채워짐', ['streamer', 'common_user'].includes(sample[7]), sample[7]);

const jsonl = fs.readFileSync(files.jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('JSONL 마커 기록됨', jsonl.filter((r) => r.type).length === 2, jsonl.filter((r) => r.type).map((r) => r.type).join(', '));
check('발화자 ID 해시 저장', jsonl.find((r) => r.senderChannelId)?.senderChannelId.length === 16);

// ---------- 2. 하이라이트 분석 ----------
console.log('\n2. 하이라이트 분석');
const highlights = analyzeFile(files.csvPath);
check('하이라이트 감지됨', highlights.length > 0, `${highlights.length}개`);
for (const h of highlights) {
  console.log(`     ${formatTime(h.startSec)} ~ ${formatTime(h.endSec)} 분당 ${h.baselinePerMin}→${h.peakPerMin} | ${h.topMessages.map((m) => `${m.content} x${m.count}`).join(', ')}`);
}
const hit = highlights.filter((h) => (h.startSec < 240 && h.endSec > 200) || (h.startSec < 470 && h.endSec > 420));
check('심어둔 구간을 찾음', hit.length === highlights.length && hit.length >= 1, `${hit.length}/${highlights.length}`);

// ---------- 3. 채팅 0줄이면 빈 파일을 남기지 않는다 ----------
console.log('\n3. 채팅 0줄 수집');
const empty = await newCollector('empty');
empty.collector.stop();
check('빈 파일 삭제됨', !fs.existsSync(empty.files.csvPath) && !fs.existsSync(empty.files.jsonlPath));
check('안내 문구 출력', empty.logs.some((m) => m.includes('빈 파일은 저장하지 않았습니다')));

// ---------- 4. 시작 실패 시 뒷정리 ----------
console.log('\n4. 시작 실패');
const failed = new ChatCollector({ tokens: { accessToken: 'x', refreshToken: '' }, onStatus: () => {} });
failed.connect = async () => { throw new Error('GET /open/v1/sessions/auth failed: 401 INVALID_TOKEN'); };
let threw = false;
try {
  await failed.start({ broadcastTitle: 'fail', outputDir });
} catch {
  threw = true;
}
check('에러가 호출자에게 전달됨', threw);
check('빈 파일 남지 않음', !fs.readdirSync(outputDir).some((f) => f.startsWith('fail')));
check('running 해제됨', failed.running === false);

console.log(`\n${process.exitCode ? '실패한 항목이 있습니다' : '전부 통과'} · 출력: ${path.resolve(outputDir)}`);
