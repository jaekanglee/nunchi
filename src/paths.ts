// 앱 데이터 위치. Electron userData와 같은 곳이라 Electron 없이 도는 ctl·persona 스크립트도 같은 DB와 말투 데이터를 쓴다.
//   macOS   ~/Library/Application Support/slmmury
//   Windows %APPDATA%\slmmury
//   Linux   $XDG_CONFIG_HOME/slmmury (기본 ~/.config/slmmury)
import os from 'node:os';
import path from 'node:path';

export function dataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'slmmury');
  if (platform === 'win32') return p.join(env.APPDATA ?? p.join(home, 'AppData', 'Roaming'), 'slmmury');
  return p.join(env.XDG_CONFIG_HOME ?? p.join(home, '.config'), 'slmmury');
}

export const DATA_DIR = dataDir();
export const DB_PATH = path.join(DATA_DIR, 'slmmury.db');
export const PERSONA_DIR = path.join(DATA_DIR, 'persona');
