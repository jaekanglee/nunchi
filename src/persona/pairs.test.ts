import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicChannel, parseThreadTs, previousFromOther, type SearchMatch } from './pairs.js';

const match = (channel: SearchMatch['channel']): SearchMatch => ({ ts: '1', text: 'x', permalink: 'https://a.slack.com/archives/C1/p1', channel });

test('공개 채널만 통과', () => {
  assert.equal(isPublicChannel(match({ id: 'C1', is_channel: true, is_private: false })), true);
  assert.equal(isPublicChannel(match({ id: 'G1', is_channel: true, is_private: true })), false);
  assert.equal(isPublicChannel(match({ id: 'D1', is_im: true })), false);
  assert.equal(isPublicChannel(match({ id: 'G2', is_mpim: true })), false);
});

test('permalink에서 thread_ts 추출', () => {
  assert.equal(parseThreadTs('https://a.slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.000100&cid=C1'), '1700000000.000100');
  assert.equal(parseThreadTs('https://a.slack.com/archives/C1/p1700000001000200'), undefined);
});

const ME = 'UME';

test('바로 앞 상대 메시지를 맥락으로', () => {
  const msgs = [
    { ts: '1', user: 'UA', text: '오래된 말' },
    { ts: '2', user: 'UB', text: '이거 확인 가능?' },
    { ts: '3', user: ME, text: '넵 볼게요' },
  ];
  assert.deepEqual(previousFromOther(msgs, '3', ME), msgs[1]);
});

test('바로 앞이 내 메시지면 쌍 없음', () => {
  const msgs = [
    { ts: '1', user: 'UB', text: '질문' },
    { ts: '2', user: ME, text: '첫 답' },
    { ts: '3', user: ME, text: '추가 답' },
  ];
  assert.equal(previousFromOther(msgs, '3', ME), null);
});

test('바로 앞이 봇·시스템 메시지면 쌍 없음', () => {
  assert.equal(previousFromOther([{ ts: '1', user: 'UB', text: 'x', bot_id: 'B1' }], '2', ME), null);
  assert.equal(previousFromOther([{ ts: '1', user: 'UB', text: 'x', subtype: 'channel_join' }], '2', ME), null);
});

test('앞 메시지가 없으면 null', () => {
  assert.equal(previousFromOther([], '2', ME), null);
});
