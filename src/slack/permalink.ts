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
