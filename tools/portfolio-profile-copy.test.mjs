import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = await readFile(new URL('../data/portfolio.js', import.meta.url), 'utf8');
const sandbox = { window: {} }; vm.runInNewContext(source, sandbox);
const data = JSON.parse(JSON.stringify(sandbox.window.PORTFOLIO_DATA));
test('rev3.5: 공개 자료는 대표 프로젝트 3개와 검증된 7개 사례만 제공한다', () => {
 assert.deepEqual(data.projects.map(p=>p.id), ['makertion','catequest','bookking']);
 assert.equal(data.projects.flatMap(p=>p.sections).length, 7);
 assert.ok(data.profile.contacts.some(c=>c.href==='mailto:dmstjd0812@naver.com'));
 for(const metric of data.metrics) assert.ok(data.projects.flatMap(p=>p.sections).some(s=>s.id===metric.target));
 assert.doesNotMatch(source, /54 -> 1|120\.45ms|결함 탐지율|1\.44%|mixeddev0812@gmail/);
});
test('rev3.5: 정합성과 요청 성공, 튜닝과 앱 확장을 구분한다', () => {
 const db=data.projects[0].sections.find(s=>s.id==='project-makertion-db');
 assert.match(db.result, /로컬/); assert.match(db.result,/앱/); assert.match(db.result,/튜닝/);
 assert.ok(db.measurementNotes.some(n=>n.includes('30초')&&n.includes('1회')));
 const lock=data.projects[2].sections[0];
 for(const number of ['79,200','52,908','19,440','6,852']) assert.ok(lock.result.includes(number));
 assert.match(lock.result,/우선 검토/);
 assert.equal(lock.tables[0].headers.length,4);
});
test('rev3.5: 학습 모델의 출력 한계와 후속 N+1 시험 조건을 유지한다',()=>{
 const [n1,ai]=data.projects[1].sections;
 assert.match(n1.result,/프로젝트 종료 후/); assert.match(n1.result,/PostgreSQL 17/);
 assert.match(n1.result,/53→1/); assert.match(n1.result,/7\.785→1\.557/);
 assert.match(ai.result,/정량 품질 평가/); assert.equal(ai.examples.length,3);
 assert.equal(data.experience.tools.length,3);
 assert.equal(data.experience.certifications.length,3);
});
