// 방송 하나를 "편집자에게 그대로 넘길 수 있는 기록"으로 만든다.
// 매니저가 방송을 보면서 적던 타임라인 메모를 대신하는 것이 목적이라,
// 화면용 점수순이 아니라 시간순으로 정렬하고 파일로 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import { analyzeLogFile, formatTime, intervalStats } from './highlight.js';

export function buildReport(csvPath, options = {}) {
  const { intervalSec = 300, threshold } = options;
  const analysis = analyzeLogFile(csvPath, threshold ? { threshold } : {});
  if (!analysis.ok) return { ok: false, error: analysis.error };

  const intervals = intervalStats(csvPath, intervalSec);
  const name = path.basename(csvPath);
  const stats = analysis.speakerStats;
  const lines = [];

  lines.push(`# 방송 기록 — ${name.replace(/\.csv$/i, '')}`, '');
  lines.push(`- 방송 길이: ${formatTime(analysis.durationSec)}`);
  lines.push(`- 총 채팅: ${analysis.totalChats.toLocaleString('ko-KR')}개 (분당 평균 ${analysis.perMinute}개)`);
  lines.push(`- 발화자: ${stats.total.toLocaleString('ko-KR')}명 (상위 10%가 전체의 ${stats.concentration}%)`);
  lines.push('');

  // 편집점 후보 — 시간순
  const byTime = [...analysis.highlights].sort((a, b) => a.startSec - b.startSec);
  lines.push(`## 편집점 후보 ${byTime.length}개`, '');
  if (!byTime.length) {
    lines.push('채팅이 특별히 몰린 구간이 없습니다. 아래 구간별 채팅량을 참고하세요.', '');
  }
  byTime.forEach((h, i) => {
    lines.push(`### ${i + 1}. ${formatTime(h.startSec)} ~ ${formatTime(h.endSec)}${h.kind ? ` · ${h.kind}` : ''}`);
    lines.push(`- 반응: 분당 ${h.baselinePerMin} → ${h.peakPerMin}개, 이 구간 채팅 ${h.chats.toLocaleString('ko-KR')}줄`);
    if (h.keywords.length) lines.push(`- 키워드: ${h.keywords.join(', ')}`);
    if (h.topMessages.length) {
      lines.push(`- 반응 예시: ${h.topMessages.map((m) => `${m.content} (${m.count}회)`).join(' · ')}`);
    }
    lines.push('');
  });

  // 구간별 채팅량 — 방송 전체를 빠짐없이 훑을 수 있게
  if (intervals.ok) {
    lines.push(`## 구간별 채팅량 (${intervalSec / 60}분 간격)`, '');
    lines.push('| 구간 | 채팅 | 분당 | 평상시 대비 | 참여자 |');
    lines.push('|---|---|---|---|---|');
    for (const b of intervals.rows) {
      const mark = b.hot ? ' ⬅' : '';
      lines.push(`| ${formatTime(b.startSec)} ~ ${formatTime(b.endSec)}${mark} | ${b.chats.toLocaleString('ko-KR')} | ${b.perMin} | x${b.ratio} | ${b.chatters} |`);
    }
    lines.push('', `⬅ 표시는 채팅이 특히 많았던 구간입니다 (평상시 분당 ${intervals.baselinePerMin}개).`, '');
  }

  lines.push('## 채팅 많이 친 사람', '');
  stats.top.forEach((s, i) => {
    const role = s.role === 'streamer' ? ' (스트리머)' : s.role === 'manager' ? ' (매니저)' : '';
    lines.push(`${i + 1}. ${s.nickname}${role} — ${s.count.toLocaleString('ko-KR')}줄 (${s.share}%)`);
  });
  lines.push('');
  lines.push('---', '', `원본 로그: \`${name}\` · CHZZK Clip Scout에서 생성`);

  return { ok: true, markdown: lines.join('\n') };
}

// 리포트를 원본 로그 옆에 저장한다
export function saveReport(csvPath, options = {}) {
  const report = buildReport(csvPath, options);
  if (!report.ok) return report;
  const target = csvPath.replace(/\.csv$/i, '.report.md');
  try {
    fs.writeFileSync(target, `${report.markdown}\n`, 'utf8');
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
