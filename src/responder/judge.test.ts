import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUDGE_EFFORT, SCHEMA as JUDGE_SCHEMA, SYSTEM } from './judge.js';
import { SYSTEM_NEW } from '../replay/prompts.js';
import { SCHEMA as DRAFT_SCHEMA } from './draft.js';

test('judge 기본 effort는 low', () => {
  assert.equal(JUDGE_EFFORT, 'low');
});

test('judge·draft SCHEMA는 직렬화가 고정이다 (프롬프트 캐시 유지)', () => {
  assert.equal(JSON.stringify(JUDGE_SCHEMA), JSON.stringify(structuredClone(JUDGE_SCHEMA)));
  assert.deepEqual(JUDGE_SCHEMA.required, ['needs_my_reply', 'reason', 'topic']);
  assert.equal(JSON.stringify(DRAFT_SCHEMA), JSON.stringify(structuredClone(DRAFT_SCHEMA)));
});

test('앱 judge 문구는 재생 검증에서 채택한 new 문구와 같다', () => {
  assert.equal(SYSTEM, SYSTEM_NEW);
});
