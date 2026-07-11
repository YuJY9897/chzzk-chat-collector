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

## 쉬운 실행: 로컬 웹앱

일반 사용자는 토큰을 복사하지 않아도 됩니다. 로컬 웹앱을 실행하고 버튼으로 연결합니다.

Windows에서는 아래 파일을 더블클릭해 실행할 수 있습니다.

```text
CHZZK Clip Scout.cmd
```

터미널 창도 숨기고 싶다면 아래 파일을 실행합니다.

```text
CHZZK Clip Scout 숨김 실행.vbs
```

실행 후 브라우저가 자동으로 열립니다.

```bash
npm run server
```

브라우저에서 아래 주소를 엽니다.

```text
http://localhost:3000
```

사용 흐름:

1. `치지직 연결` 버튼 클릭
2. 치지직 권한 동의
3. 자동으로 `tokens.json`에 토큰 저장
4. `수집 시작` 버튼 클릭
5. 방송 종료 후 `수집 중지` 클릭

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
