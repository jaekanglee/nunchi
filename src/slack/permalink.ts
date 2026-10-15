// Slack permalink → 채널, 메시지 ts, 스레드 루트 ts
// 예) https://x.slack.com/archives/C123/p1700000001000200?thread_ts=1700000000.000100&cid=C123

export type PermalinkTarget = { channel: string; ts: string; rootTs: string };

export function parsePermalink(url: string): PermalinkTarget | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const m = u.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/);
  if (!m) return null;
  const ts = `${m[2]}.${m[3]}`;
  return { channel: m[1], ts, rootTs: u.searchParams.get('thread_ts') ?? ts };
}

// 감시 대화 → 원문 링크. 스레드는 루트 메시지(chat.getPermalink와 같은 모양이라 스레드가 바로 열린다), DM은 대화방 자체
// teamUrl은 auth.test의 url (예: https://x.slack.com/)
export function buildPermalink(teamUrl: string, channel: string, rootTs: string | null): string {
  const base = `${teamUrl.replace(/\/+$/, '')}/archives/${channel}`;
  return rootTs ? `${base}/p${rootTs.replace('.', '')}?thread_ts=${rootTs}&cid=${channel}` : base;
}

// Slack 데스크톱 앱 딥링크. slack://channel?team=&id= 는 공식 문서에 있는 형식이고,
// message·thread_ts는 문서에 없는 값이라 앱이 모르면 무시하고 채널만 연다
export function buildDeepLink(teamId: string, channel: string, rootTs: string | null): string {
  const q = new URLSearchParams({ team: teamId, id: channel });
  if (rootTs) {
    q.set('message', rootTs);
    q.set('thread_ts', rootTs);
  }
  return `slack://channel?${q}`;
}
