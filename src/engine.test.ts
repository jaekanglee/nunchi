import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebClient } from '@slack/web-api';
import { createEngine } from './engine.js';
import { openStore, type Store } from './store/db.js';
import type { ClaudeResult } from './llm/claude.js';
import type { Judgment } from './responder/judge.js';
import type { DraftResult } from './responder/draft.js';
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
