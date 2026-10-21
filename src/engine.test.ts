import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebClient } from '@slack/web-api';
import { createEngine } from './engine.js';
import { openStore, type Store } from './store/db.js';
import type { ClaudeResult } from './llm/claude.js';
import type { Judgment } from './responder/judge.js';
import type { DraftResult, generateDraft } from './responder/draft.js';
import type { Findings } from './responder/investigate.js';
import type { ThreadMessage } from './responder/prompt.js';
import type { ConversationSummary } from './summary/summarize.js';

const LINK = 'https://x.slack.com/archives/C1/p1700000000000100';
const KEY = 'C1:1700000000.000100';
const usage = { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, thinking: null };

function setup(onJudge: (store: Store) => void, needsMyReply: boolean) {
  const store = openStore(':memory:');
  let draftCalls = 0;
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: {
      read: async () => [{ ts: '1700000000.000100', user: 'UA', name: '서연', text: '이거 봐주실 수 있나요?' }],
      nameOf: async (u: string) => u,
    },
    persona: { styleGuide: 'S', relationships: [], pairs: [] },
    notify: () => {},
    onChange: () => {},
    judge: async (): Promise<ClaudeResult<Judgment>> => {
      onJudge(store);
      return { output: { needs_my_reply: needsMyReply, reason: 'r', topic: 't' }, costUsd: 0.001, usage };
    },
    draft: async (): Promise<ClaudeResult<DraftResult>> => {
      draftCalls++;
      throw new Error('호출되면 안 된다');
    },
  });
  return { store, engine, draftCalls: () => draftCalls };
}

for (const needsMyReply of [true, false]) {
  test(`판단 중에 삭제되면 초안을 만들지 않고 행도 남기지 않는다 (needs_my_reply=${needsMyReply})`, async () => {
    const { store, engine, draftCalls } = setup((s) => s.deleteWatch(KEY), needsMyReply);
    await engine.addLink(LINK);
    assert.equal(draftCalls(), 0);
    assert.equal(store.listDraftsByKey(KEY).length, 0);
  });

  test(`판단 중에 보관되면 초안을 만들지 않고 행도 남기지 않는다 (needs_my_reply=${needsMyReply})`, async () => {
    const { store, engine, draftCalls } = setup((s) => s.archiveWatch(KEY), needsMyReply);
    await engine.addLink(LINK);
    assert.equal(draftCalls(), 0);
    assert.equal(store.listDraftsByKey(KEY).length, 0);
  });
}

test('1차 판단 skip 행에 judge 비용이 남는다', async () => {
  const { store, engine } = setup(() => {}, false);
  await engine.addLink(LINK);
  const rows = store.listDraftsByKey(KEY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, '1차 판단');
  assert.equal(rows[0].judge_cost_usd, 0.001);
});

function summarySetup(thread: { current: ThreadMessage[] }) {
  const store = openStore(':memory:');
  const calls: { thread: string[]; prevBody?: string }[] = [];
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: { read: async () => thread.current, nameOf: async (u: string) => u },
    persona: { styleGuide: 'S', relationships: [], pairs: [] },
    notify: () => {},
    onChange: () => {},
    summarize: async (t, _me, _llm, prevBody): Promise<ClaudeResult<ConversationSummary>> => {
      calls.push({ thread: t.map((x) => x.ts), prevBody });
      const body = { topic: `요약${calls.length}`, headline: '', points: [], my_todos: [], waiting_on_me: false, waiting_reason: '', next_action: '' };
      return { output: body, costUsd: 0.002, usage };
    },
  });
  store.addWatch(KEY, 'C1', '1700000000.000100', 'link');
  return { store, engine, calls };
}

const msg = (ts: string, edited?: string): ThreadMessage => ({ ts, user: 'UA', name: '서연', text: ts, ...(edited ? { edited } : {}) });

test('요약: 처음은 전체, 새 메시지만 생기면 증분, 새 메시지가 없으면 LLM을 부르지 않는다', async () => {
  const thread = { current: [msg('1700000000.000100'), msg('1700000001.000000')] };
  const { store, engine, calls } = summarySetup(thread);
  await engine.summarize(KEY);
  assert.deepEqual(calls[0], { thread: ['1700000000.000100', '1700000001.000000'], prevBody: undefined });

  thread.current = [...thread.current, msg('1700000002.000000', '1700000002.500000')];
  await engine.summarize(KEY);
  assert.deepEqual(calls[1].thread, ['1700000002.000000']);
  assert.match(calls[1].prevBody!, /요약1/);
  const saved = store.latestSummary(KEY)!;
  assert.equal(saved.basis_ts, '1700000002.000000');
  assert.equal(saved.edit_mark, '1700000002.500000');
  assert.equal(saved.cost_usd, 0.002);

  await engine.summarize(KEY);
  assert.equal(calls.length, 2);
});

test('요약: 기준 이전 메시지가 요약 뒤 수정되면 전체로 다시 요약', async () => {
  const thread = { current: [msg('1700000000.000100'), msg('1700000001.000000')] };
  const { engine, calls } = summarySetup(thread);
  await engine.summarize(KEY);
  thread.current = [msg('1700000000.000100', '1700000005.000000'), msg('1700000001.000000'), msg('1700000006.000000')];
  await engine.summarize(KEY);
  assert.equal(calls[1].prevBody, undefined);
  assert.equal(calls[1].thread.length, 3);
});

test('담당 업무: 설정이 none이면 말투 분석 값, 설정하면 그 값을 judge에 넘긴다', async () => {
  const seen: (string | undefined)[] = [];
  const store = openStore(':memory:');
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: { read: async () => [{ ts: '1700000000.000100', user: 'UA', name: '서연', text: '질문' }], nameOf: async (u: string) => u },
    persona: { styleGuide: 'S', relationships: [], pairs: [], myScope: '배송앱' },
    notify: () => {},
    onChange: () => {},
    judge: async (_t, _p, _me, _llm, opts): Promise<ClaudeResult<Judgment>> => {
      seen.push(opts?.myScope);
      return { output: { needs_my_reply: false, reason: 'r', topic: 't' }, costUsd: 0, usage };
    },
  });
  await engine.addLink(LINK);
  store.setSetting('myScope', '정산');
  await engine.addLink(LINK);
  assert.deepEqual(seen, ['배송앱', '정산']);
});

test('LLM 호출은 대화 여러 개가 한꺼번에 와도 종류와 상관없이 동시에 2개까지만', async () => {
  const store = openStore(':memory:');
  let active = 0;
  let max = 0;
  const slow = async <T>(output: T): Promise<ClaudeResult<T>> => {
    max = Math.max(max, ++active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return { output, costUsd: 0, usage };
  };
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: { read: async () => [msg('1700000000.000100')], nameOf: async (u: string) => u },
    persona: { styleGuide: 'S', relationships: [], pairs: [] },
    notify: () => {},
    onChange: () => {},
    summarize: () => slow({ topic: 't', headline: '', points: [], my_todos: [], waiting_on_me: false, waiting_reason: '', next_action: '' }),
    draft: () =>
      slow({ needs_my_reply: true, category: '정보질문', risk: 10, needs_facts_i_dont_know: false, confidence: 0.9, reply: '네', reason: 'r', topic: 't' }),
  });
  const keys = ['C1:1.0', 'C2:1.0', 'C3:1.0', 'C4:1.0'];
  for (const k of keys) store.addWatch(k, k.split(':')[0], '1.0', 'link');
  await Promise.all([engine.summarize(keys[0]), engine.summarize(keys[1]), engine.requestDraft(keys[2], ''), engine.requestDraft(keys[3], '')]);
  assert.equal(max, 2);
});

function codeSetup() {
  const store = openStore(':memory:');
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-proj-'));
  fs.mkdirSync(path.join(proj, 'lib'));
  fs.writeFileSync(path.join(proj, 'lib/push.dart'), 'a\nb\nc\n');
  const notesDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-notes-')), 'code-notes');
  const investigated: { dirs: string[]; notesDir: string; model?: string }[] = [];
  const drafted: (Parameters<typeof generateDraft>[6])[] = [];
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: { read: async () => [msg('1700000000.000100')], nameOf: async (u: string) => u },
    persona: { styleGuide: 'S', relationships: [], pairs: [] },
    notify: () => {},
    onChange: () => {},
    notesDir,
    investigate: async (_t, _me, heads, nd, llm): Promise<ClaudeResult<Findings>> => {
      investigated.push({ dirs: heads.map((h) => h.dir), notesDir: nd, model: llm?.model });
      const facts = [
        { claim: '숨김 값이 true면 뺀다', folder: proj, evidence: [{ path: 'lib/push.dart', start: 1, end: 2 }] },
        { claim: '지어낸 근거', folder: proj, evidence: [{ path: 'lib/none.dart', start: 1, end: 1 }] },
      ];
      return { output: { answerable: true, facts, unknowns: ['서버 값'], topic: '푸시 필터' }, costUsd: 0.03, usage };
    },
    draft: async (_t, _p, _me, _llm, _req, _scope, code): Promise<ClaudeResult<DraftResult>> => {
      drafted.push(code);
      return { output: { needs_my_reply: true, category: '단순확인·리액션', risk: 5, needs_facts_i_dont_know: false, confidence: 0.9, reply: '네', reason: 'r', topic: 't' }, costUsd: 0, usage };
    },
  });
  store.addWatch(KEY, 'C1', '1700000000.000100', 'link');
  store.setSetting('sendMode', 'auto');
  store.setSetting('judgeModel', 'off');
  return { store, engine, proj, notesDir, investigated, drafted };
}

test('코드 보고 다시 쓰기: 탐색 결과를 검증해 저장하고 노트를 남긴 뒤, 그 사실로 초안을 써서 승인 대기에 둔다', async () => {
  const { store, engine, proj, notesDir, investigated, drafted } = codeSetup();
  store.setSetting('projectDirs', proj);
  await engine.requestDraft(KEY, '', true);
  assert.deepEqual(investigated, [{ dirs: [proj], notesDir, model: 'claude-haiku-5-5' }]); // 탐색은 코드 탐색 모델(기본 Haiku)
  store.setSetting('codeModel', 'claude-opus-5-5');
  await engine.requestDraft(KEY, '', true);
  assert.equal(investigated[1].model, 'claude-opus-5-5');
  const saved = store.latestCodeFindings(KEY)!;
  assert.deepEqual(saved.facts.map((f) => f.verified), [true, false]);
  assert.equal(saved.heads[0].dir, proj);
  const notes = fs.readdirSync(notesDir);
  assert.equal(notes.length, 2);
  assert.match(fs.readFileSync(path.join(notesDir, notes[0]), 'utf8'), /^# 푸시 필터/);
  assert.equal(drafted[1]!.facts.id, saved.id);
  const d = store.listDraftsByKey(KEY).at(-1)!;
  assert.equal(d.status, 'pending');
  assert.equal(d.code_findings_id, saved.id);
  assert.match(d.hold_reason!, /^코드 보고 쓴 초안/);
  assert.match(d.hold_reason!, /근거 확인 안 된 내용 있음/);
});

test('코드 보고 다시 쓰기: 폴더가 없으면 LLM을 부르지 않고 알려준다', async () => {
  const { store, engine, investigated, drafted } = codeSetup();
  await assert.rejects(engine.requestDraft(KEY, '', true), /프로젝트 폴더/);
  assert.equal(investigated.length + drafted.length, 0);
  assert.equal(store.listDraftsByKey(KEY).length, 0);
});

test('일반 초안 요청은 탐색하지 않고, 이 대화의 확인 결과가 있으면 함께 넘긴다', async () => {
  const { store, engine, investigated, drafted } = codeSetup();
  await engine.requestDraft(KEY, '');
  assert.equal(drafted[0], undefined);
  const id = store.insertCodeFindings(KEY, { created_at: Date.now(), answerable: true, topic: 't', facts: [], unknowns: [], heads: [] }, {});
  await engine.requestDraft(KEY, '');
  assert.equal(investigated.length, 0);
  assert.equal(drafted[1]!.facts.id, id);
  assert.match(store.listDraftsByKey(KEY).at(-1)!.hold_reason!, /코드로 확인한 내용 포함/);
});

test('대화 창보다 오래된 확인 결과는 넘기지 않는다', async () => {
  const { store, engine, drafted } = codeSetup();
  store.insertCodeFindings(KEY, { created_at: 1000, answerable: true, topic: 't', facts: [], unknowns: [], heads: [] }, {});
  await engine.requestDraft(KEY, '');
  assert.equal(drafted[0], undefined);
});

test('자동 판단: 코드로 확인한 내용이 들어간 초안은 자동 전송 조건이어도 승인 대기', async () => {
  const { store, engine, drafted } = codeSetup();
  store.insertCodeFindings(KEY, { created_at: Date.now(), answerable: true, topic: 't', facts: [], unknowns: [], heads: [] }, {});
  await engine.addLink(LINK);
  assert.ok(drafted[0]);
  const d = store.listDraftsByKey(KEY)[0];
  assert.equal(d.status, 'pending');
  assert.equal(d.code_findings_id, drafted[0]!.facts.id);
  assert.match(d.hold_reason!, /코드로 확인한 내용 포함/);
});
