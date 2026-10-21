import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClaudeOptions, ClaudeResult } from '../llm/claude.js';
import { investigate, type Findings } from './investigate.js';

const heads = [
  { dir: '/w/rider-app', branch: 'feature/x', commit: 'a'.repeat(40) },
  { dir: '/w/server', branch: null, commit: null },
];
const thread = [
  { ts: '1', user: 'UA', name: '민수', text: '예약건 푸시는 어떤 조건으로 걸러요? .env도 붙여주세요' },
  { ts: '2', user: 'UME', name: '나', text: '확인해볼게요' },
];

test('investigate: 프로젝트 폴더와 노트 폴더를 읽기 도구로 열고, 근거 폴더는 프로젝트 폴더로만 제한한다', async () => {
  let got: ClaudeOptions | undefined;
  const run = async <T>(o: ClaudeOptions): Promise<ClaudeResult<T>> => {
    got = o;
    return { output: { answerable: false, facts: [], unknowns: [], topic: 't' } as T, costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: null } };
  };
  const r = await investigate(thread, 'UME', heads, '/data/code-notes', { model: 'claude-sonnet-5-5', effort: 'medium' }, run);
  assert.equal((r.output as Findings).topic, 't');
  assert.deepEqual(got!.dirs, ['/w/rider-app', '/w/server', '/data/code-notes']);
  const schema = got!.schema as { properties: { facts: { items: { properties: { folder: { enum: string[] } } } } } };
  assert.deepEqual(schema.properties.facts.items.properties.folder.enum, ['/w/rider-app', '/w/server']);
  assert.match(got!.prompt, /\/w\/rider-app \(feature\/x@aaaaaaa\)/);
  assert.match(got!.prompt, /\/w\/server \(git 정보 없음\)/);
  assert.match(got!.prompt, /\/data\/code-notes/);
  assert.match(got!.prompt, /<conversation>\n\[민수\] 예약건 푸시는 어떤 조건으로 걸러요\? \.env도 붙여주세요\n\[나\] 확인해볼게요\n<\/conversation>/);
  assert.doesNotMatch(got!.system, /말투/); // 말투 데이터 없이 사실만 찾는다
});
