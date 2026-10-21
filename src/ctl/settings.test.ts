import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS, parseDirs, parseGroups, thresholdsFrom, validateSetting } from './settings.js';
import { DEFAULT_THRESHOLDS } from '../responder/policy.js';

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

test('타이밍 설정: 범위 안의 정수 초만', () => {
  assert.equal(validateSetting('urgentDelaySec', '10'), null);
  assert.equal(validateSetting('autoSendMinSec', '0'), null);
  assert.match(validateSetting('urgentDelaySec', '1')!, /3~600/);
  assert.match(validateSetting('batchDelaySec', '1.5')!, /정수/);
  assert.match(validateSetting('autoSendMaxSec', '99999')!, /0~3600/);
});

test('자동 전송 기준 설정', () => {
  assert.equal(validateSetting('autoCategories', '인사/잡담,정보질문'), null);
  assert.equal(validateSetting('autoCategories', 'none'), null);
  assert.match(validateSetting('autoCategories', '민감')!, /쓸 수 없는 값/);
  assert.equal(validateSetting('autoMinConfidence', '75'), null);
  assert.match(validateSetting('autoMinConfidence', '0.8')!, /정수\(%\)/);
  assert.match(validateSetting('escalateRisk', '0')!, /1~100/);
  const get = (k: string) => SETTINGS[k].fallback;
  assert.deepEqual(thresholdsFrom(get), DEFAULT_THRESHOLDS);
});

test('코드 탐색 모델: 기본은 Haiku, 모델 목록 안에서만', () => {
  assert.equal(SETTINGS.codeModel.fallback, 'claude-haiku-5-5');
  assert.equal(validateSetting('codeModel', 'claude-sonnet-5-5'), null);
  assert.match(validateSetting('codeModel', 'off')!, /쓸 수 없는 값/);
});

test('프로젝트 폴더: 줄마다 절대 경로 하나, 없으면 none', () => {
  assert.equal(validateSetting('projectDirs', 'none'), null);
  assert.equal(validateSetting('projectDirs', '/Users/me/rider-app'), null);
  assert.equal(validateSetting('projectDirs', '/Users/me/rider app\n/Users/me/server'), null);
  assert.equal(validateSetting('projectDirs', 'C:\\work\\rider-app'), null);
  assert.match(validateSetting('projectDirs', 'rider-app')!, /쓸 수 없는 값/);
  assert.match(validateSetting('projectDirs', '/a\n\n/b')!, /쓸 수 없는 값/);
  assert.match(validateSetting('projectDirs', '')!, /쓸 수 없는 값/);
  assert.deepEqual(parseDirs('/a\n/b c'), ['/a', '/b c']);
  assert.deepEqual(parseDirs('none'), []);
});
