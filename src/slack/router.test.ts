import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressedToOthersOnly, extractMentions, findKeyword, isUrgent, joinsThread, mentionsGroup, route, threadKey, type MessageEvent } from './router.js';

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

test('findKeyword: 영문·숫자 키워드는 단어 경계에서만, 한글 키워드는 붙여 써도 찾는다 (대소문자 무시)', () => {
  const kws = ['app', 'shop-api', '쇼핑몰'];
  assert.equal(findKeyword('happy 하네요', kws), undefined);
  assert.equal(findKeyword('APP 설치가 안 돼요', kws), 'app');
  assert.equal(findKeyword('shop-api에서 500 나요', kws), 'shop-api');
  assert.equal(findKeyword('<https://git.example.com/acme/shop-api/pull/3|PR>', kws), 'shop-api');
  assert.equal(findKeyword('쇼핑몰앱 결제 오류', kws), '쇼핑몰');
  assert.equal(findKeyword('mshop-apix', kws), undefined);
  assert.equal(findKeyword(undefined, kws), undefined);
});

test('채널 메시지에 내 프로젝트 키워드가 나오면 keyword. 나를 부른 경우·DM이 먼저이고, 자동 감지가 꺼져 있으면 무시', () => {
  const opts = { ...auto, keywords: ['쇼핑몰'] };
  assert.equal(route({ ...base, channel_type: 'channel', text: '쇼핑몰 결제가 안 돼요' }, ME, opts), 'keyword');
  assert.equal(route({ ...base, channel_type: 'channel', text: '쇼핑몰 답글', thread_ts: '0.5' }, ME, opts), 'keyword');
  assert.equal(route({ ...base, channel_type: 'channel', text: `<@${ME}> 쇼핑몰` }, ME, opts), 'mention');
  assert.equal(route({ ...base, channel_type: 'im', text: '쇼핑몰' }, ME, opts), 'dm');
  assert.equal(route({ ...base, channel_type: 'channel', text: '쇼핑몰', user: ME }, ME, opts), null);
  assert.equal(route({ ...base, channel_type: 'channel', text: '쇼핑몰' }, ME, { ...opts, autoDetect: false }), null);
  assert.equal(route({ ...base, channel_type: 'channel', text: '배포 공지' }, ME, opts), null);
});

test('joinsThread: 감시 밖 스레드에 내가 단 답글. 채널 원글·DM·남의 글·편집 등은 아니다', () => {
  const mine = { ...base, channel_type: 'channel', user: ME, ts: '2.0', thread_ts: '1.0' };
  assert.equal(joinsThread(mine, ME), true);
  assert.equal(joinsThread({ ...mine, thread_ts: undefined }, ME), false); // 채널에 쓴 원글 (답글은 my_thread로 잡힌다)
  assert.equal(joinsThread({ ...mine, thread_ts: '2.0' }, ME), false); // 스레드 원글 자신
  assert.equal(joinsThread({ ...mine, user: 'UOTHER' }, ME), false);
  assert.equal(joinsThread({ ...mine, channel_type: 'im' }, ME), false);
  assert.equal(joinsThread({ ...mine, subtype: 'message_changed' }, ME), false);
});
