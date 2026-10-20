import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OPTIONS, buildManifest, createAppUrl, missingScopes, toYaml } from './manifest.js';

test('저장소의 slack-manifest.yaml은 기본 옵션 생성 결과와 같다', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', '..', 'slack-manifest.yaml'), 'utf8');
  assert.equal(file.trim(), toYaml(buildManifest(DEFAULT_OPTIONS)));
});

test('선택 기능을 끄면 해당 권한과 이벤트가 빠진다', () => {
  const m = buildManifest({ ...DEFAULT_OPTIONS, privateChannels: false, groupDms: false, personaLearning: false });
  assert.deepEqual(m.oauth_config.scopes.user, ['im:history', 'channels:history', 'chat:write', 'users:read']);
  assert.deepEqual(m.settings.event_subscriptions.user_events, ['message.im', 'message.channels']);
});

test('앱 이름은 35자로 자르고 비어 있으면 기본값', () => {
  assert.equal(buildManifest({ ...DEFAULT_OPTIONS, appName: 'a'.repeat(50) }).display_information.name.length, 35);
  assert.equal(buildManifest({ ...DEFAULT_OPTIONS, appName: '  ' }).display_information.name, 'Nunchi');
});

test('생성 링크는 JSON을 URL 인코딩해 담는다', () => {
  const m = buildManifest(DEFAULT_OPTIONS);
  const url = new URL(createAppUrl(m));
  assert.equal(url.origin + url.pathname, 'https://api.slack.com/apps');
  assert.deepEqual(JSON.parse(url.searchParams.get('manifest_json')!), m);
});

test('missingScopes: 필수와 선택 권한을 나눠 알려준다', () => {
  assert.deepEqual(missingScopes(['im:history', 'channels:history', 'chat:write', 'users:read']), {
    required: [],
    optional: ['groups:history', 'mpim:history', 'search:read'],
  });
  assert.deepEqual(missingScopes(['im:history', 'search:read']).required, ['channels:history', 'chat:write', 'users:read']);
});
