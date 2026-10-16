import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agreement, classifyReplay, decideJudge, gateExitCode, parseArm, summarizeArm, type ResultRow } from './verdict.js';
import { NARROWED_LINE, SYSTEM_BASE, SYSTEM_NEW } from './prompts.js';
import { extractSystem } from './check-base.js';

const o = (needs: boolean | null) => ({ needs, costUsd: 0.001, usage: { input: 1, output: 20, cacheRead: 0, cacheCreation: 0, thinking: 10 } });
const r = (id: number, label: boolean, outcomes: Record<string, boolean | null>, unavailable = false): ResultRow => ({
  id, key: `C:${id}`, label, unavailable, outcomes: Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, o(v)])),
});

test('classifyReplay: 놓침·거름·통과·재조회 실패, LLM 실패는 보수적으로', () => {
  assert.equal(classifyReplay(true, false, o(true)), 'hit');
  assert.equal(classifyReplay(true, false, o(false)), 'missed');
  assert.equal(classifyReplay(true, false, o(null)), 'missed');
  assert.equal(classifyReplay(false, false, o(false)), 'filtered');
  assert.equal(classifyReplay(false, false, o(true)), 'kept');
  assert.equal(classifyReplay(false, false, o(null)), 'kept');
  assert.equal(classifyReplay(true, true, undefined), 'unavailable');
});

test('summarizeArm·agreement 집계', () => {
  const rows = [r(1, true, { a: true, b: true }), r(2, false, { a: false, b: true }), r(3, true, { a: null, b: true }), r(4, true, {}, true)];
  const s = summarizeArm(rows, 'a');
  assert.deepEqual([s.hit, s.missed, s.filtered, s.kept, s.unavailable, s.failed], [1, 1, 1, 0, 1, 1]);
  assert.equal(s.labelAgreement, 2 / 3);
  assert.deepEqual(agreement(rows, 'a', 'b'), { rate: 1 / 3, differing: [2, 3] });
});

test('gateExitCode: 2를 1보다 먼저 본다', () => {
  const missing = [r(1, true, { a: false }), r(2, true, {}, true), r(3, true, { a: true }), r(4, true, { a: true })];
  assert.equal(gateExitCode(missing, 'a'), 2); // 라벨 true 4건 중 재조회 실패 1건 = 25%
  const ok = [r(1, true, { a: false }), ...Array.from({ length: 9 }, (_, i) => r(i + 2, true, { a: true }))];
  assert.equal(gateExitCode(ok, 'a'), 1);
  assert.equal(gateExitCode(ok.slice(1), 'a'), 0);
});

test('--from 재판정: JSON 왕복 후에도 같은 종료 코드', () => {
  const rows = [r(1, true, { 'new@low': false, 'new@medium': true }), r(2, false, { 'new@low': false, 'new@medium': false })];
  const again = JSON.parse(JSON.stringify(rows)) as ResultRow[];
  for (const arm of ['new@low', 'new@medium']) assert.equal(gateExitCode(again, arm), gateExitCode(rows, arm));
  assert.equal(gateExitCode(again, 'new@low'), 1);
  assert.equal(gateExitCode(again, 'new@medium'), 0);
});

test('종료 코드 2 여부는 arm마다 같다 (무작위 픽스처)', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = () => (rand() < 0.1 ? null : rand() < 0.5);
  for (let n = 0; n < 200; n++) {
    const rows = Array.from({ length: 1 + Math.floor(rand() * 30) }, (_, i) =>
      r(i, rand() < 0.6, { a: pick(), b: pick(), c: pick() }, rand() < 0.15),
    );
    const twos = ['a', 'b', 'c'].map((arm) => gateExitCode(rows, arm) === 2);
    assert.ok(twos.every((x) => x === twos[0]));
  }
});

test('decideJudge 결정표', () => {
  assert.deepEqual(decideJudge({ a0: 0, lowMediumAgreement: 0.97 }), { action: 'adopt', prompt: 'new', effort: 'low', unstable: false });
  assert.deepEqual(decideJudge({ a0: 0, lowMediumAgreement: 0.9 }), { action: 'adopt', prompt: 'new', effort: 'low', unstable: true });
  assert.deepEqual(decideJudge({ a0: 2 }), { action: 'revert' });
  assert.deepEqual(decideJudge({ a0: 1 }), { action: 'needM' });
  assert.deepEqual(decideJudge({ a0: 1, m: 0 }), { action: 'adopt', prompt: 'new', effort: 'medium', unstable: false });
  assert.deepEqual(decideJudge({ a0: 1, m: 1 }), { action: 'needB' });
  assert.deepEqual(decideJudge({ a0: 1, m: 1, b: 0 }), { action: 'adopt', prompt: 'mid', effort: 'low', unstable: false });
  assert.deepEqual(decideJudge({ a0: 1, m: 1, b: 1 }), { action: 'revert' });
  assert.deepEqual(decideJudge({ a0: 1, m: 1, b: 2 }), { action: 'revert' });
  assert.throws(() => decideJudge({ a0: 1, m: 2 }), /도달할 수 없다/);
});

test('arm 이름 해석과 문구 변형', () => {
  assert.deepEqual(parseArm('base@low#2'), { name: 'base@low#2', prompt: 'base', effort: 'low' });
  assert.throws(() => parseArm('old@low'));
  assert.notEqual(SYSTEM_NEW, SYSTEM_BASE);
  assert.ok(SYSTEM_NEW.includes(NARROWED_LINE));
  assert.equal(extractSystem('const SYSTEM = `a\nb`;\n'), 'a\nb');
  assert.equal(extractSystem('export const SYSTEM = `x`;'), 'x');
});
