import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, migrateLegacyData } from './paths.js';

test('dataDir: OS별로 Electron userData와 같은 위치', () => {
  assert.equal(dataDir('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/nunchi');
  assert.equal(dataDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\nunchi');
  assert.equal(dataDir('win32', {}, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\nunchi');
  assert.equal(dataDir('linux', {}, '/home/a'), '/home/a/.config/nunchi');
  assert.equal(dataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/a'), '/x/nunchi');
});

test('dataDir: 이름을 넘기면 그 이름의 폴더 (옛 이름 위치 계산용)', () => {
  assert.equal(dataDir('darwin', {}, '/Users/a', 'slmmury'), '/Users/a/Library/Application Support/slmmury');
});

// 이전 로직 테스트는 항상 임시 폴더만 쓴다 (기본 인자는 실제 데이터 폴더)
const quiet = { log() {}, warn() {} };
const makeDirs = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-migrate-'));
  return { from: path.join(root, 'old'), to: path.join(root, 'new') };
};
const write = (dir: string, name: string, body = name) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
};
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

test('migrateLegacyData: 항목을 옮기고 DB 파일(-wal, -shm 포함) 이름을 바꾼다', () => {
  const { from, to } = makeDirs();
  write(from, 'slmmury.db', 'DB');
  write(from, 'slmmury.db-wal', 'WAL');
  write(from, 'slmmury.db-shm', 'SHM');
  write(from, 'credentials.json', 'TOKENS');
  write(from, 'persona/style_guide.md', 'STYLE');

  const r = migrateLegacyData(from, to, quiet);

  assert.equal(r.conflict, false);
  assert.deepEqual(r.moved.sort(), ['credentials.json', 'nunchi.db', 'nunchi.db-shm', 'nunchi.db-wal', 'persona']);
  assert.equal(read(to, 'nunchi.db'), 'DB');
  assert.equal(read(to, 'nunchi.db-wal'), 'WAL');
  assert.equal(read(to, 'nunchi.db-shm'), 'SHM');
  assert.equal(read(to, 'credentials.json'), 'TOKENS');
  assert.equal(read(to, 'persona/style_guide.md'), 'STYLE');
  assert.equal(fs.existsSync(from), false); // 다 옮겨서 비었으니 치운다
});

test('migrateLegacyData: 옛 폴더가 없으면 아무것도 하지 않는다', () => {
  const { from, to } = makeDirs();
  assert.deepEqual(migrateLegacyData(from, to, quiet), { moved: [], conflict: false });
  assert.equal(fs.existsSync(to), false);
});

test('migrateLegacyData: 새 폴더가 먼저 만들어져 있어도 옮기고, 새 쪽에 있는 항목은 건드리지 않는다', () => {
  const { from, to } = makeDirs();
  write(from, 'slmmury.db', 'DB');
  write(from, 'app.log', 'OLD LOG');
  write(to, 'app.log', 'NEW LOG'); // nunchi start가 로그부터 열어 둔 상황

  const r = migrateLegacyData(from, to, quiet);

  assert.deepEqual(r.moved, ['nunchi.db']);
  assert.equal(read(to, 'nunchi.db'), 'DB');
  assert.equal(read(to, 'app.log'), 'NEW LOG');
  assert.equal(read(from, 'app.log'), 'OLD LOG'); // 겹친 항목은 옛 폴더에 남는다
});

test('migrateLegacyData: DB가 양쪽에 다 있으면 아무것도 옮기지 않고 충돌로 알린다', () => {
  const { from, to } = makeDirs();
  write(from, 'slmmury.db', 'OLD');
  write(from, 'credentials.json', 'TOKENS');
  write(to, 'nunchi.db', 'NEW');
  const warnings: string[] = [];

  const r = migrateLegacyData(from, to, { log() {}, warn: (m: string) => void warnings.push(m) });

  assert.deepEqual(r, { moved: [], conflict: true });
  assert.equal(warnings.length, 1);
  assert.equal(read(from, 'slmmury.db'), 'OLD');
  assert.equal(fs.existsSync(path.join(to, 'credentials.json')), false);
});

test('migrateLegacyData: 두 번째 실행은 아무것도 하지 않는다', () => {
  const { from, to } = makeDirs();
  write(from, 'slmmury.db', 'DB');
  migrateLegacyData(from, to, quiet);

  assert.deepEqual(migrateLegacyData(from, to, quiet), { moved: [], conflict: false });
  assert.equal(read(to, 'nunchi.db'), 'DB');
});
