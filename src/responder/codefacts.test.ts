import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factsSection, gitHead, noteMarkdown, verifyFacts, type CodeFacts } from './codefacts.js';

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-code-'));
}
function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('gitHead: 브랜치의 커밋을 refs에서 읽는다', () => {
  const dir = tmp();
  write(path.join(dir, '.git/HEAD'), 'ref: refs/heads/feature/login\n');
  write(path.join(dir, '.git/refs/heads/feature/login'), `${C1}\n`);
  assert.deepEqual(gitHead(dir), { dir, branch: 'feature/login', commit: C1 });
});

test('gitHead: refs에 없으면 packed-refs에서 찾는다', () => {
  const dir = tmp();
  write(path.join(dir, '.git/HEAD'), 'ref: refs/heads/develop\n');
  write(path.join(dir, '.git/packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${C2} refs/heads/develop\n${C1} refs/heads/main\n`);
  assert.deepEqual(gitHead(dir), { dir, branch: 'develop', commit: C2 });
});

test('gitHead: detached HEAD는 브랜치 없이 커밋만', () => {
  const dir = tmp();
  write(path.join(dir, '.git/HEAD'), `${C1}\n`);
  assert.deepEqual(gitHead(dir), { dir, branch: null, commit: C1 });
});

test('gitHead: worktree는 .git 파일이 가리키는 곳과 공용 폴더의 refs를 읽는다', () => {
  const main = tmp();
  const wt = tmp();
  const gitDir = path.join(main, '.git/worktrees/wt');
  write(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
  write(path.join(gitDir, 'HEAD'), 'ref: refs/heads/fix\n');
  write(path.join(gitDir, 'commondir'), '../..\n');
  write(path.join(main, '.git/refs/heads/fix'), `${C2}\n`);
  assert.deepEqual(gitHead(wt), { dir: wt, branch: 'fix', commit: C2 });
});

test('gitHead: git 폴더가 아니면 둘 다 null', () => {
  const dir = tmp();
  assert.deepEqual(gitHead(dir), { dir, branch: null, commit: null });
});

test('verifyFacts: 등록 폴더 안 실제 파일의 줄 범위만 확인됨으로 본다', () => {
  const dir = tmp();
  write(path.join(dir, 'lib/a.dart'), 'l1\nl2\nl3\n');
  const facts = verifyFacts(
    [
      { claim: 'ok', folder: dir, evidence: [{ path: 'lib/a.dart', start: 2, end: 3 }] },
      { claim: '폴더 이름부터 쓴 경로', folder: dir, evidence: [{ path: `${path.basename(dir)}/lib/a.dart`, start: 1, end: 1 }] },
      { claim: '줄 범위 밖', folder: dir, evidence: [{ path: 'lib/a.dart', start: 2, end: 9 }] },
      { claim: '없는 파일', folder: dir, evidence: [{ path: 'lib/none.dart', start: 1, end: 1 }] },
      { claim: '폴더 밖', folder: dir, evidence: [{ path: '../etc/passwd', start: 1, end: 1 }] },
      { claim: '거꾸로', folder: dir, evidence: [{ path: 'lib/a.dart', start: 3, end: 2 }] },
      { claim: '근거 없음', folder: dir, evidence: [] },
      { claim: '등록 안 한 폴더', folder: '/elsewhere', evidence: [{ path: 'lib/a.dart', start: 1, end: 1 }] },
    ],
    [dir],
  );
  assert.deepEqual(facts.map((f) => [f.claim, f.verified]), [
    ['ok', true], ['폴더 이름부터 쓴 경로', true], ['줄 범위 밖', false], ['없는 파일', false], ['폴더 밖', false], ['거꾸로', false], ['근거 없음', false], ['등록 안 한 폴더', false],
  ]);
});

const cf: CodeFacts = {
  created_at: Date.UTC(2026, 9, 20, 9, 40), // 한국 시각 18:40
  answerable: true,
  topic: '예약건 푸시 필터',
  facts: [
    { claim: '숨김 값이 true일 때만 목록에서 뺀다', folder: '/w/rider', evidence: [{ path: 'lib/f.dart', start: 24, end: 47 }], verified: true },
    { claim: '푸시 값이 비면 기존 값을 쓴다', folder: '/w/rider', evidence: [{ path: 'lib/m.dart', start: 117, end: 117 }], verified: false },
  ],
  unknowns: ['서버가 예약 푸시에 값을 넣는지'],
  heads: [{ dir: '/w/rider', branch: 'feature/x', commit: C1 }],
};

test('factsSection: 사실·확인 못 한 것·기준 커밋을 쓰고 파일 경로는 넣지 않는다', () => {
  const s = factsSection(cf, [{ dir: '/w/rider', branch: 'feature/x', commit: C1 }]);
  assert.match(s, /# 코드로 확인한 사실/);
  assert.match(s, /- 숨김 값이 true일 때만 목록에서 뺀다\n/);
  assert.match(s, /- 푸시 값이 비면 기존 값을 쓴다 \(근거 확인 안 됨/);
  assert.match(s, /서버가 예약 푸시에 값을 넣는지/);
  assert.match(s, /rider feature\/x@aaaaaaa/);
  assert.doesNotMatch(s, /lib\/f\.dart/);
  assert.doesNotMatch(s, /코드가 바뀌었다/);
});

test('factsSection: 확인한 뒤 커밋이 바뀌었으면 알린다', () => {
  const s = factsSection(cf, [{ dir: '/w/rider', branch: 'feature/x', commit: C2 }]);
  assert.match(s, /코드가 바뀌었다/);
});

test('noteMarkdown: 근거와 검증 결과, 기준 커밋을 남긴다', () => {
  const md = noteMarkdown(7, cf, '예약건 푸시 공유정보 없으면 어떻게 거르나요?');
  assert.match(md, /^# 예약건 푸시 필터/);
  assert.match(md, /예약건 푸시 공유정보 없으면 어떻게 거르나요\?/);
  assert.match(md, /rider\/lib\/f\.dart:24-47 ✓/);
  assert.match(md, /rider\/lib\/m\.dart:117 \?/);
  assert.match(md, /rider: feature\/x @ aaaaaaa/);
});
