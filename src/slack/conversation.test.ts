import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capMessages, conversationTitle, participantNames, readableGroupMentions, trimThread } from './conversation.js';

test('페이지 합친 결과를 ts순 정렬·중복 제거하고 루트 + 최근 N개만 남긴다', () => {
  const page1 = [{ ts: '1' }, { ts: '2' }, { ts: '9' }];
  const page2 = [{ ts: '1' }, { ts: '3' }, { ts: '4' }];
  assert.deepEqual(trimThread([...page1, ...page2], '1', 2).map((m) => m.ts), ['1', '4', '9']);
});

test('짧은 스레드는 그대로', () => {
  assert.deepEqual(trimThread([{ ts: '1' }, { ts: '2' }], '1', 60).map((m) => m.ts), ['1', '2']);
});

test('대화 제목: 스레드는 작성자 · 본문 앞부분, DM은 상대 이름', () => {
  const msgs = [
    { ts: '1', user: 'UA', name: '지수', text: '배송앱의 주문 알림이\n두번 울리는 문의가 계속 들어오고 있는데 확인 부탁드려요 혹시 원인 아시나요' },
    { ts: '2', user: 'UME', name: '민수', text: '넵' },
  ];
  assert.equal(conversationTitle(msgs, false, 'UME'), '지수 · 배송앱의 주문 알림이 두번 울리는 문의가 계속 들어오고 있는데 확인 부탁…');
  assert.equal(conversationTitle(msgs, true, 'UME'), 'DM · 지수');
});

test('그룹 멘션을 읽을 수 있게 바꾸고, 내가 속한 그룹은 표시한다', () => {
  assert.equal(readableGroupMentions('<!subteam^S0GROUP0001|@dev-team> 확인 부탁', ['S0GROUP0001']), '@dev-team(나 포함 그룹) 확인 부탁');
  assert.equal(readableGroupMentions('<!subteam^S0GROUP0001> 확인', ['S0GROUP0001']), '@그룹(나 포함 그룹) 확인');
  assert.equal(readableGroupMentions('<!subteam^S0GROUP0002|@qa> 공유', ['S0GROUP0001']), '@qa 공유');
});

test('participantNames: 말한 순서대로, 나는 끝에', () => {
  const msgs = [
    { ts: '1', user: 'UA', name: '지수', text: 'a' },
    { ts: '2', user: 'UME', name: '민수', text: 'b' },
    { ts: '3', user: 'UB', name: '서연', text: 'c' },
    { ts: '4', user: 'UA', name: '지수', text: 'd' },
  ];
  assert.deepEqual(participantNames(msgs, 'UME'), ['지수', '서연', '나']);
  assert.deepEqual(participantNames(msgs.filter((m) => m.user !== 'UME'), 'UME'), ['지수', '서연']);
});

test('capMessages: 상한 넘는 중간 메시지만 자르고, 루트와 마지막 5개는 원문 그대로', () => {
  const long = 'x'.repeat(20);
  const msgs = Array.from({ length: 8 }, (_, i) => ({ ts: String(i + 1), text: i === 2 ? 'short' : long }));
  const capped = capMessages(msgs, { max: 10, keepTail: 5, rootTs: '1' });
  assert.equal(capped[0].text, long); // 루트
  assert.equal(capped[1].text, 'x'.repeat(10) + ' …(10자 생략)');
  assert.equal(capped[2].text, 'short'); // 상한 이하
  for (const m of capped.slice(3)) assert.equal(m.text, long); // 마지막 5개
  assert.equal(msgs[1].text, long); // 입력은 바꾸지 않는다
});

test('capMessages: DM은 루트 없이 마지막 N개만 원문', () => {
  const msgs = [{ ts: '1', text: 'y'.repeat(12) }, { ts: '2', text: 'y'.repeat(12) }];
  assert.deepEqual(capMessages(msgs, { max: 10, keepTail: 1 }).map((m) => m.text), ['y'.repeat(10) + ' …(2자 생략)', 'y'.repeat(12)]);
});
