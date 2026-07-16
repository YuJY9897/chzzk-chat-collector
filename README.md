# CHZZK Chat Collector

치지직 공식 Open API의 Session API로 라이브 채팅 이벤트를 저장하는 수집기입니다.

이 수집기는 비공식 크롤링, 쿠키 기반 수집, 다시보기 채팅 긁기를 하지 않습니다. 공식 API 권한을 받은 채널의 **라이브 중 발생하는 채팅**을 CSV/JSONL로 기록하는 용도입니다.

## 준비

1. 치지직 개발자 센터에서 애플리케이션을 생성합니다.
2. Redirect URI를 `.env`의 `CHZZK_REDIRECT_URI`와 동일하게 등록합니다.
3. API Scope에서 `채팅 메시지 조회` 권한을 신청/허용합니다.
4. 의존성을 설치합니다.

```bash
npm install
```

5. `.env.example`을 `.env`로 복사하고 `CHZZK_CLIENT_ID`, `CHZZK_CLIENT_SECRET`, `CHZZK_REDIRECT_URI`를 채웁니다.

## 데스크톱 앱 (권장)

Electron 기반 네이티브 앱입니다. 개발 모드 실행:

```bash
npm run app
```

exe 빌드 (dist/CHZZK-Clip-Scout.exe 생성):

```bash
npm run dist
```

빌드된 exe는 **`.env` 파일을 exe와 같은 폴더에 두고** 실행합니다. 토큰(`tokens.json`), 설정(`settings.json`), 기본 저장 폴더(`data/`)도 exe 옆에 만들어집니다.

- 창을 닫으면 "백그라운드로 유지 / 완전히 종료"를 물어봅니다 (선택 기억 가능, 트레이 메뉴에서 초기화)
- 백그라운드로 유지하면 트레이 아이콘으로 상주하며 수집이 계속됩니다
- 방송 종료 자동 감지 시 Windows 알림 + 앱 내 모달로 저장 위치를 알려줍니다
- 저장 위치는 네이티브 폴더 선택 창으로 지정합니다

## 웹 버전 (레거시)

일반 사용자는 토큰을 복사하지 않아도 됩니다. Windows에서 아래 파일을 더블클릭하면 서버가 **백그라운드로** 실행되고 브라우저가 자동으로 열립니다. (CMD 창이 남지 않습니다)

```text
CHZZK Clip Scout.cmd
```

터미널에서 직접 실행하려면:

```bash
npm run server
```

브라우저에서 `http://localhost:3000`을 엽니다.

사용 흐름:

1. `치지직 계정 연결하기` 클릭 → 권한 동의 (한 번만, 연결돼 있으면 버튼이 비활성화됨)
2. 저장할 파일 이름과 저장 경로 지정
3. `로그 수집 ON` 클릭 — 방송 전이면 방송이 켜질 때까지 기다렸다가 자동으로 수집을 시작하고, 이미 방송 중이면 바로 시작합니다
4. 수집 중에는 `일시정지`/`재개`, `종료` 버튼으로 제어합니다 (일시정지 후 재개하면 같은 파일에 이어서 저장)
5. 방송이 끝나면 자동으로 수집이 종료되고, 어디에 어떤 이름으로 저장됐는지 알림이 표시됩니다
6. `최근 채팅`의 `새로고침` 버튼으로 원할 때 수집 상태를 확인할 수 있습니다
7. 앱을 완전히 끄려면 화면 맨 아래 `앱 종료` 버튼을 누르거나, 트레이 아이콘 우클릭 → `앱 종료`를 누릅니다

실행 중에는 작업표시줄 오른쪽 아래(트레이)에 초록 점 아이콘이 표시됩니다. 더블클릭하면 화면이 열리고, 우클릭하면 열기/앱 종료 메뉴가 나옵니다. 브라우저를 닫아도 수집은 계속되며, 트레이 아이콘으로 실행 여부를 확인할 수 있습니다.

토큰은 화면에 표시하지 않으며, `tokens.json`은 `.gitignore`에 포함되어 있습니다.

## 고급 실행: CLI 인증

테스트나 디버깅이 필요할 때만 사용합니다.

인증 URL을 출력합니다.

```bash
npm run auth:url
```

브라우저에서 URL을 열고 권한을 허용하면 Redirect URI로 `code`와 `state`가 붙어서 돌아옵니다.

```text
http://localhost:3000/callback?code=...&state=...
```

그 값을 넣어 토큰을 발급합니다.

```bash
npm run auth:token -- --code 받은_CODE --state 받은_STATE
```

출력된 `accessToken`, `refreshToken`을 `.env`의 `CHZZK_ACCESS_TOKEN`, `CHZZK_REFRESH_TOKEN`에 넣습니다.

## 채팅 수집

방송이 켜져 있을 때 실행합니다.

```bash
npm run collect
```

저장 위치:

```text
data/
  chat_YYYY-MM-DDTHH-mm-ss.csv
  chat_YYYY-MM-DDTHH-mm-ss.jsonl
```

CSV 컬럼:

```text
received_at,message_time,elapsed_seconds,channel_id,sender_channel_id,nickname,user_role,verified,content,emoji_keys,badge_count
```

## 안정성 / 개인정보 처리

- 방송 중 네트워크가 잠깐 끊기면 5초 간격으로 최대 5분까지 자동 재연결하고, 같은 파일에 이어서 저장합니다. 재연결 구간은 JSONL에 `reconnect_start` / `reconnect_end` 마커로 기록되어 수집 공백을 확인할 수 있습니다.
- 시청자 식별자(`sender_channel_id`)는 원본 대신 SHA-256 해시(16자)로 저장합니다. 같은 시청자는 같은 해시값을 가지므로 분석은 가능하지만, 원본 ID는 파일에 남지 않습니다.
- 채팅 내용이 `=` `+` `-` `@`로 시작하면 CSV에서 앞에 `'`를 붙여 Excel 수식 실행을 방지합니다.
- 수집 중에는 웹 화면에 "마지막 채팅 수신 시각"이 표시되어, 새로고침으로 정상 수집 여부를 확인할 수 있습니다.

## 중요한 제한

- 공식 API 기준으로는 끝난 다시보기 URL만 넣어서 과거 채팅 리플레이를 가져오는 기능을 확인하지 못했습니다.
- 이 수집기는 라이브 중 미리 켜두고 채팅을 저장하는 방식입니다.
- 다른 스트리머 채널의 채팅을 수집하려면 해당 권한/동의 범위가 공식 API에서 허용되어야 합니다.
