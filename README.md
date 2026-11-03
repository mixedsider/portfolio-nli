# Lee EunSung Portfolio

이은성의 Java·Spring 백엔드 개발 포트폴리오입니다. 최신 Notion 포트폴리오와 rev.3.5의 내용을 정적 웹 화면과 자연어 도우미의 공통 데이터에 반영했습니다. 내용 출처와 파일은 [자료 안내](docs/sources/README.md)를 참고하세요.

## 현재 콘텐츠

대표 프로젝트는 사장님 피규어, CateQuest, Bookking의 3개이며 상세 사례는 7개입니다.

- 사장님 피규어: 메인 캐시, ARM 빌드·배포, AI PR 사전 검토, PostgreSQL 튜닝·앱 확장.
- CateQuest: 일기·태그 N+1 조회 개선, 소형 모델 질문 생성.
- Bookking: 프로젝트 이후 개인적으로 개선한 락·트랜잭션 경계와 세 가지 락 비교.
- 추가 경험: 백엔드 멘토링, 개인 도구 3개, 학력·교육, 확인된 수상 2건과 자격.

수치 옆의 시험 조건도 사실 데이터의 일부입니다. 캐시는 단일 요청 DB 실행 수와 로컬 단일 클라이언트 시험을 구분합니다. DB 처리량 101.36→175.15 req/s(+72.8%)는 약 8.6GB 로컬 데이터에서 **DB 튜닝과 앱 2→4대 확장을 함께 적용한 결과**입니다. CateQuest의 SQL 53→1회는 프로젝트 종료 후 PostgreSQL17·일기50건·방식별15회 비교입니다. Bookking의 79,200요청에는 성공 52,908건, 품절 19,440건, 시간 초과 6,852건이 포함되며, 재고·주문 불일치 미관측을 모든 요청 성공으로 해석하지 않습니다.

이전 OTT·비용·HTTPS·관측성·CateQuest CI의 상세 경로는 현재 화면과 도우미 근거에서 제외했습니다. 현재 데이터에 없는 과거 수치나 실적을 답변에 추가하지 않습니다. 일반 용어의 정의는 프로젝트 수행 근거와 구분합니다.

## 구성

- `index.html`, `styles.css`, `app.js`: 반응형 화면과 안전한 데이터 렌더링.
- `data/portfolio.js`: 화면·Gateway가 함께 사용하는 프로필, 지표, 프로젝트, 추가 경험.
- `assets/`: 프로젝트 구조와 측정 결과 이미지.
- `nli/routes.json`, `nli/glossary.json`, `nli/system-prompt.md`: 실제 화면 대상, 용어, 근거 응답 정책.
- `tools/nli/`: 근거 선택, 모델 클라이언트, 응답 검증, HTTP 경계.
- `tests/catalog.json`: 수준·방식·실행기별 테스트 목록.

## 로컬 실행

Node24와 `package.json`의 고정 pnpm 버전을 사용합니다.

```bash
pnpm install --frozen-lockfile
node tools/static-server.mjs
```

브라우저에서 [로컬 포트폴리오](http://127.0.0.1:4173)를 엽니다. 위젯의 기본 요청 대상은 `nli-widget.js`에 정의된 운영 Gateway입니다. 로컬 화면만 실행해도 운영 도우미의 내용이 바뀌는 것은 아닙니다.

2026-11-03 연결 점검에서는 운영 Gateway의 상태 응답은 정상이었으나, `http://127.0.0.1:4173`의 사전 요청은 `403 ORIGIN_NOT_ALLOWED`로 거절됐습니다. 이 로컬 주소에서 실제 답변을 사용하려면 Gateway의 허용 Origin 설정을 확인해야 합니다. 화면·도우미 조작 검증과 실제 모델 응답 검증은 별도로 기록합니다.

변경한 Gateway를 로컬에서 직접 검증하려면 별도 터미널에서 실행합니다. 브라우저 통합 검증은 아래 `pnpm test:ci`의 격리된 테스트 앱이 로컬 Gateway와 모형 upstream을 연결해 수행합니다.

```bash
node tools/nli-gateway.mjs
```

[Gateway 상태](http://127.0.0.1:8787/api/nli/health)는 프로세스와 context 상태를 보여줍니다. 이 응답은 실제 모델 API 동작 확인을 의미하지 않습니다.

도우미 입력 예시:

```text
CateQuest로 이동
DB 최적화 보여줘
P95가 뭐야?
CateQuest N+1 해결 방법 설명해줘
AWS 경험 있어?
k6 시험 조건을 설명해줘
VoiceRecorder와 멘토링 경험을 알려줘
수상 이력 알려줘
자격증 알려줘
```

## 모델과 환경 설정

현재 기본 endpoint는 Gemini의 OpenAI 호환 API이며 요청 모델 ID는 `gemini-3.5-flash-lite`입니다. 설정의 실제 기준은 [config.mjs](tools/nli/config.mjs)와 [.env.example](.env.example)입니다. 이번 콘텐츠 변경에서 모델 ID, API transport, timeout, API key 처리와 운영 설정은 변경하지 않았습니다.

Gateway는 `.env`를 읽으며 비어 있지 않은 process 환경 변수가 우선합니다. `GEMINI_API_KEY`를 비공개 환경에 설정하세요. `GEMINI_BASE_URL`/`GEMINI_MODEL`과 기존 `LM_STUDIO_*`, `LFM_*` 호환 설정도 유지합니다. 기존 `.env`를 덮어쓰지 말고 `.env`와 `.nli/` 파일은 추적하거나 업로드하지 않습니다. 브라우저 요청에는 `NLI_ALLOWED_ORIGINS` 설정이 필요합니다.

현재 일반 Gateway 경로는 설정된 모델에 한 번 요청하고, 반환된 제안을 같은 근거·출처·요청 충족 검증으로 확인합니다. `useModel:false`의 명시적 오프라인 경로와 기존 cascade/probe 모듈은 별도 경로로 유지됩니다. 과거 LAN LFM/Qwen 평가와 당시 설정의 설명은 [이전 README 기록](docs/history/nli-readme-before-rev35.md)에 보존했습니다. 그 과거 평가 결과는 현재 Gemini 운영 상태를 입증하지 않습니다.

## 근거와 안전 경계

`answer_portfolio`의 후보 근거는 현재 데이터와 등록된 대상에서만 생성합니다. 표, 프로젝트 메타데이터·링크, 측정 조건, 생성 예시와 추가 경험도 근거에 포함합니다. 요청과 관련된 완전한 레코드를 먼저 선택한 뒤 기존 1,741byte 카드 상한을 적용해, 긴 프로필 때문에 뒤의 수상·자격·개인 도구가 사라지지 않게 합니다. 카드 최대 8개, 답변 출처 최대 6개와 대화 최근 6개 제한을 유지합니다.

모델은 전달된 후보 ID 안에서만 출처를 선택하며, 최종 출처 label은 Gateway가 등록값으로 다시 조립합니다. 답변은 HTML·Markdown·URL로 해석하지 않는 일반 텍스트이고 출처 버튼은 실제 화면 대상으로만 이동합니다. 데이터에 포함된 공개 자료 링크는 사실 근거이며, 답변 본문에 URL을 삽입할 권한을 주지 않습니다.

숫자·단위·기술 식별자와 출처 범위를 검사합니다. DB 단독 효과, 전체 요청 성공, 미배포 모델의 배포·정량 평가 완료, 검토 단계 락의 운영 도입처럼 이번 자료의 명시적 한계를 뒤집는 표현에는 추가 거절 회귀를 둡니다. 이 검증은 임의의 모든 문장에 대한 의미적 함의를 보장하지 않습니다.

HTTP origin·body·history 검증, 요청 크기·동시 작업·시간 제한, 지시 탈취 거절과 신뢰된 fallback 경계는 유지합니다. 테스트 성공이나 로컬 fallback은 실제 모델 채택·운영 준비 완료의 증거가 아닙니다.

## 검증

기본 검증은 실제 LLM·API·LAN과 운영 secret을 사용하지 않습니다.

```bash
pnpm test:check
pnpm test:node
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:ci
```

`test:unit`, `test:integration`, `test:e2e`는 수준별 선택이고 `test:blackbox`, `test:whitebox`는 방식별 선택입니다. `test:node`, `test:browser`는 실행기별 선택입니다. [테스트 안내](docs/testing.md)에 필터·보고서·브라우저 준비·실패 조사 절차가 있습니다.

실제 API 검증, 운영 재시작, 게시와 main 병합은 이 콘텐츠 갱신의 로컬 검증에 포함하지 않았습니다. 배포·rollback·기존 receipt/probe 경로는 [배포 문서](docs/deployment.md)를 참고하세요.
