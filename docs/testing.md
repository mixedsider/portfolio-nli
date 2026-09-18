# 테스트 하네스와 GitHub Actions

## 목적과 경계

기본 테스트는 실제 모델/API, 운영 Gateway, LAN, SSH 또는 운영 secret 없이 실행합니다. 브라우저 E2E도 **실제 정적 서버 → 실제 Gateway → loopback HTTP 가짜 LFM/Qwen**을 사용합니다. 최종 Gateway JSON을 브라우저에서 만들어 반환하는 widget 회귀는 별도의 **통합 테스트**이며 E2E 증거를 대신하지 않습니다.

Node24가 CI 기준이며, 실행 검증 환경은 Linux/Ubuntu의 Node22.22.1과 Node24.21.0입니다. `package.json`의 정확한 `packageManager` 버전의 pnpm을 사용하고 아래 예시는 저장소 루트에서 실행합니다. workflow shell 계약 테스트에는 Bash가 필요합니다. PowerShell에서도 같은 CLI 명령 형식을 사용할 수 있지만, **Windows 네이티브의 전체 하네스 실행 및 프로세스 트리 정리는 검증하지 않았습니다**. 프로세스 정리의 실행 증거는 Linux `/proc` 기반 경로에 한정되며, Git for Windows의 Bash 설치만으로 전체 Windows 호환성이 보장되지는 않습니다. 전체 CI와 같은 Linux 환경에서 실행하려면 **WSL2/Linux 사용을 권장**합니다.

## 설치와 빠른 실행 (검증 환경: Linux/Ubuntu; Windows는 WSL2 권장)

```text
pnpm --version
pnpm install --frozen-lockfile
pnpm test:check
pnpm test:list
pnpm exec playwright install chromium
pnpm test:ci
```

pnpm 버전은 `package.json`의 `packageManager`와 맞추세요. lockfile을 임의 재생성하거나 전역 Playwright를 사용하지 않습니다. `test:check`는 catalog 완전성, 기존 JavaScript 구문 및 NLI JSON fixture를 검사하며 브라우저 설치 없이 실행할 수 있습니다. 테스트 파일이 catalog에서 빠지거나 중복 등록되면 실패합니다.

CI의 임시 hosted Linux runner에서는 `pnpm exec playwright install --with-deps chromium`으로 **설치된 Playwright와 일치하는 Chromium 및 OS 의존성**을 설치합니다. 로컬 명령은 브라우저만 다운로드합니다. 로컬 Linux에서 OS 라이브러리가 부족하면 브라우저 실행은 실패하며, 이를 skip 성공으로 처리하지 않습니다. 이 하네스는 로컬 OS 패키지나 Git hook을 자동 설치하지 않습니다.

## 분류와 필터

| 축 | 값 | 의미 |
| --- | --- | --- |
| level | unit / integration / e2e | 검증하는 경계의 크기 |
| technique | blackbox / whitebox | 관찰/검증 방식; 한 파일에 둘 다 가능 |
| runner | node / playwright | 실행 도구 |

level과 technique은 별도 축입니다. blackbox/whitebox를 추가 lane으로 복제해 같은 테스트를 다섯 번 실행하지 않습니다. 파일은 하나의 level·runner에 속하고 전체 실행에서는 한 번만 실행됩니다.

```text
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm test:blackbox
pnpm test:whitebox
pnpm test:node
pnpm test:browser
node tools/test-harness.mjs list
node tools/test-harness.mjs check
node tools/test-harness.mjs run --all --out-dir test-results/local-all
node tools/test-harness.mjs run --level integration --runner node --out-dir test-results/local-node
node tools/test-harness.mjs run --level unit --technique whitebox --out-dir test-results/local-whitebox
node tools/test-harness.mjs run --runner playwright --out-dir test-results/local-browser
```

`pnpm test`와 `pnpm test:ci`는 모두 `run --all`입니다. 여러 필터는 AND로 결합합니다. `--all`과 필터 혼용, 알 수 없는 인자, 빈 선택은 오류입니다. 브라우저 설치 누락, 필수 결과 누락/손상, 0건, 비정상 종료 및 허용되지 않은 skip도 실패입니다. 위 CLI 명령의 표기 형식은 PowerShell에서도 사용할 수 있지만, Windows 네이티브 실행 검증을 의미하지는 않습니다.

## 보고서와 실패 조사

`--out-dir`로 실행별 경로를 지정하면 해당 디렉터리 아래에 공통 summary와 runner별 native 결과가 저장됩니다. Node는 native JUnit 및 V8/LCOV coverage, Playwright는 JUnit/JSON/HTML과 설정에 따라 실패 trace를 남깁니다. HTML 보고서는 `pnpm exec playwright show-report <HTML-report-directory>`, trace는 `pnpm exec playwright show-trace <trace.zip>`으로 확인합니다. 두 도구의 coverage를 가짜 단일 비율로 합치거나 임의 100% 기준을 적용하지 않습니다.

CI 보고서 루트는 다음과 같습니다.

| job | 경로 | artifact |
| --- | --- | --- |
| check | `test-results/check/check.log` | `ci-check-<run_id>-<run_attempt>` |
| node-unit | `test-results/node-unit/` | `ci-node-unit-<run_id>-<run_attempt>` |
| node-integration | `test-results/node-integration/` | `ci-node-integration-<run_id>-<run_attempt>` |
| browser | `test-results/browser/` | `ci-browser-<run_id>-<run_attempt>` |

각 lane은 성공/실패와 무관하게 자신의 결과 디렉터리 전체와 존재하는 `playwright-report/`, `coverage/`를 업로드하며 보존 기간은 14일입니다. 설치 자체가 실패하면 보고서가 없을 수 있으며 업로드도 오류가 됩니다. 업로드가 원래 테스트 실패를 성공으로 바꾸지 않습니다. 하네스가 필수 보고서의 존재/내용을 검사하고, artifact 업로드는 파일이 하나도 없으면 실패합니다. `.env`, 운영 `.nli/` receipt 또는 숨겨진 파일을 artifact에 넣지 않습니다.

## CI와 배포는 독립

`.github/workflows/ci.yml`의 이름은 `CI`입니다. 모든 branch push, pull request, 수동 `workflow_dispatch`에서 GitHub-hosted `ubuntu-latest`, Node24, `contents: read`로 실행됩니다. production secret, self-hosted runner, `pull_request_target` 및 운영 LAN은 사용하지 않습니다. fork PR 실행은 GitHub의 승인 정책에 따라 대기할 수 있습니다.

`check` 성공 후 `node-unit`, `node-integration`, `browser`가 병렬 실행됩니다. browser lane은 통합과 E2E를 함께 선택합니다. 한 lane 실패가 나머지 lane을 취소하지 않으며 workflow/ref concurrency도 진행 중 실행을 취소하지 않습니다. 마지막 job ID `verify`, 표시 이름 **Verify portfolio**는 `always()`로 실행되어 네 필수 job이 **모두 success**여야 통과합니다. failure/cancelled/skipped는 실패입니다.

기존 `deploy-nli-gateway.yml`은 main push의 독립 self-hosted 배포입니다. 자체 운영 preflight·모델 검증·rollback은 그대로이며 **CI 완료를 기다리지 않습니다**. CI 테스트 성공은 모델 readiness, 배포 순서 보장 또는 branch protection 설정이 아닙니다. required status 설정 등 저장소 정책은 별도 관리 사항이며 이 작업에서 변경하지 않습니다. CI 명령과 배포 명령이 같다는 가정도 하지 않습니다.

**로컬 commit만으로 Actions가 실행되지는 않습니다.** workflow가 GitHub에 push되거나 해당 원격 이벤트가 발생해야 합니다. 이 구현 작업은 commit/push/PR/배포 및 hook 설치를 수행하지 않습니다. 로컬 구조·shell 검증은 실제 hosted Actions 성공 증거와 구분합니다.

## Workflow 자체 검증

```text
node --check tests/harness/workflow.test.mjs
node --test tests/harness/workflow.test.mjs
```

`yaml` parser로 event 필터, hosted runner, 권한, secret 부재, 명시적 lane 구성, 필수 집계, 보고서 업로드, package CLI 계약을 검사합니다. branch 제한/self-hosted/continue-on-error/필수 job 누락·skip 등을 메모리에서 의도적으로 삽입했을 때 거부하는지도 확인합니다. 실제 Bash의 `-n` 구문 검사와 집계 shell의 모든 dependency 실패 상태 실행을 포함합니다. prose 문자열이나 임의 테스트 개수 기준을 성공 조건으로 삼지 않습니다.

## 실제 LLM 검증은 별도 opt-in

기본 하네스/CI는 실제 모델을 호출하지 않습니다. live 검증은 명시적 운영 승인 후 network-capable Gateway host에서만 [배포 문서의 모델 활성화 preflight](deployment.md#모델-활성화-preflight-gateway-host에서만)를 따릅니다. 그 절차의 fresh receipt, 현재 설정 binding, timeout 및 rollback 요건은 CI의 fake 성공으로 대체하거나 완화할 수 없습니다. `--live` 명령을 기본 `pnpm test:ci`에 추가하지 마세요.
