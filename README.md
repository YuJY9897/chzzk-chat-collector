# CHZZK Chat Collector

[![Node.js](https://img.shields.io/badge/Node.js-JavaScript-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/Electron-데스크톱%20앱-47848F?logo=electron&logoColor=white)](https://electronjs.org)
[![CHZZK Open API](https://img.shields.io/badge/CHZZK-Open%20API%20(OAuth%202.0)-00FFA3)](https://developers.chzzk.naver.com)

> **방송 하나가 몇 시간씩 가는데, 쇼츠나 롱폼으로 편집할 구간을 찾으려면 그 긴 영상을 다시 돌려봐야 합니다.**
> 채팅이 몰리는 순간이 대체로 그 지점이라, 채팅을 시각과 함께 쌓아두면 편집점을 데이터로 찾을 수 있겠다고 봤습니다.
> 이 수집기는 그 **첫 단계인 데이터 수집**을 맡는 도구입니다.

치지직 공식 Open API의 Session API로 라이브 채팅 이벤트를 저장하는 수집기입니다.

이 수집기는 비공식 크롤링, 쿠키 기반 수집, 다시보기 채팅 긁기를 하지 않습니다. 공식 API 권한을 받은 채널의 **라이브 중 발생하는 채팅**을 CSV/JSONL로 기록하는 용도입니다.

## 직접 해결한 것

- **장시간 방송에서 끊기지 않게** — OAuth 2.0 토큰 자동 갱신, 네트워크 단절 시 5초 간격 최대 5분 재연결, 재연결 구간을 JSONL 마커로 남겨 수집 공백을 확인할 수 있게 했습니다
- **시청자 식별자를 원본으로 저장하지 않습니다** — SHA-256 해시(16자)로 바꿔 저장해, 같은 시청자 추적은 되지만 원본 ID는 파일에 남지 않습니다
- **CSV 수식 주입을 막았습니다** — 채팅이 `=` `+` `-` `@`로 시작하면 앞에 `'`를 붙여 Excel에서 수식으로 실행되지 않게 처리했습니다
- **개발 환경 없이도 쓸 수 있게** — Electron으로 exe 빌드, 트레이 상주 백그라운드 수집, 방송 종료 자동 감지 후 Windows 알림
- **범위를 처음부터 제한했습니다** — 공식 API 권한을 허용한 채널의 라이브 채팅만 대상으로 하고, `clientSecret` 등 민감 정보는 `.env`로 분리해 저장소에 올리지 않습니다

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
- 수집이 끝나면 Windows 알림 + 앱 내 모달로 저장 위치와 하이라이트를 알려줍니다
- 저장 위치는 네이티브 폴더 선택 창으로 지정합니다
- 메인 화면에는 현재 상태와 수집 버튼만 두고, 연결·저장 설정·수집 결과·실시간 채팅은 접이식으로 펼쳐 봅니다

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
3. `로그 수집 ON` 클릭 — 방송 전에 미리 켜두면 방송이 시작될 때부터 채팅이 저장됩니다
4. 수집 중에는 `일시정지`/`재개`, `수집 종료` 버튼으로 제어합니다 (일시정지 후 재개하면 같은 파일에 이어서 저장)
5. **방송이 끝나면 `수집 종료`를 직접 눌러야 합니다.** 치지직 공식 API로는 방송 종료를 알 수 없습니다 (아래 "중요한 제한" 참고)
6. 종료하면 저장 위치와 하이라이트 구간이 표시됩니다
7. 화면 상단 상태로 현재 상황을 확인합니다 — 채팅이 들어오는 중이면 `방송 채팅 수신 중`으로 표시됩니다
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
received_at,message_time,elapsed_seconds,channel_id,chat_channel_id,sender_channel_id,nickname,user_role,verified,content,emoji_keys,badges
```

## 안정성 / 개인정보 처리

- 방송 중 네트워크가 잠깐 끊기면 5초 간격으로 최대 5분까지 자동 재연결하고, 같은 파일에 이어서 저장합니다. 재연결 구간은 JSONL에 `reconnect_start` / `reconnect_end` 마커로 기록되어 수집 공백을 확인할 수 있습니다.
- 시청자 식별자(`sender_channel_id`)는 원본 대신 SHA-256 해시(16자)로 저장합니다. 같은 시청자는 같은 해시값을 가지므로 분석은 가능하지만, 원본 ID는 파일에 남지 않습니다.
- 채팅 내용이 `=` `+` `-` `@`로 시작하면 CSV에서 앞에 `'`를 붙여 Excel 수식 실행을 방지합니다.
- 수집 중에는 화면 상단에 저장된 줄 수와 마지막 채팅 수신 시각이 표시됩니다.
- 채팅이 한 줄도 수집되지 않으면 헤더만 있는 빈 파일을 남기지 않고 지웁니다.

## 하이라이트 감지

수집이 끝나면 저장된 CSV를 분석해 채팅이 몰린 구간을 찾아 보여줍니다. 채팅량 폭증 + 반응성 표현 비율(`ㅋㅋㅋ`, `클립`, `헐`, `레전드` 등) + 참여자 수 급증을 함께 봅니다. 기준선은 앞뒤 10분 중앙값이라 방송 중 시청자가 늘고 줄어도 따라갑니다.

수집한 파일을 따로 분석하려면:

```bash
node tools/detect-highlights.mjs data/파일이름.csv
```

분석/개발용 더미 로그 생성 (동시시청자 300명, 3시간):

```bash
node tools/make-dummy-log.mjs ./test-data 300 180
```

하이라이트 구간을 의도적으로 심고 `*.highlights.json`에 정답지를 함께 저장하므로, 감지 알고리즘의 재현율/정밀도를 채점할 수 있습니다.

## 중요한 제한

- **방송 시작/종료를 자동으로 감지할 수 없습니다.** 2026-09-04 실측으로 확인한 내용:
  - 방송을 꺼도 세션 소켓에 `revoked` 이벤트가 오지 않고 소켓도 끊기지 않습니다.
  - 채팅 구독(`POST /open/v1/sessions/events/subscribe/chat`)은 방송 여부와 무관하게 항상 성공합니다. 따라서 "구독 실패 = 방송 전"으로 판별할 수 없습니다.
  - 세션 목록(`GET /open/v1/sessions`)의 `subscribedEvents`는 방송 종료 후에도 그대로 남습니다.
  - Channel API와 `lives/setting`에 방송 상태 필드가 없고, `GET /open/v1/lives`는 전체 라이브를 시청자 수 순으로 주기 때문에 특정 채널을 찾기에 적합하지 않습니다.
  - 결론: 채팅이 들어오면 방송 중인 것이 확실하지만, 조용하다고 방송이 끝난 것인지는 알 수 없습니다. 종료는 사용자가 직접 눌러야 합니다.
- 방송 시작 시각을 알 수 없으므로, `다시보기 기준 시작 시간`을 입력하지 않으면 `elapsed_seconds`는 **수집을 켠 시각** 기준으로 계산됩니다. 다시보기 타임라인에 정확히 맞추려면 방송 시작 시각을 직접 입력하세요.
- 공식 API 기준으로는 끝난 다시보기 URL만 넣어서 과거 채팅 리플레이를 가져오는 기능을 확인하지 못했습니다.
- 이 수집기는 라이브 중 미리 켜두고 채팅을 저장하는 방식입니다.
- 다른 스트리머 채널의 채팅을 수집하려면 해당 권한/동의 범위가 공식 API에서 허용되어야 합니다.
