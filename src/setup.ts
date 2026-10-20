// 첫 실행 설정: Claude Code 로그인 확인, Slack 토큰 검증·저장.
// 토큰은 Electron safeStorage로 암호화해 DATA_DIR에 둔다 (macOS 키체인, Windows DPAPI, Linux 키링).
// Linux에 키링이 없으면 암호화 없이 권한 600 파일로 저장하고 화면에 경고한다. 저장된 게 없으면 .env를 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { safeStorage } from 'electron';
import { WebClient } from '@slack/web-api';
import { DATA_DIR } from './paths.js';
import { missingScopes } from './slack/manifest.js';
import { CLAUDE_MISSING } from './llm/claude.js';

export type Tokens = { userToken: string; appToken: string };

const FILE = path.join(DATA_DIR, 'credentials.json');

type Decrypt = (value: string) => string;
const decryptWithSafeStorage: Decrypt = (v) => safeStorage.decryptString(Buffer.from(v, 'base64'));

export function loadTokens(file = FILE, decryptValue: Decrypt = decryptWithSafeStorage): Tokens | null {
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<keyof Tokens, string> & { plain?: boolean };
      const dec = (v: string) => (saved.plain ? v : decryptValue(v));
      return { userToken: dec(saved.userToken), appToken: dec(saved.appToken) };
    } catch {
      // 앱 이름이 바뀌면 안전 저장소 키가 달라져 복호화가 안 될 수 있다. 앱이 꺼지지 않게 저장된 토큰이 없는 것으로 보고 설정 화면에서 다시 받는다.
      // 오류 메시지에는 파일 내용 조각이 섞일 수 있어 로그에 남기지 않는다
      console.warn('[setup] 저장된 토큰을 읽지 못했습니다(복호화 실패 또는 파일 손상). 설정 화면에서 토큰을 다시 입력하세요');
    }
  }
  const { SLACK_USER_TOKEN, SLACK_APP_TOKEN } = process.env;
  return SLACK_USER_TOKEN && SLACK_APP_TOKEN ? { userToken: SLACK_USER_TOKEN, appToken: SLACK_APP_TOKEN } : null;
}

// weak: 키링이 없어 암호화하지 못했거나(평문) Linux의 basic_text 백엔드(난독화 수준)인 경우
export function saveTokens(t: Tokens): { weak: boolean } {
  const available = safeStorage.isEncryptionAvailable();
  const enc = (v: string) => (available ? safeStorage.encryptString(v).toString('base64') : v);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ userToken: enc(t.userToken), appToken: enc(t.appToken), plain: !available }), { mode: 0o600 });
  return { weak: !available || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') };
}

// 두 토큰이 실제로 동작하고 필요한 권한이 붙었는지 확인한다. 선택 권한이 빠진 건 경고로 돌려준다
export async function verifyTokens(t: Tokens): Promise<{ user: string; team: string; missingOptional: string[] }> {
  if (!t.userToken.startsWith('xoxp-')) throw new Error('User OAuth Token은 xoxp-로 시작해야 합니다 (Bot 토큰 xoxb-가 아님)');
  if (!t.appToken.startsWith('xapp-')) throw new Error('App-Level Token은 xapp-로 시작해야 합니다');
  const auth = await new WebClient(t.userToken).auth.test().catch((err) => {
    throw new Error(`User Token 확인 실패: ${err.data?.error ?? err.message}`);
  });
  const missing = missingScopes(auth.response_metadata?.scopes ?? []);
  if (missing.required.length) throw new Error(`User Token에 필수 권한이 없습니다: ${missing.required.join(', ')} (매니페스트를 고친 뒤 앱을 다시 설치하세요)`);
  await new WebClient(t.appToken).apps.connections.open().catch((err) => {
    throw new Error(`App Token 확인 실패: ${err.data?.error ?? err.message} (connections:write 권한과 Socket Mode를 확인하세요)`);
  });
  return { user: auth.user as string, team: auth.team as string, missingOptional: missing.optional };
}

// LLM은 이 컴퓨터에 로그인된 Claude Code(`claude -p`)를 쓴다
export function checkClaude(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], (err, stdout) => {
      if (err && !stdout) return resolve({ ok: false, detail: CLAUDE_MISSING });
      try {
        const s = JSON.parse(stdout);
        resolve(s.loggedIn ? { ok: true, detail: `${s.authMethod ?? ''} 로그인됨` } : { ok: false, detail: '로그인 필요: 터미널에서 claude 실행 후 /login' });
      } catch {
        resolve({ ok: false, detail: stdout.trim() || String(err) });
      }
    });
  });
}
