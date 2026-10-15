// 원격 제어(ctl)와 앱이 함께 쓰는 설정 키와 허용 값
import { EFFORTS, MODELS } from '../llm/claude.js';

// range: 정수 [최소, 최대] (초 단위 타이밍 설정)
type SettingDef = { values?: readonly string[]; pattern?: RegExp; range?: [number, number]; fallback: string; desc: string };

export const SETTINGS: Record<string, SettingDef> = {
  paused: { values: ['on', 'off'], fallback: 'off', desc: '전체 일시정지 (on이면 판단·초안·자동 전송 모두 멈춤)' },
  autoDetect: { values: ['on', 'off'], fallback: 'on', desc: '자동 감지 (off면 링크로 등록한 대화만)' },
  sendMode: { values: ['draft', 'auto'], fallback: 'draft', desc: '전송 방식' },
  model: { values: MODELS, fallback: 'claude-sonnet-5-5', desc: '기본 모델' },
  draftEffort: { values: EFFORTS, fallback: 'medium', desc: '초안 effort' },
  summaryEffort: { values: EFFORTS, fallback: 'low', desc: '요약 effort' },
  judgeModel: { values: [...MODELS, 'off'], fallback: 'claude-haiku-5-5', desc: '채널 스레드 1차 판단 모델 (내 차례일 때만 기본 모델로 초안, DM은 항상 기본 모델, off면 끔)' },
  // 내가 속한 사용자 그룹 ID (쉼표로 여러 개, 비우려면 none)
  urgentDelaySec: { range: [3, 600], fallback: '10', desc: '나를 부른 메시지·DM이 오면 몇 초 모았다가 판단할지' },
  batchDelaySec: { range: [10, 3600], fallback: '120', desc: '감시 스레드의 나머지 댓글을 몇 초 모았다가 판단할지' },
  autoSendMinSec: { range: [0, 3600], fallback: '60', desc: '자동 전송 지연 최소(초). 최소~최대 사이에서 무작위' },
  autoSendMaxSec: { range: [0, 3600], fallback: '300', desc: '자동 전송 지연 최대(초)' },
  mentionGroups: { pattern: /^(none|S[A-Z0-9]+(,S[A-Z0-9]+)*)$/, fallback: 'none', desc: '반응할 그룹 멘션 (S로 시작하는 ID, 쉼표 구분, 없으면 none)' },
};

export function parseGroups(value: string): string[] {
  return value === 'none' ? [] : value.split(',').filter(Boolean);
}

export function validateSetting(key: string, value: string): string | null {
  const def = SETTINGS[key];
  if (!def) return `알 수 없는 설정: ${key} (가능: ${Object.keys(SETTINGS).join(', ')})`;
  if (def.values && !def.values.includes(value)) return `${key}에 쓸 수 없는 값: ${value} (가능: ${def.values.join(', ')})`;
  if (def.pattern && !def.pattern.test(value)) return `${key}에 쓸 수 없는 값: ${value} (${def.desc})`;
  if (def.range) {
    const n = Number(value);
    const [min, max] = def.range;
    if (!/^\d+$/.test(value) || n < min || n > max) return `${key}는 ${min}~${max} 사이 정수(초)여야 합니다: ${value}`;
  }
  return null;
}
