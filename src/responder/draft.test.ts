import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersona, MY_SCOPE_FILE } from './draft.js';

function personaDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-persona-'));
  fs.writeFileSync(path.join(dir, 'style_guide.md'), 'S');
  fs.writeFileSync(path.join(dir, 'relationships.json'), '[]');
  fs.writeFileSync(path.join(dir, 'pairs.jsonl'), '');
  return dir;
}

test('말투 분석의 담당 업무 파일이 있으면 읽고, 없거나 비었으면 넣지 않는다', () => {
  const dir = personaDir();
  assert.equal(loadPersona(dir).myScope, undefined);
  fs.writeFileSync(path.join(dir, MY_SCOPE_FILE), '  ');
  assert.equal(loadPersona(dir).myScope, undefined);
  fs.writeFileSync(path.join(dir, MY_SCOPE_FILE), '배송앱·관리자 웹\n');
  assert.equal(loadPersona(dir).myScope, '배송앱·관리자 웹');
});
