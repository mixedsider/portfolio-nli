# Portfolio rev.3.5 Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 최신 Notion/rev.3.5의 내용을 웹 화면과 자연어 답변 근거에 일관되게 반영한다.

**Architecture:** 정적 HTML/CSS/JS와 기존 NLI Gateway를 유지한다. data/portfolio.js의 공통 사실 데이터와 routes를 화면·도우미가 공유한다. 공개 문구/통계/그림은 최신 포트폴리오만 사용한다.

**Tech Stack:** Node24, pnpm11, vanilla HTML/CSS/JS, Playwright, node:test.

**Spec:** docs/superpowers/specs/2026-10-28-portfolio-rev35-refresh-design.md

## Global Constraints

- 프로젝트3개·사례7개; canonical ID makertion/catequest/bookking 및 기존 유효 사례ID 유지.
- 기존 NLI 보안·이동·출처·모델설정 유지. 실제 모델/LAN 호출 금지.
- 로컬/운영, 성과 종합효과/개별효과, 미관측 불일치/전체요청성공 구분.
- Naver메일·승인된 연락처, applicant 말투, 공개 rev표기없음.
- 사용자 요청대로 구현을 계속 진행한다. 별도 codex브랜치에서 로컬 검증하고 게시/병합은 하지 않는다.

## Review Focus

- 삭제한 경로가 DOM 또는 도우미 답변 근거에 남는 경우.
- 근거 축약으로 시험 조건·한계가 떨어져 나가 수치가 과장되는 경우.
- 숫자 파서 테스트의 임의 fixture를 최신 실제 데이터와 혼동해 보안 검증을 약화하는 경우.
- 모바일 표·프로젝트 헤더·도우미가 본문을 가리거나 넘치는 경우.
- 추가경험을 화면에만 넣어 도우미가 답할 수 없는 경우.

### Task 1: Canonical portfolio data and evidence assets

**Files:** data/portfolio.js, assets/rev35-*.png, docs/sources/portfolio-rev35-notion.md, tools/portfolio-profile-copy.test.mjs.

**Interfaces:** 기존 profile/metrics/projects 유지. project에 metadata:[{label,value}], links:[{label,href}] 추가. 최상위 experience:{mentoring:{title,period,summary,href},tools:[{title,summary,href}],education:[{title,period}],awards:[{title,period}],certifications:[{title,period}]} 추가. 사례의 problem/analyze/action/resultDetails는 문자열배열; tables는 기존caption/headers/rows. measurementNotes:string[]와 examples:string[] 추가 가능. 최신 조건은 result에도 간결하게 포함한다.

- [x] 기존 node테스트 기준선 실행 및 최신 내용 회귀 기대값의 실패 확인.
- [x] Notion 본문을 저장하고 3프로젝트/7사례·표/조건·이미지·추가경험 데이터로 작성.
- [x] 실제 데이터 검증과 최신 시험조건 확인.

### Task 2: Readable responsive web rendering

**Files:** index.html, styles.css, app.js, tests/e2e/portfolio.spec.mjs 및 관련 browser 테스트.

**Interfaces:** Task1의 확장데이터 소비. 기존 data-* NLI DOM, top/metrics/projects/about 및 project/case ID 보존. 신규 경험은 about 내부 렌더링. 메타데이터·링크·measurementNotes·examples도 안전하게 렌더링. 지표/개요/필터/출처버튼이 실제 target에 연결된다.

- [x] 기존화면 테스트와 메타데이터/링크/모바일 가로넘침 회귀 실패 확인.
- [x] 간결한 hero·프로젝트개요·핵심결과·PAAR상세·추가경험을 일관된 타이포/여백으로 재구성.
- [x] 데스크톱/모바일·키보드·도우미위젯동작을 검증하고 스크린샷 저장.

### Task 3: NLI sources, routes and regression synchronization

**Files:** nli/routes.json, nli/glossary.json, tools/nli/evidence-cards.mjs 및 필요시 근거 투영, tests/fixtures, 실제데이터 의존 테스트 및 nli 평가케이스, README.md.

**Interfaces:** Task1의 data와 Task2의 실제DOM ID를 사용. 과거 OTT/비용/HTTPS/관측성/CateQuestCI에 대한 수치/없는target은 근거로 제공하지 않음. experience는 about근거에 포함. 실제 모델 설정·보안경계는 유지.

- [x] 근거/경로 회귀를 최신데이터로 변경하고 실패 확인.
- [x] routes/용어관련target/근거/fixture를 동기화하고 잘못된과거주장 거절을 검증.
- [x] Node 전체회귀·브라우저회귀·최신데이터 도우미 응답 확인.
- [x] 독립 리뷰 후 실질적문제 보완, 전체변경·테스트·한계 기록.

## Progress

- 시작기준: main=origin/main fa099c9, 미커밋변경없음. codex/portfolio-rev35-refresh 생성.
- 설계범위: 사용자 화면재구성+Notion근거+도우미답변 최신화와 계속진행 요청으로 확정.

- 2026-10-28 검증: Node1,056/1,056·브라우저13/13 통과. 독립 Astra 리뷰의 중요 문제 수정·재검증 완료. 검증 기록 docs/sources/portfolio-rev35-verification.json. 실제 API·운영 배포 미실행.

- 2026-11-03: 도우미의 본문 폭 축소, 스크롤바 치수, 너비 복원과 모바일 최소화 영역을 수정했다. 모바일·태블릿·PC 독립 검증 및 전체 Node1,056/1,056·브라우저25/25 통과. 로컬 Origin의 운영 Gateway preflight는 403 ORIGIN_NOT_ALLOWED로 실제 모델 답변은 미검증이다.
- 2026-11-03: 사용자가 현재 변경의 커밋·푸시·PR 작성을 승인했다. main 병합과 운영 배포는 이번 요청에 포함되지 않는다.
