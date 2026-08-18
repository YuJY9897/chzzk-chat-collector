// 실제 수집기와 똑같은 포맷의 더미 로그를 만든다.
// 포맷이 어긋나지 않도록 CSV/JSONL 쓰기는 ChatCollector.writeChat을 그대로 재사용한다.
// 사용: node tools/make-dummy-log.mjs [출력폴더] [분량(줄)] [방송길이(분)]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChatCollector } from '../src/chat-collector.js';

const outputDir = process.argv[2] || './test-data';
const targetLines = Number(process.argv[3] || 4000);
const durationMin = Number(process.argv[4] || 180);

const CHANNEL_ID = crypto.randomBytes(16).toString('hex');
const CHAT_CHANNEL_ID = crypto.randomBytes(4).toString('base64url').slice(0, 6);
const BADGE = (name) => ({ imageUrl: `https://ssl.pstatic.net/static/nng/glive/icon/${name}.png` });

const NICKNAMES = [
  '유자주팬1호', '고양이집사', '새벽감성', '치킨먹고싶다', '오늘도출석', '눈사람', '방구석평론가',
  '라면요정', '무지개곰', '별헤는밤', '커피중독', '잠은사치', '떡볶이러버', '구독자A', '지나가던행인',
  '햄스터', '초코송이', '밤샘각', '월요병환자', '단호박', '숲속의곰', '파란하늘', '노랑주전자',
  '토마토', '민초단', '반민초단', '겜창', '롤창', '옵치충', '집사요정'
];

const SMALL_TALK = [
  'ㅋㅋㅋ', 'ㅋㅋㅋㅋㅋㅋ', 'ㅇㅇ', 'ㄴㄴ', '안녕하세요', 'ㅎㅇ', '오늘도 화이팅', '방송 잘보고있어요',
  '오 신박하네', '그거 맞음', '아 진짜?', '음성 잘 들려요', '화질 좋다', '오늘 뭐하실 거예요?',
  '방금 뭐라고 하셨어요', '아까 그거 다시 해주세요', '배고파요', '저녁 뭐 드셨어요',
  '오늘 목소리 좋으시네', '컨디션 좋아보인다', 'ㄱㄱ', '가보자고', '이거 어렵나요?', '님 실력 늘었다',
  '아 아까워', '어어어', '조심해요', '뒤에 뒤에', '체력 관리하세요', '물 좀 드세요'
];

const HYPE = [
  'ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', 'ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', '헐', '헐랭', '미친', '대박', '와 진짜?',
  '클립 ㄱㄱ', '클립!!!', '이거 클립각', '지금 그거 다시', '아니 이걸 한다고?', '개웃겨',
  'ㅠㅠㅠㅠㅠ', '아 배아파 ㅋㅋㅋ', '레전드', '이거 레전드다', '박제각', '와 소름',
  '지렸다', '뭐야뭐야', '방금 뭐임', 'ㅗㅜㅑ', '어어어어', '와아아아'
];

const EMOJI_KEYS = ['d_1', 'd_15', 'd_23', 'chzzk_01', 'chzzk_07'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// 시청자 풀: 닉네임 + 고정 채널 ID + 역할/뱃지
const viewers = NICKNAMES.map((nickname, i) => {
  const role = i === 0 ? 'manager' : 'common_user';
  const badges = [];
  if (role === 'manager') badges.push(BADGE('manager'));
  if (i % 3 === 0) badges.push(BADGE('subscription'));
  return { nickname, senderChannelId: crypto.randomBytes(16).toString('hex'), role, badges };
});
const streamer = {
  nickname: '유자주',
  senderChannelId: crypto.randomBytes(16).toString('hex'),
  role: 'streamer',
  badges: [BADGE('streamer')]
};

// 하이라이트 구간 5개: 방송 전체에 흩어놓고 정답지로 따로 저장한다
const highlights = [];
const slot = durationMin / 5;
for (let i = 0; i < 5; i += 1) {
  const startMin = i * slot + randInt(3, Math.floor(slot) - 3);
  highlights.push({
    index: i + 1,
    startSec: Math.floor(startMin * 60),
    durationSec: randInt(30, 90),
    intensity: randInt(8, 20) // 평소 대비 몇 배로 몰리는지
  });
}
const inHighlight = (sec) =>
  highlights.find((h) => sec >= h.startSec && sec < h.startSec + h.durationSec);

// 초당 채팅 수를 만들어 목표 줄 수에 맞춘다
const totalSec = durationMin * 60;
const highlightSec = highlights.reduce((sum, h) => sum + h.durationSec * h.intensity, 0);
const basePerSec = targetLines / (totalSec + highlightSec);

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

for (let sec = 0; sec < totalSec; sec += 1) {
  const burst = inHighlight(sec);
  const rate = basePerSec * (burst ? burst.intensity : 1);
  let count = Math.floor(rate);
  if (Math.random() < rate - count) count += 1;

  for (let i = 0; i < count; i += 1) {
    const speaker = Math.random() < 0.03 ? streamer : pick(viewers);
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
  `${JSON.stringify({ startedAt: startedAt.toISOString(), durationMin, totalChats: writer.chatCount, highlights }, null, 2)}\n`,
  'utf8'
);

console.log(`생성 완료: ${writer.chatCount}줄 / ${durationMin}분`);
console.log(files.csvPath);
console.log(files.jsonlPath);
console.log(answerPath);
