import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressedToOthersOnly, extractMentions, isUrgent, mentionsGroup, route, threadKey, type MessageEvent } from './router.js';

const ME = 'UME';
const base: MessageEvent = { type: 'message', channel: 'C1', user: 'UOTHER', text: 'hi', ts: '1.0' };
const auto = { autoDetect: true, isWatched: () => false };
const manual = { autoDetect: false, isWatched: () => false };

test('DM은 dm', () => {
  assert.equal(route({ ...base, channel_type: 'im' }, ME, auto), 'dm');
});

test('그룹 DM은 group_dm', () => {
  assert.equal(route({ ...base, channel_type: 'mpim' }, ME, auto), 'group_dm');
});

test('채널에서 나를 멘션하면 mention', () => {
  assert.equal(route({ ...base, channel_type: 'channel', text: `<@${ME}> 확인 부탁` }, ME, auto), 'mention');
});

test('채널의 일반 메시지는 무시', () => {
  assert.equal(route({ ...base, channel_type: 'channel' }, ME, auto), null);
});

test('내가 보낸 메시지는 무시 (루프 방지)', () => {
  assert.equal(route({ ...base, channel_type: 'im', user: ME }, ME, auto), null);
});

test('봇 메시지는 무시', () => {
  assert.equal(route({ ...base, channel_type: 'im', bot_id: 'B1' }, ME, auto), null);
});

test('subtype 있는 메시지(편집 등)는 무시', () => {
  assert.equal(route({ ...base, channel_type: 'im', subtype: 'message_changed' }, ME, auto), null);
});

test('자동 감지 OFF면 DM·멘션도 무시', () => {
  assert.equal(route({ ...base, channel_type: 'im' }, ME, manual), null);
  assert.equal(route({ ...base, channel_type: 'channel', text: `<@${ME}>` }, ME, manual), null);
});

test('내가 쓴 글의 스레드 답글은 멘션이 없어도 my_thread', () => {
  const reply = { ...base, channel_type: 'channel', ts: '2.0', thread_ts: '1.0', parent_user_id: ME };
  assert.equal(route(reply, ME, auto), 'my_thread');
  assert.equal(route({ ...reply, text: `<@${ME}> 이거요` }, ME, auto), 'mention'); // 나를 부르면 mention이 먼저
  assert.equal(route({ ...reply, parent_user_id: 'UOTHER' }, ME, auto), null); // 남의 글 스레드
  assert.equal(route({ ...reply, user: ME }, ME, auto), null); // 내 답글
  assert.equal(route(reply, ME, manual), null); // 자동 감지 OFF
});

test('감시 스레드의 답글은 멘션 없이도, 자동 감지 OFF여도 watched', () => {
  const ev = { ...base, channel_type: 'channel', thread_ts: '0.5', ts: '1.0' };
  const watched = { autoDetect: false, isWatched: (k: string) => k === 'C1:0.5' };
  assert.equal(route(ev, ME, watched), 'watched');
});

test('감시 스레드여도 내 메시지는 무시', () => {
  const ev = { ...base, channel_type: 'channel', thread_ts: '0.5', user: ME };
  assert.equal(route(ev, ME, { autoDetect: true, isWatched: () => true }), null);
});

test('threadKey: 스레드는 루트, 본문은 자기 ts, DM은 채널', () => {
  assert.equal(threadKey({ channel: 'C1', ts: '2.0', thread_ts: '1.0' }), 'C1:1.0');
  assert.equal(threadKey({ channel: 'C1', ts: '2.0', channel_type: 'channel' }), 'C1:2.0');
  assert.equal(threadKey({ channel: 'D1', ts: '2.0', channel_type: 'im' }), 'D1:dm');
});

test('내가 속한 그룹을 멘션하면 group_mention, 다른 그룹은 무시', () => {
  const opts = { autoDetect: true, isWatched: () => false, mentionGroups: ['S0GROUP0001'] };
  assert.equal(route({ ...base, channel_type: 'channel', text: '<!subteam^S0GROUP0001> 확인 부탁' }, ME, opts), 'group_mention');
  assert.equal(route({ ...base, channel_type: 'channel', text: '<!subteam^S0GROUP0001|@dev-team> 확인' }, ME, opts), 'group_mention');
  assert.equal(route({ ...base, channel_type: 'channel', text: '<!subteam^S0GROUP0002> 확인' }, ME, opts), null);
  assert.equal(route({ ...base, channel_type: 'channel', text: '<!subteam^S0GROUP0001> 확인' }, ME, { ...opts, autoDetect: false }), null);
});

test('mentionsGroup: ID가 다른 ID의 앞부분과 겹쳐도 오탐하지 않는다', () => {
  assert.equal(mentionsGroup('<!subteam^S0GROUP0001X>', ['S0GROUP0001']), false);
  assert.equal(mentionsGroup(undefined, ['S1']), false);
});

test('extractMentions: 사용자·그룹·전체 멘션 ID', () => {
  assert.deepEqual(extractMentions('<@UA> <@UB|b> <!subteam^S0GROUP0001|@dev> <!here> 확인'), ['UA', 'UB', 'S0GROUP0001', '!here']);
  assert.deepEqual(extractMentions('멘션 없음'), []);
});

test('addressedToOthersOnly: 남만 부르면 true, 나·내 그룹·전체가 끼면 false', () => {
  assert.equal(addressedToOthersOnly(['UA'], ME, []), true);
  assert.equal(addressedToOthersOnly(['UA', 'S0OTHER'], ME, ['S0GROUP0001']), true);
  assert.equal(addressedToOthersOnly([], ME, []), false);
  assert.equal(addressedToOthersOnly(['UA', ME], ME, []), false);
  assert.equal(addressedToOthersOnly(['UA', 'S0GROUP0001'], ME, ['S0GROUP0001']), false);
  assert.equal(addressedToOthersOnly(['!here'], ME, []), false);
});

test('isUrgent: DM과 나를 부른 메시지만 급함', () => {
  assert.equal(isUrgent({ channel_type: 'im', text: '잡담' }, ME, []), true);
  assert.equal(isUrgent({ channel_type: 'channel', text: `<@${ME}> 확인` }, ME, []), true);
  assert.equal(isUrgent({ channel_type: 'channel', text: '<!subteam^S0GROUP0001> 확인' }, ME, ['S0GROUP0001']), true);
  assert.equal(isUrgent({ channel_type: 'channel', text: '<@UA> 확인' }, ME, []), false);
  assert.equal(isUrgent({ channel_type: 'channel', text: 'ㅋㅋ' }, ME, []), false);
});
