import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroups, validateSetting } from './settings.js';

test('허용된 키·값만 통과', () => {
  assert.equal(validateSetting('sendMode', 'auto'), null);
  assert.equal(validateSetting('paused', 'on'), null);
  assert.equal(validateSetting('model', 'claude-opus-5-5'), null);
  assert.match(validateSetting('sendMode', 'yolo')!, /쓸 수 없는 값/);
  assert.match(validateSetting('foo', 'on')!, /알 수 없는 설정/);
});

test('그룹 멘션 설정: S로 시작하는 ID 목록 또는 none', () => {
  assert.equal(validateSetting('mentionGroups', 'S0GROUP0001'), null);
  assert.equal(validateSetting('mentionGroups', 'S0GROUP0001,S0GROUP0002'), null);
  assert.equal(validateSetting('mentionGroups', 'none'), null);
  assert.match(validateSetting('mentionGroups', 'U123')!, /쓸 수 없는 값/);
  assert.deepEqual(parseGroups('S1,S2'), ['S1', 'S2']);
  assert.deepEqual(parseGroups('none'), []);
});
