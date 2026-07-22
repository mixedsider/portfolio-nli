# 포트폴리오 NLI 인수인계

갱신: 2026-07-23 (Asia/Seoul)

## 현재 상태

- 브랜치: `main` (`origin/main` 추적).
- LLM-first NLI 변경은 `0ff0604` (`Refine LLM-first portfolio NLI`)로 커밋되어 있다.
- 현재 작업 트리에는 배포 롤백의 systemd fallback을 명시적으로 검증하는 변경과, 그와 일치하도록 확장한 배포 문서가 커밋 전 상태로 남아 있다.
- 배포는 실행하지 않았다.
- 최종 전역 5-레인 리뷰를 2026-07-23에 다시 실행해 완료했다. 짧고 근거 중심인 `answer_portfolio` 제약을 추가한 뒤, 실제 Qwen 4-액션 매트릭스와 오프라인·브라우저 검증을 모두 통과했다.

## 구현된 내용

- 일반적인 안전 요청은 모델이 `navigate` / `define_term` / `answer_portfolio` / `reject` 중 하나를 제안한다.
- 게이트웨이는 canonical ID, 근거, 화면에 보이는 JSON을 검증한다.
- `reasoning_effort: none`을 사용한다.
- 기본 모델은 Qwen `.57` / `qwen/qwen3.5-9b`이며 환경 변수로 재정의할 수 있다.
- Gemma `.58`은 알려진 8초 타임아웃 문제가 있어 기본 모델이 아니다. 8초 조건 통과를 주장하면 안 된다.
- 카테고리 프롬프트와 랭킹은 넓은 다중 사례 답변과 명시적인 지표 탐색을 구분한다.
- 유효하지 않은 히스토리와 프롬프트 인젝션은 모델 호출 전에 거절한다.
- 비활성 intent 필드도 거절한다.

## 확인된 결과

- LAN을 사용하지 않은 최신 결과: 루트 Node 스위트 `56 pass / 0 fail / 2 skip`, 중첩 NLI 스위트 `24 pass / 0 fail`, 일반 fixture `37/37`, live fixture(local) `32/32`, grounded category fixture `17/17`, adversarial fixture `8/8`.
- loopback에서 카테고리 답변과 명시적 metrics 탐색을 각각 확인했다.
- 과거 Qwen 매트릭스는 네 액션 모두 8초 이내 통과(`4/4`), 액션당 모델 호출은 정확히 1회였다고 기록돼 있다. 근거: `.omo/evidence/task-8-qwen-final-matrix.md`.
- 2026-07-23 직접 LAN 재검증: Qwen `.57` / `qwen/qwen3.5-9b`은 이동 `2.5초`, 용어 `1.1초`, 근거 답변 `3.6초`, 범위 거절 `1.3초`로 네 액션 모두 통과했다(`4/4`). 각 요청의 모델 호출은 정확히 1회였고, 근거 답변은 `project-makertion-db`와 `project-makertion-cache`만 선택해 canonical 검증을 통과했다.
- 같은 직접 재검증에서 Gemma `.58` / `google/gemma-4-e4b`은 네 요청 모두 8초 timeout 뒤 안전 fallback이 반환됐다. 결과는 `0/4`이며, 통과 결과로 기록하지 않는다.
- 실제 Google Chrome 브라우저 회귀를 스킵 없이 실행했다. XSS-safe 텍스트 렌더링, 근거 버튼의 포커스·이동, P95 이동, 최근 6개 이력 제한, 새로고침 후 근거 복원을 통과했다.
- 배포 롤백은 PM2가 없을 때 등록된 user systemd 서비스만 재시작하며, 둘 다 없으면 명시적으로 실패하도록 정렬했다. 관련 배포 lifecycle 테스트도 통과했다.

## 최종 5-레인 리뷰

1. 목표·제약: 모델 제안은 `navigate` / `define_term` / `answer_portfolio` / `reject_out_of_scope`로 제한되고, Gateway가 canonical ID·근거·응답 계약을 소유하는 구조를 확인했다.
2. 실사용 QA: fixture와 실제 Google Chrome 위젯 시나리오를 통과했다. 직접 LAN 모델 검증에서 Qwen은 네 액션을 8초 이내에 통과했다. Gemma는 8초 timeout으로 기본 모델 후보가 아니다.
3. 코드 품질: JavaScript 문법 검사와 모든 Node 스위트가 통과했고, `git diff --check`도 깨끗하다.
4. 보안: HTTP 경계·CORS·rate limit·history 검증·prompt injection 거절을 테스트로 확인했고, UI의 모델 답변과 source label은 text API로 렌더링됨을 확인했다.
5. 문맥·문서·CI: `docs/deployment.md`의 preflight를 README 및 workflow와 맞췄고, rollback의 PM2/systemd 분기를 안전하게 만들었다.

## 다음 작업

1. `nli/system-prompt.md`, `tools/nli/model-client.test.mjs`, `.github/workflows/deploy-nli-gateway.yml`, `docs/deployment.md`, `plan.md`의 현재 변경을 검토해 커밋한다.
2. 모델 또는 프롬프트를 바꾸면 실제 Qwen 네 액션 매트릭스를 다시 실행해 8초 제한·요청당 모델 호출 1회·`4/4`를 확인한다.
3. 사용자가 명시적으로 요청할 때만 배포 workflow를 실행한다.

## 알려진 위험

- Qwen은 소형 로컬 모델이므로 프롬프트 변화에 민감하다.
- Gemma는 8초 타임아웃 조건과 호환되지 않는다.
- Qwen은 장문 세부 주장에서 근거성 검증에 실패할 수 있으므로, `answer_portfolio`의 짧고 카드별 대표 결과 제약을 유지해야 한다.
- 실제 운영 Gateway 배포 및 배포 후 live 검증은 아직 실행하지 않았다.

## 주요 파일

- 게이트웨이 및 라우팅: `tools/nli-gateway.mjs`, `tools/nli/router.mjs`, `tools/nli/model-client.mjs`, `tools/nli/config.mjs`.
- 근거 선택/검증: `tools/nli/evidence-ranking.mjs`, `tools/nli/response-contract-validation.mjs`.
- 계약, 프롬프트, fixture: `nli/model-decision.schema.json`, `nli/system-prompt.md`, `nli/grounded-category-test-cases.json`.
- 최신 Qwen 실행 근거: `.omo/evidence/task-8-qwen-final-matrix.md`.
