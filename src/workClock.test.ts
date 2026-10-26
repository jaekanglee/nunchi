import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossedTime } from './workClock.js';

const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 9, d, h, m, s);

test('자동 퇴근: 지난번 확인 뒤부터 이번 확인까지(이번 포함) 사이에 그 시각이 있으면 true', () => {
  assert.equal(crossedTime(at(26, 18, 59, 50), at(26, 19, 0, 20), '19:00'), true);
  assert.equal(crossedTime(at(26, 18, 59, 30), at(26, 19, 0, 0), '19:00'), true); // 이번 확인 시각과 같으면 포함
  assert.equal(crossedTime(at(26, 19, 0, 0), at(26, 19, 0, 30), '19:00'), false); // 지난번 확인 시각과 같으면 이미 판정함
  assert.equal(crossedTime(at(26, 18, 0), at(26, 18, 0, 30), '19:00'), false);
});

test('자동 퇴근: 그 시각이 지난 뒤 켰거나 야근 중이면 다음 날 그 시각까지 false, 자정을 넘는 구간도 본다', () => {
  assert.equal(crossedTime(at(26, 20, 0), at(26, 20, 0, 30), '19:00'), false);
  assert.equal(crossedTime(at(26, 23, 59, 50), at(27, 0, 0, 20), '00:00'), true);
  assert.equal(crossedTime(at(26, 23, 59, 50), at(27, 0, 0, 20), '19:00'), false);
});
