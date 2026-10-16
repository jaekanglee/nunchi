// 재생 결과 판정 (순수 함수). 재생 CLI와 --from 재판정이 같은 함수를 쓴다
import type { Usage } from '../llm/claude.js';
import { PROMPTS, type PromptName } from './prompts.js';

// needs: 판단 결과. null이면 1회 재시도 후에도 LLM 호출 실패
export type ArmOutcome = { needs: boolean | null; costUsd: number; usage: Usage | null };
export type ResultRow = {
  id: number;
  key: string;
  label: boolean;
  unavailable: boolean; // Slack 재조회 실패. 행 단위로 한 번 정해져 모든 arm에 같다
  outcomes: Record<string, ArmOutcome>;
};
export type ReplayResult = { createdAt: string; arms: string[]; myScope: string; rows: ResultRow[] };

export type Arm = { name: string; prompt: PromptName; effort: string };

// prompt@effort[#n] (#n은 같은 조건 반복 측정 구분)
export function parseArm(name: string): Arm {
  const m = name.match(/^([a-z]+)@([a-z]+)(?:#\d+)?$/);
  if (!m || !(m[1] in PROMPTS)) throw new Error(`arm 형식이 아닙니다: ${name} (예: new@low, base@low#1)`);
  return { name, prompt: m[1] as PromptName, effort: m[2] };
}

export type Verdict = 'hit' | 'missed' | 'filtered' | 'kept' | 'unavailable';

// LLM 실패는 보수적으로 센다: 라벨 true면 놓침(missed), false면 거르지 못함(kept)
export function classifyReplay(label: boolean, unavailable: boolean, outcome: ArmOutcome | undefined): Verdict {
  if (unavailable) return 'unavailable';
  const needs = outcome?.needs ?? null;
  if (label) return needs === true ? 'hit' : 'missed';
  return needs === false ? 'filtered' : 'kept';
}

export type ArmSummary = {
  arm: string;
  hit: number;
  missed: number;
  filtered: number;
  kept: number;
  unavailable: number;
  failed: number;
  labelAgreement: number; // (hit + filtered) / 재조회된 행
  avgThinking: number | null;
  avgOutput: number | null;
  costUsd: number;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarizeArm(rows: ResultRow[], arm: string): ArmSummary {
  const s: ArmSummary = { arm, hit: 0, missed: 0, filtered: 0, kept: 0, unavailable: 0, failed: 0, labelAgreement: 0, avgThinking: null, avgOutput: null, costUsd: 0 };
  const thinking: number[] = [];
  const output: number[] = [];
  for (const r of rows) {
    const o = r.outcomes[arm];
    s[classifyReplay(r.label, r.unavailable, o)]++;
    if (r.unavailable || !o) continue;
    if (o.needs === null) s.failed++;
    s.costUsd += o.costUsd;
    if (o.usage?.thinking != null) thinking.push(o.usage.thinking);
    if (o.usage?.output != null) output.push(o.usage.output);
  }
  const available = rows.length - s.unavailable;
  s.labelAgreement = available ? (s.hit + s.filtered) / available : 0;
  s.avgThinking = avg(thinking);
  s.avgOutput = avg(output);
  return s;
}

// 두 arm이 같은 판단을 낸 비율과 갈린 행. 둘 중 하나라도 실패한 행은 갈린 것으로 본다
export function agreement(rows: ResultRow[], a: string, b: string): { rate: number; differing: number[] } {
  const available = rows.filter((r) => !r.unavailable);
  const differing = available.filter((r) => {
    const x = r.outcomes[a]?.needs ?? null;
    const y = r.outcomes[b]?.needs ?? null;
    return x === null || y === null || x !== y;
  });
  return { rate: available.length ? (available.length - differing.length) / available.length : 0, differing: differing.map((r) => r.id) };
}

// 2(재조회 실패 과다)를 1(놓침)보다 먼저 본다. unavailable은 행 단위라 2 여부는 arm과 무관하다
export function gateExitCode(rows: ResultRow[], arm: string): 0 | 1 | 2 {
  const positives = rows.filter((r) => r.label);
  const unavailablePositives = positives.filter((r) => r.unavailable).length;
  if (unavailablePositives > positives.length * 0.2) return 2;
  return summarizeArm(rows, arm).missed > 0 ? 1 : 0;
}

export type Decision =
  | { action: 'adopt'; prompt: PromptName; effort: string; unstable: boolean }
  | { action: 'revert' }
  | { action: 'needM' }
  | { action: 'needB' };

// 결정표. a0 = 실행 A(--gate new@low), m = --from A --gate new@medium, b = 실행 B(--gate mid@low)
// lowMediumAgreement: new@low와 new@medium의 판단 일치율 (95% 미만이면 불안정 경고)
export function decideJudge(input: { a0: number; m?: number; b?: number; lowMediumAgreement?: number }): Decision {
  const { a0, m, b, lowMediumAgreement } = input;
  if (a0 === 0) return { action: 'adopt', prompt: 'new', effort: 'low', unstable: lowMediumAgreement !== undefined && lowMediumAgreement < 0.95 };
  if (a0 === 2) return { action: 'revert' };
  if (a0 !== 1) throw new Error(`알 수 없는 종료 코드 A0=${a0}`);
  if (m === undefined) return { action: 'needM' };
  if (m === 2) throw new Error('A0=1·M=2는 도달할 수 없다 (unavailable은 arm 공통)');
  if (m === 0) return { action: 'adopt', prompt: 'new', effort: 'medium', unstable: false };
  if (b === undefined) return { action: 'needB' };
  if (b === 0) return { action: 'adopt', prompt: 'mid', effort: 'low', unstable: false };
  return { action: 'revert' };
}
