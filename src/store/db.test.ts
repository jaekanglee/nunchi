import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { badgeCount, openStore, replyState, summaryState } from './db.js';

test('감시 등록 후 isWatched, OFF로 바꾸면 해제', () => {
  const s = openStore(':memory:');
  s.addWatch('C1:1.0', 'C1', '1.0', 'link');
  assert.equal(s.isWatched('C1:1.0'), true);
  s.setWatchMode('C1:1.0', 'off');
  assert.equal(s.isWatched('C1:1.0'), false);
  // 다시 멘션돼도 내가 끈 설정은 유지
  s.addWatch('C1:1.0', 'C1', '1.0', 'mention');
  assert.equal(s.getWatch('C1:1.0')?.mode, 'off');
});

test('보관: 목록에서 빠지고 차단, 복원하면 다시 목록·감시', () => {
  const s = openStore(':memory:');
  s.addWatch('C1:1.0', 'C1', '1.0', 'mention');
  s.archiveWatch('C1:1.0');
  assert.equal(s.isBlocked('C1:1.0'), true);
  assert.equal(s.listWatches().length, 0);
  assert.deepEqual(s.listArchived().map((w) => w.key), ['C1:1.0']);
  s.unarchiveWatch('C1:1.0');
  assert.equal(s.isBlocked('C1:1.0'), false);
  assert.equal(s.listWatches().length, 1);
  assert.equal(s.listArchived().length, 0);
});

test('삭제: 대화·초안·요약을 지우고 이후 차단, 링크 재등록 시 해제', () => {
  const s = openStore(':memory:');
  s.addWatch('C1:1.0', 'C1', '1.0', 'mention');
  s.insertDraft({ key: 'C1:1.0', channel: 'C1', root_ts: '1.0', basis_ts: '2.0', category: 'x', risk: 0, confidence: 1, reason: '', draft_text: 'x', status: 'pending', hold_reason: null });
  s.insertSummary('C1:1.0', '2.0', { topic: 't' });
  s.deleteWatch('C1:1.0');
  assert.equal(s.getWatch('C1:1.0'), undefined);
  assert.equal(s.listDraftsByKey('C1:1.0').length, 0);
  assert.equal(s.latestSummary('C1:1.0'), undefined);
  assert.equal(s.isBlocked('C1:1.0'), true);
  s.unblock('C1:1.0');
  assert.equal(s.isBlocked('C1:1.0'), false);
});

test('새 메시지가 오면 같은 대화의 열린 초안은 superseded', () => {
  const s = openStore(':memory:');
  const base = { key: 'C1:1.0', channel: 'C1', root_ts: '1.0', basis_ts: '2.0', category: '정보질문', risk: 10, confidence: 0.9, reason: '', draft_text: 'x', hold_reason: '확신 0.6' };
  const open = s.insertDraft({ ...base, status: 'pending' });
  const sent = s.insertDraft({ ...base, status: 'sent' });
  s.supersedeOpen('C1:1.0');
  assert.equal(s.getDraft(open)?.status, 'superseded');
  assert.equal(s.getDraft(sent)?.status, 'sent');
  s.insertDraft({ ...base, key: 'C2:1.0', status: 'pending' });
  assert.deepEqual(s.listDraftsByKey('C1:1.0').map((d) => d.id), [open, sent]);
});

test('설정 기본값과 저장', () => {
  const s = openStore(':memory:');
  assert.equal(s.getSetting('sendMode', 'draft'), 'draft');
  s.setSetting('sendMode', 'auto');
  assert.equal(s.getSetting('sendMode', 'draft'), 'auto');
});

test('열린 초안만 모으고, 대화 제목 저장', () => {
  const s = openStore(':memory:');
  const base = { key: 'C1:1.0', channel: 'C1', root_ts: '1.0', basis_ts: '2.0', category: '정보질문', risk: 10, confidence: 0.9, reason: '', draft_text: 'x', hold_reason: '확신 0.6' };
  const open = s.insertDraft({ ...base, status: 'escalated' });
  s.insertDraft({ ...base, status: 'sent' });
  s.insertDraft({ ...base, status: 'skipped' });
  assert.deepEqual(s.listOpenDrafts().map((d) => d.id), [open]);
  assert.equal(s.getDraft(open)?.hold_reason, '확신 0.6');
  s.addWatch('C1:1.0', 'C1', '1.0', 'link');
  s.setWatchTitle('C1:1.0', '서연 · 주문 알림');
  assert.equal(s.getWatch('C1:1.0')?.title, '서연 · 주문 알림');
});

test('summaryState: 요약 없음 / 최신 / 요약 후 새 메시지', () => {
  assert.equal(summaryState('5.0', null), 'none');
  assert.equal(summaryState('5.0', '5.0'), 'fresh');
  assert.equal(summaryState('6.0', '5.0'), 'outdated');
  assert.equal(summaryState(null, '5.0'), 'fresh');
});

test('마지막 메시지는 더 최신일 때만 갱신, 목록에 요약 상태 포함', () => {
  const s = openStore(':memory:');
  s.addWatch('C1:1.0', 'C1', '1.0', 'link');
  s.setLastMessage('C1:1.0', '10.0', '지수', '요기용');
  s.setLastMessage('C1:1.0', '9.0', '서연', '옛날 메시지');
  assert.equal(s.getWatch('C1:1.0')?.last_text, '요기용');
  assert.equal(s.listWatches()[0].summary_state, 'none');
  s.insertSummary('C1:1.0', '10.0', { headline: 'x' });
  assert.equal(s.listWatches()[0].summary_state, 'fresh');
  s.setLastMessage('C1:1.0', '11.0', '지수', '추가 질문');
  assert.equal(s.listWatches()[0].summary_state, 'outdated');
});

test('데이터 폴더가 없어도 만들어서 연다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slmmury-'));
  const s = openStore(path.join(dir, 'new', 'slmmury.db'));
  s.setSetting('sendMode', 'auto');
  assert.equal(s.getSetting('sendMode', 'draft'), 'auto');
  fs.rmSync(dir, { recursive: true });
});

test('링크로 등록하면 source가 link가 되고, 이후 자동 감지로 덮어쓰지 않는다', () => {
  const s = openStore(':memory:');
  s.addWatch('C1:1.0', 'C1', '1.0', 'mention');
  s.addWatch('C1:1.0', 'C1', '1.0', 'link');
  assert.equal(s.getWatch('C1:1.0')?.source, 'link');
  s.addWatch('C1:1.0', 'C1', '1.0', 'group_mention');
  assert.equal(s.getWatch('C1:1.0')?.source, 'link');
});

test('목록 정보: 주제는 요약이 덮어쓰고, 시작 시각은 더 이른 것만 남는다', () => {
  const s = openStore(':memory:');
  s.addWatch('C1:1.0', 'C1', '1.0', 'mention');
  s.setWatchTopic('C1:1.0', '주문 알림 중복', true);
  s.setWatchTopic('C1:1.0', '다른 주제', true);
  assert.equal(s.getWatch('C1:1.0')?.topic, '주문 알림 중복');
  s.setWatchTopic('C1:1.0', '푸시 필터 버그');
  assert.equal(s.getWatch('C1:1.0')?.topic, '푸시 필터 버그');
  s.setParticipants('C1:1.0', '5.0', ['지수', '나']);
  s.setParticipants('C1:1.0', '7.0', ['지수', '서연', '나']);
  assert.equal(s.getWatch('C1:1.0')?.first_ts, '5.0');
  assert.deepEqual(JSON.parse(s.getWatch('C1:1.0')!.participants!), ['지수', '서연', '나']);
});

test('replyState: 열린 초안 > 내가 답함 > 최신까지 판단해 답 불필요 > 판단 전', () => {
  const w = { mode: 'on' as const, last_ts: '10.0', last_name: '지수' };
  assert.equal(replyState(w, { status: 'escalated', basis_ts: '10.0' }), 'urgent');
  assert.equal(replyState(w, { status: 'pending', basis_ts: '9.0' }), 'need');
  assert.equal(replyState(w, { status: 'scheduled', basis_ts: '10.0' }), 'auto');
  assert.equal(replyState({ ...w, last_name: '나' }, { status: 'skipped', basis_ts: '9.0' }), 'replied');
  assert.equal(replyState(w, { status: 'skipped', basis_ts: '10.0' }), 'none');
  assert.equal(replyState(w, { status: 'skipped', basis_ts: '9.0' }), 'unknown'); // 판단 뒤 새 메시지
  assert.equal(replyState(w, null), 'unknown');
  assert.equal(replyState({ ...w, mode: 'off' }, null), 'off');
});

test('목록에 답 필요 상태 포함', () => {
  const s = openStore(':memory:');
  s.addWatch('C1:1.0', 'C1', '1.0', 'link');
  s.setLastMessage('C1:1.0', '10.0', '지수', '이거 봐줄래요?');
  assert.equal(s.listWatches()[0].reply_state, 'unknown');
  s.insertDraft({ key: 'C1:1.0', channel: 'C1', root_ts: '1.0', basis_ts: '10.0', category: '정보질문', risk: 10, confidence: 0.9, reason: '', draft_text: '네', status: 'pending', hold_reason: null });
  assert.equal(s.listWatches()[0].reply_state, 'need');
});

test('badgeCount: 직접 확인·승인 대기 대화만 센다', () => {
  const states = ['urgent', 'need', 'need', 'auto', 'replied', 'none', 'unknown', 'off'] as const;
  assert.equal(badgeCount(states.map((reply_state) => ({ reply_state }))), 3);
});

const baseDraft = {
  key: 'C1:1', channel: 'C1', root_ts: '1', basis_ts: '2', category: '일반', risk: 1, confidence: 0.9,
  reason: 'r', draft_text: 'd', status: 'pending' as const, hold_reason: null,
};

test('초안 비용·토큰·judge_cost_usd 저장과 조회, 없는 값은 null', () => {
  const s = openStore(':memory:');
  const id = s.insertDraft({
    ...baseDraft, judge_cost_usd: 0.001, cost_usd: 0.02, input_tokens: 10, output_tokens: 20,
    cache_read_tokens: 30, cache_creation_tokens: 40, thinking_tokens: 5,
  });
  const d = s.getDraft(id)!;
  assert.equal(d.judge_cost_usd, 0.001);
  assert.equal(d.cost_usd, 0.02);
  assert.deepEqual([d.input_tokens, d.output_tokens, d.cache_read_tokens, d.cache_creation_tokens, d.thinking_tokens], [10, 20, 30, 40, 5]);
  const bare = s.getDraft(s.insertDraft(baseDraft))!;
  assert.equal(bare.judge_cost_usd, null);
  assert.equal(bare.cost_usd, null);
  assert.equal(bare.thinking_tokens, null);
});

test('요약 비용·토큰·edit_mark 저장과 조회, 생략하면 null', () => {
  const s = openStore(':memory:');
  s.insertSummary('C1:1', '5', { a: 1 }, { edit_mark: '7', cost_usd: 0.03, input_tokens: 1, output_tokens: 2, thinking_tokens: null });
  const got = s.latestSummary('C1:1')!;
  assert.equal(got.edit_mark, '7');
  assert.equal(got.cost_usd, 0.03);
  assert.equal(got.output_tokens, 2);
  assert.equal(got.thinking_tokens, null);
  assert.equal(got.cache_read_tokens, null);
  s.insertSummary('C1:1', '6', { a: 2 });
  const plain = s.latestSummary('C1:1')!;
  assert.equal(plain.edit_mark, null);
  assert.equal(plain.cost_usd, null);
});

test('이전 스키마 DB를 열면 새 컬럼이 추가되고 기존 행은 보존된다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slmmury-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, channel TEXT NOT NULL, root_ts TEXT,
      basis_ts TEXT NOT NULL, category TEXT NOT NULL, risk INTEGER NOT NULL, confidence REAL NOT NULL,
      reason TEXT NOT NULL, draft_text TEXT NOT NULL, final_text TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, sent_ts TEXT
    );
    CREATE TABLE summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, basis_ts TEXT NOT NULL,
      body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO drafts (key, channel, root_ts, basis_ts, category, risk, confidence, reason, draft_text, status, created_at)
      VALUES ('C1:1', 'C1', '1', '2', '일반', 1, 0.5, 'r', 'old', 'sent', 1);
    INSERT INTO summaries (key, basis_ts, body, created_at) VALUES ('C1:1', '2', '{}', 1);
  `);
  old.close();

  const s = openStore(file);
  const d = s.getDraft(1)!;
  assert.equal(d.draft_text, 'old');
  assert.equal(d.cost_usd, null);
  assert.equal(d.judge_cost_usd, null);
  const sum = s.latestSummary('C1:1')!;
  assert.equal(sum.basis_ts, '2');
  assert.equal(sum.edit_mark, null);
  const id = s.insertDraft({ ...baseDraft, judge_cost_usd: 0.5, cost_usd: 1 });
  assert.equal(s.getDraft(id)!.judge_cost_usd, 0.5);

  const check = new DatabaseSync(file);
  const names = (table: string) => (check.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const cost = ['cost_usd', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'thinking_tokens'];
  for (const c of [...cost, 'judge_cost_usd', 'hold_reason']) assert.ok(names('drafts').includes(c), c);
  for (const c of [...cost, 'edit_mark']) assert.ok(names('summaries').includes(c), c);
  check.close();
});

test('대화별 최신 초안·요약 조회는 테이블 전체를 훑지 않는다 (key 인덱스)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slmmury-idx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'idx.db');
  openStore(file);
  const check = new DatabaseSync(file);
  const plan = (sql: string) => (check.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('k') as { detail: string }[]).map((r) => r.detail).join(' / ');
  for (const table of ['drafts', 'summaries']) {
    assert.match(plan(`SELECT * FROM ${table} WHERE key = ? ORDER BY id DESC LIMIT 1`), /USING INDEX/, table);
  }
  check.close();
});

test('대화 화면 초안 기록: 보이는 메시지보다 오래된 닫힌 초안은 빼고 열린 초안은 남긴다', () => {
  const s = openStore(':memory:');
  const add = (basis_ts: string, status: 'pending' | 'skipped' | 'sent') => s.insertDraft({ ...baseDraft, basis_ts, status });
  const old = add('99.0', 'skipped'); // 문자열로 비교하면 '200.0'보다 크다
  const oldOpen = add('150.0', 'pending');
  const recent = add('300.0', 'sent');
  // 스레드 본문(root_ts '1')은 늘 보이므로 본문 기준 초안도 남긴다
  const onRoot = add('1', 'skipped');
  // 기준 메시지는 범위 밖이어도 보낸 메시지가 보이면 남긴다 ("Slmmury가 보냄" 표시)
  const sentShown = add('150.0', 'sent');
  s.setDraftStatus(sentShown, 'sent', { sent_ts: '250.0' });
  assert.deepEqual(s.listDraftsByKey('C1:1', '200.0').map((d) => d.id), [oldOpen, recent, onRoot, sentShown]);
  assert.deepEqual(s.listDraftsByKey('C1:1').map((d) => d.id), [old, oldOpen, recent, onRoot, sentShown]);
});
