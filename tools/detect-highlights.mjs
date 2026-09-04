// 수집한 CSV에서 하이라이트를 찾아 출력한다.
// 같은 이름의 *.highlights.json(더미 정답지)이 있으면 채점까지 한다.
// 사용: node tools/detect-highlights.mjs <csv경로> [임계값]
import fs from 'node:fs';
import { detectHighlights, formatTime, loadRowsFromCsv } from '../src/highlight.js';

const csvPath = process.argv[2];
const threshold = Number(process.argv[3] || 3);

if (!csvPath || !fs.existsSync(csvPath)) {
  console.error('사용: node tools/detect-highlights.mjs <csv경로> [임계값]');
  process.exit(1);
}

const rows = loadRowsFromCsv(csvPath);
console.log(`${csvPath}\n채팅 ${rows.length}줄 / ${formatTime(Math.max(...rows.map((r) => r.sec)))} 분량 / 임계값 ${threshold}\n`);

const found = detectHighlights(rows, { threshold });

console.log(`하이라이트 ${found.length}개`);
found.forEach((h, i) => {
  console.log(
    `\n${i + 1}. ${formatTime(h.startSec)} ~ ${formatTime(h.endSec)} (${h.durationSec}초)  점수 ${h.score}`
  );
  console.log(`   분당 ${h.baselinePerMin} → ${h.peakPerMin}개, 채팅 ${h.chats}줄, 반응성 ${Math.round(h.reactionRate * 100)}%`);
  console.log(`   반응: ${h.topMessages.map((m) => `"${m.content}" x${m.count}`).join(', ')}`);
});

// 정답지가 있으면 채점
const answerPath = csvPath.replace(/\.csv$/, '.highlights.json');
if (fs.existsSync(answerPath)) {
  const answer = JSON.parse(fs.readFileSync(answerPath, 'utf8')).highlights;
  const overlaps = (a, b) => a.startSec < b.startSec + b.durationSec && b.startSec < a.endSec;

  const hit = found.filter((f) => answer.some((a) => overlaps(f, a)));
  const missed = answer.filter((a) => !found.some((f) => overlaps(f, a)));

  console.log('\n===== 채점 =====');
  console.log(`정답 ${answer.length}개 중 ${answer.length - missed.length}개 찾음 (재현율 ${pct((answer.length - missed.length) / answer.length)})`);
  console.log(`탐지 ${found.length}개 중 ${hit.length}개 정답 (정밀도 ${pct(hit.length / (found.length || 1))})`);
  if (missed.length) {
    console.log('놓친 구간:', missed.map((m) => `${formatTime(m.startSec)}(x${m.intensity})`).join(', '));
  }
  const falseAlarms = found.filter((f) => !answer.some((a) => overlaps(f, a)));
  if (falseAlarms.length) {
    console.log('오탐:', falseAlarms.map((f) => `${formatTime(f.startSec)}(점수 ${f.score})`).join(', '));
  }
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}
