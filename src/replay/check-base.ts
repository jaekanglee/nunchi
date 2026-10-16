// judge SYSTEM 원복 확인: HEAD의 judge.ts SYSTEM, 현재 judge.ts SYSTEM, SYSTEM_BASE가 바이트 단위로 같으면 0
// 사용: npm run replay:check-base
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { SYSTEM } from '../responder/judge.js';
import { SYSTEM_BASE } from './prompts.js';

export function extractSystem(source: string): string | null {
  return source.match(/(?:export )?const SYSTEM = `([\s\S]*?)`;/)?.[1] ?? null;
}

function main(): number {
  const repo = path.resolve(__dirname, '..', '..');
  const head = extractSystem(execFileSync('git', ['-C', repo, 'show', 'HEAD:src/responder/judge.ts'], { encoding: 'utf8' }));
  if (head === null) {
    console.error('HEAD의 judge.ts에서 SYSTEM을 찾지 못했습니다');
    return 2;
  }
  const checks: [string, boolean][] = [
    ['HEAD SYSTEM == SYSTEM_BASE', head === SYSTEM_BASE],
    ['현재 SYSTEM == SYSTEM_BASE', SYSTEM === SYSTEM_BASE],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? 'OK  ' : 'DIFF'} ${name}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
