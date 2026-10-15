import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, holdReasons, type Assessment } from './policy.js';

const safe: Assessment = { needs_my_reply: true, category: '단순확인·리액션', risk: 5, needs_facts_i_dont_know: false, confidence: 0.9 };

test('내 차례가 아니면 skip', () => {
  assert.equal(decide({ ...safe, needs_my_reply: false }, 'auto'), 'skip');
});

test('초안 모드에서는 안전한 건도 승인 대기', () => {
  assert.equal(decide(safe, 'draft'), 'approve');
});

test('자동 모드 + 안전한 건은 auto', () => {
  assert.equal(decide(safe, 'auto'), 'auto');
});

test('위급·민감 카테고리는 자동 모드여도 escalate', () => {
  for (const category of ['업무지시·결정', '장애·긴급', '민감'] as const) {
    assert.equal(decide({ ...safe, category }, 'auto'), 'escalate');
  }
});

test('모르는 사실이 필요하거나 위험도가 높으면 escalate', () => {
  assert.equal(decide({ ...safe, needs_facts_i_dont_know: true }, 'auto'), 'escalate');
  assert.equal(decide({ ...safe, risk: 60 }, 'auto'), 'escalate');
});

test('자동 모드여도 확신이 낮거나 위험도가 애매하면 approve', () => {
  assert.equal(decide({ ...safe, confidence: 0.7 }, 'auto'), 'approve');
  assert.equal(decide({ ...safe, risk: 30 }, 'auto'), 'approve');
  assert.equal(decide({ ...safe, category: '정보질문' }, 'auto'), 'approve');
});

test('holdReasons: 자동으로 안 보낸 이유를 전부 알려준다', () => {
  assert.deepEqual(holdReasons(safe, 'auto'), []);
  assert.deepEqual(holdReasons(safe, 'draft'), ['전송 설정이 초안 모드']);
  assert.deepEqual(holdReasons({ ...safe, category: '인사/잡담', confidence: 0.6 }, 'auto'), ['확신 0.6 (자동 전송은 0.8 이상)']);
  assert.deepEqual(holdReasons({ ...safe, category: '정보질문', risk: 30 }, 'auto'), [
    "'정보질문'은 자동 전송 대상이 아님 (인사/잡담, 단순확인·리액션만)",
    '위험 30 (자동 전송은 20 미만)',
  ]);
  assert.deepEqual(holdReasons({ ...safe, category: '장애·긴급', needs_facts_i_dont_know: true }, 'auto'), [
    "'장애·긴급'은 항상 직접 확인",
    '내가 모르는 사실이 필요함',
  ]);
});
