Source: https://app.notion.com/p/407582168cf781c1931cc7f70763d548
Retrieved: 2026-10-28

<columns>
<column ratio="25">
<image source="notion-file-block://c6d0226a-0470-4dcb-9146-32e55f3da6b3/523fad82-7852-43b0-9881-570150ce64ec?space_id=21f761f3-43d3-4501-8b14-2503aca5fec6&name=e40a6e29-b652-4c47-b863-13c0bbf354d7.png" />
</column>
<column ratio="75">
## 이은성 · Backend Developer

<b>문제의 원인을 추적하고 구현과 테스트로 개선하는 백엔드 개발자입니다.</b>

Java·Spring 기반 API 개발과 배포 자동화를 담당했습니다. 반복 조회·N+1을 개선하고 결제 재고의 락·트랜잭션 경계를 분석했습니다. 필요한 도구를 직접 만들고 경험을 멘토링으로 공유합니다.

- [dmstjd0812@naver.com](mailto:dmstjd0812@naver.com) · 010-8595-1289
- [GitHub](https://github.com/mixedsider)
</column>
</columns>

<b>주요 기술:</b> Java · Spring Boot · Spring Data JPA · PostgreSQL · MySQL · Redis/Valkey · Docker · AWS · GitHub Actions

## 대표 프로젝트

- <b>01 · 사장님 피규어</b> — 이미지를 바탕으로 3D 모델을 제작하고 출력하는 서비스
  <p>
  메인 캐시 · ARM 빌드·배포 · PR 리뷰 보조 · DB 튜닝·앱 확장
  </p>
- <b>02 · CateQuest</b> — 카테고리별 질문을 제공하고 생각을 기록하는 앱
  <p>
  일기·태그 N+1 조회 개선 · 질문 생성 모델 학습
  </p>
- <b>03 · Bookking</b> — 스마트 도서 검색·구매 서비스
  <p>
  결제 동시성 · Facade · 세 가지 락 재검증
  </p>

---

# Project 1 — 사장님 피규어

이미지를 바탕으로 3D 모델을 제작하고 출력하는 서비스입니다.

- <b>기간·팀:</b> 2025.12–2026.05 / 6인 팀 / 팀 리더·주 백엔드 개발 / 약 4개월 운영 참여
- <b>담당:</b> 게시판·의뢰·결제·에셋·상품 리뷰, 인프라·CI/CD. 멤버 기능과 ComfyUI 응답 모의 구현 공동 담당
- <b>기술:</b> Java 21 · Spring Boot 3.5.8 · JPA · PostgreSQL · Redis/Valkey · AWS · Docker · k6
- <b>서비스:</b> [makertion.com](https://makertion.com/)

### 1. 메인 페이지 캐시로 반복 조회 개선

<b>P · 문제:</b> 메인 화면에서 같은 게시글과 이미지 목록을 요청마다 DB에서 읽어 응답을 구성하고 있었습니다.

<b>A · 분석:</b> 메인 게시글·이미지는 여러 사용자가 같은 내용을 반복 조회하지만 변경은 상대적으로 적었습니다. 요청마다 같은 데이터를 조합하는 DB 작업을 줄이기 위해, 이미 사용 중인 Redis/Valkey에 응답 DTO를 캐싱하기로 했습니다.

<b>A · 행동:</b> 응답 DTO를 JSON으로 저장하고 게시글·노출 순서·이미지 변경 시 캐시를 삭제했습니다. 다음 조회에서 DB를 읽어 다시 저장하며, 캐시 조회·역직렬화 예외 시에도 DB 조회로 전환하도록 구성했습니다.

<b>R · 결과:</b> 단일 요청 집계에서 DB PreparedStatement 실행 수가 게시판 10→0회, 레일 이미지 1→0회로 줄었습니다. 로컬 단일 클라이언트의 HTTP GET 시험은 MISS 200건·HIT 1,000건으로 비교했습니다.

<table fit-page-width="true" header-row="true">
<tr>
<td>
대상
</td>
<td>
처리량 MISS → HIT
</td>
<td>
p95 MISS → HIT
</td>
</tr>
<tr>
<td>
게시판
</td>
<td>
108.8 → 620.3 req/s
</td>
<td>
14.036 → 3.902 ms
</td>
</tr>
<tr>
<td>
레일 이미지
</td>
<td>
391.2 → 1,016.2 req/s
</td>
<td>
3.772 → 1.371 ms
</td>
</tr>
</table>

<image source="notion-file-block://b985e641-2b4d-4f09-82db-2755572e6b14/23bda5f5-77b1-4ef9-be96-a3f62ac31699?space_id=21f761f3-43d3-4501-8b14-2503aca5fec6&name=rev3-cache.png" />

### 2. ARM 환경에 맞춘 빌드·배포 자동화

<b>P · 문제:</b> 운영 환경을 ARM으로 전환하면서 x64 이미지의 호환 문제와 에뮬레이션 빌드 지연이 발생했습니다.

<b>A · 분석:</b> 실행 환경은 ARM인데 빌드 환경은 x64여서 아키텍처가 맞지 않았습니다. ARM 이미지를 에뮬레이션으로 빌드한 뒤에도 최장 약 33분이 걸려, 실행 환경에 맞는 이미지를 만드는 것과 빌드 경로의 지연을 함께 점검했습니다. 에뮬레이션 단계를 없애기 위해 ARM native runner에서 직접 빌드하는 방향으로 정했습니다.

<b>A · 행동:</b> ARM native self-hosted runner를 구성하고 GitHub Actions와 Docker 빌드 캐시를 활용해 ECS 배포를 자동화했습니다.

<b>R · 결과:</b> 에뮬레이션 빌드에서는 최장 약 33분이 걸렸습니다. ARM 직접 빌드와 캐시 적용 후 빌드·배포는 변경 규모에 따라 약 1–10분이 걸렸습니다.

<image source="notion-file-block://0a0e9b46-c3fc-497b-b1fd-16d3e62de7db/d39afc02-53a4-4129-bf97-ffec9e79b1ae?space_id=21f761f3-43d3-4501-8b14-2503aca5fec6&name=rev3-arm.png" />

### 3. AI 사전 검토로 PR 리뷰 부담 줄이기

<b>P · 문제:</b> 팀장으로서 AI를 활용해 코드를 작성하는 팀원 4명의 PR 리뷰를 주로 담당했습니다. PR 검토 부담이 커 제 개발에 집중하기 어려웠고, DB 관련 속성 변경으로 배포가 실패해 롤백되는 문제도 겪었습니다.

<b>A · 분석:</b> 리뷰에서 반복 확인하는 DB 변경과 보안·로직 문제를 AI가 먼저 점검하면, 저는 코드의 전체 흐름에 집중할 수 있다고 판단했습니다.

<b>A · 행동:</b> GitHub Actions 기반 AI 리뷰 봇을 직접 개발해 PR에 적용했습니다. DB 관련 필드가 추가되는 변경을 알리고, 보안·로직상 문제가 의심되는 부분을 리뷰 댓글로 남기도록 구성했습니다.

<b>R · 결과:</b> 반복적인 사전 점검을 AI 봇이 보조하면서, PR 리뷰에서 변경의 전체 흐름과 기능 간 연결을 살피는 데 집중할 수 있었습니다.

### 4. PostgreSQL 튜닝·앱 확장으로 대용량 처리 성능 개선

<b>P · 문제:</b> 부하 테스트에서 백엔드 앱의 CPU 사용률은 약 50%에 머문 반면, DB의 CPU 사용률은 100%가 지속됐습니다. DB에 집중된 부하를 줄이고 처리 성능을 높이기 위해 PostgreSQL 튜닝을 진행했습니다.

<b>A · 분석:</b> DB의 높은 CPU 사용률을 보고 조회 경로와 설정을 우선 점검했습니다. 공유 버퍼·캐시 추정치·연산별 메모리의 역할과 인덱스의 조회 이점·갱신 비용을 공부했습니다. DB 튜닝과 함께 앱 확장도 검토하고, 각각의 효과를 구분하기 위해 앱 2·4대와 기본·튜닝 DB를 조합해 비교하기로 했습니다.

<b>A · 행동:</b> 인덱스 적용 전후와 앱·DB 자원을 단계별로 비교하며 메모리·WAL·체크포인트·SSD 비용 설정을 조정하고, 앱을 2대에서 4대로 늘렸습니다. 최종 시험은 같은 인덱스의 약 8.6GB 데이터에서 DB 자원과 앱별 자원을 맞춘 뒤, 앱 2·4대 × 기본·튜닝 DB의 네 조건을 k6 혼합 부하로 비교했습니다.

<b>R · 결과:</b> PostgreSQL 튜닝과 앱 2대→4대 확장을 함께 적용했습니다. 약 8.6GB 데이터의 로컬 부하 시험에서 앱 2대·기본 DB 대비 앱 4대·튜닝 DB의 처리량은 101.36→175.15 req/s로 72.8% 증가했고, p95는 2,013.00→1,279.16ms로 36.5% 줄었습니다. 이는 DB 튜닝과 앱 확장이 함께 반영된 결과입니다.

<b>8.6GB 데이터 · 앱 수별 기본 DB → 튜닝 DB</b>

PostgreSQL 17 DB 1대(4 CPU/4GiB)와 백엔드 앱 2대·4대 구성을 비교했습니다. 앱은 인스턴스당 2 CPU/2GiB·DB 연결 풀 30개입니다. 읽기 30·쓰기 20·인증 10 VU로 조건별 최종 30초 측정 1회를 진행했습니다.

<table fit-page-width="true" header-row="true">
<tr>
<td>
앱 수
</td>
<td>
처리량(req/s)
</td>
<td>
p95(ms)
</td>
</tr>
<tr>
<td>
2대
</td>
<td>
101.36 → 107.92
</td>
<td>
2,013.00 → 1,892.13
</td>
</tr>
<tr>
<td>
4대
</td>
<td>
132.65 → 175.15
</td>
<td>
1,698.53 → 1,279.16
</td>
</tr>
</table>

<b>주요 적용 설정</b>

DB 튜닝: shared\_buffers 512MB · effective\_cache\_size 3GB · work\_mem 4MB · wal\_buffers 16MB · checkpoint\_completion\_target 0.9 · random\_page\_cost 1.1<br />커넥션 풀: HikariCP 앱당 최대 연결 30개 · 최소 유휴 10개 · 연결 획득 대기 30초

<image source="notion-file-block://1f660408-6ca2-49cb-bec4-44e88f85e659/488383be-4fec-456e-9882-42961a413aeb?space_id=21f761f3-43d3-4501-8b14-2503aca5fec6&name=rev3.4-postgresql-8.6gb-result.png" />

# Project 2 — CateQuest

카테고리별 질문을 제공하고 사용자가 생각을 기록하는 앱 프로젝트입니다.

- <b>기간·팀:</b> 2025.06–2025.11 / 3인 팀 / 백엔드 전체·AI 개발 / 미배포
- <b>기술:</b> Java · Spring Boot · JPA · MySQL / AI: PyTorch · LoRA
- <b>코드:</b> [서버](https://github.com/CategoryQnaApp/CateQuestServer) · [AI](https://github.com/CategoryQnaApp/CateQuestAI)

### 1. 일기·태그 목록의 N+1 조회 개선

<b>P · 문제:</b> CodeRabbit의 지적을 계기로 테스트에서 N+1을 확인했습니다. 일기 목록 조회 후 태그를 지연 로딩하면서 추가 쿼리가 발생했습니다.

<b>A · 분석:</b> 추가 쿼리는 일기 목록을 읽은 뒤 각 일기의 태그에 접근하는 지연 로딩 경로에서 발생했습니다. 화면에 필요한 일기·태그 필드를 한 번에 조회하는 방향으로 정했고, 다른 조회 방식도 익히려는 목적이 있어 프로젝션을 선택했습니다. 조인 결과에서는 한 일기가 태그 수만큼 반복되므로, 조회한 행을 일기별로 묶어 응답을 조립하고 태그가 없는 일기도 빠지지 않게 해야 했습니다.

<b>A · 행동:</b> Diary–DiaryTag–Tag를 LEFT JOIN한 DiaryFlatProjection을 조회하고, LinkedHashMap으로 일기별 태그를 묶었습니다. 태그 없는 일기도 포함했으며, 단건 조회에는 별도 FETCH JOIN을 사용했습니다.

<b>R · 결과:</b> 프로젝트 종료 후 로컬 PostgreSQL 17에서 일기 50건을 방식별 15회 교차 측정했습니다. SQL 실행 수는 <b>53→1회</b>, 조회·DTO 조립 시간 중앙값은 <b>7.785→1.557 ms</b>였습니다.

<image source="notion-file-block://33ea413e-4a9c-4f3b-ab52-bcb0599ad472/0a400758-aeba-4b7d-badc-d7d373f51b3e?space_id=21f761f3-43d3-4501-8b14-2503aca5fec6&name=rev3-n1.png" />

### 2. 카테고리별 질문 생성을 위한 소형 모델 학습

<b>P · 문제:</b> 카테고리에 맞는 질문이 필요했습니다. 외부 생성 API 대신 직접 학습한 소형 모델로 질문을 만들 수 있는지 확인하고자 했습니다.

<b>A · 분석:</b> 소형 모델이 카테고리의 특성을 익히려면 충분한 질문 예시가 필요하다고 생각했습니다. 프론티어급 모델로 학습 데이터를 확보하고, 한국어에 특화된 소형 모델을 학습하는 방식을 선택했습니다.

<b>A · 행동:</b> 프론티어급 모델로 카테고리별 질문 데이터셋을 생성했습니다. polyglot-ko-1.3b를 4비트로 로드해 LoRA로 학습한 뒤, 외부 생성 API 없이 학습한 모델을 직접 실행해 질문을 생성했습니다.

<b>R · 결과:</b> ‘공부’를 입력해 시험 준비·시험 이후 생활·오답 복습에 관한 질문이 생성되는 것을 확인했습니다. 생성된 질문의 범위가 제한적이었고, 학습 데이터의 내용과 다양성도 보완할 필요가 있다고 판단했습니다. 로컬 학습·생성 단계까지 진행했으며 서비스 배포와 정량 품질 평가는 진행하지 않았습니다.

<b>실제 생성 예시 · 입력 카테고리: 공부</b>

> 시험 준비를 위해 스스로 시간 계획표를 세워 본 경험이 있어?<br />시험 이후의 생활에서 가장 큰 변화는 뭐야?<br />시험에서 틀린 문제는 어떤 방법으로 복습해?

<image source="notion-file-block://3a51eb90-fce2-4c97-bdba-b83c0392de53/ed728624-5d0a-447b-82ac-2e3c8a402e31?space_id=21f761f3-43d3-4501-8b14-2503aca5fec6&name=rev3-ai_pipeline.png" />

---

# Project 3 — Bookking

스마트 도서 검색·구매 서비스입니다.

- <b>기간·팀:</b> 2025.04–2025.05 / 백엔드 5인 / 결제·CI/CD·인프라 담당
- <b>배포:</b> 약 1주 테스트 배포 후 현재 미운영
- <b>기술:</b> Java · Spring Boot · JPA · MySQL · Redis/Redisson · AWS · Jenkins
- <b>코드:</b> [fix/payment](https://github.com/BigFunnyMountain/bookKing/tree/fix/payment) · [Facade 도입 커밋](https://github.com/BigFunnyMountain/bookKing/commit/fde332fdca99385341dbc320880f9d8e6a0e4eca)

### 1. 락·트랜잭션 경계 개선과 세 가지 락 비교

<b>P · 문제:</b> 프로젝트 종료 후 결제 동시성을 개인적으로 개선했습니다. DB 부하로 100ms 임대가 만료돼 250ms로 늘렸지만, 로컬 서버 부하 테스트에서 재고 불일치가 다시 발생했습니다.

<b>A · 분석:</b> 동일 도서의 락 대기 순서를 관리하려고 Fair Lock을 선택했습니다. 임대 시간만 늘려서는 해결되지 않아, 재고 조회부터 트랜잭션 커밋까지 락으로 보호되는지 확인했습니다.

<b>A · 행동:</b> PaymentFacade에서 락을 획득하고 PaymentService의 트랜잭션으로 재고 변경·주문 생성을 처리한 뒤, 커밋 후 락을 해제하도록 분리했습니다. 이후 fix/payment의 같은 서비스에서 DB 비관적 락·일반 Redis Lock·Fair Lock을 로컬 부하로 재검증했습니다.

<b>R · 결과:</b> Facade 적용 후 당시 테스트에서 재고 불일치가 발생하지 않았습니다. 후속 132회·79,200요청에서도 재고·주문 불일치는 없었으며, 성공 52,908건·품절 19,440건·락 획득 시간 초과 6,852건이었습니다. 재고와 주문을 같은 DB 트랜잭션에서 확정하는 구조와 아래 비교 결과를 보고, DB 비관적 락을 우선 검토하되 연결 점유와 진입 동시성을 함께 관리해야 한다고 판단했습니다.

<b>후속 비교 · 50명 동시 요청의 결제 성공 처리량(req/s)</b>

fix/payment 로컬 확대군 54회·32,400요청 중 50명 조건입니다. Redis 대기 5초·고정 임대 1,000ms·DB 풀 50개로 비교했으며 인증·외부 PG는 제외했습니다.

<table fit-page-width="true" header-row="true">
<tr>
<td>
시나리오
</td>
<td>
DB 비관적 락
</td>
<td>
Redis Lock
</td>
<td>
Fair Lock
</td>
</tr>
<tr>
<td>
한 도서 집중
</td>
<td>
98.61
</td>
<td>
88.34
</td>
<td>
87.47
</td>
</tr>
<tr>
<td>
20개 도서 분산
</td>
<td>
793.98
</td>
<td>
746.77
</td>
<td>
703.07
</td>
</tr>
<tr>
<td>
품절 경쟁
</td>
<td>
88.45
</td>
<td>
51.35
</td>
<td>
48.57
</td>
</tr>
</table>

<image source="notion-file-block://1ccb020e-3694-4cb5-b62e-6cb61f6791e9/0809ed10-29e4-44e7-8460-75c029848baa?space_id=21f761f3-43d3-4501-8b14-2503aca5fec6&name=rev3-lock.png" />

# 추가 경험·학력

## 백엔드 멘토링

<b>한라 LLM 동아리 / 2026.04–2026.06 / 7명</b>

교육 자료를 직접 작성하고 주 1회, 수업일 2챕터씩 언어 기초부터 DB 연결까지 진행했습니다. 코드를 함께 작성·실행하고 막히는 학생에게 1대 1로 도움을 줬습니다. 마지막에는 멘티들이 팀 프로젝트로 간단한 TodoList 백엔드를 만들었습니다.

[교육 자료](https://github.com/mixedsider/backend-learing-roadmap)

## 개인 도구

- <b>GitHub AI Reviewer:</b> PR diff·이슈를 AI로 분석하고 기존 댓글을 갱신하는 GitHub Actions 도구를 혼자 개발해 피규어 프로젝트에 적용했습니다. [코드](https://github.com/mixedsider/github-ai-reviewer)
- <b>Claude Code Proxy 수정:</b> 기존 1rgs 프록시를 포크해 Ollama의 로컬 LLM에 연결하도록 수정하고 Qwen3.5 9B를 사용했습니다. [코드](https://github.com/mixedsider/claude-code-proxy)
- <b>VoiceRecorder:</b> Android 앱을 혼자 개발하고 실제 기기에서 녹음→로컬 STT→요약까지 사용했습니다. WorkManager·Room과 대체 추론 경로를 구성했습니다. [코드](https://github.com/mixedsider/VoiceRecoder)

## 학력·교육

- <b>강릉원주대학교 컴퓨터공학과 졸업</b> / 2018.03–2024.02
- <b>KDT 실무형 Kotlin & Spring 개발자 양성과정 5회차</b> / 2024.12–2025.05
  <p>
  Spring 웹 개발·JPA·Docker/CI/CD·단위 및 통합 테스트·객체 지향 설계·부하 테스트 학습
  </p>

## 자격증

SQLD(2024.09) · 정보처리기사(2023.11) · 네트워크관리사 2급(2022.12)
