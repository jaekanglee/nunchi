// 원격 제어(ctl)와 앱이 함께 쓰는 설정 키와 허용 값
import { EFFORTS, MODELS } from '../llm/claude.js';
import { AUTO_ELIGIBLE, DEFAULT_THRESHOLDS, type Category, type Thresholds } from '../responder/policy.js';

// range: 정수 [최소, 최대], unit은 오류 메시지용. list: 쉼표로 여러 개 고르는 값 (없으면 none). check: 정규식으로 못 거르는 값 (JSON 등)
type SettingDef = {
  values?: readonly string[];
  list?: readonly string[];
  pattern?: RegExp;
  check?: (value: string) => boolean;
  range?: [number, number];
  unit?: string;
  fallback: string;
  desc: string;
};

// 자동 전송할 대화 종류: 1:1 DM, 그룹 DM, 채널 스레드
export const AUTO_TARGETS = ['dm', 'group_dm', 'channel'] as const;

export const SETTINGS: Record<string, SettingDef> = {
  paused: { values: ['on', 'off'], fallback: 'off', desc: '전체 일시정지 (on이면 판단·초안·자동 전송 모두 멈춤)' },
  autoDetect: { values: ['on', 'off'], fallback: 'on', desc: '자동 감지 (off면 링크로 등록한 대화만)' },
  sendMode: { values: ['draft', 'auto'], fallback: 'draft', desc: '전송 방식' },
  model: { values: MODELS, fallback: 'claude-sonnet-5-5', desc: '기본 모델' },
  draftEffort: { values: EFFORTS, fallback: 'medium', desc: '초안 effort' },
  summaryEffort: { values: EFFORTS, fallback: 'low', desc: '요약 effort' },
  judgeModel: { values: [...MODELS, 'off'], fallback: 'claude-haiku-5-5', desc: '채널 스레드 1차 판단 모델 (내 차례일 때만 기본 모델로 초안, DM은 항상 기본 모델, off면 끔)' },
  // 실측(질문 4개): Haiku 탐색이 근거 23/23 확인, 비용은 한 번에 처리하던 방식의 약 40%
  codeModel: { values: MODELS, fallback: 'claude-haiku-5-5', desc: "'코드 보고 다시 쓰기'에서 코드를 찾는 모델 (답장은 기본 모델이 쓴다)" },
  // 내가 속한 사용자 그룹 ID (쉼표로 여러 개, 비우려면 none)
  urgentDelaySec: { range: [3, 600], unit: '초', fallback: '10', desc: '나를 부른 메시지·DM이 오면 몇 초 뒤 판단할지 (그 사이 온 메시지는 기다림을 늘리지 않고 함께 판단)' },
  batchDelaySec: { range: [10, 3600], unit: '초', fallback: '120', desc: '눈치 보는 스레드의 나머지 댓글을 몇 초 모았다가 판단할지' },
  autoSendMinSec: { range: [0, 3600], unit: '초', fallback: '60', desc: '자동 전송 지연 최소(초). 최소~최대 사이에서 무작위' },
  autoSendMaxSec: { range: [0, 3600], unit: '초', fallback: '300', desc: '자동 전송 지연 최대(초)' },
  autoTargets: { list: AUTO_TARGETS, fallback: AUTO_TARGETS.join(','), desc: `자동 전송할 대화 종류 (쉼표 구분, 없으면 none. 가능: ${AUTO_TARGETS.join(', ')})` },
  autoCategories: { list: AUTO_ELIGIBLE, fallback: DEFAULT_THRESHOLDS.autoCategories.join(','), desc: `자동 전송할 카테고리 (쉼표 구분, 없으면 none. 가능: ${AUTO_ELIGIBLE.join(', ')})` },
  autoMaxRisk: { range: [0, 100], fallback: String(DEFAULT_THRESHOLDS.autoMaxRisk), desc: '위험이 이 값 미만일 때만 자동 전송 (0~100)' },
  autoMinConfidence: { range: [0, 100], unit: '%', fallback: String(DEFAULT_THRESHOLDS.autoMinConfidence * 100), desc: '확신이 이 값(%) 이상일 때만 자동 전송' },
  escalateRisk: { range: [1, 100], fallback: String(DEFAULT_THRESHOLDS.escalateRisk), desc: '위험이 이 값 이상이면 모드와 상관없이 직접 확인' },
  adUrl: { pattern: /^(none|https:\/\/\S+)$/, fallback: 'none', desc: '사이드바 하단 광고 배너로 띄울 https 페이지 (없으면 none)' },
  mentionGroups: { pattern: /^(none|S[A-Z0-9]+(,S[A-Z0-9]+)*)$/, fallback: 'none', desc: '반응할 그룹 멘션 (S로 시작하는 ID, 쉼표 구분, 없으면 none)' },
  myScope: { pattern: /^\S.{0,299}$/, fallback: 'none', desc: '내 담당 업무 키워드 (쉼표로 여러 개, 300자 이내). none이면 말투 학습이 뽑은 값을 쓴다 (판단·초안에서 내 담당과 무관한 대화를 거름)' },
  myGuide: { pattern: /^\S[\s\S]{0,1999}$/, fallback: 'none', desc: '내 지침. 판단·초안을 쓸 때 말투 가이드보다 우선해서 따른다 (여러 줄 2000자 이내, 없으면 none)' },
  projectKeywords: { check: isKeywordMap, fallback: '{}', desc: '프로젝트 폴더별로 직접 고친 키워드 (JSON: {"폴더 경로": ["키워드", …]}). 없는 폴더는 폴더에서 자동으로 뽑는다' },
  projectDirs: { pattern: /^(none|(\/|[A-Za-z]:\\)[^\n]*(\n(\/|[A-Za-z]:\\)[^\n]*)*)$/, fallback: 'none', desc: "내 프로젝트 폴더. 키워드로 판단·감지에 쓰고 '코드 보고 다시 쓰기'가 코드를 읽는다 (절대 경로, 줄바꿈으로 여러 개, 없으면 none)" },
};

// 자동 전송 기준 프리셋 (설정 화면의 칩). 값은 설정 저장 단위(확신은 %). 보통은 기본값을 따라간다
type RiskValues = { autoMaxRisk: string; escalateRisk: string; autoMinConfidence: string };
export const RISK_PRESETS: { id: string; label: string; desc: string; values: RiskValues }[] = [
  { id: 'careful', label: '신중', desc: '확실히 안전한 것만 보내고, 조금만 애매해도 알립니다', values: { autoMaxRisk: '10', escalateRisk: '40', autoMinConfidence: '90' } },
  {
    id: 'normal', label: '보통', desc: '가벼운 답장은 보내고, 위험해 보이면 알립니다',
    values: { autoMaxRisk: SETTINGS.autoMaxRisk.fallback, escalateRisk: SETTINGS.escalateRisk.fallback, autoMinConfidence: SETTINGS.autoMinConfidence.fallback },
  },
  { id: 'bold', label: '적극', desc: '웬만한 건 보내고, 정말 위험할 때만 알립니다', values: { autoMaxRisk: '35', escalateRisk: '75', autoMinConfidence: '70' } },
];

export function parseList(value: string): string[] {
  return value === 'none' ? [] : value.split(',').filter(Boolean);
}

export function thresholdsFrom(get: (key: string) => string): Thresholds {
  return {
    autoCategories: parseList(get('autoCategories')) as Category[],
    autoMaxRisk: Number(get('autoMaxRisk')),
    autoMinConfidence: Number(get('autoMinConfidence')) / 100,
    escalateRisk: Number(get('escalateRisk')),
  };
}

export const parseGroups = parseList;

// 프로젝트 키워드 설정: 절대 경로 → 키워드 목록. 키워드는 공백만 아닌 40자 이내
function isKeywordMap(value: string): boolean {
  let map: unknown;
  try {
    map = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return false;
  return Object.entries(map).every(
    ([dir, kws]) => /^(\/|[A-Za-z]:\\)/.test(dir) && Array.isArray(kws) && kws.length <= 30 && kws.every((k) => typeof k === 'string' && k.trim() !== '' && k.length <= 40),
  );
}

export function parseKeywordMap(value: string): Record<string, string[]> {
  return isKeywordMap(value) ? JSON.parse(value) : {};
}

// 폴더 경로에는 쉼표가 들어갈 수 있어 줄바꿈으로 나눈다
export function parseDirs(value: string): string[] {
  return value === 'none' ? [] : value.split('\n');
}

export function validateSetting(key: string, value: string): string | null {
  const def = SETTINGS[key];
  if (!def) return `알 수 없는 설정: ${key} (가능: ${Object.keys(SETTINGS).join(', ')})`;
  if (def.values && !def.values.includes(value)) return `${key}에 쓸 수 없는 값: ${value} (가능: ${def.values.join(', ')})`;
  if (def.list && value !== 'none' && !value.split(',').every((v) => def.list!.includes(v)))
    return `${key}에 쓸 수 없는 값: ${value} (가능: ${def.list.join(', ')}, 또는 none)`;
  if (def.pattern && !def.pattern.test(value)) return `${key}에 쓸 수 없는 값: ${value} (${def.desc})`;
  if (def.check && !def.check(value)) return `${key}에 쓸 수 없는 값 (${def.desc})`;
  if (def.range) {
    const n = Number(value);
    const [min, max] = def.range;
    if (!/^\d+$/.test(value) || n < min || n > max) return `${key}는 ${min}~${max} 사이 정수${def.unit ? `(${def.unit})` : ''}여야 합니다: ${value}`;
  }
  return null;
}
