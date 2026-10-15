import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
