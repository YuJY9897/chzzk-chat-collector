// 실제 수집기와 똑같은 포맷의 더미 로그를 만든다.
// 포맷이 어긋나지 않도록 CSV/JSONL 쓰기는 ChatCollector.writeChat을 그대로 재사용한다.
// 사용: node tools/make-dummy-log.mjs [출력폴더] [동시시청자] [방송길이(분)]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChatCollector } from '../src/chat-collector.js';

const outputDir = process.argv[2] || './test-data';
const viewers = Number(process.argv[3] || 300); // 평균 동시시청자
const durationMin = Number(process.argv[4] || 180);

// 규모 가정: 분당 채팅 ≈ 동시시청자의 20%, 방송 중 한 번이라도 채팅하는 사람 ≈ 동시시청자의 1.1배
const baseChatPerMin = viewers * 0.2;
const chatterCount = Math.round(viewers * 1.1);

const CHANNEL_ID = crypto.randomBytes(16).toString('hex');
const CHAT_CHANNEL_ID = crypto.randomBytes(4).toString('base64url').slice(0, 6);
const BADGE = (name) => ({ imageUrl: `https://ssl.pstatic.net/static/nng/glive/icon/${name}.png` });

const HEAD = ['고양이', '새벽', '치킨', '눈사람', '라면', '무지개', '별', '커피', '떡볶이', '햄스터',
  '초코', '단호박', '숲속', '파란', '노랑', '토마토', '민초', '겜', '집사', '월요병',
  '주말', '야근', '퇴근', '출근', '방구석', '이불속', '심야', '한밤중', '아침형', '올빼미',
  '구름', '바람', '나무늘보', '판다', '북극곰', '펭귄', '수달', '너구리', '다람쥐', '고슴도치'];
const TAIL = ['집사', '요정', '러버', '중독', '장인', '초보', '고인물', '평론가', '헌터', '수집가',
  '기사단', '연구원', '탐험가', '수호자', '방랑자', '감성', '충', '단', '봇', '님'];

const SMALL_TALK = [
  'ㅋㅋㅋ', 'ㅋㅋㅋㅋㅋㅋ', 'ㅇㅇ', 'ㄴㄴ', '안녕하세요', 'ㅎㅇ', '오늘도 화이팅', '방송 잘보고있어요',
  '오 신박하네', '그거 맞음', '아 진짜?', '음성 잘 들려요', '화질 좋다', '오늘 뭐하실 거예요?',
  '방금 뭐라고 하셨어요', '아까 그거 다시 해주세요', '배고파요', '저녁 뭐 드셨어요',
  '오늘 목소리 좋으시네', '컨디션 좋아보인다', 'ㄱㄱ', '가보자고', '이거 어렵나요?', '님 실력 늘었다',
  '아 아까워', '어어어', '조심해요', '뒤에 뒤에', '체력 관리하세요', '물 좀 드세요',
  '처음 왔는데 재밌네요', '오늘 몇시까지 하세요?', '지각했다', '이제 왔어요', '다시 왔습니다',
  'ㅇㅋ', '굿굿', '오케이', '그쵸', '맞말', '인정', '아 그렇구나', '알겠습니다'
];

const HYPE = [
  'ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', 'ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', '헐', '헐랭', '미친', '대박', '와 진짜?',
  '클립 ㄱㄱ', '클립!!!', '이거 클립각', '지금 그거 다시', '아니 이걸 한다고?', '개웃겨',
  'ㅠㅠㅠㅠㅠ', '아 배아파 ㅋㅋㅋ', '레전드', '이거 레전드다', '박제각', '와 소름',
  '지렸다', '뭐야뭐야', '방금 뭐임', 'ㅗㅜㅑ', '어어어어', '와아아아', '؟؟؟', '?????',
  '실화냐', '이걸 성공하네', '갓유자주', '와 미쳤다'
];

const EMOJI_KEYS = ['d_1', 'd_15', 'd_23', 'chzzk_01', 'chzzk_07'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function makeNickname(i) {
  const name = `${pick(HEAD)}${pick(TAIL)}`;
  return i % 4 === 0 ? `${name}${randInt(1, 99)}` : name;
}

// 시청자 풀. 발화량은 멱함수(Zipf) 분포 — 소수의 헤비 채터가 대부분을 차지하고
// 다수는 방송 내내 몇 줄만 친다.
const chatters = Array.from({ length: chatterCount }, (_, i) => {
  const rank = i + 1;
  // Zipf-Mandelbrot: 순위에 10을 더해 1등이 혼자 도배하는 것을 막는다
  const weight = 1 / Math.pow(rank + 10, 0.95);
  const isSubscriber = Math.random() < 0.25;
  const badges = isSubscriber ? [BADGE('subscription')] : [];
  return {
    nickname: makeNickname(i),
    senderChannelId: crypto.randomBytes(16).toString('hex'),
    role: 'common_user',
    badges,
    weight,
    // 하위 60%는 평소엔 거의 눈팅, 하이라이트 때만 튀어나오는 부류
    lurker: rank > chatterCount * 0.4
  };
});
// 매니저 2명은 상위권에 섞는다
for (const rank of [3, 11]) {
  if (chatters[rank]) {
    chatters[rank].role = 'manager';
    chatters[rank].badges = [BADGE('manager'), ...chatters[rank].badges];
    chatters[rank].lurker = false;
  }
}
const streamer = {
  nickname: '유자주',
  senderChannelId: crypto.randomBytes(16).toString('hex'),
  role: 'streamer',
  badges: [BADGE('streamer')]
};

// 가중치 누적표 (평소용 / 하이라이트용)
function cumulative(list, weightOf) {
  const out = [];
  let sum = 0;
  for (const item of list) {
    sum += weightOf(item);
    out.push(sum);
  }
  return { out, sum };
}
const calm = cumulative(chatters, (c) => (c.lurker ? c.weight * 0.15 : c.weight));
const loud = cumulative(chatters, (c) => (c.lurker ? c.weight * 1.6 : c.weight));

function pickChatter(table) {
  const target = Math.random() * table.sum;
  let lo = 0;
  let hi = table.out.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table.out[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return chatters[lo];
}

// 하이라이트 구간 5개: 방송 전체에 흩어놓고 정답지로 따로 저장한다
const highlights = [];
const slot = durationMin / 5;
for (let i = 0; i < 5; i += 1) {
  const startMin = i * slot + randInt(3, Math.floor(slot) - 3);
  highlights.push({
    index: i + 1,
    startSec: Math.floor(startMin * 60),
    durationSec: randInt(30, 90),
    intensity: randInt(6, 14) // 평소 대비 몇 배로 몰리는지
  });
}
const inHighlight = (sec) =>
  highlights.find((h) => sec >= h.startSec && sec < h.startSec + h.durationSec);

const startedAt = new Date();
startedAt.setHours(20, 0, 0, 0);

fs.mkdirSync(outputDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const files = {
  csvPath: path.join(outputDir, `dummy_${stamp}.csv`),
  jsonlPath: path.join(outputDir, `dummy_${stamp}.jsonl`)
};
fs.writeFileSync(
  files.csvPath,
  'received_at,message_time,elapsed_seconds,channel_id,chat_channel_id,sender_channel_id,nickname,user_role,verified,content,emoji_keys,badges\n',
  'utf8'
);
fs.writeFileSync(files.jsonlPath, '', 'utf8');

// writeChat만 빌려 쓴다 (소켓/토큰 없이)
const writer = Object.create(ChatCollector.prototype);
writer.files = files;
writer.startedAt = startedAt;
writer.chatCount = 0;
writer.onChat = () => {};

const totalSec = durationMin * 60;
for (let sec = 0; sec < totalSec; sec += 1) {
  const burst = inHighlight(sec);
  // 평소에도 시청자가 들고 나므로 분당 채팅이 ±30% 흔들리게 둔다
  const drift = 1 + 0.3 * Math.sin(sec / 900) + (Math.random() - 0.5) * 0.2;
  const rate = (baseChatPerMin / 60) * drift * (burst ? burst.intensity : 1);
  let count = Math.floor(rate);
  if (Math.random() < rate - count) count += 1;

  for (let i = 0; i < count; i += 1) {
    const speaker = Math.random() < 0.02 ? streamer : pickChatter(burst ? loud : calm);
    const emojis = {};
    let content = burst ? pick(HYPE) : pick(SMALL_TALK);
    if (Math.random() < 0.08) {
      const key = pick(EMOJI_KEYS);
      emojis[key] = `https://ssl.pstatic.net/static/nng/glive/emoji/${key}.png`;
      content = `${content} {:${key}:}`;
    }
    const messageTime = startedAt.getTime() + sec * 1000 + randInt(0, 999);
    writer.writeChat({
      channelId: CHANNEL_ID,
      chatChannelId: CHAT_CHANNEL_ID,
      senderChannelId: speaker.senderChannelId,
      profile: {
        nickname: speaker.nickname,
        verifiedMark: false,
        badges: speaker.badges,
        userRoleCode: speaker.role
      },
      content,
      emojis,
      messageTime,
      eventSentAt: new Date(messageTime + 60).toISOString()
    });
  }
}

// writeChat은 received_at에 "지금"을 찍는다. 더미는 방송 시각을 따라가야 하므로
// 메시지 시각 + 0~200ms(수신 지연)로 다시 쓴다.
const delay = () => randInt(0, 200);
fs.writeFileSync(
  files.csvPath,
  fs.readFileSync(files.csvPath, 'utf8').split('\n').map((line, i) => {
    if (i === 0 || !line) return line;
    const cols = line.split(',');
    cols[0] = new Date(new Date(cols[1]).getTime() + delay()).toISOString();
    return cols.join(',');
  }).join('\n'),
  'utf8'
);
fs.writeFileSync(
  files.jsonlPath,
  `${fs.readFileSync(files.jsonlPath, 'utf8').trim().split('\n').map((line) => {
    const row = JSON.parse(line);
    row.receivedAt = new Date(row.messageTime + delay()).toISOString();
    return JSON.stringify(row);
  }).join('\n')}\n`,
  'utf8'
);

// 하이라이트 정답지 (감지 알고리즘 채점용)
const answerPath = path.join(outputDir, `dummy_${stamp}.highlights.json`);
fs.writeFileSync(
  answerPath,
  `${JSON.stringify(
    { startedAt: startedAt.toISOString(), durationMin, viewers, totalChats: writer.chatCount, highlights },
    null,
    2
  )}\n`,
  'utf8'
);

console.log(`생성 완료: ${writer.chatCount}줄 / ${durationMin}분 / 동시시청자 ${viewers}명 가정`);
console.log(files.csvPath);
console.log(files.jsonlPath);
console.log(answerPath);
