// 공개 채널에서 내 메시지를 모아 (상대 발화 → 내 답) 쌍을 만든다.
// 앱 첫 설정 화면에서 실행된다. 직접 돌릴 때: npm run persona:collect -- [개월수=6] [최대메시지수=1000] (.env의 SLACK_USER_TOKEN 사용)
// 결과: PERSONA_DIR/my_messages.jsonl, PERSONA_DIR/pairs.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import { PERSONA_DIR } from '../paths.js';
import { isPublicChannel, parseThreadTs, previousFromOther, type Pair, type SearchMatch, type SlackMessage } from './pairs.js';

export async function collectPersona(token: string, months = 6, limit = 1000, log: (line: string) => void = console.log) {
  // rate limit(429)은 WebClient가 알아서 기다렸다가 재시도한다
  const client = new WebClient(token);
  const myUserId = (await client.auth.test()).user_id as string;

  const after = new Date();
  after.setMonth(after.getMonth() - months);
  const query = `from:<@${myUserId}> after:${after.toISOString().slice(0, 10)}`;

  // 1) 내 메시지 검색 (공개 채널만)
  const mine: SearchMatch[] = [];
  for (let page = 1; mine.length < limit; page++) {
    const res = await client.search.messages({ query, sort: 'timestamp', sort_dir: 'desc', count: 100, page });
    const matches = (res.messages?.matches ?? []) as unknown as SearchMatch[];
    mine.push(...matches.filter(isPublicChannel));
    log(`검색 ${page}/${res.messages?.paging?.pages ?? '?'} 페이지 · 누적 ${mine.length}`);
    if (page >= (res.messages?.paging?.pages ?? 0)) break;
  }
  mine.splice(limit);

  // 2) 각 메시지의 직전 상대 발화 붙이기
  const threadCache = new Map<string, SlackMessage[]>();
  const nameCache = new Map<string, string>();
  const pairs: Pair[] = [];

  for (const [i, m] of mine.entries()) {
    const channel = m.channel.id;
    const threadTs = parseThreadTs(m.permalink);
    let candidates: SlackMessage[];
    try {
      if (threadTs && threadTs !== m.ts) {
        const key = `${channel}:${threadTs}`;
        if (!threadCache.has(key)) {
          const r = await client.conversations.replies({ channel, ts: threadTs, limit: 1000 });
          threadCache.set(key, (r.messages ?? []) as SlackMessage[]);
        }
        candidates = threadCache.get(key)!;
      } else {
        const r = await client.conversations.history({ channel, latest: m.ts, inclusive: false, limit: 1 });
        candidates = (r.messages ?? []) as SlackMessage[];
      }
    } catch (err) {
      console.warn(`맥락 조회 실패 (${channel} ${m.ts}):`, (err as Error).message);
      continue;
    }

    const prev = previousFromOther(candidates, m.ts, myUserId);
    if (prev) {
      const partner = prev.user!;
      if (!nameCache.has(partner)) {
        const u = await client.users.info({ user: partner }).catch(() => null);
        nameCache.set(partner, u?.user?.real_name ?? u?.user?.name ?? partner);
      }
      pairs.push({ channel, ts: m.ts, partner, partnerName: nameCache.get(partner), context: prev.text!, reply: m.text });
    }
    if ((i + 1) % 50 === 0) log(`맥락 ${i + 1}/${mine.length} · 쌍 ${pairs.length}`);
  }

  fs.mkdirSync(PERSONA_DIR, { recursive: true });
  const toJsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(
    path.join(PERSONA_DIR, 'my_messages.jsonl'),
    toJsonl(mine.map((m) => ({ channel: m.channel.id, ts: m.ts, text: m.text }))),
  );
  fs.writeFileSync(path.join(PERSONA_DIR, 'pairs.jsonl'), toJsonl(pairs));
  log(`완료: 내 메시지 ${mine.length}개, 대화 쌍 ${pairs.length}개 → ${PERSONA_DIR}`);
  return { messages: mine.length, pairs: pairs.length };
}

if (require.main === module) {
  require('dotenv/config');
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error('.env에 SLACK_USER_TOKEN이 없습니다');
  collectPersona(token, Number(process.argv[2] ?? 6), Number(process.argv[3] ?? 1000)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
