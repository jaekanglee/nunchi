import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeepLink, buildPermalink, parsePermalink } from './permalink.js';

test('본문 링크', () => {
  assert.deepEqual(parsePermalink('https://example.slack.com/archives/C0123ABC/p1700000001000200'), {
    channel: 'C0123ABC',
    ts: '1700000001.000200',
    rootTs: '1700000001.000200',
  });
});

test('스레드 답글 링크는 루트 ts를 thread_ts에서 가져온다', () => {
  assert.deepEqual(
    parsePermalink('https://example.slack.com/archives/C0123ABC/p1700000001000200?thread_ts=1700000000.000100&cid=C0123ABC'),
    { channel: 'C0123ABC', ts: '1700000001.000200', rootTs: '1700000000.000100' },
  );
});

test('앞뒤 공백 허용', () => {
  assert.equal(parsePermalink('  https://example.slack.com/archives/D1/p1700000001000200 \n')?.channel, 'D1');
});

test('Slack 링크가 아니면 null', () => {
  assert.equal(parsePermalink('https://example.com/foo'), null);
  assert.equal(parsePermalink('그냥 텍스트'), null);
});

test('buildPermalink: 스레드는 루트 메시지 링크, DM은 대화방 링크', () => {
  const url = buildPermalink('https://example.slack.com/', 'C0123ABC', '1700000000.000100');
  assert.equal(url, 'https://example.slack.com/archives/C0123ABC/p1700000000000100?thread_ts=1700000000.000100&cid=C0123ABC');
  assert.deepEqual(parsePermalink(url), { channel: 'C0123ABC', ts: '1700000000.000100', rootTs: '1700000000.000100' });
  assert.equal(buildPermalink('https://example.slack.com', 'D1', null), 'https://example.slack.com/archives/D1');
});

test('buildDeepLink: 채널·스레드 딥링크', () => {
  assert.equal(buildDeepLink('T1', 'C1', null), 'slack://channel?team=T1&id=C1');
  assert.equal(buildDeepLink('T1', 'C1', '1700000000.000100'), 'slack://channel?team=T1&id=C1&message=1700000000.000100&thread_ts=1700000000.000100');
});
