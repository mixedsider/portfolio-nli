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
CateQuest N+1 해결 요약해줘
CloudWatch 모니터링 보여줘
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
$env:LM_STUDIO_BASE_URL="http://192.168.0.58:1234/v1"
$env:LM_STUDIO_MODEL="google/gemma-4-e4b"
$env:LM_STUDIO_TIMEOUT_MS="8000"
node tools/nli-gateway.mjs
```

## 테스트

NLI 라우팅 테스트:

```bash
node tools/nli-test.mjs
```

JavaScript 문법 확인:

```bash
node --check app.js
node --check data/portfolio.js
node --check tools/static-server.mjs
node --check tools/nli-gateway.mjs
node --check tools/nli-test.mjs
```

## 문서

- [NLI MVP 설계](docs/nli-mvp.md)
- [배포 방법](docs/deployment.md)
