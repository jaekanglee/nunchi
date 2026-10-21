import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeywords, projectsFrom } from './projects.js';

function project(files: Record<string, string>, name = 'shop-app'): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-proj-')), name);
  fs.mkdirSync(dir);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  return dir;
}

test('extractKeywords: 폴더 이름, package.json·pubspec.yaml 이름, README 첫 제목을 겹치지 않게 뽑는다', () => {
  const dir = project({
    'package.json': JSON.stringify({ name: '@acme/shop-web', description: '긴 설명은 쓰지 않는다' }),
    'pubspec.yaml': 'name: shop_mobile\ndescription: x\n',
    'README.md': '<p>logo</p>\n\n# 쇼핑몰 앱\n\n## 설치\n',
  });
  assert.deepEqual(extractKeywords(dir), ['shop-app', 'shop-web', 'shop_mobile', '쇼핑몰 앱']);
});

test('extractKeywords: 파일이 없거나 깨져도 폴더 이름은 남고, 대소문자만 다른 값은 하나로 친다', () => {
  assert.deepEqual(extractKeywords(project({ 'package.json': '{깨짐' })), ['shop-app']);
  assert.deepEqual(extractKeywords(project({ 'README.md': '# Shop-App\n' })), ['shop-app']);
});

test('projectsFrom: 직접 고친 키워드가 있으면 그것을, 없으면 자동으로 뽑은 키워드를 쓴다', () => {
  const a = project({}, 'alpha');
  const b = project({}, 'beta');
  const ps = projectsFrom([a, b], { [b]: ['베타', 'beta-api'], '/지운/폴더': ['x'] });
  assert.deepEqual(ps, [
    { dir: a, name: 'alpha', keywords: ['alpha'], auto: true },
    { dir: b, name: 'beta', keywords: ['베타', 'beta-api'], auto: false },
  ]);
});
