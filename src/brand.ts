// 개발 실행(node_modules의 Electron.app)은 macOS에서 "Electron"으로 뜨고, app.setName으로는 바뀌지 않는다.
// 이름의 출처가 두 군데라 둘 다 맞춘다.
//   메뉴바·Cmd+Tab: Info.plist의 CFBundleName
//   Dock·Finder: 번들 폴더 이름(Electron.app → "Electron"). 예외는 지역화 표시 이름으로, CFBundleDisplayName이 폴더 이름과 같고
//                LSHasLocalizedDisplayName이 켜져 있고 각 .lproj/InfoPlist.strings에 이름이 있을 때만 그 이름을 쓴다.
//                그래서 CFBundleDisplayName은 폴더 이름 그대로 두고, 실제 이름은 InfoPlist.strings에 넣는다.
// 번들 ID(com.github.Electron)와 아이콘은 그대로 둔다. ID를 바꾸면 알림 허용이 초기화된다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 이름을 바꿨으면 true. 이미 맞춰져 있거나 번들이 없거나 실패하면 false (앱 실행을 막지 않는다)
export function brandElectronApp(appPath: string, name: string): boolean {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return false;
  const resources = path.join(appPath, 'Contents', 'Resources');
  const folderName = path.basename(appPath, '.app');
  const strings = `"CFBundleDisplayName" = ${JSON.stringify(name)};\n"CFBundleName" = ${JSON.stringify(name)};\n`;
  // plutil의 오류 출력은 터미널로 새지 않게 잡아서 경고 한 줄에 합친다
  const plutil = (...args: string[]) => execFileSync('plutil', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const read = (key: string): string | null => {
    try {
      return plutil('-extract', key, 'raw', '-o', '-', plist).replace(/\n$/, '');
    } catch {
      return null;
    }
  };
  try {
    let changed = false;
    const ensure = (key: string, type: '-string' | '-bool', value: string) => {
      if (read(key) === value) return;
      plutil('-replace', key, type, value, plist);
      changed = true;
    };
    ensure('CFBundleName', '-string', name);
    ensure('CFBundleDisplayName', '-string', folderName);
    ensure('LSHasLocalizedDisplayName', '-bool', 'true');
    const lprojs = fs.existsSync(resources) ? fs.readdirSync(resources).filter((d) => d.endsWith('.lproj')) : [];
    for (const lproj of lprojs) {
      const file = path.join(resources, lproj, 'InfoPlist.strings');
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === strings) continue;
      fs.writeFileSync(file, strings);
      changed = true;
    }
    if (!changed) return false;
    // 번들 수정 시각을 갱신해야 macOS가 이름을 다시 읽는다
    const now = new Date();
    fs.utimesSync(appPath, now, now);
    return true;
  } catch (err) {
    const why = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n')[0];
    console.warn(`[brand] 앱 이름을 바꾸지 못했습니다: ${why}`);
    return false;
  }
}
