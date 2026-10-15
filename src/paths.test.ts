import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataDir } from './paths.js';

test('dataDir: OS별로 Electron userData와 같은 위치', () => {
  assert.equal(dataDir('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/slmmury');
  assert.equal(dataDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\slmmury');
  assert.equal(dataDir('win32', {}, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\slmmury');
  assert.equal(dataDir('linux', {}, '/home/a'), '/home/a/.config/slmmury');
  assert.equal(dataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/a'), '/x/slmmury');
});
