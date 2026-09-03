# NLI Gateway 프로젝트 요약·이동 오분류 수정 명세

- 대상 저장소: `mixedsider/portfolio-nli`
- 기준 revision: `0004463e4ce4478ee771f264d3f78aee2a25fc5d`
- 작성일: 2026-09-03
- 상태: 구현 전 — 테스트 결과에 기반한 수정 범위 정의

## 1. 배경 및 문제 재현

운영 Gateway `https://portfolio-nli-gateway.mixedsider.cloud/api/nli`에서 특정 프로젝트를 명시한 정상 요약·이동 요청이 `reject_out_of_scope` 또는 일반 `projects` 페이지 이동으로 오분류된다.

### 운영 재현 결과

| 입력 | 기대 결과 | 실제 결과 |
|---|---|---|
| `CateQuest 프로젝트 요약해줘` | `summarize_project / project-catequest` | `reject_out_of_scope` |
| `Bookking 프로젝트 요약해줘` | `summarize_project / project-bookking` | `reject_out_of_scope` |
| `Makertion 프로젝트 설명해줘` | `summarize_project / project-makertion` 또는 근거 기반 프로젝트 답변 | `reject_out_of_scope` |
| `CateQuest 프로젝트로 이동해 주세요` | `navigate / project-catequest` | `navigate / projects` 발생 가능 |
| `Bookking 프로젝트에 이동해 주시겠어요?` | `navigate / project-bookking` | `navigate / projects` 발생 가능 |
| `CateQuest를 요약해줘` | `summarize_project / project-catequest` | 정상 |

이 문제는 Gateway 기동·CORS 장애가 아니다. Health endpoint, 허용 Origin의 preflight 및 POST 요청은 정상이다. 핵심은 **intent/target 라우팅 우선순위와 모델 계약의 불일치**다.

---

## 2. 원인

### 2.1 일반 `프로젝트` 페이지 alias가 명시 프로젝트보다 경쟁 우위가 되는 문제

- 관련 파일: `nli/routes.json`, `tools/nli/router.mjs`
- `routes.json`의 일반 page target `projects`는 `프로젝트` alias를 가진다.
- `router.mjs`의 `findBestRoute()`는 모든 target의 점수를 계산한 뒤 최고 점수 하나만 선택한다.
- 입력에 `CateQuest` 같은 프로젝트명과 `프로젝트`가 함께 있을 경우, page target이 선택될 수 있다.
- 이후 요약 처리에서 page target은 confidence 0의 reject를 반환한다.

```js
if (routeMatch && hasAny(normalizedMessage, summarizeWords)) {
  if (routeMatch.target.type === "page") {
    return rejectResponse("요약할 포트폴리오 프로젝트나 사례를 구체적으로 알려주세요.", 0);
  }
}
```

### 2.2 Gateway의 generic reject 치환

- 관련 파일: `tools/nli-gateway.mjs`
- local router가 confidence 0인 reject를 만들면 Gateway는 이를 기본 reject로 대체한다.
- 모델 timeout, invalid JSON, schema 검증 실패, candidate source 검증 실패가 겹치면 사용자는 범위 내 요청에도 `reject_out_of_scope`를 받는다.
- 사용자 화면의 confidence 1은 실제 분류 확신이 아니라 기본 reject 객체의 값일 수 있다.

### 2.3 프로젝트 요약 intent 계약 이중화

| 영역 | 현재 기대 |
|---|---|
| Router 및 기존 fixture | `summarize_project` |
| Model prompt 및 model decision schema | `answer_portfolio` |

- 모델이 legacy intent인 `summarize_project`를 반환하면 model schema에서 거부될 수 있다.
- 모델이 `answer_portfolio`를 반환하면 현재 위젯은 source 버튼만 렌더링하고 프로젝트 요약 intent처럼 자동 이동하지 않는다.
- 같은 기능에 대해 결과와 UI 정책이 모델 상태에 따라 달라진다.

### 2.4 후보 근거 검색의 영문 프로젝트명+한국어 조사 처리 부족

- 관련 파일: `tools/nli/evidence-cards.mjs`, `tools/nli/evidence-ranking.mjs`
- `CateQuest를`처럼 영문 프로젝트명 뒤에 한국어 조사가 붙으면 `catequest`가 독립 토큰으로 분리되지 않을 수 있다.
- 이 경우 올바른 project evidence가 candidate source에 빠질 수 있고, 모델이 올바른 답을 제안해도 source validation에서 버려질 수 있다.

### 2.5 현재 프로젝트 문맥 적용 범위가 지나치게 좁음

`currentTargetId`는 사실상 `이 프로젝트 요약해줘` 계열에만 사용된다.

다음처럼 정상적인 프로젝트 후속 질문은 현재 거절될 수 있다.

```text
이 프로젝트에서 비용은 어떻게 줄였어?
```

`currentTargetId: project-makertion`이면 해당 프로젝트의 비용 최적화 사례를 근거로 답하거나 관련 section으로 이동해야 한다.

---

## 3. 수정 목표

1. 명시 프로젝트명/별칭이 일반 page alias보다 항상 우선되게 한다.
2. 프로젝트명 + `프로젝트` + 요약/설명/이동 조합을 결정론적으로 처리한다.
3. 프로젝트 요약의 intent 및 위젯 동작 계약을 하나로 통일한다.
4. 현재 프로젝트 문맥을 요약뿐 아니라 세부 질문의 evidence retrieval에도 반영한다.
5. 별칭·띄어쓰기·조사 결합을 정규화하고 회귀 테스트로 고정한다.
6. Gateway 일시 오류에서 UI가 단순 연결 실패로 오인하지 않도록 오류 형식을 일관되게 만든다.

---

## 4. 구현 요구사항

## 4.1 라우팅 우선순위 수정 (P0)

### 대상

- `tools/nli/router.mjs`
- 필요 시 `nli/routes.json`

### 요구사항

1. `findBestRoute()`가 단일 최고 점수만 바로 반환하지 않도록 한다.
2. 명시 project/section 후보와 page 후보를 분리한다.
3. 입력에 명시 project 후보가 하나 이상 있으면 generic page target `projects`는 요약/설명/이동 의도에서 선택하지 않는다.
4. 동점 또는 유사 점수에서는 다음 우선순위를 적용한다.

```text
명시 section label/alias
> 명시 project label/alias
> project의 alias
> page label/alias
```

5. 사용자가 프로젝트 전체를 명시하면 하위 section보다 project root를 우선한다.
6. 사용자가 section 사례를 명시하면 section을 우선한다.

### 필수 기대 결과

```text
CateQuest 프로젝트 요약해줘
→ summarize_project / project-catequest

Bookking 프로젝트로 이동해줘
→ navigate / project-bookking

오늘의 OTT 프로젝트 요약해줘
→ summarize_project / project-ott

오늘의 OTT 통합 API 사례 설명해줘
→ summarize_section 또는 answer_portfolio / project-ott-api
```

---

## 4.2 명시 프로젝트 패턴의 deterministic handler 추가 (P0)

### 대상

- `tools/nli/router.mjs`
- `tools/nli/routing-vocabulary.mjs`

### 요구사항

프로젝트 target을 찾은 뒤, 아래 패턴은 모델 의존 없이 우선 처리한다.

```text
<프로젝트명> 요약해줘
<프로젝트명> 프로젝트 요약해줘
<프로젝트명> 프로젝트를 요약해줘
<프로젝트명> 설명해줘
<프로젝트명> 프로젝트 설명해줘
<프로젝트명> 보여줘
<프로젝트명>으로 이동해줘
<프로젝트명> 프로젝트로 이동해줘
```

- `요약`, `정리`, `설명`, `소개`, `핵심`, `간추려`는 프로젝트 요약 표현으로 인식한다.
- `이동`, `보여`, `열어`, `가줘`, `데려가`, `이동시켜`는 이동 표현으로 인식한다.
- project target이 명시된 상황에서 `프로젝트`라는 일반 명사는 page target으로 해석하지 않는다.

---

## 4.3 프로젝트 요약 모델 계약 정리 (P0)

### 결정 필요

아래 두 방식 중 하나를 구현 전에 확정한다.

### 권장안: deterministic `summarize_project` 유지

- 명시 프로젝트 요약/이동은 local router가 소유한다.
- 응답은 항상 `summarize_project + targetId`다.
- 위젯의 자동 이동 정책을 유지한다.
- 자유 서술 비교·카테고리 질문만 `answer_portfolio`로 보낸다.

### 대안: `answer_portfolio` 중심 통일

- model schema와 prompt는 단순해진다.
- 대신 `answer_portfolio`에도 명시 target과 자동 이동 여부 계약이 필요하다.
- 기존 `summarize_project` fixture, response schema, 위젯 로직을 함께 변경해야 한다.

### 공통 요구사항

- `nli/intents.json`의 예제, `nli/test-cases.json`, `nli/live-test-cases.json`, `nli/system-prompt.md`, `nli/model-decision.schema.json`이 같은 intent 계약을 가져야 한다.
- 선언된 intent 예제를 실제 router 및 Gateway 테스트에 모두 실행해 불일치를 차단한다.

---

## 4.4 Evidence retrieval 정규화 개선 (P1)

### 대상

- `tools/nli/evidence-cards.mjs`
- `tools/nli/evidence-ranking.mjs`

### 요구사항

1. 영문 프로젝트명 뒤의 한국어 조사를 분리하거나 정규화한다.

```text
CateQuest를 → catequest
Bookking의 → bookking
Makertion에서 → makertion
```

2. 공백·대소문자·기호 변형을 정규화한다.

```text
Cate Quest → CateQuest
오늘의OTT → 오늘의 OTT
```

3. `currentTargetId`가 유효하면 해당 project/section evidence를 후보 pool에 우선 포함한다.
4. 명시 project/section을 찾은 경우 후보 pool에서 관련 evidence가 빠지지 않도록 한다.

---

## 4.5 currentTargetId 기반 후속 질문 처리 (P1)

### 대상

- `tools/nli/router.mjs`
- `tools/nli/evidence.mjs` 및 관련 ranking 모듈

### 요구사항

다음과 같은 대명사 기반 프로젝트 질문을 처리한다.

```text
이 프로젝트에서 비용은 어떻게 줄였어?
여기서 동시성 문제는 어떻게 해결했어?
이 서비스의 CI/CD 방식은 뭐야?
현재 프로젝트의 DB 최적화 사례를 알려줘
```

- `currentTargetId`가 project이면 해당 project의 section/evidence만 우선 검색한다.
- 질문이 특정 section과 충분히 매칭되면 `summarize_section` 또는 `navigate`로 처리한다.
- 자유 답변이 적합하면 `answer_portfolio`로 처리하되 관련 project evidence를 필수 후보로 넣는다.
- 현재 target이 없고 history도 부족한 경우에만 명확한 확인 질문 또는 낮은 confidence reject를 반환한다.

---

## 4.6 별칭 및 오타 처리 (P1)

### 대상

- `nli/routes.json`
- 정규화/유사도 처리 모듈

### 최소 alias

| 프로젝트 | 추가 alias |
|---|---|
| CateQuest | `Cate Quest`, `카테퀘스트`, `케이트퀘스트`, `케이트 퀘스트` |
| Bookking | `북킹`, `부킹` |
| 오늘의 OTT | `오늘의OTT`, `오늘의 오티티`, `오티티` |
| Makertion | `메이커션` |

### 요구사항

- alias가 정확히 하나의 프로젝트로만 해석되면 해당 target을 사용한다.
- 오타가 한 프로젝트에만 유사하면 일반 `projects` 이동보다 확인 메시지 또는 후보 project를 제시한다.
- 불확실한 경우에는 범위 밖 거절이 아니라 포트폴리오 내부 확인 메시지를 사용한다.

---

## 4.7 오류 응답 및 프런트 안내 개선 (P2)

### 대상

- `tools/nli-gateway.mjs`
- `nli-widget.js`

### 요구사항

1. validation 오류, request too large, rate limit, upstream/model failure, 범위 밖 거절을 구분 가능한 오류 코드로 반환한다.
2. 5xx 또는 upstream 일시 장애 시 가능한 deterministic fallback을 먼저 사용한다.
3. fallback도 불가능하면 JSON 형태와 request ID를 일관되게 반환한다.
4. 위젯은 5xx를 단순히 “Gateway가 꺼져 있음”으로 단정하지 않는다.

예시:

```json
{
  "intent": "reject_out_of_scope",
  "errorCode": "UPSTREAM_UNAVAILABLE",
  "requestId": "...",
  "message": "도우미 응답을 일시적으로 가져오지 못했습니다. 잠시 후 다시 시도해주세요."
}
```

> `reject_out_of_scope`와 요청 형식/인프라 오류를 같은 intent로 표현하지 않는 방향도 함께 검토한다.

---

## 5. 회귀 테스트 요구사항

## 5.1 프로젝트별 필수 fixture

모든 프로젝트에 대해 아래 패턴을 추가한다.

```text
<정확한 프로젝트명> 요약해줘
<정확한 프로젝트명> 프로젝트 요약해줘
<정확한 프로젝트명> 프로젝트를 요약해줘
<정확한 프로젝트명> 프로젝트 설명해줘
<정확한 프로젝트명>으로 이동해줘
<정확한 프로젝트명> 프로젝트로 이동해줘
```

## 5.2 필수 경계 fixture

```text
Cate Quest 프로젝트를 요약해 주세요
케이트퀘스트 프로젝트를 요약해줘
북킹 프로젝트를 요약해줘
오늘의 오티티 프로젝트로 이동해줘
현재 프로젝트에서 비용은 어떻게 줄였어?
이 프로젝트에서 동시성은 어떻게 처리했어?
오늘의 OTT 프로젝트의 통합 API 내용을 알려줘
```

## 5.3 기대 검증 계층

1. **Router unit test**
   - 모델 없이 deterministic intent와 targetId를 확인한다.
2. **Gateway integration test**
   - fake model의 valid/invalid JSON, timeout, invalid source, legacy intent 제안을 확인한다.
3. **Model proposal contract test**
   - system prompt, schema, intents, response contract의 허용 intent가 일치하는지 확인한다.
4. **Evidence retrieval test**
   - `CateQuest를`, `Bookking의`, 공백/별칭 입력에서도 올바른 candidate source가 포함되는지 확인한다.
5. **운영 live test**
   - 실제 Gateway에 허용 Origin과 함께 호출한다.
   - 각 배포 후 명시 프로젝트 요약/이동 fixture는 100% 통과해야 한다.
6. **Browser regression test**
   - 실제 위젯에서 입력 → 응답 렌더링 → target scroll/source button 동작까지 확인한다.

---

## 6. 완료 기준

다음이 모두 충족돼야 수정 완료로 판단한다.

- [ ] `CateQuest 프로젝트 요약해줘` → `summarize_project / project-catequest`
- [ ] `Bookking 프로젝트 요약해줘` → `summarize_project / project-bookking`
- [ ] `Makertion 프로젝트 설명해줘` → 프로젝트 요약/근거 기반 답변, 범위 밖 거절 금지
- [ ] `CateQuest 프로젝트로 이동해 주세요` → `navigate / project-catequest`
- [ ] `오늘의 OTT 프로젝트 요약해줘` → project root 요약, 하위 API 사례로 임의 축소 금지
- [ ] valid `currentTargetId`가 있는 세부 프로젝트 질문이 관련 evidence 또는 section으로 연결됨
- [ ] 영문명+한국어 조사, 공백 alias, 최소 alias fixture가 모두 통과함
- [ ] `nli/intents.json`의 모든 예제가 실제 router/Gateway 결과와 일치함
- [ ] 기존 보안 fixture(prompt injection, malformed history, origin 제한, request size, rate limit)가 계속 통과함
- [ ] 운영 live test와 실제 브라우저 위젯 회귀 테스트가 통과함

---

## 7. 구현 범위 제외

이번 수정 범위에는 다음을 포함하지 않는다.

- 포트폴리오 데이터의 사실 내용 변경
- 프로젝트 문구/이미지/UI 디자인 재작성
- 외부 범용 챗봇 기능 추가
- 임의의 LLM 자유 생성 범위 확장

목표는 포트폴리오 내부의 **프로젝트 요약·이동·설명 의도에 대한 결정론적이고 일관된 처리**를 복구하는 것이다.
