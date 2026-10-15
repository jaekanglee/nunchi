// 말투 학습용 (상대 발화 → 내 답) 쌍을 만드는 순수 함수들. (design.md §4.1)

export type SearchMatch = {
  ts: string;
  text: string;
  permalink: string;
  channel: { id: string; is_channel?: boolean; is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
};

export type SlackMessage = { ts: string; user?: string; text?: string; bot_id?: string; subtype?: string };

export type Pair = {
  channel: string;
  ts: string;
  partner: string;
  partnerName?: string;
  context: string;
  reply: string;
};

// 공개 채널 메시지만 학습에 쓴다. DM·비공개 채널 제외
export function isPublicChannel(match: SearchMatch): boolean {
  const c = match.channel;
  return c.is_channel === true && c.is_private !== true && c.is_im !== true && c.is_mpim !== true;
}

// 스레드 답글이면 permalink에 thread_ts가 붙는다
export function parseThreadTs(permalink: string): string | undefined {
  return new URL(permalink).searchParams.get('thread_ts') ?? undefined;
}

// myTs 바로 앞 메시지가 다른 사람의 일반 메시지면 그걸 맥락으로 쓴다.
// 바로 앞이 내 메시지거나 봇·시스템 메시지면 상대 발화가 아니므로 쌍을 만들지 않는다.
export function previousFromOther(messages: SlackMessage[], myTs: string, myUserId: string): SlackMessage | null {
  const before = messages.filter((m) => Number(m.ts) < Number(myTs)).sort((a, b) => Number(a.ts) - Number(b.ts));
  const prev = before.at(-1);
  if (!prev || !prev.user || !prev.text) return null;
  if (prev.user === myUserId || prev.bot_id !== undefined || prev.subtype !== undefined) return null;
  return prev;
}
