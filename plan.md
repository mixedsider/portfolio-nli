# 포트폴리오 NLI 인수인계

갱신: 2026-07-22 (Asia/Seoul)

## 현재 상태

- 브랜치: `main` (`origin/main` 추적).
- 작업 트리에는 하나의 응집된 **LLM-first NLI 변경**이 아직 커밋되지 않은 상태이며, 이 핸드오프 뒤 상위 작업자가 커밋할 예정이다.
- 배포는 실행하지 않았다.
- 최종 전역 5-레인 리뷰는 사용자의 인수인계 요청으로 의도적으로 중단되었다. 재개 시 반드시 처음부터 다시 실행하며, 최종 승인으로 간주하지 않는다.

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

- LAN을 사용하지 않은 최신 결과: 루트 Node 스위트 `56 pass / 0 fail / 2 skip`, 일반 fixture `37/37`, grounded category fixture `17/17`.
- loopback에서 카테고리 답변과 명시적 metrics 탐색을 각각 확인했다.
- 승인된 최신 Qwen 매트릭스: 네 액션 모두 8초 이내 통과(`4/4`), 액션당 모델 호출은 정확히 1회. 근거: `.omo/evidence/task-8-qwen-final-matrix.md`.
- Gemma는 이전에 8초 타임아웃으로 실패했다. 통과 결과로 기록하지 않는다.

## 다음 컴퓨터에서 재개 순서

1. 먼저 `git status`로 브랜치와 작업 트리를 확인한다. 현재 변경을 보존하고 관련 없는 변경을 되돌리지 않는다.
2. 루트 및 중첩 NLI 테스트와 fixture를 다시 실행해 현재 변경을 검증한다.
3. 필요할 때만 현재 Qwen 네 액션 매트릭스를 다시 실행하고, 8초 제한 및 액션당 정확히 한 번의 모델 호출을 확인한다.
4. 최종 5-레인 리뷰를 다시 실행한다: 목표/제약, 실사용 QA, 코드 품질, 보안, 문맥·문서·CI.
5. 다섯 레인이 모두 끝나기 전에는 최종 승인이라고 기록하지 않는다. 배포는 사용자가 명시적으로 요청한 경우에만 실행한다.

## 알려진 위험

- Qwen은 소형 로컬 모델이므로 프롬프트 변화에 민감하다.
- Gemma는 8초 타임아웃 조건과 호환되지 않는다.
- 최종 리뷰 게이트가 아직 완료되지 않았다.

## 주요 파일

- 게이트웨이 및 라우팅: `tools/nli-gateway.mjs`, `tools/nli/router.mjs`, `tools/nli/model-client.mjs`, `tools/nli/config.mjs`.
- 근거 선택/검증: `tools/nli/evidence-ranking.mjs`, `tools/nli/response-contract-validation.mjs`.
- 계약, 프롬프트, fixture: `nli/model-decision.schema.json`, `nli/system-prompt.md`, `nli/grounded-category-test-cases.json`.
- 최신 Qwen 실행 근거: `.omo/evidence/task-8-qwen-final-matrix.md`.
