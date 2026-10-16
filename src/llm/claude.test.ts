import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLlm } from './claude.js';

const global = { model: 'claude-sonnet-5-5', effort: 'medium' };

test('대화별 설정이 없으면 전역 기본값', () => {
  assert.deepEqual(resolveLlm({ model: null, effort: null }, global), global);
  assert.deepEqual(resolveLlm(undefined, global), global);
});

test('대화별 설정은 항목별로 덮어쓴다', () => {
  assert.deepEqual(resolveLlm({ model: 'claude-opus-5-5', effort: null }, global), { model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(resolveLlm({ model: null, effort: 'low' }, global), { model: 'claude-sonnet-5-5', effort: 'low' });
});
import { parseUsage } from './claude';

test('parseUsage: 표준 usage 필드를 읽는다', () => {
  const u = parseUsage({
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 145, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
  });
  assert.deepEqual(u, { input: 10, output: 145, cacheRead: 900, cacheCreation: 50, thinking: null });
});

test('parseUsage: 하위 details의 thinking 필드를 찾는다', () => {
  const u = parseUsage({ usage: { input_tokens: 1, output_tokens: 145, output_tokens_details: { thinking_tokens: 92 } } });
  assert.equal(u.thinking, 92);
  assert.equal(u.cacheRead, null);
});

test('parseUsage: usage가 없으면 모두 null', () => {
  assert.deepEqual(parseUsage({}), { input: null, output: null, cacheRead: null, cacheCreation: null, thinking: null });
  assert.deepEqual(parseUsage(null), { input: null, output: null, cacheRead: null, cacheCreation: null, thinking: null });
});
