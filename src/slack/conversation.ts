// 대화 키(channel:rootTs 또는 channel:dm)의 메시지들을 이름과 함께 가져온다.
import type { WebClient } from '@slack/web-api';
import type { ThreadMessage } from '../responder/prompt.js';
import type { SlackMessage } from '../persona/pairs.js';
import { extractMentions } from './router.js';

const DM_HISTORY = 20;
const THREAD_KEEP = 60; // 긴 스레드는 기본으로 본문 + 최근 60개만 쓴다 (요약은 더 많이)

// 페이지를 합친 결과는 순서·중복이 보장되지 않으므로 ts로 정리하고, 본문(루트)은 항상 남긴다
export function trimThread<T extends { ts: string }>(messages: T[], rootTs: string, keep: number): T[] {
  const sorted = [...new Map(messages.map((m) => [m.ts, m])).values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  const root = sorted.find((m) => m.ts === rootTs);
  const rest = sorted.filter((m) => m.ts !== rootTs).slice(-keep);
  return root ? [root, ...rest] : rest;
}

// <!subteam^S123|@handle> → @handle, 내가 속한 그룹이면 (나 포함)을 붙여 모델이 나에게 온 말인지 알게 한다
export function readableGroupMentions(text: string, myGroups: string[]): string {
  return text.replace(/<!subteam\^(S[A-Z0-9]+)(?:\|(@?[^>]+))?>/g, (_m, id: string, handle?: string) => {
    const name = handle ? (handle.startsWith('@') ? handle : `@${handle}`) : '@그룹';
    return myGroups.includes(id) ? `${name}(나 포함 그룹)` : name;
  });
}

// 대화 목록에 보여줄 제목: "DM · 상대" 또는 "본문 작성자 · 본문 앞부분"
export function conversationTitle(messages: ThreadMessage[], isDm: boolean, myUserId: string): string {
  if (isDm) {
    const names = [...new Set(messages.filter((m) => m.user !== myUserId).map((m) => m.name))];
    return `DM · ${names.join(', ') || '상대'}`;
  }
  const root = messages[0];
  if (!root) return '(빈 대화)';
  const snippet = root.text.replace(/\s+/g, ' ').trim();
  return `${root.user === myUserId ? '나' : root.name} · ${snippet.length > 40 ? snippet.slice(0, 40) + '…' : snippet}`;
}

// 나를 가리키는 멘션은 프롬프트의 [나]와 맞추기 위해 @나 로 쓴다
export function createConversationReader(client: WebClient, myUserId: string, myGroups: () => string[] = () => []) {
  const names = new Map<string, string>();

  async function nameOf(user: string): Promise<string> {
    if (!names.has(user)) {
      const u = await client.users.info({ user }).catch(() => null);
      names.set(user, u?.user?.profile?.display_name || u?.user?.real_name || u?.user?.name || user);
    }
    return names.get(user)!;
  }

  async function read(channel: string, rootTs: string | null, keep = THREAD_KEEP): Promise<ThreadMessage[]> {
    let raw: SlackMessage[];
    if (rootTs) {
      const all: SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const r = await client.conversations.replies({ channel, ts: rootTs, limit: 200, cursor });
        all.push(...((r.messages ?? []) as SlackMessage[]));
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      raw = trimThread(all, rootTs, keep);
    } else {
      // DM은 기본 최근 20개, 요약처럼 깊게 읽을 때는 keep만큼 (API 한 번 최대 200)
      const limit = keep === THREAD_KEEP ? DM_HISTORY : Math.min(keep, 200);
      const r = await client.conversations.history({ channel, limit });
      raw = ((r.messages ?? []) as SlackMessage[]).reverse();
    }

    const out: ThreadMessage[] = [];
    for (const m of raw) {
      if (!m.user || m.subtype !== undefined) continue;
      let text = m.text ?? '';
      const mentions = extractMentions(text);
      // 첨부 파일·링크 미리보기는 텍스트에 없으므로 무엇이 붙었는지만 적어준다
      const extra = m as { files?: { name?: string }[]; attachments?: { title?: string; from_url?: string }[] };
      for (const f of extra.files ?? []) text += `\n[첨부 파일: ${f.name ?? '이름 없음'}]`;
      for (const a of extra.attachments ?? []) text += `\n[링크 미리보기: ${a.title ?? ''} ${a.from_url ?? ''}]`;
      // <@U123> 멘션을 이름으로 풀어준다
      for (const id of new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((x) => x[1]))) {
        text = text.replaceAll(`<@${id}>`, `@${id === myUserId ? '나' : await nameOf(id)}`);
      }
      text = readableGroupMentions(text, myGroups());
      out.push({ ts: m.ts, user: m.user, name: await nameOf(m.user), text, mentions });
    }
    return out;
  }

  return { read, nameOf };
}

export type ConversationReader = ReturnType<typeof createConversationReader>;
