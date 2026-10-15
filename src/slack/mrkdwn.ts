// Slack 메시지 원문(mrkdwn)을 화면용 조각으로. 링크는 Slack처럼 라벨을 보여주고 주소를 건다.
// 예) "<https://a.com|문서> 봐주세요 &amp; <#C1|dev>" → [링크 '문서'], ' 봐주세요 & ', '#dev'

export type Part = { text: string; url?: string };

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const LINKABLE = /^(https?:\/\/|mailto:)/i;
const BARE_URL = /https?:\/\/[^\s<>]+[^\s<>.,;:!?)'"\]]/g;

// <...> 밖에 그냥 적힌 주소도 링크로 (첨부 미리보기 줄 등)
function plain(s: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of s.matchAll(BARE_URL)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ text: m[0], url: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

function token(body: string): Part {
  const [target, label] = [body.split('|')[0], body.includes('|') ? body.slice(body.indexOf('|') + 1) : ''];
  if (LINKABLE.test(target)) return { text: unescape(label || target.replace(/^mailto:/i, '')), url: unescape(target) };
  if (target.startsWith('#')) return { text: `#${label || target.slice(1)}` };
  if (target.startsWith('@')) return { text: `@${label || target.slice(1)}` };
  if (target.startsWith('!')) {
    const name = target.slice(1).split('^')[0];
    if (['here', 'channel', 'everyone'].includes(name)) return { text: `@${name}` };
    return { text: unescape(label || target) }; // <!date^…|대체 문구> 등
  }
  return { text: `<${unescape(body)}>` };
}

export function toParts(text: string): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(/<([^<>\n]+)>/g)) {
    if (m.index > last) out.push(...plain(unescape(text.slice(last, m.index))));
    out.push(token(m[1]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...plain(unescape(text.slice(last))));
  // 이어진 일반 텍스트는 하나로
  return out.reduce<Part[]>((acc, p) => {
    const prev = acc.at(-1);
    if (prev && !prev.url && !p.url) prev.text += p.text;
    else acc.push({ ...p });
    return acc;
  }, []);
}
