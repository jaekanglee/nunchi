import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTokens } from './setup.js';

function credFile(body: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-cred-'));
  const file = path.join(dir, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

// 개발자 셸에 토큰 환경변수가 있어도 결과가 달라지지 않게 고정한다
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(prev);
  }
}
const NO_ENV = { SLACK_USER_TOKEN: undefined, SLACK_APP_TOKEN: undefined };
const failing = () => {
  throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString');
};

test('loadTokens: 평문으로 저장된 토큰은 복호화 없이 읽는다', () => {
  const file = credFile({ userToken: 'xoxp-1', appToken: 'xapp-1', plain: true });
  const t = withEnv(NO_ENV, () => loadTokens(file, failing));
  assert.deepEqual(t, { userToken: 'xoxp-1', appToken: 'xapp-1' });
});

test('loadTokens: 암호화된 토큰은 decrypt를 거친다', () => {
  const file = credFile({ userToken: 'AAA', appToken: 'BBB', plain: false });
  const t = withEnv(NO_ENV, () => loadTokens(file, (v) => `dec:${v}`));
  assert.deepEqual(t, { userToken: 'dec:AAA', appToken: 'dec:BBB' });
});

test('loadTokens: 복호화에 실패해도 던지지 않고 null (앱이 꺼지지 않고 설정 화면이 뜨게)', (t) => {
  t.mock.method(console, 'warn', () => {});
  const file = credFile({ userToken: 'AAA', appToken: 'BBB', plain: false });
  assert.equal(withEnv(NO_ENV, () => loadTokens(file, failing)), null);
});

test('loadTokens: 복호화에 실패하면 환경변수 토큰으로 넘어간다', (t) => {
  t.mock.method(console, 'warn', () => {});
  const file = credFile({ userToken: 'AAA', appToken: 'BBB', plain: false });
  const got = withEnv({ SLACK_USER_TOKEN: 'xoxp-env', SLACK_APP_TOKEN: 'xapp-env' }, () => loadTokens(file, failing));
  assert.deepEqual(got, { userToken: 'xoxp-env', appToken: 'xapp-env' });
});
