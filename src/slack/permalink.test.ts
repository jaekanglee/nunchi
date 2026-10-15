import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePermalink } from './permalink.js';

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
