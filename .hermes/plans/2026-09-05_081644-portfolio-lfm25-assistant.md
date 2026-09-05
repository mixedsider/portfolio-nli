# 포트폴리오 LFM2.5 AI 도우미 안정 운영 구현 계획

> **For Hermes:** 구현 시 작업을 작은 단위로 나누고, 각 API·회귀 테스트의 증거를 남긴다.

**Goal:** 포트폴리오 방문자가 안전한 서버 API를 통해 LFM2.5-2.6B에 질의하고, 빈 응답·긴 reasoning·내부망 주소 노출을 견디는 AI 도우미를 실제 운영한다.

**Architecture:** 브라우저는 포트폴리오 도메인의 `/api/assistant`만 호출한다. 포트폴리오 서버가 내부망의 LM Studio OpenAI API(`http://192.168.0.106:1234/v1`)를 호출하고, 요청 문맥을 프로젝트 관련 자료로 제한한다. 모델 응답이 비어 있거나 `length`로 종료되면 서버가 축약된 문맥으로 1회만 재시도하고, 그마저 실패하면 안전한 오류 응답을 반환한다.

**Tech Stack:** 기존 포트폴리오 프런트엔드·백엔드 스택, 서버 측 OpenAI-compatible HTTP 클라이언트, LFM2.5-2.6B/LM Studio.

---

## 1. 확정된 런타임 기준

### LFM 서버

```text
base URL: http://192.168.0.106:1234/v1
model ID: lfm2.5-2.6b
format: GGUF Q4_K_M
context length: 16,384
parallel: 2
Flash Attention: 활성화
KV cache GPU offload: 활성화
관측 최고 VRAM: 1,992MiB / 3,072MiB
```

### 모델 운용 제약

- `max_tokens`가 작으면 모델의 `reasoning_content`가 예산을 소진해 최종 `content`가 빈 값일 수 있다.
- 약 11.8K-token 문맥에서 정보 회수는 성공했지만, 특정 약 7.75K-token 입력은 `max_tokens=2,048`까지도 reasoning만 생성하고 답을 끝내지 못했다.
- 따라서 긴 원문을 그대로 전달해 max token만 키우는 방식은 금지한다.
- 포트폴리오 도우미의 모델 입력은 **관련 자료만 선별하여 2K~4K tokens**를 목표로 한다.

## 2. 서비스 계약

### 외부 API: `POST /api/assistant`

#### Request

```json
{
  "message": "CateQuest에서 맡은 역할을 알려줘",
  "conversation": [
    {"role": "user", "content": "선택 사항"},
    {"role": "assistant", "content": "선택 사항"}
  ]
}
```

#### Success response

```json
{
  "answer": "...",
  "requestId": "uuid",
  "retryUsed": false
}
```

#### Controlled failure response

```json
{
  "answer": "답변을 생성하지 못했습니다. 질문을 더 구체적으로 입력해 주세요.",
  "requestId": "uuid",
  "retryUsed": true,
  "errorCode": "MODEL_EMPTY_RESPONSE"
}
```

### 서버 → LFM 요청

```json
{
  "model": "lfm2.5-2.6b",
  "messages": [
    {"role": "system", "content": "포트폴리오 안내 도우미 규칙"},
    {"role": "user", "content": "선별된 프로젝트 문맥과 방문자 질문"}
  ],
  "temperature": 0.1,
  "max_tokens": 1024
}
```

- `192.168.0.106` 주소와 LFM 모델 ID는 브라우저 JavaScript·HTML·클라이언트 로그에 노출하지 않는다.
- LFM API가 인증 없이 동작하더라도, 접근 주체는 포트폴리오 서버만으로 제한한다.
- 서버 타임아웃은 최초 요청 30초, 재시도 30초로 제한한다. 재시도 포함 60초를 넘기지 않는다.

---

## 3. 구현 전 발견 단계

### Task 1: 실제 포트폴리오 코드와 배포 경로 식별

**Objective:** 추측으로 파일을 만들지 않고 현재 AI 도우미 UI·API·배포 구조를 확정한다.

**Files:**
- Inspect: 포트폴리오 저장소의 `package.json` 또는 해당 런타임 매니페스트
- Inspect: AI 도우미 컴포넌트, API route/controller, 환경 변수 예시 파일, reverse proxy 설정

**Steps:**
1. 저장소 루트와 현재 기본 브랜치를 읽기 전용으로 확인한다.
2. `assistant`, `chat`, `openai`, `fetch`, `192.168.0.106`, `1234` 키워드를 검색한다.
3. 현재 도우미 요청 URL·모델명·`max_tokens`·오류 처리·클라이언트 직접 호출 여부를 문서화한다.
4. 프런트엔드가 정적 호스팅인지, Node/Next/Nuxt 등 서버 API를 쓸 수 있는지 확인한다.

**Acceptance criteria:**
- 실제 수정 대상 파일의 정확한 경로를 확보한다.
- 서버 측 API를 둘 수 없는 정적 구조라면, 별도 내부 API 서비스 또는 기존 백엔드 경로를 결정한다.

---

## 4. 테스트 우선 구현 단계

### Task 2: LFM 응답 정규화와 실패 판정 단위 테스트 작성

**Objective:** 정상 응답, 빈 content, `length`, HTTP 오류를 안전하게 구분한다.

**Files:**
- Create: `<repo>/src/lib/assistant/normalizeLlmResponse.ts` 또는 현재 언어·구조에 대응하는 모듈
- Create/Modify: `<repo>/tests/assistant/normalizeLlmResponse.test.*`

**Step 1: 실패 테스트 작성**

테스트 케이스:

```text
- content가 있고 finish_reason=stop → success
- content가 공백이고 finish_reason=length → retryable_empty
- HTTP 5xx/네트워크 timeout → retryable_upstream_error
- content가 있고 finish_reason=length → partial_answer로 취급하지 않고 재시도 여부를 정책으로 결정
- reasoning_content는 응답 본문·브라우저 로그에 포함하지 않음
```

**Step 2: 최소 구현**

정규화 반환값은 아래와 같은 내부 타입으로 고정한다.

```ts
type AssistantModelResult =
  | { kind: "success"; answer: string }
  | { kind: "retryable"; reason: "empty" | "length" | "upstream" }
  | { kind: "fatal"; reason: "invalid_request" | "invalid_response" };
```

**Step 3: 검증**

현재 저장소의 테스트 명령으로 해당 테스트를 실행해 모든 케이스가 통과해야 한다.

---

### Task 3: 포트폴리오 문맥 선택기 작성

**Objective:** 16K를 무분별하게 채우지 않고 질문 관련 자료만 모델에 전달한다.

**Files:**
- Create: `<repo>/src/lib/assistant/portfolioContext.*`
- Create/Modify: `<repo>/tests/assistant/portfolioContext.test.*`
- Source: 기존 프로젝트 데이터/MDX/JSON의 실제 경로

**Steps:**
1. 공통 프로필 요약(직무, 기술 스택, 연락 경로)을 짧은 정적 문맥으로 만든다.
2. 프로젝트별 자료를 다음 단위로 분리한다.
   - 사장님 피규어
   - CateQuest
   - Bookking
   - 기타 포트폴리오 항목
3. 질문 키워드와 URL/페이지 맥락으로 관련 프로젝트 1~2개만 선택한다.
4. 문맥이 목표 예산을 넘으면 상세 설명 → 성과 → 기술 태그 순서로 잘라낸다.
5. 모델 지시문에 “제공된 자료 밖의 경력·수치·기능을 만들지 말 것”을 명시한다.

**Acceptance criteria:**
- CateQuest 질문에 사장님 피규어 전체 자료가 섞이지 않는다.
- 문맥 생성 결과가 목표 2K~4K tokens 상당의 크기를 넘지 않도록 길이 제한이 있다.
- 사용자 메시지 내부의 시스템 지시 덮어쓰기 시도는 포트폴리오 사실로 취급하지 않는다.

---

### Task 4: 서버 전용 LFM 클라이언트 구현

**Objective:** 내부망 LFM 호출을 서버에만 두고, 고정된 모델·timeout·재시도 정책을 적용한다.

**Files:**
- Create: `<repo>/src/lib/assistant/lfmClient.*`
- Modify: `<repo>/.env.example` 또는 동등한 환경 변수 문서
- Test: `<repo>/tests/assistant/lfmClient.test.*`

**Configuration:**

```text
LFM_BASE_URL=http://192.168.0.106:1234/v1
LFM_MODEL=lfm2.5-2.6b
LFM_REQUEST_TIMEOUT_MS=30000
```

**Steps:**
1. 서버 환경 변수에서만 base URL과 model ID를 읽는다.
2. API body에 `temperature: 0.1`, `max_tokens: 1024`를 명시한다.
3. 응답에서 `choices[0].message.content`만 최종 answer 후보로 읽는다.
4. `reasoning_content`를 저장·반환·프런트엔드 전송하지 않는다.
5. timeout, JSON 형식 오류, 비-200, 빈 content, `finish_reason=length`를 Task 2의 정규화 정책으로 전달한다.

**Acceptance criteria:**
- 브라우저 번들에서 `LFM_BASE_URL`과 `192.168.0.106`이 검색되지 않는다.
- 모델 요청의 `model` 값이 정확히 `lfm2.5-2.6b`이다.

---

### Task 5: API route에 1회 축약 재시도 적용

**Objective:** 빈 응답이 방문자에게 그대로 표시되지 않게 한다.

**Files:**
- Modify: 실제 서버 API route/controller (Task 1에서 확인한 경로)
- Test: `<repo>/tests/assistant/api.test.*` 또는 해당 프레임워크 통합 테스트 경로

**Algorithm:**

```text
1. 입력 검증: message는 빈 문자열이 아니고 최대 길이를 제한한다.
2. 관련 포트폴리오 문맥을 선택한다.
3. LFM에 max_tokens=1024로 1차 요청한다.
4. 정상 content + stop이면 즉시 반환한다.
5. 빈 content 또는 length면:
   a. 문맥을 더 짧은 요약으로 다시 만든다.
   b. 질문을 "최종 답변만 간결히 답하세요" 형태로 재구성한다.
   c. max_tokens=1536으로 딱 1회 재시도한다.
6. 재시도 실패 시 controlled failure 응답을 반환한다.
```

**금지 사항:**

```text
- max_tokens=2048 이상을 무조건 기본값으로 두지 않는다.
- 같은 장문 문맥·같은 요청을 무제한 반복하지 않는다.
- 모델의 reasoning_content를 사용자에게 반환하지 않는다.
```

**Acceptance criteria:**
- 빈 `content`가 UI에 빈 말풍선으로 렌더링되지 않는다.
- 요청당 LFM 호출 횟수는 최대 2회다.
- API 응답에는 `retryUsed`가 정확히 반영된다.

---

### Task 6: 프런트엔드 도우미 UI 연결 및 오류 상태 구현

**Objective:** 방문자가 요청 상태·정상 응답·안전한 실패 메시지를 구분해 볼 수 있게 한다.

**Files:**
- Modify: Task 1에서 확인한 AI 도우미 컴포넌트
- Test: 해당 컴포넌트 테스트 또는 E2E 테스트

**Steps:**
1. 클라이언트 호출 대상을 상대 경로 `/api/assistant`로 고정한다.
2. 요청 진행 중에는 전송 버튼을 비활성화하고 로딩 상태를 표시한다.
3. success의 `answer`만 렌더링한다.
4. controlled failure에서는 재시도 루프를 UI에서 만들지 않고 서버 제공 메시지만 표시한다.
5. HTTP 오류에서는 "현재 도우미 연결이 지연되고 있습니다"라는 사용자용 문구를 표시한다.
6. console/network/error boundary에 내부 URL·원문 모델 응답·reasoning을 출력하지 않는다.

---

## 5. 실운영 검증 단계

### Task 7: API 계약 및 회귀 검증

**Objective:** 프런트엔드·서버·LFM 간 실제 연결을 증명한다.

**Verification cases:**

```text
1. 사장님 피규어 역할 질문 → 관련 자료만 근거로 답변
2. CateQuest 기술 질문 → 관련 기술과 역할 답변
3. Bookking 소개 질문 → 프로젝트 범위 답변
4. 포트폴리오에 없는 사실 질문 → 추측하지 않고 모른다고 안내
5. 매우 긴 질문 → 입력 제한 또는 안전한 축약
6. LFM이 빈 content/length를 반환하도록 mock → 1회 축약 재시도 확인
7. LFM upstream timeout mock → controlled failure 확인
8. 브라우저 Network 탭 → `/api/assistant`만 보이고 사설 LFM IP 미노출 확인
```

### Task 8: 부하·VRAM 안정성 검증

**Objective:** 16K/parallel=2가 실제 도우미 요청 형태에서 안정적인지 확인한다.

**Steps:**
1. 프로젝트 문맥 약 3K~4K tokens와 `max_tokens=1024`로 단일 요청을 10회 반복한다.
2. 동일 요청 2개를 동시에 보내 parallel=2를 확인한다.
3. `.106`에서 `nvidia-smi`로 peak VRAM, GPU utilization, 오류 여부를 기록한다.
4. peak VRAM이 2.5GiB를 넘거나 OOM/서버 재시작/응답 timeout이 발생하면 context·문맥 선택 예산을 낮춘다.

**Pass criteria:**

```text
- 10회 중 빈 content 0건
- 동시 2요청 모두 HTTP 200 + final content 존재
- GPU peak < 2.5GiB 권장
- API가 60초 안에 항상 종료
```

---

## 6. 배포 및 롤백

### Task 9: 설정·배포 검증

**Steps:**
1. production 환경 변수에 LFM 내부 URL을 서버 측으로만 설정한다.
2. 프로덕션 빌드 결과에서 `192.168.0.106` 문자열이 클라이언트 bundle에 없는지 확인한다.
3. 배포 전 staging 또는 로컬 production build에서 Task 7을 재실행한다.
4. 배포 직후 실제 포트폴리오에서 한 번의 정상 질문과 한 번의 실패 유도 질문을 검증한다.

### Rollback

```text
- LFM 호출 오류가 지속되면 AI 도우미의 전송 기능만 feature flag로 숨긴다.
- 포트폴리오 본문·프로젝트 페이지·이력서 링크에는 영향이 없어야 한다.
- 모델 서버 설정(16K/parallel=2)은 포트폴리오 앱 배포 실패와 독립적으로 되돌리지 않는다.
```

---

## 7. 완료 기준

```text
[ ] 실제 코드 구조 및 수정 경로 확인
[ ] 서버 전용 `/api/assistant` 연결
[ ] LFM 모델 ID와 환경 변수 검증
[ ] 관련 프로젝트 문맥 선택·상한 적용
[ ] 빈 content/length 1회 축약 재시도
[ ] UI 정상·로딩·제어된 실패 상태 구현
[ ] 단위/통합/E2E 테스트 통과
[ ] 16K/parallel=2 실부하 VRAM 및 응답 안정성 증거 확보
[ ] 브라우저에 사설 LFM URL 미노출 확인
```

## 위험과 결정

- **확정:** LFM 설정은 `context=16K`, `parallel=2`로 유지한다.
- **확정:** 기본 `max_tokens=1024`, 빈 응답 재시도 시 `1536`을 쓴다.
- **확정:** 사용자 요청마다 장문 포트폴리오 원문 전체를 주입하지 않는다.
- **확정:** 재시도는 최대 1회이며, 빈 응답을 정상 답변으로 표시하지 않는다.
- **확인 필요:** 실제 포트폴리오 코드 저장소 경로와 프레임워크/API route 구조.
- **확인 필요:** 포트폴리오 서버가 `192.168.0.106:1234` 내부망에 직접 도달 가능한지.
