// 코드 확인 결과(사실·근거·기준 커밋)를 다루는 순수 함수들. LLM이 아니라 앱이 직접 확인하고 기록한다
import fs from 'node:fs';
import path from 'node:path';

export type Head = { dir: string; branch: string | null; commit: string | null };
export type Evidence = { path: string; start: number; end: number }; // 폴더 기준 상대 경로, 줄 범위
export type Fact = { claim: string; folder: string; evidence: Evidence[] };
export type VerifiedFact = Fact & { verified: boolean };
export type CodeFacts = { created_at: number; answerable: boolean; topic: string; facts: VerifiedFact[]; unknowns: string[]; heads: Head[] };
// 초안에 넘기는 형태: 저장된 확인 결과와 지금 체크아웃 상태 (커밋이 바뀌었는지 비교)
export type CodeContext = { facts: CodeFacts & { id: number }; now: Head[] };

const short = (commit: string | null) => commit?.slice(0, 7) ?? '?';
const headLabel = (h: Head) => `${path.basename(h.dir)} ${h.branch ?? '(분리된 HEAD)'}@${short(h.commit)}`;

// 지금 체크아웃된 브랜치와 커밋. git 명령 없이 .git 파일만 읽는다 (worktree·packed-refs·detached HEAD 포함)
export function gitHead(dir: string): Head {
  const none = { dir, branch: null, commit: null };
  try {
    let gitDir = path.join(dir, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return none;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const commonFile = path.join(gitDir, 'commondir');
    const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, 'utf8').trim()) : gitDir;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref: (refs\/heads\/.+)$/.exec(head);
    if (!ref) return { dir, branch: null, commit: /^[0-9a-f]{40,64}$/.test(head) ? head : null };
    return { dir, branch: ref[1].slice('refs/heads/'.length), commit: readRef(common, ref[1]) };
  } catch {
    return none;
  }
}

function readRef(common: string, ref: string): string | null {
  const loose = path.join(common, ref);
  if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
  const packed = path.join(common, 'packed-refs');
  if (!fs.existsSync(packed)) return null;
  const line = fs.readFileSync(packed, 'utf8').split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
  return line ? line.split(' ')[0] : null;
}

// 근거가 등록 폴더 안 실제 파일의 실제 줄을 가리키는지. 하나라도 아니면 그 사실은 확인 안 됨
export function verifyFacts(facts: Fact[], dirs: string[]): VerifiedFact[] {
  return facts.map((f) => ({ ...f, verified: dirs.includes(f.folder) && f.evidence.length > 0 && f.evidence.every((e) => evidenceExists(f.folder, e)) }));
}

function evidenceExists(folder: string, e: Evidence): boolean {
  const root = path.resolve(folder);
  // 모델이 "폴더이름/lib/…"처럼 폴더 이름부터 쓰기도 한다 (실측)
  const rel = e.path.startsWith(`${path.basename(root)}/`) ? e.path.slice(path.basename(root).length + 1) : e.path;
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) || e.start < 1 || e.end < e.start) return false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return e.end <= lines;
  } catch {
    return false;
  }
}

// 사실이 나온 폴더의 기준 커밋 (사실이 없으면 전부)
function citedHeads(cf: CodeFacts): Head[] {
  const cited = cf.heads.filter((h) => cf.facts.some((f) => f.folder === h.dir));
  return cited.length ? cited : cf.heads;
}

// 초안 프롬프트에 붙이는 섹션. 답장에 파일 경로가 새지 않게 근거는 넣지 않는다
export function factsSection(cf: CodeFacts, now: Head[]): string {
  const when = new Date(cf.created_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const heads = citedHeads(cf);
  const moved = heads.some((h) => {
    const cur = now.find((n) => n.dir === h.dir);
    return h.commit && cur?.commit && cur.commit !== h.commit;
  });
  return [
    `# 코드로 확인한 사실 (${when} 확인. 답장에 써도 된다)`,
    ...(cf.facts.length ? cf.facts.map((f) => `- ${f.claim}${f.verified ? '' : ' (근거 확인 안 됨. 단정하지 않는다)'}`) : ['- 없음']),
    ...(cf.unknowns.length ? ['', '# 코드로 확인하지 못한 것 (답장에서 단정하지 않고 보류한다)', ...cf.unknowns.map((u) => `- ${u}`)] : []),
    '',
    `확인 기준: ${heads.map(headLabel).join(', ')}. 배포된 버전과 다를 수 있다.`,
    ...(moved ? ['확인한 뒤로 코드가 바뀌었다(커밋이 다름). 단정하지 말고 다시 확인이 필요할 수 있다고 쓴다.'] : []),
    '답장에는 코드나 파일 경로를 붙이지 않고 상대가 알아들을 말로 쓴다.',
  ].join('\n');
}

// 다음 조사가 먼저 찾아보는 노트. 앱이 직접 쓴다 (LLM에 쓰기 도구를 주지 않는다)
export function noteMarkdown(id: number, cf: CodeFacts, question: string): string {
  const at = new Date(cf.created_at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const ev = (f: VerifiedFact, e: Evidence) => `${path.basename(f.folder)}/${e.path}:${e.start === e.end ? e.start : `${e.start}-${e.end}`} ${f.verified ? '✓' : '?'}`;
  return [
    `# ${cf.topic}`,
    '',
    `- 기록: ${stamp} (#${id})`,
    `- 질문: ${question.replace(/\s+/g, ' ').slice(0, 300)}`,
    `- 답할 수 있음: ${cf.answerable ? '예' : '아니오'}`,
    '',
    '## 확인한 사실',
    ...(cf.facts.length ? cf.facts.flatMap((f) => [`- ${f.claim}`, ...f.evidence.map((e) => `  - ${ev(f, e)}`)]) : ['- 없음']),
    ...(cf.unknowns.length ? ['', '## 확인하지 못한 것', ...cf.unknowns.map((u) => `- ${u}`)] : []),
    '',
    '## 기준 커밋',
    ...citedHeads(cf).map((h) => `- ${path.basename(h.dir)}: ${h.branch ?? '(분리된 HEAD)'} @ ${short(h.commit)}`),
    '',
  ].join('\n');
}
