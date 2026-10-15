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
