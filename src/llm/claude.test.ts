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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude } from './claude.js';

// PATH 맨 앞에 가짜 claude를 둔다. FAKE_CLAUDE 값으로 동작을 고른다
function fakeClaude(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slmmury-fake-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));
if (process.env.FAKE_CLAUDE === 'garbage') console.log('not json');
if (process.env.FAKE_CLAUDE === 'hang') setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const before = { PATH: process.env.PATH, FAKE_CLAUDE: process.env.FAKE_CLAUDE };
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  t.after(() => {
    process.env.PATH = before.PATH;
    if (before.FAKE_CLAUDE === undefined) delete process.env.FAKE_CLAUDE;
    else process.env.FAKE_CLAUDE = before.FAKE_CLAUDE;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { pid: () => Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')) };
}

const opts = { system: 's', prompt: 'p', schema: {} };
const skip = process.platform === 'win32'; // 가짜 claude가 shebang 스크립트라 Windows에서는 건너뛴다

test('runClaude: 출력이 JSON이 아니면 reject한다 (멈추지 않는다)', { skip }, async (t) => {
  fakeClaude(t);
  process.env.FAKE_CLAUDE = 'garbage';
  await assert.rejects(runClaude(opts), /JSON/);
});

test('runClaude: 제한 시간 안에 안 끝나면 프로세스를 죽이고 reject한다', { skip }, async (t) => {
  const fake = fakeClaude(t);
  process.env.FAKE_CLAUDE = 'hang';
  await assert.rejects(runClaude({ ...opts, timeoutMs: 500 }), /제한 시간/);
  assert.throws(() => process.kill(fake.pid(), 0), { code: 'ESRCH' });
});
