import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, pickExamples, type Persona } from './prompt.js';
import type { Pair } from '../persona/pairs.js';

const pair = (partner: string, reply: string): Pair => ({ channel: 'C', ts: '1', partner, context: 'q', reply });

test('대화 상대와의 예시를 먼저 고른다', () => {
  const pairs = [pair('UA', 'a1'), pair('UB', 'b1'), pair('UA', 'a2'), pair('UC', 'c1')];
  assert.deepEqual(pickExamples(pairs, ['UB'], 3).map((p) => p.reply), ['b1', 'a1', 'a2']);
});

test('프롬프트: 내 발화는 [나]로, Slack 데이터는 태그로 감싼다', () => {
  const persona: Persona = {
    styleGuide: 'STYLE',
    relationships: [{ user_id: 'UA', name: '서연', register: '존댓말', tone: '편함', notes: '' }],
    pairs: [],
  };
  const { context, conversation } = buildPrompt(
    [
      { ts: '1', user: 'UA', name: '서연', text: '이거 봐주실 수 있나요?' },
      { ts: '2', user: 'UME', name: '민수', text: '넵 볼게요' },
    ],
    persona,
    'UME',
  );
  assert.match(conversation, /\[서연\] 이거 봐주실 수 있나요\?/);
  assert.match(conversation, /\[나\] 넵 볼게요/);
  assert.match(conversation, /<conversation>[\s\S]*<\/conversation>/);
  assert.match(context, /서연: 존댓말/);
  assert.match(context, /STYLE/);
});

test('같은 상대의 댓글이 늘어도 context는 그대로 (프롬프트 캐시 유지)', () => {
  const persona: Persona = { styleGuide: 'STYLE', relationships: [], pairs: [pair('UA', 'a1')] };
  const t1 = [{ ts: '1', user: 'UA', name: '서연', text: '질문' }];
  const t2 = [...t1, { ts: '2', user: 'UME', name: '민수', text: '답' }, { ts: '3', user: 'UA', name: '서연', text: '추가 질문' }];
  const a = buildPrompt(t1, persona, 'UME');
  const b = buildPrompt(t2, persona, 'UME');
  assert.equal(a.context, b.context);
  assert.ok(!a.context.includes('질문'));
  assert.notEqual(a.conversation, b.conversation);
});

test('myScope: none이면 기존 context와 같고, 값이 같으면 매번 같고, 바뀌면 담당 섹션만 다르다', () => {
  const persona: Persona = { styleGuide: 'STYLE', relationships: [], pairs: [pair('UA', 'a1')] };
  const t = [{ ts: '1', user: 'UA', name: '서연', text: '질문' }];
  const base = buildPrompt(t, persona, 'UME');
  assert.equal(buildPrompt(t, persona, 'UME', 'none').context, base.context);
  const a = buildPrompt(t, persona, 'UME', '배송앱·관리자 웹');
  assert.equal(buildPrompt(t, persona, 'UME', '배송앱·관리자 웹').context, a.context);
  assert.match(a.context, /STYLE\n\n# 내 담당 업무\n배송앱·관리자 웹\n\n# 이 대화 상대와의 관계/);
  const b = buildPrompt(t, persona, 'UME', '정산');
  const strip = (s: string) => s.replace(/\n\n# 내 담당 업무\n[^\n]*/, '');
  assert.equal(strip(a.context), base.context);
  assert.equal(strip(b.context), base.context);
  assert.equal(a.conversation, base.conversation);
});
