# Lee EunSung Portfolio

이은성 백엔드 및 인프라 개발자 포트폴리오입니다.

정적 포트폴리오 사이트를 먼저 제공하고, 별도 NLI Gateway를 붙여 자연어로 프로젝트 섹션 이동, 용어 설명, 프로젝트 요약을 수행하는 구조입니다.

## 구성

- `index.html`: 포트폴리오 메인 페이지
- `styles.css`: 화면 스타일
- `app.js`: 포트폴리오 렌더링과 NLI 입력창 동작
- `data/portfolio.js`: 포트폴리오 프로젝트 데이터
- `assets/`: 포트폴리오 이미지
- `tools/static-server.mjs`: 로컬 정적 서버
- `tools/nli-gateway.mjs`: LM Studio 연동 NLI Gateway
- `tools/nli/`: Gateway의 설정, HTTP 경계, 모델 클라이언트, 라우팅, 응답 생성 모듈
- `nli/`: NLI 라우팅, 용어 사전, 테스트 데이터
- `docs/`: 설계 및 배포 문서

## 빠른 실행

### 1. 포트폴리오만 보기

브라우저에서 아래 파일을 직접 열면 됩니다.

```text
C:\Users\xeon-e3\Documents\portfolio\index.html
```

### 2. 로컬 서버로 보기

```bash
node tools/static-server.mjs
```

브라우저에서 접속합니다.

```text
http://127.0.0.1:4173
```

### 3. NLI Gateway 함께 실행하기

포트폴리오 오른쪽 아래 자연어 입력창을 사용하려면 NLI Gateway를 별도 터미널에서 실행합니다.

```bash
node tools/nli-gateway.mjs
```

상태 확인:

```text
http://127.0.0.1:8787/api/nli/health
```

예시 입력:

```text
DB 최적화 보여줘
P95가 뭐야?
너는 누구야?
자기소개해줘
사장님 피규어 만들어주세요 요약해줘
CateQuest 요약해줘
CateQuest N+1 해결 요약해줘
CloudWatch 모니터링 보여줘
이 포트폴리오에서 뭘 할 수 있어?
오늘 날씨 알려줘
```

## 환경 변수

기본값은 `.env.example`에 정리되어 있습니다. 서버에서는 `.env.example`을 `.env`로 복사한 뒤 값을 수정하면 `tools/nli-gateway.mjs`가 자동으로 읽습니다.

Linux 서버 예시:

```bash
cp .env.example .env
node tools/nli-gateway.mjs
```

PowerShell 환경 변수 예시:

```powershell
$env:NLI_HOST="127.0.0.1"
$env:NLI_PORT="8787"
$env:LM_STUDIO_BASE_URL="http://192.168.0.57:1234/v1"
$env:LM_STUDIO_MODEL="qwen/qwen3.5-9b"
$env:LM_STUDIO_TIMEOUT_MS="8000"
$env:LM_STUDIO_MAX_TOKENS="256"
$env:LM_STUDIO_MAX_RESPONSE_BYTES="65536"
$env:LM_STUDIO_MAX_CONCURRENT_REQUESTS="4"
$env:NLI_MAX_REQUEST_BYTES="16384"
$env:NLI_MAX_MESSAGE_LENGTH="500"
$env:NLI_RATE_LIMIT_WINDOW_MS="60000"
$env:NLI_RATE_LIMIT_MAX="30"
$env:NLI_RATE_LIMIT_MAX_BUCKETS="10000"
$env:NLI_REQUEST_TIMEOUT_MS="15000"
$env:NLI_ALLOWED_ORIGINS="http://127.0.0.1:4173"
node tools/nli-gateway.mjs
```

Gateway는 OpenAI-compatible Chat Completions 요청마다 `reasoning_effort: "none"`을 고정으로 보냅니다. 이 값은 환경 변수로 변경하지 않습니다. LM Studio 버전이나 모델을 바꾸면 실제 strict JSON probe로 해당 모델의 호환성을 다시 확인해야 합니다.

## 테스트

NLI 라우팅 테스트:

```bash
node tools/nli-test.mjs
```

fake LM Studio와 HTTP 경계를 포함한 보안 통합 테스트:

```bash
node --test tools/nli-gateway.test.mjs
node tools/nli-test.mjs --local --cases nli/adversarial-test-cases.json --min-pass-rate 1
```

배포된 Gateway 실제 호출 테스트:

```bash
NLI_TEST_BASE_URL="http://127.0.0.1:8787" node tools/nli-test.mjs --live --cases nli/live-test-cases.json --min-pass-rate 0.9
NLI_TEST_BASE_URL="http://127.0.0.1:8787" node tools/nli-test.mjs --live --cases nli/adversarial-test-cases.json --min-pass-rate 1
```

JavaScript 문법 확인:

```bash
node --check app.js
node --check data/portfolio.js
node --check tools/static-server.mjs
node --check tools/nli-gateway.mjs
node --check tools/nli-test.mjs
node --test tools/nli-gateway.test.mjs
```

## 근거 기반 포트폴리오 도우미

`answer_portfolio`는 포트폴리오 전체, 자기소개, 프로젝트 비교와 카테고리 질문에 사용하는 근거 기반 응답입니다. Gateway가 포트폴리오 데이터에서 후보 근거를 찾고, 모델은 그 후보 안의 ID만 선택할 수 있습니다. 최종 `sources`의 ID와 label은 Gateway가 다시 조립하므로 모델이 만든 출처 표기를 신뢰하지 않습니다.

- 예시 범주는 성능 최적화(DB 튜닝, 메인 홈페이지 캐싱, N+1, HTTPS), AWS, 관측성, 동시성, Redis/Valkey, CI/CD, 비용, AI/LLM, 데이터 모델링입니다. 범주 이름으로 고정 라우팅하지 않고, 질문과 현재 근거에 따라 후보를 자동으로 고릅니다.
- 직접 이동과 용어 설명은 결정적 로컬 경로를 우선 사용합니다. 자유 서술이 필요한 질문만 근거 후보와 함께 모델에 전달합니다.
- 브라우저는 현재 위치와 완료된 최근 대화 최대 6개를 `{ role, text }` 형태로만 보냅니다. 대화는 Gateway에 저장되지 않으며, 형식이 잘못됐거나 지시 탈취가 포함된 history는 모델에 전달하기 전에 거절됩니다.
- 근거 버튼은 해당 섹션으로만 이동합니다. 답변을 표시할 때는 자동 스크롤하지 않고, 이동 intent 또는 요약 intent의 대상만 자동 이동합니다. 답변 텍스트와 근거 label은 HTML로 해석하지 않습니다.
- 모델 timeout, 잘못된 JSON, 허용되지 않은 source ID는 검증된 로컬 응답이 있으면 그 응답으로, 없으면 canonical 거절 응답으로 처리합니다. 원본 모델 문장은 이 경계를 우회해 브라우저로 전달되지 않습니다.

## 배포 전 NLI 검증

다음 명령은 LAN의 LM Studio나 배포 Gateway를 호출하지 않습니다. category fixture는 요청별 fake model 응답만 사용하며, source ID와 포함/제외 문구를 함께 확인합니다.

```bash
for file in app.js nli-history.js nli-widget.js data/portfolio.js tools/*.mjs; do node --check "$file"; done
for file in tools/nli/*.mjs; do node --check "$file"; done
node -e "for (const f of ['nli/routes.json','nli/glossary.json','nli/intents.json','nli/response.schema.json','nli/model-decision.schema.json','nli/test-cases.json','nli/live-test-cases.json','nli/adversarial-test-cases.json','nli/grounded-category-test-cases.json']) JSON.parse(require('fs').readFileSync(f, 'utf8')); console.log('json ok')"
node tools/nli-test.mjs
node tools/nli-test.mjs --local --cases nli/live-test-cases.json --min-pass-rate 1
node tools/nli-test.mjs --fake --cases nli/grounded-category-test-cases.json --min-pass-rate 1
node tools/nli-test.mjs --local --cases nli/adversarial-test-cases.json --min-pass-rate 1
node --test tools/*.test.mjs
node --test tools/nli/*.test.mjs
node --test tools/nli-widget.browser-test.mjs
```

배포 preflight는 root와 `tools/nli/`의 test glob 실행 뒤 `tools/nli-widget.browser-test.mjs`를 별도로 실행합니다. 기본 환경에서는 Chrome 또는 Playwright 의존성을 설치하지 않으므로 해당 browser regression은 명시적으로 skip됩니다. Chrome-capable Playwright module을 외부 runner가 주입한 경우에만 아래처럼 실제 브라우저 회귀를 실행합니다.

```bash
NLI_WIDGET_BROWSER_MODULE=/absolute/path/to/playwright-module.mjs node tools/nli-widget.browser-test.mjs
```

## 문서

- [NLI MVP 설계](docs/nli-mvp.md)
- [배포 방법](docs/deployment.md)
