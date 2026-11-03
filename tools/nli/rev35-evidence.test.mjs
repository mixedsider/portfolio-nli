import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadNliContext } from './context.mjs';
import { prepareGroundedRequest } from './evidence-selection.mjs';

const context = await loadNliContext(fileURLToPath(new URL('../../', import.meta.url)));
const about = (message) => prepareGroundedRequest(message, context).candidateSources.find((card) => card.id === 'about')?.evidence || '';

test('bounded experience answers retain the requested complete record', () => {
  for (const [message, values] of [
    ['VoiceRecorder 도구를 설명해줘', ['Android', 'WorkManager', 'Room', 'github.com/mixedsider/VoiceRecoder']],
    ['자격증 알려줘', ['SQLD', '2024.09', '정보처리기사', '네트워크관리사']],
    ['학력과 교육 알려줘', ['강릉원주대학교', 'KDT', '2024.12–2025.05']],
    ['수상 이력은?', ['2024.01', '2023.12', '최우수상']],
    ['멘토링은 어떻게 했어?', ['멘티 7명', 'TodoList', 'backend-learing-roadmap']]
  ]) for (const value of values) assert.ok(about(message).includes(value), `${message}: ${value}`);
});

test('bounded AI and database case evidence retain examples and all comparison rows with scope', () => {
  for (const [message, id, values] of [
    ['CateQuest AI 질문 생성 예시를 설명해줘', 'project-catequest-ai', context.sectionById.get('project-catequest-ai').examples],
    ['DB 튜닝 앱 2대와 4대 비교 표를 설명해줘', 'project-makertion-db', ['101.36', '175.15', '30초', '1회', ...context.sectionById.get('project-makertion-db').tables.flatMap((table) => table.rows.map((row) => row[0]))]],
    ['Bookking 세 가지 락 비교 표 설명해줘', 'project-bookking-lock', ['98.61', '793.98', '88.45', '5초', '1,000ms', '인증', 'PG']]
  ]) {
    const card = prepareGroundedRequest(message, context).candidateSources.find((card) => card.id === id);
    assert.ok(card, id);
    for (const value of values) assert.ok(card.evidence.includes(value), `${id}: ${value}`);
  }
});

test('model prompt examples cannot reintroduce removed projects or past numeric claims', () => {
  assert.doesNotMatch(context.prompt, /오늘의 OTT|120\.45|41\.68|project-makertion-observability|project-makertion-cost|project-bookking-lock/);
});

test('current experience answers pass actual grounded proposal acceptance with about sources', async () => {
  const { acceptProposal } = await import('./proposal-acceptance.mjs');
  const experience = context.portfolio.experience;
  for (const [message, answer] of [
    ['VoiceRecorder 도구 설명해줘', experience.tools[2].summary],
    ['멘토링 경험 알려줘', experience.mentoring.summary],
    ['자격증 알려줘', 'SQLD, 정보처리기사, 네트워크관리사 2급을 취득했습니다.'],
    ['수상 이력 알려줘', experience.awards.map((record) => record.title).join('. ')]
  ]) {
    const prepared = prepareGroundedRequest(message, context);
    const result = acceptProposal({ intent: 'answer_portfolio', confidence: 1, answer, sourceIds: ['about'] }, context, prepared, message);
    assert.equal(result.accepted, true, `${message}: ${JSON.stringify(result)}`);
    assert.deepEqual(result.response.sources.map((source) => source.id), ['about']);
  }
});

test('revoked numeric claims are rejected even when a current source ID is supplied', async () => {
  const { acceptProposal } = await import('./proposal-acceptance.mjs');
  for (const [message, id, answer] of [
    ['CateQuest N+1 결과 설명해줘', 'project-catequest-n1', 'CateQuest는 DTO Projection으로 SQL을 54회에서 1회로 줄였습니다.'],
    ['DB 성능 개선 설명해줘', 'project-makertion-db', 'DB 평균 응답을 120.45ms에서 41.68ms로 줄였습니다.'],
    ['사장님 피규어 비용은?', 'project-makertion', 'NAT Gateway 제거로 서버 비용을 31% 절감했습니다.'],
    ['Bookking 결과 설명해줘', 'project-bookking-lock', 'Bookking의 HTTPS 응답은 200ms에서 30ms로 줄었습니다.']
  ]) {
    const prepared = prepareGroundedRequest(message, context);
    assert.equal(acceptProposal({ intent: 'answer_portfolio', confidence: 1, answer, sourceIds: [id] }, context, prepared, message).accepted, false, message);
  }
});


test('explicit overstatements of current measurement scope are rejected', async () => {
  const { acceptProposal } = await import('./proposal-acceptance.mjs');
  for (const [message, id, answer] of [
    ['DB 성능 개선 설명해줘', 'project-makertion-db', 'DB 튜닝만으로 처리량이 72.8% 증가했습니다.'],
    ['DB 성능 개선 설명해줘', 'project-makertion-db', 'DB 단독 튜닝의 처리량 개선율은 72.8%입니다.'],
    ['Bookking 락 결과 설명해줘', 'project-bookking-lock', 'Bookking의 전체 79,200요청은 모두 성공했습니다.'],
    ['CateQuest AI 질문 생성 설명해줘', 'project-catequest-ai', 'CateQuest 질문 생성 모델은 서비스 배포와 정량 품질 평가를 완료했습니다.']
  ]) {
    const prepared = prepareGroundedRequest(message, context);
    const result = acceptProposal({ intent: 'answer_portfolio', confidence: 1, answer, sourceIds: [id] }, context, prepared, message);
    assert.equal(result.accepted, false, `${message}: ${answer}`);
  }
});

test('current en dash month ranges match exact calendar endpoints without numeric fragments', async () => {
  const { quantitiesSupported } = await import('./answer-obligations.mjs');
  assert.equal(quantitiesSupported('2025.06–2025.11', '2025.06–2025.11'), true);
  assert.equal(quantitiesSupported('2025년6월부터11월까지', '2025.06–2025.11'), true);
  for (const claim of ['2025.06–2025.12', '+2025.06–2025.11', '2025.06––2025.11', '6개월', '2025.06'])
    assert.equal(quantitiesSupported(claim, '2025.06–2025.11'), false, claim);
});

test('combined tool and mentoring question retains both complete records and accepts the supported answer', async () => {
  const { acceptProposal } = await import('./proposal-acceptance.mjs');
  const message = 'VoiceRecorder와 멘토링 경험을 알려줘';
  const prepared = prepareGroundedRequest(message, context);
  const evidence = prepared.candidateSources.find((card) => card.id === 'about').evidence;
  const records = [context.portfolio.experience.tools[2], context.portfolio.experience.mentoring];
  for (const record of records) assert.ok(evidence.includes(record.summary), record.title);
  const result = acceptProposal({ intent: 'answer_portfolio', confidence: 1, answer: records.map((record) => record.summary).join(' '), sourceIds: ['about'] }, context, prepared, message);
  assert.equal(result.accepted, true);
});

test('generic AWS and k6 experience requests retain the actual infrastructure and measured trial sources', () => {
  for (const [message, id, witnesses] of [
    ['AWS 경험 있어?', 'project-makertion-cd', ['AWS', 'ECS', 'ARM']],
    ['k6 경험 있어?', 'project-makertion-db', ['k6', '8.6GB', '30초', '1회']]
  ]) {
    const card = prepareGroundedRequest(message, context).candidateSources.find((card) => card.id === id);
    assert.ok(card, id);
    for (const witness of witnesses) assert.ok(card.evidence.includes(witness), `${id}: ${witness}`);
  }
});

test('paired measurements retain the explicit unit on both original endpoints', async () => {
  const { acceptProposal } = await import('./proposal-acceptance.mjs');
  const message = 'CateQuest N+1의 소요 시간을 설명해줘';
  const prepared = prepareGroundedRequest(message, context);
  const answer = 'CateQuest N+1 조회·DTO 조립 시간 중앙값은 로컬 PostgreSQL 17의 일기 50건·방식별 15회 비교에서 7.785ms에서 1.557ms로 줄었습니다.';
  assert.equal(acceptProposal({ intent: 'answer_portfolio', confidence: 1, answer, sourceIds: ['project-catequest-n1'] }, context, prepared, message).accepted, true);
});

test('registered legacy cache wording still retrieves its exact current case', () => {
  const prepared = prepareGroundedRequest('Main 홈페이지 캐싱 최적화 요약해줘', context);
  assert.equal(prepared.coveragePossible, true);
  assert.deepEqual(prepared.candidateSources.map((card) => card.id), ['project-makertion-cache']);
});

test('the current en dash build duration range is accepted without stripping signed scalars', async () => {
  const { acceptProposal } = await import('./proposal-acceptance.mjs');
  const { quantitiesSupported } = await import('./answer-obligations.mjs');
  const message = '이 프로젝트에서 빌드 지연은 어떻게 줄였어?';
  const scoped = { ...context, currentTargetId: 'project-makertion' };
  const prepared = prepareGroundedRequest(message, scoped);
  const answer = 'Makertion은 ARM 직접 빌드와 캐시 적용 후 변경 규모에 따라 약 1–10분이 걸렸습니다.';
  assert.equal(acceptProposal({ intent: 'answer_portfolio', confidence: 1, answer, sourceIds: ['project-makertion-cd'] }, scoped, prepared, message).accepted, true);
  for (const claim of ['–10분', '-10분', '−10분', '+10분']) assert.equal(quantitiesSupported(claim, '1–10분'), false, claim);
});

test('natural deployment, evaluation and operational adoption claims cannot invert explicit limitations', async () => {
  const { acceptProposal } = await import('./proposal-acceptance.mjs');
  for (const [message, id, answer] of [
    ['CateQuest AI 질문 생성 설명해줘', 'project-catequest-ai', 'polyglot-ko-1.3b를 LoRA로 학습해 서비스에 배포했습니다.'],
    ['CateQuest AI 질문 생성 설명해줘', 'project-catequest-ai', 'CateQuest 질문 생성 모델은 정량 품질 평가를 실시했습니다.'],
    ['Bookking 락 결과 설명해줘', 'project-bookking-lock', 'Bookking에서 DB 비관적 락을 운영에 도입했습니다.']
  ]) {
    const prepared = prepareGroundedRequest(message, context);
    assert.equal(acceptProposal({ intent: 'answer_portfolio', confidence: 1, answer, sourceIds: [id] }, context, prepared, message).accepted, false, answer);
  }
});

test('declared AI/LLM experience question retains the existing local intent with current case evidence', async () => {
  const { resolveLocally } = await import('./router.mjs');
  const response = resolveLocally('AI/LLM 경험은?', context);
  assert.equal(response.intent, 'list_skill_experience');
  assert.ok(response.answer.includes('polyglot-ko-1.3b') || response.answer.includes('질문 생성'));
});

test('generic core stack experience falls back to authoritative project tags when no section names the stack', () => {
  const prepared = prepareGroundedRequest('Java 경험 있어?', context);
  assert.equal(prepared.coveragePossible, true);
  assert.ok(prepared.candidateSources.length > 0);
  for (const card of prepared.candidateSources) {
    assert.equal(card.type, 'project');
    assert.ok(card.evidence.includes('Java'));
    assert.ok(context.projectByTargetId.get(card.id).tags.some((tag) => tag.includes('Java')));
  }
});
