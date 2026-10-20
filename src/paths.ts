// 앱 데이터 위치. Electron userData와 같은 곳이라 Electron 없이 도는 ctl·persona 스크립트도 같은 DB와 말투 데이터를 쓴다.
//   macOS   ~/Library/Application Support/nunchi
//   Windows %APPDATA%\nunchi
//   Linux   $XDG_CONFIG_HOME/nunchi (기본 ~/.config/nunchi)
// 앱 이름이 slmmury이던 때의 폴더는 migrateLegacyData가 처음 실행할 때 옮긴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = 'nunchi';
const LEGACY_APP_DIR = 'slmmury';
const DB_FILE = 'nunchi.db';
const LEGACY_DB_FILE = 'slmmury.db';

export function dataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir(), name = APP_DIR): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', name);
  if (platform === 'win32') return p.join(env.APPDATA ?? p.join(home, 'AppData', 'Roaming'), name);
  return p.join(env.XDG_CONFIG_HOME ?? p.join(home, '.config'), name);
}

export const DATA_DIR = dataDir();
export const LEGACY_DATA_DIR = dataDir(undefined, undefined, undefined, LEGACY_APP_DIR);
export const DB_PATH = path.join(DATA_DIR, DB_FILE);
export const PERSONA_DIR = path.join(DATA_DIR, 'persona');

export type Migration = { moved: string[]; conflict: boolean };

// 옛 이름 폴더의 내용을 새 폴더로 옮긴다. 앱과 ctl이 DB를 열기 전에 부르며, 앱이 꺼져 있을 때만 안전하다.
// 폴더째 옮기지 않고 항목마다 옮긴다. 앱이나 `nunchi start`가 새 폴더를 먼저 만들어 둬도(로그, Chromium 파일) 이전이 건너뛰어지지 않게.
// 새 쪽에 이미 있는 항목은 건드리지 않고 옛 폴더에 남긴다. DB가 양쪽에 다 있으면 어느 쪽이 맞는지 알 수 없으니 아무것도 옮기지 않는다.
export function migrateLegacyData(from = LEGACY_DATA_DIR, to = DATA_DIR, log: Pick<Console, 'log' | 'warn'> = console): Migration {
  const result: Migration = { moved: [], conflict: false };
  if (!fs.existsSync(from)) return result;
  if (fs.existsSync(path.join(from, LEGACY_DB_FILE)) && fs.existsSync(path.join(to, DB_FILE))) {
    log.warn(`[migrate] ${from}와 ${to}에 DB가 모두 있어 옮기지 않았습니다. 맞는 쪽만 남기고 다른 쪽을 치워 주세요`);
    return { ...result, conflict: true };
  }
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    // DB 본체와 -wal, -shm은 같이 이름을 바꿔야 SQLite가 한 묶음으로 읽는다
    const isDb = name === LEGACY_DB_FILE || name === `${LEGACY_DB_FILE}-wal` || name === `${LEGACY_DB_FILE}-shm`;
    const target = isDb ? DB_FILE + name.slice(LEGACY_DB_FILE.length) : name;
    const dest = path.join(to, target);
    if (fs.existsSync(dest)) continue;
    fs.renameSync(path.join(from, name), dest);
    result.moved.push(target);
  }
  if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
  if (result.moved.length) log.log(`[migrate] ${from} → ${to} (${result.moved.length}개 항목)`);
  return result;
}
