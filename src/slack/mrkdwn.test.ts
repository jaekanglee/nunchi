import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toParts } from './mrkdwn.js';

test('라벨 링크는 라벨을 보여주고 주소를 건다', () => {
  assert.deepEqual(toParts('이거 <https://a.com/x?y=1&amp;z=2|문서> 봐줘'), [
    { text: '이거 ' },
    { text: '문서', url: 'https://a.com/x?y=1&z=2' },
    { text: ' 봐줘' },
  ]);
});

test('라벨 없는 링크·메일은 주소를 그대로 보여준다', () => {
  assert.deepEqual(toParts('<https://a.com>'), [{ text: 'https://a.com', url: 'https://a.com' }]);
  assert.deepEqual(toParts('<mailto:a@b.com|a@b.com>'), [{ text: 'a@b.com', url: 'mailto:a@b.com' }]);
});

test('채널·특수 멘션·이스케이프', () => {
  assert.deepEqual(toParts('<#C1|dev> <!here> &lt;b&gt; &amp;'), [{ text: '#dev @here <b> &' }]);
  assert.deepEqual(toParts('<!date^1700000000^{date}|2023-11-14>'), [{ text: '2023-11-14' }]);
});

test('<> 밖의 주소도 링크로, 끝 문장부호는 뺀다', () => {
  assert.deepEqual(toParts('[링크 미리보기: 제목 https://a.com/b].'), [
    { text: '[링크 미리보기: 제목 ' },
    { text: 'https://a.com/b', url: 'https://a.com/b' },
    { text: '].' },
  ]);
});

test('링크 없는 글은 한 조각', () => {
  assert.deepEqual(toParts('그냥 글\n두 줄'), [{ text: '그냥 글\n두 줄' }]);
});
