import fs from 'node:fs';
import { optionalEnv, requiredEnv } from './config.js';
import { ChatCollector } from './chat-collector.js';

const collector = new ChatCollector({
  tokens: {
    accessToken: requiredEnv('CHZZK_ACCESS_TOKEN'),
    refreshToken: optionalEnv('CHZZK_REFRESH_TOKEN')
  },
  onStatus: (message) => console.log(message),
  onTokens: (tokens) => {
    fs.writeFileSync('.tokens.latest.json', `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
    console.log('토큰이 갱신되어 .tokens.latest.json에 저장했습니다. 수집이 끝나면 .env에 반영하고 파일을 삭제하세요.');
  },
  onChat: (row) => console.log(`[${row.message_time}] ${row.nickname}: ${row.content}`),
  onEnd: (reason) => {
    console.log(`연결 종료: ${reason}`);
    process.exit(0);
  }
});

const files = await collector.start({
  broadcastTitle: optionalEnv('BROADCAST_TITLE', 'broadcast'),
  broadcastStartedAt: optionalEnv('BROADCAST_STARTED_AT')
});

console.log(`Writing CSV: ${files.csvPath}`);
console.log(`Writing JSONL: ${files.jsonlPath}`);
console.log('Press Ctrl+C to stop.');

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  console.log('');
  console.log('Stopping collector...');
  const savedFiles = collector.stop();
  console.log(`Saved CSV: ${savedFiles.csvPath}`);
  console.log(`Saved JSONL: ${savedFiles.jsonlPath}`);
  process.exit(0);
}
