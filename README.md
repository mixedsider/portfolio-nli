# Lee EunSung Portfolio

이은성 백엔드 및 인프라 개발자 포트폴리오입니다.

정적 포트폴리오 사이트를 먼저 제공하고, 별도 NLI Gateway를 붙여 자연어로 프로젝트 섹션 이동, 용어 설명, 프로젝트 요약을 수행하는 구조입니다.

**운영 상태: activation-blocked / ready=false. 이전 전체 평가(당시 설정): 2026-09-09 18:54 UTC.** payload projection과 verifier 정렬 후 당시 bound-probe 두 개와 전체 실제 evaluator를 실행했지만 모두 exit 1입니다. 당시 결과는 성공 fixture **5/26**, adversarial **7/10**, **LFM 채택 0건**, Qwen receipt 없음입니다. 그 이전 실제 실행과 수치가 같지만 별개의 날짜/입력에 묶인 실패 증거이며 과거 report를 재사용한 결과가 아닙니다. 일반 페이지 명사 관련 fake9/10 semantic 결함은 **task4fix3에서 해결**됐습니다. 당시 실제 adversarial의 세 실패는 모델 completion을 받지 못한 upstream 실패이지 현재 fake 라우팅 결함이 아닙니다. 작은 projected profile 요청도 당시 고정 예산 내 completion headers를 받지 못했으며 원격 serving 지연의 정확한 원인은 미확정입니다. 속도 향상이나 운영 활성화를 주장하지 않습니다. [이전 전체 평가의 projected QA](.omo/evidence/lfm25-middle-model/task12-projected-summary.md), [당시 계약](.omo/evidence/lfm25-middle-model/task-12-contract.md), `task12-projected-live-eval.json`을 참고하세요. `task-12-attempt-1-live-eval.json`과 [초기 DoneClaim](.omo/evidence/lfm25-middle-model/task-12-DoneClaim.md)은 별도 과거 기록입니다. 이후 새 모델 ID로 수행한 [2026-09-13 제한 실측](.omo/evidence/lfm25-middle-model/lfm-loaded-model-adoption-20260913T065843Z.md)은 아래에 구분합니다. `.omo/`는 gitignored 로컬 증거이며 공개 배포물에 포함되지 않습니다.

최신 MODEL amendment 제한 실측 (2026-09-13 06:58–07:00 UTC): loaded `lfm2.5-2.6b` (Q4_0, context 8192)에서 최소 JSON은 **495ms에 HTTP 200/stop 및 유효 JSON 확인만 통과했으며 포트폴리오 응답 채택은 아닙니다**. 현재 자기소개는 **3,921ms에 HTTP 200/stop 및 공유 acceptance를 통과해 한 건 채택**됐습니다. 추가 대표 5개는 timeout, 이후 한 번의 LFM bound verify는 **0/12 채택, exit 1** (timeout 7건, HTTP 200이나 invalid JSON 5건)입니다. Qwen/전체 live matrix는 실행하지 않았으며 **full ready 미충족**입니다. 새 증거는 [한국어 요약·이동 이력](.omo/evidence/lfm25-middle-model/lfm-loaded-model-adoption-20260913T065843Z.md), [실측 JSON](.omo/evidence/lfm25-middle-model/lfm-loaded-model-adoption-20260913T065843Z.json), [bound verify JSON](.omo/evidence/lfm25-middle-model/lfm-loaded-model-adoption-20260913T065843Z-bound.json)에 있습니다. 서버/프로세스 설정 변경이나 재시작 없이 측정했으며 기존 과거 증거를 새 모델 결과로 재사용하지 않았습니다.

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

프로세스/context 상태 확인 (모델 준비 완료 검사가 아님):

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

사용자 MODEL amendment에 따라 현재 서버에 로드된 GTX1060 최적화 Q4_0 모델을 그대로 사용합니다. 요청 ID는 `lfm2.5-2.6b`이며 미로드 alias `@q4_0` 또는 `@q4_k_m`으로 요청하지 않습니다. 서버 URL·옵션·로드 상태는 변경하지 않습니다. 위 2026-09-09 전체 평가는 이전 설정의 과거 기록이며 새 ID의 결과가 아닙니다. 모델 변경은 readiness 승인이 아니며 fresh 검증 전까지 activation-blocked / ready=false 및 기존 OFF/strict acceptance gate를 유지합니다.

기본값은 `.env.example`에 정리되어 있습니다. 서버에서는 `.env.example`을 `.env`로 복사한 뒤 값을 수정하면 `tools/nli-gateway.mjs`가 자동으로 읽습니다.

Linux 서버 예시:

```bash
cp .env.example .env
node tools/nli-gateway.mjs
```

PowerShell 실행 예시 (`.env.example`의 최종 모델 설정 사용):

```powershell
Copy-Item .env.example .env
$env:NLI_HOST="127.0.0.1"
$env:NLI_ALLOWED_ORIGINS="http://127.0.0.1:4173"
node tools/nli-gateway.mjs
```

기존 `.env`를 덮어쓰지 마세요. **비어 있지 않은 process 환경 변수가 `.env`보다 우선**하므로 PM2/systemd 환경도 함께 확인해야 합니다. `.env`와 `.nli/` receipt는 비밀을 포함할 수 있는 host-local 파일이며 추적/업로드하지 않습니다.

| 역할 | endpoint / 요청 모델 ID | 제한 (보장 성능 아님) |
| --- | --- | --- |
| 기본 LFM (GTX1060 최적화 Q4_0) | `http://192.168.0.106:1234/v1` / `lfm2.5-2.6b` | 6,500ms / 512 tokens |
| 어려운 미해결 요청의 Qwen (`LM_STUDIO_*`) | `http://192.168.0.57:1234/v1` / `Qwen3.8-27B-UD-Q4_K_M` | 16,000ms / 768 tokens |

Issue #6 시간 정책의 단일 기준은 `tools/nli/timeout-policy.mjs`입니다. 두 output mode는 최종 유지값 `json_schema`이며 자동 plain 재시도는 없습니다. 응답 상한은 각각 65,536 bytes, endpoint별/공유 동시 작업 상한은 각각 4입니다. 전체 상한/기본값은 23,500ms (LFM 6.5초 + Qwen 16초 + 응답 여유 1초)이며 resolver 진입부터 검색/입장/metadata까지 포함합니다. metadata 최대 1,000ms는 Qwen의 단일 16초 stage 안에서 소모하며 승격 최소 잔여 예산은 2,000ms입니다. 더 작은 명시적 timeout은 유지합니다. 평가 HTTP caller 기본값은 30,000ms입니다. `NLI_REQUEST_TIMEOUT_MS=15000`은 inbound HTTP body/header 수신 제한이며 응답 deadline이 아닙니다. 요청당 LFM 먼저 최대 두 번의 **순차** 추론만 허용합니다.

LFM timeout 변경은 LFM settings binding을 바꾸므로 fresh LFM bound verification이 필요합니다. LFM/전체/평가 timeout 변경만으로 Qwen binding이 바뀌지는 않으며, Qwen settings/payload/prompt/schema/matrix 및 model/build/template가 같고 유효 기간·runtime gate를 통과하는 receipt만 재사용 가능합니다. 사용자 승인으로 2026-09-20에 6.5초 설정을 실측했습니다. 대표 요청은 완료 15/15·채택 12/15·timeout 0회이며 CateQuest는 3/3 채택됐지만 Makertion 비용은 3/3 `quantity_unsupported`였습니다. 별도 실제 Gateway 5회는 LFM 채택 4회·로컬 fallback 1회입니다. fresh bound 검증은 schema 4/6·plain 0/6으로 실패했습니다. #5 수정도 함께 반영된 결과이므로 이전 실측과의 차이를 timeout 증가만의 효과로 해석하지 않습니다. 상세 근거는 [PR #10](https://github.com/mixedsider/portfolio-nli/pull/10)에 있으며, 성공한 fresh proof 및 최종 통합 live 검증(#7)은 **pending**입니다. 전체 gate 통과 전까지 activation-blocked / ready=false를 유지합니다.

Qwen은 `reasoning_effort: "none"`과 `chat_template_kwargs: { enable_thinking: false }`를 고정 전송합니다. 옵션이나 reasoning 필드 부재만으로 reasoning-off를 입증하지 않습니다. Gateway host에서 **probe `--mode verify --receipt`만** 18개 clean completion과 실제 template/model/build 증거를 통과한 후 receipt를 atomic rename으로 발급합니다. 최대 유효 기간은 24시간이며 재시작 또는 model/build/template/prompt/schema/settings 변경 후 재검증해야 합니다. 매 승격 시 제한된 metadata 검증도 필요합니다. [정확한 검증/rollback 절차](docs/deployment.md#모델-활성화-preflight-gateway-host에서만)를 따르세요.

새 evaluator readiness에는 `node tools/nli/eval-bound-probe.mjs --endpoint lfm|qwen --mode verify --output <fresh-report>` (`qwen`은 `--receipt <configured-path>` 추가)를 사용합니다. adapter는 기존 atomic probe 발급 API를 호출하되 **검증 시작 전에** 현재 runtime payload/settings/fixture/prompt/schema의 `evaluationBinding`을 캡처합니다. ordinary/과거 report에 새 binding을 덧붙이면 안 됩니다. producer/runtime projection 불일치도 activation blocker입니다. 배포 workflow는 PM2를 delete/start하지 않고 **재시작 전** 등록 환경·실제 PID·receipt 경로를 private checkpoint한 뒤 같은 환경으로 restart/rollback하며 revision stamp만 변경합니다. 환경 snapshot은 성공/실패 후 host cleanup으로 제거합니다.

첫 업그레이드의 이전 config에 `cascade`가 없어도 checkpoint는 가능합니다. 기존 config의 receipt 경로, 명시적 `NLI_QWEN_VERIFICATION_FILE`, workspace 기본 `.nli/qwen-no-thinking.json` 순으로 이전 파일/부재를 기록하며 이를 검증된 receipt로 간주하지 않습니다. checkout 후에는 새 config와 bound-probe/eval 검증을 반드시 통과해야 합니다. listener 불일치 로그는 PID와 고정 사유만 남기며 raw command line을 출력하지 않습니다.

## 테스트

Node24와 `package.json`의 고정 pnpm 버전을 기준으로 다층 테스트 하네스를 실행합니다. 아래 명령은 Linux/Windows PowerShell 공통이며 workflow shell 계약 검증에는 Bash가 필요합니다. 기본 테스트는 실제 LLM/API/LAN이나 운영 secret을 사용하지 않습니다.

```text
pnpm install --frozen-lockfile
pnpm test:check
pnpm test:list
pnpm exec playwright install chromium
pnpm test:ci
node tools/test-harness.mjs run --level integration --runner node --out-dir test-results/local-node
```

`test:unit`, `test:integration`, `test:e2e`는 수준별 선택이고 `test:blackbox`, `test:whitebox`는 별도의 검증 방식 필터입니다. `test:node`, `test:browser`는 runner별 선택입니다. 전체 실행은 파일을 중복 실행하지 않습니다. [테스트 문서](docs/testing.md)에 필터 조합, 보고서 경로, 브라우저 설치와 실패 조사 절차가 있습니다.

GitHub의 **CI**는 모든 branch push/PR/수동 실행에서 hosted runner로 검사하고 **Verify portfolio**가 필수 lane 결과를 집계합니다. 로컬 commit만으로 Actions가 실행되지는 않으며 push가 필요합니다. hook은 설치하지 않습니다. 기존 main push 배포는 독립 실행되므로 CI 성공이 배포 순서·branch protection·실제 모델 readiness를 보장하지 않습니다. 실제 LLM 검증은 기본 테스트가 아닌 [별도 승인 후 운영 preflight](docs/deployment.md#모델-활성화-preflight-gateway-host에서만)입니다.

## 근거 기반 포트폴리오 도우미

`answer_portfolio`는 포트폴리오 전체, 자기소개, 프로젝트 비교와 카테고리 질문에 사용하는 근거 기반 응답입니다. Gateway가 포트폴리오 데이터에서 후보 근거를 찾고, 모델은 그 후보 안의 ID만 선택할 수 있습니다. 최종 `sources`의 ID와 label은 Gateway가 다시 조립하므로 모델이 만든 출처 표기를 신뢰하지 않습니다.

- 예시 범주는 성능 최적화(DB 튜닝, 메인 홈페이지 캐싱, N+1, HTTPS), AWS, 관측성, 동시성, Redis/Valkey, CI/CD, 비용, AI/LLM, 데이터 모델링입니다. 범주 이름으로 고정 라우팅하지 않고, 질문과 현재 근거에 따라 후보를 자동으로 고릅니다.
- 정상 local allowlist는 전체 문장 `도움말`, `사용법`, `연락처`, `연락처 보여줘`와 **유일한** 등록 target label/alias + 선택적 공백 + 정확히 `로 이동`, `으로 이동`, `보여줘`뿐입니다. NFKC/trim/Latin case-fold/공백 축약만 수행하며 구두점·보이지 않는 문자를 제거하지 않습니다. alias가 여러 ID에 걸치면 local로 선택하지 않습니다. `CateQuest로 이동`은 local, `소개로 이동`, `P95가 뭐야?`, `CateQuest 요약해줘`, 복합 문장과 정중한 이동 의역은 LFM 경로입니다. 보안 거절 및 명시적 offline `useModel:false`는 이 정상 local 경로와 별개입니다.
- 요약·프로필·연락처 의역·용어 정의·후속 설명은 LFM 기본입니다. 검증된 LFM 답변이면 즉시 종료합니다. LFM이 해결하지 못한 비교/종합/근거 있는 모호성만 scope·coverage·시간·입장·Qwen receipt 조건을 모두 만족할 때 Qwen 한 번으로 승격합니다. 일반 질문의 timeout/invalid JSON/낮은 confidence만으로는 승격하지 않습니다.
- 브라우저는 현재 위치와 완료된 최근 대화 최대 6개를 `{ role, text }` 형태로만 보냅니다. 대화는 Gateway에 저장되지 않으며, 형식이 잘못됐거나 지시 탈취가 포함된 history는 모델에 전달하기 전에 거절됩니다.
- 정상 모델 요약은 `answer_portfolio`와 근거 버튼을 사용하며 자동 스크롤하지 않습니다. 이동 intent는 자동 이동하고, 명시적 offline 경로의 legacy `summarize_project` 동작은 별도로 유지합니다. 답변 텍스트와 근거 label은 HTML로 해석하지 않습니다.
- 두 모델에 같은 transport/schema/grounding/요청 충족 검증을 적용합니다. 실패 시 scope·intent·coverage가 맞는 trusted fallback만 허용하며, 없으면 기존 `UPSTREAM_UNAVAILABLE`/503 또는 해당하는 trusted clarification/거절입니다. fallback HTTP 200은 모델 채택이 아닙니다. 보수적 근거 검증은 임의의 의미적 함의까지 보장하지 않으며 client 취소는 서버 GPU 중단 증거가 아닙니다.

## 배포 전 NLI 검증

일반 개발/CI의 전체 회귀는 위 `pnpm test:ci`를 사용합니다. 아래는 기존 **독립 배포 preflight의 직접 명령** 안내이며 hosted CI와 동일한 명령 구성이라는 뜻이 아닙니다. 운영 preflight나 rollback 검증을 하네스 성공으로 생략하지 않습니다.

다음 명령은 LAN의 LM Studio나 배포 Gateway를 호출하지 않습니다. category fixture는 요청별 fake model 응답만 사용하며, source ID와 포함/제외 문구를 함께 확인합니다.

```bash
for file in app.js nli-history.js nli-widget.js data/portfolio.js tools/*.mjs; do node --check "$file"; done
for file in tools/nli/*.mjs; do node --check "$file"; done
node -e "for (const f of ['nli/routes.json','nli/glossary.json','nli/intents.json','nli/response.schema.json','nli/model-decision.schema.json','nli/test-cases.json','nli/live-test-cases.json','nli/adversarial-test-cases.json','nli/grounded-category-test-cases.json','nli/cascade-test-cases.json','nli/model-probe-cases.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('json ok')"
node tools/nli-test.mjs --local --cases nli/test-cases.json --min-pass-rate 1
node tools/nli-test.mjs --local --cases nli/live-test-cases.json --min-pass-rate 1
node tools/nli-test.mjs --fake --cases nli/grounded-category-test-cases.json --min-pass-rate 1
node tools/nli-test.mjs --fake --cases nli/cascade-test-cases.json --min-pass-rate 1
node tools/nli-test.mjs --local --cases nli/adversarial-test-cases.json --min-pass-rate 1
node --test tools/*.test.mjs
node --test tools/nli/*.test.mjs
node --test tools/nli-widget.browser-test.mjs
```

기존 배포 preflight는 root와 `tools/nli/`의 test glob 실행 뒤 `tools/nli-widget.browser-test.mjs`를 별도로 실행합니다. 이 legacy 직접 실행 경로는 Chrome-capable Playwright module이 없으면 browser regression을 skip하며, 이를 브라우저 검증 성공으로 간주하지 않습니다. 반면 새 hosted CI는 matching Chromium을 설치하고 browser integration/E2E를 필수 실행하여 누락을 실패 처리합니다. legacy 직접 실행에는 아래처럼 module을 명시할 수 있습니다.

```bash
NLI_WIDGET_BROWSER_MODULE=/absolute/path/to/playwright-module.mjs node tools/nli-widget.browser-test.mjs
```

## 문서

- [NLI MVP 설계](docs/nli-mvp.md)
- [배포 방법](docs/deployment.md)
