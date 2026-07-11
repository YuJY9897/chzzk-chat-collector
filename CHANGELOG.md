# Changelog

이 프로젝트의 주요 변경사항을 기록합니다.

## 2026-07-12

- GitHub 저장소 생성 및 초기 버전 공개
- `.env.example` 추가 (README가 참조하던 누락 파일)
- README에 안정성/개인정보 처리 내용 문서화

## 2026-07-11

### 안정성
- 방송 중 네트워크 순단 시 자동 재연결 추가: 5초 간격, 최대 5분, 같은 파일에 이어쓰기
- 연결 시도 실패(`connect_error`/`connect_timeout`)도 재시도 루프에 포함 — 재연결이 조용히 멈추는 버그 수정
- 재연결 구간을 JSONL에 `reconnect_start`/`reconnect_end` 마커로 기록해 수집 공백 확인 가능
- `apiFetch`가 비-JSON 응답(HTML 에러 페이지 등)에도 안전하게 동작

### 개인정보 / 보안
- 시청자 식별자(`sender_channel_id`)를 SHA-256 해시(16자)로 익명화
- CSV 수식 인젝션 방지 (`=` `+` `-` `@` 시작 셀에 `'` 접두)

### 사용성
- 수집 중 웹 화면에 "마지막 채팅 수신 시각" 표시 (새로고침으로 정상 수집 확인)
- 새 수집 시작 시 이전 방송의 수신 시각/최근 채팅 초기화

### 구조
- CLI 수집기(`collector.js`)가 `ChatCollector` 클래스를 재사용하도록 정리 (중복 로직 제거)
- CLI 토큰 갱신 시 `.tokens.latest.json` 저장 복원 (콘솔 출력만으로는 토큰 유실 위험)

## 2026-06-09

- 최초 버전: 치지직 공식 Open API Session 기반 라이브 채팅 수집기
- OAuth 연동 로컬 웹앱(`server.js`), CLI 수집기(`collector.js`)
- 자동 저장 예약(standby) 모드: 방송 시작 감지 후 자동 수집, 30초 간격 재시도
- CSV/JSONL 동시 저장, 첫 수집 테스트 완료
