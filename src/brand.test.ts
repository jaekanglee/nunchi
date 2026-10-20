import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { brandElectronApp } from './brand.js';

// plutil은 macOS에만 있다
const onMac = { skip: process.platform !== 'darwin' && 'plutil은 macOS에만 있다' };

const plistXml = (displayName: string, id: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleDisplayName</key><string>${displayName}</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;

// 가짜 Electron.app. 실제 node_modules의 번들은 건드리지 않는다
function fakeApp(opts: { plist?: string; id?: string; displayName?: string } = {}): { app: string; plist: string; strings: (lang: string) => string } {
  const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-brand-')), 'Electron.app');
  for (const dir of ['MacOS', 'Resources/ko.lproj', 'Resources/en.lproj']) fs.mkdirSync(path.join(app, 'Contents', dir), { recursive: true });
  const file = path.join(app, 'Contents', 'Info.plist');
  fs.writeFileSync(file, opts.plist ?? plistXml(opts.displayName ?? 'Electron', opts.id ?? 'com.github.Electron'));
  return { app, plist: file, strings: (lang) => path.join(app, 'Contents', 'Resources', `${lang}.lproj`, 'InfoPlist.strings') };
}
const read = (file: string, key: string) => execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).replace(/\n$/, '');
const longAgo = new Date('2020-01-01T00:00:00Z');

test('brandElectronApp: CFBundleName을 바꾸고, 표시 이름은 지역화로 넣는다 (DisplayName은 폴더 이름 그대로)', onMac, () => {
  const { app, plist, strings } = fakeApp();

  assert.equal(brandElectronApp(app, '눈치'), true);

  assert.equal(read(plist, 'CFBundleName'), '눈치'); // 메뉴바·Cmd+Tab
  assert.equal(read(plist, 'CFBundleDisplayName'), 'Electron'); // 폴더 이름과 같아야 지역화 이름이 쓰인다
  assert.equal(read(plist, 'LSHasLocalizedDisplayName'), 'true');
  for (const lang of ['ko', 'en']) {
    assert.equal(read(strings(lang), 'CFBundleDisplayName'), '눈치');
    assert.equal(read(strings(lang), 'CFBundleName'), '눈치');
  }
  assert.equal(read(plist, 'CFBundleIdentifier'), 'com.github.Electron'); // 바꾸면 알림 허용이 초기화된다
});

test('brandElectronApp: DisplayName까지 바꿔 둔 이전 패치 번들을 바로잡는다', onMac, () => {
  const { app, plist, strings } = fakeApp({ displayName: '눈치' });

  assert.equal(brandElectronApp(app, '눈치'), true);

  assert.equal(read(plist, 'CFBundleDisplayName'), 'Electron');
  assert.equal(read(strings('ko'), 'CFBundleDisplayName'), '눈치');
});

test('brandElectronApp: 이미 맞춰져 있으면 false를 돌려주고 파일을 건드리지 않는다', onMac, () => {
  const { app, plist, strings } = fakeApp();
  brandElectronApp(app, '눈치');
  for (const f of [plist, strings('ko'), strings('en')]) fs.utimesSync(f, longAgo, longAgo);

  assert.equal(brandElectronApp(app, '눈치'), false);

  for (const f of [plist, strings('ko'), strings('en')]) assert.equal(fs.statSync(f).mtimeMs, longAgo.getTime());
});

test('brandElectronApp: 바꾼 뒤 번들 수정 시각을 갱신한다 (macOS가 이름을 다시 읽게)', onMac, () => {
  const { app } = fakeApp();
  fs.utimesSync(app, longAgo, longAgo);

  brandElectronApp(app, '눈치');

  assert.ok(fs.statSync(app).mtimeMs > longAgo.getTime());
});

test('brandElectronApp: Finder·Dock이 보는 표시 이름이 바뀐다', onMac, (t) => {
  // 실제 앱과 번들 ID가 겹치면 LaunchServices가 가짜 번들을 실제 앱으로 착각할 수 있어 다른 ID를 쓴다
  const { app } = fakeApp({ id: 'com.example.nunchi-brand-test' });
  t.after(() => {
    try {
      execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app]);
    } catch {}
  });
  const displayName = () =>
    execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('Foundation'); $.NSFileManager.defaultManager.displayNameAtPath(${JSON.stringify(app)}).js`], { encoding: 'utf8' }).trim();

  brandElectronApp(app, '눈치');

  assert.equal(displayName(), '눈치');
});

test('brandElectronApp: 번들이 없으면 던지지 않고 false', () => {
  assert.equal(brandElectronApp(path.join(os.tmpdir(), 'nunchi-no-such-dir', 'Electron.app'), '눈치'), false);
});

test('brandElectronApp: plist가 깨져 있어도 던지지 않고 false (앱 실행을 막지 않는다)', onMac, (t) => {
  t.mock.method(console, 'warn', () => {});
  const { app } = fakeApp({ plist: 'not a plist' });

  assert.equal(brandElectronApp(app, '눈치'), false);
});
