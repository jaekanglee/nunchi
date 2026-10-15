// Slack 앱 매니페스트 생성기. 설정 화면의 "매니페스트 만들기"와 권한 안내가 이 목록 하나를 같이 쓴다.

export type ManifestOptions = {
  appName: string;
  privateChannels: boolean; // 비공개 채널 감시
  groupDms: boolean; // 그룹 DM 감시
  personaLearning: boolean; // 말투 학습(검색)
};

export const DEFAULT_OPTIONS: ManifestOptions = { appName: 'Slmmury', privateChannels: true, groupDms: true, personaLearning: true };

type ScopeInfo = {
  scope: string;
  why: string;
  without: string;
  option?: keyof Omit<ManifestOptions, 'appName'>; // 없으면 필수
  event?: string; // 같이 구독해야 하는 user event
};

export const SCOPES: ScopeInfo[] = [
  { scope: 'im:history', event: 'message.im', why: 'DM을 받고 대화 내용을 읽습니다', without: 'DM에 반응하지 못합니다' },
  { scope: 'channels:history', event: 'message.channels', why: '공개 채널의 멘션과 감시 중인 스레드를 읽습니다', without: '채널 멘션·링크 등록이 동작하지 않습니다' },
  { scope: 'chat:write', why: '내 이름으로 답장을 보냅니다', without: '초안만 만들고 보내지 못합니다' },
  { scope: 'users:read', why: '대화 상대 이름을 표시합니다', without: '상대가 U0123 같은 ID로 보입니다' },
  { scope: 'groups:history', event: 'message.groups', option: 'privateChannels', why: '내가 속한 비공개 채널을 읽습니다', without: '비공개 채널 멘션을 놓칩니다' },
  { scope: 'mpim:history', event: 'message.mpim', option: 'groupDms', why: '여러 명이 있는 그룹 DM을 읽습니다', without: '그룹 DM에 반응하지 못합니다' },
  { scope: 'search:read', option: 'personaLearning', why: '말투 학습 때 공개 채널에서 내가 쓴 메시지를 찾습니다', without: '말투 학습을 할 수 없습니다' },
];

const included = (s: ScopeInfo, o: ManifestOptions) => !s.option || o[s.option];

export function requiredScopes(): string[] {
  return SCOPES.filter((s) => !s.option).map((s) => s.scope);
}

export function buildManifest(o: ManifestOptions) {
  const scopes = SCOPES.filter((s) => included(s, o));
  return {
    display_information: {
      name: o.appName.trim().slice(0, 35) || DEFAULT_OPTIONS.appName,
      description: '개인용 Slack 대리 응답 도우미',
    },
    oauth_config: { scopes: { user: scopes.map((s) => s.scope) } },
    settings: {
      event_subscriptions: { user_events: scopes.flatMap((s) => (s.event ? [s.event] : [])) },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

// 매니페스트에 나오는 모양(중첩 객체, 문자열 배열, 스칼라)만 다루는 최소 YAML 출력
export function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${pad}${k}:\n${v.map((x) => `${pad}  - ${x}`).join('\n')}`;
      if (v !== null && typeof v === 'object') return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
      return `${pad}${k}: ${v}`;
    })
    .join('\n');
}

// 이 링크를 열면 Slack 앱 생성 화면에 매니페스트가 채워진다
export function createAppUrl(manifest: object): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

// 토큰에 실제로 붙은 권한과 비교해 빠진 것을 알려준다
export function missingScopes(granted: string[]): { required: string[]; optional: string[] } {
  const has = new Set(granted);
  const missing = SCOPES.filter((s) => !has.has(s.scope));
  return { required: missing.filter((s) => !s.option).map((s) => s.scope), optional: missing.filter((s) => s.option).map((s) => s.scope) };
}
