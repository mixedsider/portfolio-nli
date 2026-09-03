import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const portfolioDataPath = join(projectRoot, "data", "portfolio.js");

test("프로필 소개가 백엔드·인프라 포지셔닝과 직접 제작·공유 강점을 함께 전달한다", async () => {
  const source = await readFile(portfolioDataPath, "utf8");

  assert.match(source, /headline:\s*"대용량 데이터 흐름과 운영 안정성을 설계하는 Java·Spring 백엔드 개발자"/);
  assert.match(source, /백엔드·인프라·성능 최적화·CI\/CD 자동화를 연결해 병목과 장애 원인을 추적하고/);
  assert.match(source, /필요한 문제는 직접 도구로 해결하고, 학습한 내용은 동료 및 멘티와 공유합니다/);
});

test("접힌 포트폴리오 도우미가 프로필 헤드라인을 가리지 않는다", async () => {
  const stylePath = join(projectRoot, "styles.css");
  const source = await readFile(stylePath, "utf8");

  assert.match(source, /\.nli-command\.is-collapsed\s+\.nli-launcher\s*\{[\s\S]*?width:\s*52px;/);
  assert.match(source, /\.nli-command\.is-collapsed\s+\.nli-launcher\s+span\s*\{\s*display:\s*none;/);
  assert.match(source, /\.nli-command\.is-collapsed\s*\{\s*top:\s*auto;\s*right:\s*0;/);
});
