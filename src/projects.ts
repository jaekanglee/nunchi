// 내가 등록한 프로젝트 폴더와 키워드. 키워드는 1차 판단·초안의 "내 프로젝트" 근거이고,
// 나를 부르지 않은 채널 메시지도 감시에 올리는 기준이다 (router의 keyword)
import fs from 'node:fs';
import path from 'node:path';

export type Project = { dir: string; name: string; keywords: string[]; auto: boolean };

// 폴더에서 키워드를 뽑는다: 폴더 이름, package.json·pubspec.yaml의 name, README 첫 제목. LLM 없이 파일만 읽는다
export function extractKeywords(dir: string): string[] {
  const read = (file: string) => {
    try {
      return fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      return '';
    }
  };
  let pkgName = '';
  try {
    pkgName = String(JSON.parse(read('package.json') || '{}').name ?? '').replace(/^@[^/]+\//, '');
  } catch {
    // 깨진 package.json은 건너뛴다
  }
  const found = [
    path.basename(dir),
    pkgName,
    read('pubspec.yaml').match(/^name:\s*["']?([\w-]+)/m)?.[1] ?? '',
    read('README.md').match(/^#\s+(.+?)\s*$/m)?.[1] ?? '',
  ];
  const seen = new Set<string>();
  return found.map((k) => k.trim()).filter((k) => k && k.length <= 40 && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()));
}

// stored: 내가 직접 고친 키워드 (설정 projectKeywords). 없는 폴더는 자동으로 뽑는다
export function projectsFrom(dirs: string[], stored: Record<string, string[]>): Project[] {
  return dirs.map((dir) => ({
    dir,
    name: path.basename(dir),
    ...(stored[dir] ? { keywords: stored[dir], auto: false } : { keywords: extractKeywords(dir), auto: true }),
  }));
}

// 메시지마다 폴더를 다시 읽지 않게, 설정 값이 그대로면 지난 결과를 쓴다
let cache: { key: string; value: Project[] } | undefined;
export function cachedProjects(dirs: string[], stored: Record<string, string[]>): Project[] {
  const key = JSON.stringify([dirs, stored]);
  if (cache?.key !== key) cache = { key, value: projectsFrom(dirs, stored) };
  return cache.value;
}
