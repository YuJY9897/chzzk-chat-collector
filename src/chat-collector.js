import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import io from 'socket.io-client';
import { OPEN_API_BASE_URL, bearerHeaders, optionalEnv } from './config.js';
import { apiFetch, isAuthError } from './http.js';
import { refreshAccessToken } from './refresh.js';

const RECONNECT_DELAY_MS = 5000;
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;

// 치지직에는 "방송 시작" 이벤트가 없어 구독을 재시도하며 기다리는 수밖에 없다.
// 방송 직전일수록 촘촘히, 오래 기다릴수록 뜸하게 확인한다.
function subscribeRetryMs(waitedMs) {
  if (waitedMs < 2 * 60 * 1000) return 5000;
  if (waitedMs < 10 * 60 * 1000) return 15000;
  return 30000;
}

// 확인된 사실(2026-09-04): 채팅 구독은 방송 여부와 무관하게 항상 성공한다.
// 방송을 꺼도 revoked 이벤트가 오지 않고 소켓도 끊기지 않으며,
// 공식 API에 내 채널의 방송 상태를 알려주는 엔드포인트가 없다.
// 따라서 방송 시작/종료를 스스로 판별할 방법이 없어 사용자가 직접 종료해야 한다.

// onEnd(reason) reasons: 'user' | 'broadcast_end' | 'connection_lost' | 'auth_expired'
export class ChatCollector {
  constructor({ tokens, onChat = () => {}, onStatus = () => {}, onTokens = () => {}, onEnd = () => {} }) {
    this.tokens = tokens;
    this.onChat = onChat;
    this.onStatus = onStatus;
    this.onTokens = onTokens;
    this.onEnd = onEnd;
    this.socket = null;
    this.files = null;
    this.startedAt = null;
    this.running = false;
    this.paused = false;
    this.subscribed = false;
    this.stoppedByUser = false;
    this.endReason = null;
    this.reconnectTimer = null;
    this.reconnectDeadline = null;
    this.subscribeTimer = null;
    this.chatCount = 0;
    this.waitingSince = null;
    this.lastChatAt = null;
  }

  async start({
    broadcastTitle = optionalEnv('BROADCAST_TITLE', 'broadcast'),
    broadcastStartedAt = optionalEnv('BROADCAST_STARTED_AT'),
    outputDir = ''
  } = {}) {
    if (this.running) return this.files;

    this.stoppedByUser = false;
    this.paused = false;
    this.subscribed = false;
    this.endReason = null;
    this.startedAt = parseStartedAt(broadcastStartedAt);
    this.chatCount = 0;
    this.waitingSince = null;
    this.lastChatAt = null;
    this.files = createOutputFiles(broadcastTitle, outputDir);
    this.running = true;
    try {
      await this.connect();
    } catch (error) {
      // 파일을 먼저 만들고 연결하므로, 연결에 실패하면 빈 파일이 남는다
      this.discardIfEmpty({ notify: false });
      this.running = false;
      throw error;
    }
    return this.files;
  }

  async connect() {
    let accessToken = this.tokens.accessToken;

    if (this.tokens.refreshToken && optionalEnv('AUTO_REFRESH_TOKEN', 'true').toLowerCase() === 'true') {
      try {
        const refreshed = await refreshAccessToken(this.tokens.refreshToken);
        this.tokens = refreshed;
        accessToken = refreshed.accessToken;
        this.onTokens(refreshed);
        this.onStatus('토큰을 자동 갱신했습니다.');
      } catch (error) {
        this.onStatus(`토큰 갱신 실패, 기존 토큰으로 시도합니다: ${error.message}`);
      }
    }

    const session = await apiFetch(`${OPEN_API_BASE_URL}/open/v1/sessions/auth`, {
      headers: bearerHeaders(accessToken)
    });

    if (!session?.url) {
      throw new Error('Session auth response did not include content.url');
    }

    this.onStatus('치지직 세션 소켓에 연결 중입니다.');
    this.socket = io.connect(session.url, {
      reconnection: false,
      'force new connection': true,
      'connect timeout': 3000,
      transports: ['websocket']
    });

    this.socket.on('connect', () => {
      if (this.reconnectDeadline) {
        this.logGapMarker('reconnect_end');
        this.reconnectDeadline = null;
      }
      this.onStatus('소켓 연결 완료. 채팅 구독 대기 중입니다.');
    });
    this.socket.on('SYSTEM', (raw) => {
      const data = parseEvent(raw);
      if (data?.type === 'connected' && data?.data?.sessionKey) {
        this.trySubscribe(accessToken, data.data.sessionKey);
        return;
      }
      if (data?.type === 'revoked') {
        this.endReason = 'broadcast_end';
        this.onStatus('방송 종료(구독 해제)를 감지했습니다. 수집을 마무리합니다.');
        if (this.socket) this.socket.close();
        return;
      }
      this.onStatus(`SYSTEM ${data?.type || JSON.stringify(data).slice(0, 120)}`);
    });
    this.socket.on('CHAT', (raw) => this.writeChat(parseEvent(raw)));
    this.socket.on('disconnect', (reason) => this.handleDisconnect(reason));
    this.socket.on('connect_error', (error) => {
      this.onStatus(`소켓 연결 오류: ${error?.message || error}`);
      this.handleDisconnect(`connect_error: ${error?.message || error}`);
    });
    this.socket.on('connect_timeout', () => this.handleDisconnect('connect_timeout'));
  }

  async trySubscribe(accessToken, sessionKey) {
    try {
      await apiFetch(`${OPEN_API_BASE_URL}/open/v1/sessions/events/subscribe/chat?sessionKey=${encodeURIComponent(sessionKey)}`, {
        method: 'POST',
        headers: bearerHeaders(accessToken)
      });
      this.subscribed = true;

      this.waitingSince = null;
      // 구독 성공은 방송 중이라는 뜻이 아니다. 방송이 켜지면 채팅이 들어오기 시작할 뿐이다.
      this.onStatus('채팅 수집을 시작했습니다. 방송이 켜지면 채팅이 저장됩니다.');
    } catch (error) {
      // 토큰이 죽은 거면 기다려도 소용없다
      if (isAuthError(error)) {
        this.endReason = 'auth_expired';
        this.onStatus('치지직 연결이 만료되었습니다. 계정을 다시 연결해 주세요.');
        if (this.socket) this.socket.close();
        return;
      }

      if (!this.waitingSince) this.waitingSince = Date.now();
      const delay = subscribeRetryMs(Date.now() - this.waitingSince);
      this.onStatus(`채팅 구독에 실패했습니다. ${delay / 1000}초 후 다시 시도합니다. (${error.message})`);
      this.subscribeTimer = setTimeout(() => this.trySubscribe(accessToken, sessionKey), delay);
    }
  }

  handleDisconnect(reason) {
    this.clearSubscribeTimer();

    if (this.paused) {
      this.onStatus('일시정지 중입니다. 재개를 누르면 같은 파일에 이어서 저장합니다.');
      return;
    }

    if (this.endReason) {
      this.running = false;
      this.discardIfEmpty();
      this.onEnd(this.endReason);
      return;
    }

    if (this.stoppedByUser) {
      this.running = false;
      this.onStatus(`연결 종료: ${reason}`);
      this.discardIfEmpty();
      this.onEnd('user');
      return;
    }

    if (this.reconnectTimer) return;

    if (!this.reconnectDeadline) {
      this.reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
      this.logGapMarker('reconnect_start', reason);
    }

    if (Date.now() > this.reconnectDeadline) {
      this.running = false;
      this.onStatus(`연결이 끊긴 뒤 ${RECONNECT_WINDOW_MS / 60000}분 동안 복구하지 못했습니다: ${reason}`);
      this.discardIfEmpty();
      this.onEnd('connection_lost');
      return;
    }

    this.onStatus(`연결이 끊겼습니다(${reason}). ${RECONNECT_DELAY_MS / 1000}초 후 같은 파일에 이어서 재연결을 시도합니다.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.onStatus(`재연결 실패: ${error.message}`);
        this.handleDisconnect(error.message);
      });
    }, RECONNECT_DELAY_MS);
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.clearTimers();
    this.reconnectDeadline = null;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.logGapMarker('pause');
    this.onStatus('일시정지되었습니다. 재개를 누르면 같은 파일에 이어서 저장합니다.');
  }

  async resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.logGapMarker('resume');
    this.onStatus('수집을 재개합니다.');
    await this.connect();
  }

  stop() {
    this.stoppedByUser = true;
    this.paused = false;
    this.clearTimers();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.running = false;
    this.onStatus('수집을 종료했습니다.');
    this.discardIfEmpty();
    return this.files;
  }

  // 채팅이 한 줄도 없으면 헤더만 남은 빈 파일을 지운다
  discardIfEmpty({ notify = true } = {}) {
    if (!this.files || this.chatCount > 0) return false;
    for (const target of [this.files.csvPath, this.files.jsonlPath]) {
      try {
        fs.unlinkSync(target);
      } catch {
        // 이미 없으면 무시
      }
    }
    this.files = null;
    if (notify) this.onStatus('수집된 채팅이 없어 빈 파일은 저장하지 않았습니다.');
    return true;
  }

  clearSubscribeTimer() {
    if (this.subscribeTimer) {
      clearTimeout(this.subscribeTimer);
      this.subscribeTimer = null;
    }
  }

  clearTimers() {
    this.clearSubscribeTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  logGapMarker(type, reason = '') {
    if (!this.files) return;
    const marker = { receivedAt: new Date().toISOString(), type, reason };
    fs.appendFileSync(this.files.jsonlPath, `${JSON.stringify(marker)}\n`, 'utf8');
  }

  writeChat(data) {
    if (!data) return;
    const receivedAt = new Date();
    const messageTime = data?.messageTime ? new Date(Number(data.messageTime)) : receivedAt;
    const profile = data?.profile || {};
    const emojis = data?.emojis || {};
    const senderHash = hashId(data?.senderChannelId);
    const row = {
      received_at: receivedAt.toISOString(),
      message_time: messageTime.toISOString(),
      elapsed_seconds: this.startedAt ? Math.max(0, Math.floor((messageTime.getTime() - this.startedAt.getTime()) / 1000)) : '',
      channel_id: data?.channelId || '',
      chat_channel_id: data?.chatChannelId || '',
      sender_channel_id: senderHash,
      nickname: profile.nickname || '',
      user_role: data?.userRoleCode || profile.userRoleCode || '',
      verified: profile.verifiedMark ?? '',
      content: data?.content || '',
      emoji_keys: Object.keys(emojis).join('|'),
      badges: badgeNames(profile.badges)
    };

    this.chatCount += 1;
    this.lastChatAt = Date.now();

    fs.appendFileSync(this.files.csvPath, `${toCsv(row)}\n`, 'utf8');
    fs.appendFileSync(this.files.jsonlPath, `${JSON.stringify({ receivedAt: row.received_at, ...data, senderChannelId: senderHash })}\n`, 'utf8');
    this.onChat(row);
  }
}

// 치지직 세션 서버는 이벤트 데이터를 JSON 문자열로 보낼 수 있음
function parseEvent(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hashId(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function createOutputFiles(title, outputDir) {
  const dir = outputDir || optionalEnv('OUTPUT_DIR', './data');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const basename = `${sanitizeFilename(title || 'broadcast')}_${timestamp}`;
  const csvPath = path.join(dir, `${basename}.csv`);
  const jsonlPath = path.join(dir, `${basename}.jsonl`);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    csvPath,
    'received_at,message_time,elapsed_seconds,channel_id,chat_channel_id,sender_channel_id,nickname,user_role,verified,content,emoji_keys,badges\n',
    'utf8'
  );
  return { csvPath, jsonlPath };
}

function toCsv(row) {
  return [
    row.received_at,
    row.message_time,
    row.elapsed_seconds,
    row.channel_id,
    row.chat_channel_id,
    row.sender_channel_id,
    row.nickname,
    row.user_role,
    row.verified,
    row.content,
    row.emoji_keys,
    row.badges
  ].map(csvEscape).join(',');
}

// badges는 [{ imageUrl: '.../streamer.png' }] 형태 — 파일명만 뽑아 종류로 저장
function badgeNames(badges) {
  if (!Array.isArray(badges)) return '';
  return badges
    .map((badge) => String(badge?.imageUrl || '').split('/').pop().replace(/\.\w+$/, ''))
    .filter(Boolean)
    .join('|');
}

function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseStartedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('방송 시작 시간은 ISO 형식이어야 합니다. 예: 2026-06-09T20:00:00+09:00');
  }
  return date;
}

function sanitizeFilename(value) {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}
