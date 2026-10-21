// 들어온 message 이벤트 중 눈치가 처리할 대상인지 판정한다. (design.md §4.2)

export type MessageEvent = {
  type: string;
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  parent_user_id?: string; // 스레드 답글이면 원글 작성자
};

// my_reply는 route가 아니라 joinsThread로 정한다 (내 메시지라서)
export type RouteReason = 'dm' | 'group_dm' | 'mention' | 'group_mention' | 'my_thread' | 'keyword' | 'watched' | 'my_reply';

// <!subteam^S123> 또는 <!subteam^S123|@handle>
export function mentionsGroup(text: string | undefined, groupIds: string[]): boolean {
  return groupIds.some((id) => new RegExp(`<!subteam\\^${id}[>|]`).test(text ?? ''));
}

// 영문 키워드는 단어 경계에서만 찾는다 (app이 happy에 걸리지 않게). 한글은 붙여 써도 찾는다 (쇼핑몰앱 → 쇼핑몰)
export function findKeyword(text: string | undefined, keywords: string[]): string | undefined {
  const t = (text ?? '').toLowerCase();
  return keywords.find((k) => {
    const kw = k.toLowerCase();
    if (!/^[\x20-\x7e]+$/.test(kw)) return t.includes(kw);
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(t);
  });
}

// 메시지가 속한 대화 단위 키. 스레드면 루트 ts, DM이면 채널 자체
export function threadKey(event: Pick<MessageEvent, 'channel' | 'channel_type' | 'ts' | 'thread_ts'>): string {
  if (event.thread_ts) return `${event.channel}:${event.thread_ts}`;
  if (event.channel_type === 'im' || event.channel_type === 'mpim') return `${event.channel}:dm`;
  return `${event.channel}:${event.ts}`;
}

export function route(
  event: MessageEvent,
  myUserId: string,
  opts: { autoDetect: boolean; isWatched: (key: string) => boolean; mentionGroups?: string[]; keywords?: string[] },
): RouteReason | null {
  // 일반 메시지만 처리 (편집·삭제·입퇴장 등 subtype 제외)
  if (event.subtype !== undefined) return null;
  // 루프 방지: 내 메시지, 봇 메시지 제외
  if (event.bot_id !== undefined) return null;
  if (event.user === undefined || event.user === myUserId) return null;

  // 감시 중인 스레드는 멘션이 없어도, 자동 감지가 꺼져 있어도 처리한다
  if (opts.isWatched(threadKey(event))) return 'watched';
  if (!opts.autoDetect) return null;

  if (event.channel_type === 'im') return 'dm';
  if (event.channel_type === 'mpim') return 'group_dm';
  if (event.text?.includes(`<@${myUserId}>`)) return 'mention';
  if (mentionsGroup(event.text, opts.mentionGroups ?? [])) return 'group_mention';
  // 내가 쓴 글에 달린 답글. 앱을 켜기 전에 쓴 글이어도 Slack이 원글 작성자를 알려준다
  if (event.thread_ts && event.parent_user_id === myUserId) return 'my_thread';
  // 내 프로젝트 키워드가 나온 채널 메시지. 나를 부르지 않아도 감시에 올리고, 내 담당인지는 1차 판단이 가린다
  if (findKeyword(event.text, opts.keywords ?? [])) return 'keyword';
  return null;
}

// 감시하지 않던 채널 스레드에 내가 단 답글. 이때부터 그 스레드를 감시한다 (내 원글의 답글은 my_thread가 잡는다)
export function joinsThread(event: MessageEvent, myUserId: string): boolean {
  if (event.subtype !== undefined || event.user !== myUserId) return false;
  if (event.channel_type === 'im' || event.channel_type === 'mpim') return false;
  return event.thread_ts !== undefined && event.thread_ts !== event.ts;
}

// 원본 텍스트의 멘션 ID: <@U123> → U123, <!subteam^S123|…> → S123, <!here> → !here
export function extractMentions(text: string | undefined): string[] {
  const t = text ?? '';
  return [
    ...[...t.matchAll(/<@([UW][A-Z0-9]+)[>|]/g)].map((x) => x[1]),
    ...[...t.matchAll(/<!subteam\^(S[A-Z0-9]+)[>|]/g)].map((x) => x[1]),
    ...[...t.matchAll(/<!(here|channel|everyone)[>|]/g)].map((x) => `!${x[1]}`),
  ];
}

// 다른 사람(또는 내가 없는 그룹)만 콕 집어 부른 메시지. 이런 건 LLM 없이 "내 차례 아님"으로 본다
export function addressedToOthersOnly(mentions: string[], myUserId: string, myGroups: string[]): boolean {
  if (mentions.length === 0) return false;
  return !mentions.some((m) => m === myUserId || myGroups.includes(m) || m.startsWith('!'));
}

// DM과 나를 부른 메시지는 바로(10초), 감시 스레드의 나머지 댓글은 모아서(2분) 처리한다
export function isUrgent(event: Pick<MessageEvent, 'channel_type' | 'text'>, myUserId: string, myGroups: string[]): boolean {
  if (event.channel_type === 'im' || event.channel_type === 'mpim') return true;
  const mentions = extractMentions(event.text);
  return mentions.includes(myUserId) || mentions.some((m) => myGroups.includes(m) || m.startsWith('!'));
}
