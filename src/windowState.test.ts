import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowState, restoreBounds } from './windowState.js';

const screen = [{ x: 0, y: 25, width: 1728, height: 1092 }];

test('저장된 게 없거나 깨졌으면 기본 크기', () => {
  assert.deepEqual(restoreBounds(null, screen), { width: 1200, height: 820 });
  assert.equal(parseWindowState('{깨짐'), null);
  assert.equal(parseWindowState('{"x":1}'), null);
});

test('화면 안이면 위치·크기 그대로', () => {
  const s = parseWindowState('{"x":100,"y":80,"width":1400,"height":900,"maximized":false}');
  assert.deepEqual(restoreBounds(s, screen), { x: 100, y: 80, width: 1400, height: 900 });
});

test('빼버린 모니터 위치면 크기만 살린다', () => {
  const s = parseWindowState('{"x":3000,"y":80,"width":1400,"height":900}');
  assert.deepEqual(restoreBounds(s, screen), { width: 1400, height: 900 });
});

test('최소 크기보다 작게는 열지 않는다', () => {
  const s = parseWindowState('{"x":100,"y":80,"width":300,"height":200}');
  assert.deepEqual(restoreBounds(s, screen), { x: 100, y: 80, width: 900, height: 600 });
});
