import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import io from 'socket.io-client';
import { OPEN_API_BASE_URL, bearerHeaders, optionalEnv } from './config.js';
import { apiFetch } from './http.js';
import { refreshAccessToken } from './refresh.js';

const RECONNECT_DELAY_MS = 5000;
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;
const SUBSCRIBE_RETRY_MS = 30000;

// onEnd(reason) reasons: 'user' | 'broadcast_end' | 'connection_lost'
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
    this.files = createOutputFiles(broadcastTitle, outputDir);
    this.running = true;
    await this.connect();
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
      this.onStatus('채팅 구독 완료. 지금부터 올라오는 채팅을 저장합니다.');
    } catch (error) {
      this.onStatus(`아직 방송 전이거나 채팅 구독에 실패했습니다. ${SUBSCRIBE_RETRY_MS / 1000}초 후 다시 시도합니다. (${error.message})`);
      this.subscribeTimer = setTimeout(() => this.trySubscribe(accessToken, sessionKey), SUBSCRIBE_RETRY_MS);
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
      this.onEnd(this.endReason);
      return;
    }

    if (this.stoppedByUser) {
      this.running = false;
      this.onStatus(`연결 종료: ${reason}`);
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
    return this.files;
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
      sender_channel_id: senderHash,
      nickname: profile.nickname || '',
      user_role: profile.userRoleCode || '',
      verified: profile.verifiedMark ?? '',
      content: data?.content || '',
      emoji_keys: Object.keys(emojis).join('|'),
      badge_count: Array.isArray(profile.badges) ? profile.badges.length : 0
    };

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
    'received_at,message_time,elapsed_seconds,channel_id,sender_channel_id,nickname,user_role,verified,content,emoji_keys,badge_count\n',
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
    row.sender_channel_id,
    row.nickname,
    row.user_role,
    row.verified,
    row.content,
    row.emoji_keys,
    row.badge_count
  ].map(csvEscape).join(',');
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
