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
      seen.push(opts?.scope);
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
  await assert.rejects(engine.requestDraft(KEY, '', true), /내 프로젝트에서 폴더/);
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

test('내 지침: 설정하면 1차 판단과 초안에 넘긴다', async () => {
  const seen: (string | undefined)[] = [];
  const store = openStore(':memory:');
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: { read: async () => [msg('1700000000.000100')], nameOf: async (u: string) => u },
    persona: { styleGuide: 'S', relationships: [], pairs: [] },
    notify: () => {},
    onChange: () => {},
    judge: async (_t, _p, _me, _llm, opts): Promise<ClaudeResult<Judgment>> => {
      seen.push(`judge:${opts?.guide}`);
      return { output: { needs_my_reply: true, reason: 'r', topic: 't' }, costUsd: 0, usage };
    },
    draft: async (_t, _p, _me, _llm, _req, mine): Promise<ClaudeResult<DraftResult>> => {
      seen.push(`draft:${mine?.guide}`);
      return { output: { needs_my_reply: false, category: '정보질문', risk: 10, needs_facts_i_dont_know: false, confidence: 0.9, reply: '', reason: 'r', topic: 't' }, costUsd: 0, usage };
    },
  });
  await engine.addLink(LINK);
  store.setSetting('myGuide', '배포 일정은 확답하지 않는다');
  await engine.addLink(LINK);
  assert.deepEqual(seen, ['judge:none', 'draft:none', 'judge:배포 일정은 확답하지 않는다', 'draft:배포 일정은 확답하지 않는다']);
});

// 실시간 이벤트로 판단 예약을 보는 대역. 시계는 테스트가 mock.timers로 움직인다
function liveSetup(thread: { current: ThreadMessage[] }, opts: { slowDraft?: boolean } = {}) {
  const store = openStore(':memory:');
  const judged: string[][] = [];
  const drafted: string[][] = [];
  let release: (() => void) | undefined;
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: { read: async () => thread.current, nameOf: async (u: string) => u },
    persona: { styleGuide: 'S', relationships: [], pairs: [] },
    notify: () => {},
    onChange: () => {},
    judge: async (t): Promise<ClaudeResult<Judgment>> => {
      judged.push(t.map((m) => m.ts));
      return { output: { needs_my_reply: false, reason: 'r', topic: 't' }, costUsd: 0, usage };
    },
    draft: async (t): Promise<ClaudeResult<DraftResult>> => {
      drafted.push(t.map((m) => m.ts));
      if (opts.slowDraft && drafted.length === 1) await new Promise<void>((r) => (release = r));
      return { output: { needs_my_reply: false, category: '정보질문', risk: 10, needs_facts_i_dont_know: false, confidence: 0.9, reply: '', reason: 'r', topic: 't' }, costUsd: 0, usage };
    },
  });
  return { store, engine, judged, drafted, release: () => release!() };
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
const dm = (ts: string) => ({ type: 'message', channel: 'D1', channel_type: 'im', user: 'UA', text: ts, ts });
const said = (ts: string, user: string, mentions: string[] = []): ThreadMessage => ({ ts, user, name: user, text: ts, mentions });

test('판단 대기 중에 새 메시지가 와도 판단 시각을 미루지 않고, 그 시각에 함께 판단한다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const thread = { current: [said('1700000000.000100', 'UA')] };
  const { engine, drafted } = liveSetup(thread);
  await engine.handleEvent(dm('1700000000.000100'));
  const due = engine.timers().judge['D1:dm'];
  assert.equal(due, 1_700_000_010_000);
  t.mock.timers.tick(6000);
  thread.current = [...thread.current, said('1700000006.000000', 'UA')];
  await engine.handleEvent(dm('1700000006.000000'));
  assert.equal(engine.timers().judge['D1:dm'], due);
  t.mock.timers.tick(4000);
  await flush();
  assert.deepEqual(drafted, [['1700000000.000100', '1700000006.000000']]);
});

test('모으던 댓글보다 급한 메시지가 오면 판단을 앞당긴다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const { store, engine } = liveSetup({ current: [said('1700000000.000100', 'UA')] });
  store.addWatch(KEY, 'C1', '1700000000.000100', 'mention');
  const reply = (ts: string, text: string) => ({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'UB', text, ts, thread_ts: '1700000000.000100' });
  await engine.handleEvent(reply('1700000001.000000', '그냥 댓글'));
  assert.equal(engine.timers().judge[KEY], 1_700_000_120_000);
  await engine.handleEvent(reply('1700000002.000000', '<@UME> 봐주세요'));
  assert.equal(engine.timers().judge[KEY], 1_700_000_010_000);
});

test('판단하는 동안 온 메시지는 그 판단이 끝난 뒤 이어서 판단한다 (판단 시각이 지났으면 바로)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const thread = { current: [said('1700000000.000100', 'UA')] };
  const { engine, drafted, release } = liveSetup(thread, { slowDraft: true });
  await engine.handleEvent(dm('1700000000.000100'));
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(drafted.length, 1); // 첫 판단이 아직 진행 중
  thread.current = [...thread.current, said('1700000011.000000', 'UA')];
  await engine.handleEvent(dm('1700000011.000000'));
  t.mock.timers.tick(30_000); // 새 메시지의 판단 시각이 지났지만 첫 판단이 아직 안 끝났다
  await flush();
  assert.equal(drafted.length, 1);
  thread.current = [...thread.current, said('1700000041.000000', 'UA')];
  await engine.handleEvent(dm('1700000041.000000')); // 이 메시지의 판단 예약은 아직 남아 있다
  release();
  await flush();
  assert.deepEqual(drafted[1], ['1700000000.000100', '1700000011.000000', '1700000041.000000']);
  // 이어서 한 판단이 대화를 다시 읽으며 남은 예약까지 합쳤으니, 같은 내용으로 또 판단하지 않는다
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(drafted.length, 2);
  assert.equal(engine.timers().judge['D1:dm'], undefined);
});

test('다른 사람만 부른 메시지라도, 내 마지막 말 뒤에 나를 부른 메시지가 함께 있으면 규칙으로 건너뛰지 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const root = '1700000000.000100';
  const thread = { current: [said(root, 'UA', ['UME']), said('1700000001.000000', 'UB', ['UC'])] };
  const { store, engine, judged } = liveSetup(thread);
  store.addWatch(KEY, 'C1', root, 'mention');
  const event = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UB', text: '<@UC> 점심?', ts: '1700000001.000000', thread_ts: root };
  await engine.handleEvent(event);
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(judged.length, 1);

  // 나를 부른 메시지에 내가 이미 답했으면, 그 뒤 다른 사람만 부른 메시지는 규칙으로 건너뛴다
  thread.current = [said(root, 'UA', ['UME']), said('1700000001.000000', 'UME'), said('1700000002.000000', 'UB', ['UC'])];
  await engine.handleEvent({ ...event, ts: '1700000002.000000' });
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(judged.length, 1);
  assert.equal(store.listDraftsByKey(KEY).at(-1)!.category, '규칙');
});

test('내 프로젝트 키워드가 나온 채널 메시지는 감시에 올려 모아서 판단하고, 판단에 프로젝트를 넘긴다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-proj-')), 'shop-app');
  fs.mkdirSync(dir);
  const store = openStore(':memory:');
  const seen: unknown[] = [];
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: { read: async () => [said('1700000000.000100', 'UA')], nameOf: async (u: string) => u },
    persona: { styleGuide: 'S', relationships: [], pairs: [] },
    notify: () => {},
    onChange: () => {},
    judge: async (_t, _p, _me, _llm, opts): Promise<ClaudeResult<Judgment>> => {
      seen.push(opts?.projects);
      return { output: { needs_my_reply: false, reason: 'r', topic: 't' }, costUsd: 0, usage };
    },
  });
  store.setSetting('projectDirs', dir);
  store.setSetting('projectKeywords', JSON.stringify({ [dir]: ['쇼핑몰'] }));
  const event = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UA', text: '쇼핑몰 결제가 안 돼요', ts: '1700000000.000100' };
  await engine.handleEvent(event);
  assert.equal(store.getWatch(KEY)?.source, 'keyword');
  assert.equal(engine.timers().judge[KEY], 1_700_000_120_000); // 나를 부른 게 아니라 모아서 판단
  await engine.handleEvent({ ...event, ts: '1700000001.000000', text: 'shop-app 얘기' }); // 직접 고친 키워드에 없는 폴더 이름은 감지하지 않는다
  assert.equal(store.getWatch('C1:1700000001.000000'), undefined);
  t.mock.timers.tick(120_000);
  await flush();
  assert.deepEqual(seen, [[{ dir, name: 'shop-app', keywords: ['쇼핑몰'], auto: false }]]);
});

test('키워드로 감지한 대화는 나를 부른 게 아니라서, 자동 전송 조건이어도 승인 대기', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const store = openStore(':memory:');
  const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
  const engine = createEngine({
    client,
    myUserId: 'UME',
    store,
    readConversation: { read: async () => [said('1700000000.000100', 'UA'), said('1700000001.000000', 'UB')], nameOf: async (u: string) => u },
    persona: { styleGuide: 'S', relationships: [], pairs: [] },
    notify: () => {},
    onChange: () => {},
    judge: async (): Promise<ClaudeResult<Judgment>> => ({ output: { needs_my_reply: true, reason: 'r', topic: 't' }, costUsd: 0, usage }),
    draft: async (): Promise<ClaudeResult<DraftResult>> => ({
      output: { needs_my_reply: true, category: '단순확인·리액션', risk: 5, needs_facts_i_dont_know: false, confidence: 0.95, reply: '넵', reason: 'r', topic: 't' },
      costUsd: 0,
      usage,
    }),
  });
  store.setSetting('sendMode', 'auto');
  store.addWatch(KEY, 'C1', '1700000000.000100', 'keyword');
  await engine.handleEvent({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'UB', text: '그렇군요', ts: '1700000001.000000', thread_ts: '1700000000.000100' });
  t.mock.timers.tick(120_000);
  await flush();
  const d = store.listDraftsByKey(KEY)[0];
  assert.equal(d.status, 'pending');
  assert.match(d.hold_reason!, /키워드로 감지한 대화/);
});

test('감시하지 않던 스레드에 내가 답글을 달면 그때부터 감시한다. 내 말이 마지막이라 바로 판단하지는 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const root = '1700000000.000100';
  const thread = { current: [said(root, 'UA'), said('1700000001.000000', 'UME')] };
  const { store, engine, judged, drafted } = liveSetup(thread);
  const reply = (ts: string, user: string) => ({ type: 'message', channel: 'C1', channel_type: 'channel', user, text: ts, ts, thread_ts: root });
  await engine.handleEvent(reply('1700000001.000000', 'UME'));
  await flush();
  assert.equal(store.getWatch(KEY)?.source, 'my_reply');
  assert.ok(store.getWatch(KEY)?.participants); // 목록에 보일 참여자·제목을 채운다
  assert.equal(engine.timers().judge[KEY], undefined);
  assert.equal(judged.length + drafted.length, 0);

  // 그 뒤 다른 사람 답글은 멘션이 없어도 감시 중인 스레드로 판단한다
  thread.current = [...thread.current, said('1700000002.000000', 'UB')];
  await engine.handleEvent(reply('1700000002.000000', 'UB'));
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(judged.length, 1);
});

test('내 답글로 감시를 시작하는 것도 자동 감지가 꺼져 있거나 보관·삭제한 대화면 하지 않는다', async () => {
  const root = '1700000000.000100';
  const { store, engine } = liveSetup({ current: [said(root, 'UA'), said('1700000001.000000', 'UME')] });
  const reply = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UME', text: '넵', ts: '1700000001.000000', thread_ts: root };
  store.setSetting('autoDetect', 'off');
  await engine.handleEvent(reply);
  assert.equal(store.getWatch(KEY), undefined);
  store.setSetting('autoDetect', 'on');
  store.addWatch(KEY, 'C1', root, 'mention');
  store.archiveWatch(KEY);
  await engine.handleEvent(reply);
  assert.equal(store.getWatch(KEY)?.source, 'mention');
  assert.ok(store.isBlocked(KEY));
});

for (const [name, channel, channelType, label] of [['DM', 'D1', 'im', 'DM'], ['그룹 DM', 'G1', 'mpim', '그룹 DM']] as const) {
  test(`자동 전송할 대화에서 뺀 ${name}은 자동 전송 조건이어도 승인 대기, 넣으면 자동 전송 예약`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
    const store = openStore(':memory:');
    const client = { search: { messages: async () => ({ messages: { matches: [] } }) } } as unknown as WebClient;
    const engine = createEngine({
      client,
      myUserId: 'UME',
      store,
      readConversation: { read: async () => [said('1700000000.000100', 'UA')], nameOf: async (u: string) => u },
      persona: { styleGuide: 'S', relationships: [], pairs: [] },
      notify: () => {},
      onChange: () => {},
      draft: async (): Promise<ClaudeResult<DraftResult>> => ({
        output: { needs_my_reply: true, category: '인사/잡담', risk: 5, needs_facts_i_dont_know: false, confidence: 0.95, reply: '안녕하세요', reason: 'r', topic: 't' },
        costUsd: 0,
        usage,
      }),
    });
    store.setSetting('sendMode', 'auto');
    const key = `${channel}:dm`;
    const event = { type: 'message', channel, channel_type: channelType, user: 'UA', text: '안녕하세요', ts: '1700000000.000100' };
    const run = async () => {
      await engine.handleEvent(event);
      t.mock.timers.tick(10_000);
      await flush();
      return store.listDraftsByKey(key).at(-1)!;
    };
    store.setSetting('autoTargets', 'channel');
    const held = await run();
    assert.equal(held.status, 'pending');
    assert.match(held.hold_reason!, new RegExp(`${label}은 자동 전송 안 함`));
    store.setSetting('autoTargets', 'dm,group_dm,channel');
    assert.equal((await run()).status, 'scheduled');
  });
}
