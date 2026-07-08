# Lee EunSung Portfolio

이은성 백엔드 및 인프라 개발자 포트폴리오 정적 사이트입니다.

## 실행 방법

이 프로젝트는 별도 빌드 과정 없이 실행할 수 있는 정적 웹사이트입니다.

### 1. 포트폴리오만 바로 확인하기

브라우저에서 `index.html` 파일을 직접 열면 됩니다.

```text
C:\Users\xeon-e3\Documents\portfolio\index.html
```

### 2. 로컬 서버로 실행하기

브라우저 직접 열기 대신 로컬 서버로 확인하려면 프로젝트 폴더에서 다음 명령을 실행합니다.

```bash
node tools/static-server.mjs
```

실행 후 브라우저에서 아래 주소로 접속합니다.

```text
http://127.0.0.1:4173
```

### 3. NLI Gateway 실행하기

포트폴리오 화면 오른쪽 아래의 자연어 입력창을 사용하려면 NLI Gateway도 함께 실행해야 합니다.

```bash
node tools/nli-gateway.mjs
```

기본 Gateway 주소는 아래와 같습니다.

```text
http://127.0.0.1:8787
```

상태 확인 API는 아래 주소입니다.

```text
http://127.0.0.1:8787/api/nli/health
```

Gateway를 켠 뒤 포트폴리오 페이지를 새로고침하고, 오른쪽 아래 입력창에 다음처럼 입력합니다.

```text
DB 최적화 보여줘
```

정상 동작하면 `DB 성능 최적화` 섹션으로 자동 이동합니다.

코드를 수정한 뒤에는 실행 중인 Gateway 터미널에서 `Ctrl + C`로 종료한 다음 다시 실행해야 변경사항이 반영됩니다.

다른 입력 예시는 다음과 같습니다.

```text
P95가 뭐야?
CateQuest N+1 해결 요약해줘
CloudWatch 모니터링 보여줘
오늘 날씨 알려줘
```

### 4. LM Studio 주소와 모델명 바꾸기

LM Studio 서버 주소나 모델명을 바꿔야 하면 환경 변수를 사용합니다.

PowerShell에서는 다음처럼 실행합니다.

```powershell
$env:NLI_PORT="8787"
$env:LM_STUDIO_BASE_URL="http://192.168.0.58:1234/v1"
$env:LM_STUDIO_MODEL="google/gemma-4-e4b"
$env:LM_STUDIO_TIMEOUT_MS="8000"
node tools/nli-gateway.mjs
```

## NLI MVP 구성

포트폴리오 탐색용 로컬 LLM NLI 설계와 데이터 계약은 `docs/nli-mvp.md`에 정리되어 있습니다.

- `nli/routes.json`: 자연어로 이동할 수 있는 페이지/프로젝트/섹션 목록
- `nli/glossary.json`: 포트폴리오 전문 용어 사전
- `nli/intents.json`: 허용 intent 목록
- `nli/response.schema.json`: NLI 응답 JSON 계약
- `nli/system-prompt.md`: LM Studio 모델용 시스템 프롬프트 초안
- `nli/test-cases.json`: 자연어 입력 테스트 케이스

NLI 라우팅 테스트는 다음 명령으로 실행합니다.

```bash
node tools/nli-test.mjs
```

## 현재 단계

현재는 포트폴리오 정적 사이트, NLI Gateway, 프론트 자연어 입력창 연결까지 준비된 상태입니다.
