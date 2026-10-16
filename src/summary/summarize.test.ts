import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editMark, planSummary } from './summarize.js';
import type { ThreadMessage } from '../responder/prompt.js';

const m = (ts: string, edited?: string): ThreadMessage => ({ ts, user: 'UA', name: '서연', text: `t${ts}`, ...(edited ? { edited } : {}) });
const prev = (basis_ts: string, edit_mark: string | null = basis_ts) => ({ body: '{"topic":"x"}', basis_ts, edit_mark });

test('이전 요약 없음 → 전체', () => {
  assert.deepEqual(planSummary([m('1'), m('2')]), { kind: 'full' });
});

test('정상 증분 → 기준 이후 새 메시지만', () => {
  const plan = planSummary([m('1'), m('2'), m('3'), m('4')], prev('2'));
  assert.equal(plan.kind, 'incremental');
  assert.deepEqual(plan.kind === 'incremental' && plan.newMessages.map((x) => x.ts), ['3', '4']);
  assert.equal(plan.kind === 'incremental' && plan.prevBody, '{"topic":"x"}');
});

test('기준 이전 메시지가 요약 뒤 수정됨 → 전체', () => {
  assert.deepEqual(planSummary([m('1', '5'), m('2'), m('6')], prev('2', '2')), { kind: 'full' });
  // 요약 때 이미 반영된 수정(edit_mark 이하)은 증분 유지
  assert.equal(planSummary([m('1', '1.5'), m('2'), m('6')], prev('2', '2')).kind, 'incremental');
});

test('edit_mark가 없는 이전 행은 basis_ts를 기준으로 본다', () => {
  assert.deepEqual(planSummary([m('1', '3'), m('2'), m('4')], prev('2', null)), { kind: 'full' });
  assert.equal(planSummary([m('1', '1.5'), m('2'), m('4')], prev('2', null)).kind, 'incremental');
});

test('기준 메시지가 삭제됨 → 전체', () => {
  assert.deepEqual(planSummary([m('1'), m('3')], prev('2')), { kind: 'full' });
});

test('새 메시지 0개 → none', () => {
  assert.deepEqual(planSummary([m('1'), m('2')], prev('2')), { kind: 'none' });
});

test('DM: 가장 오래된 읽은 메시지가 기준이면 증분, 기준보다 나중부터 읽었으면 전체', () => {
  assert.equal(planSummary([m('10'), m('11'), m('12')], prev('10')).kind, 'incremental');
  assert.deepEqual(planSummary([m('11'), m('12')], prev('10')), { kind: 'full' });
});

test('DM: 새 메시지가 200개를 넘어 기준이 읽기 범위 밖으로 밀리면 전체', () => {
  const read200 = Array.from({ length: 200 }, (_, i) => m(String(101 + i)));
  assert.deepEqual(planSummary(read200, prev('100')), { kind: 'full' });
});

test('editMark: 기준 ts와 읽은 메시지 edited 중 가장 나중', () => {
  assert.equal(editMark([m('1', '7'), m('2'), m('5', '6')], '5'), '7');
  assert.equal(editMark([m('1'), m('2')], '2'), '2');
});
