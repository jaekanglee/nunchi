// 분류 결과 → 처리 방식 결정. (design.md §4.4)

export const CATEGORIES = [
  '인사/잡담',
  '단순확인·리액션',
  '링크요청',
  '일정조율',
  '정보질문',
  '업무지시·결정',
  '장애·긴급',
  '민감',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Assessment = {
  needs_my_reply: boolean;
  category: Category;
  risk: number; // 0~100
  needs_facts_i_dont_know: boolean;
  confidence: number; // 0~1
};

export type SendMode = 'draft' | 'auto';
export type Decision = 'skip' | 'escalate' | 'approve' | 'auto';

// 위급·민감은 설정과 상관없이 항상 직접 확인
export const ESCALATE: Category[] = ['업무지시·결정', '장애·긴급', '민감'];
// 자동 전송을 허용할 수 있는 카테고리 (설정에서 고른다)
export const AUTO_ELIGIBLE = CATEGORIES.filter((c) => !ESCALATE.includes(c));

// 자동 전송 기준. 설정 화면·ctl에서 바꾼다 (ctl/settings.ts)
export type Thresholds = {
  autoCategories: Category[];
  autoMaxRisk: number; // 위험이 이 값 미만이어야 자동 전송
  autoMinConfidence: number; // 확신(0~1)이 이 값 이상이어야 자동 전송
  escalateRisk: number; // 위험이 이 값 이상이면 직접 확인
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  autoCategories: ['인사/잡담', '단순확인·리액션'],
  autoMaxRisk: 20,
  autoMinConfidence: 0.8,
  escalateRisk: 60,
};

export function decide(a: Assessment, sendMode: SendMode, t: Thresholds = DEFAULT_THRESHOLDS): Decision {
  if (!a.needs_my_reply) return 'skip';
  if (ESCALATE.includes(a.category) || a.needs_facts_i_dont_know || a.risk >= t.escalateRisk) return 'escalate';
  if (sendMode === 'auto' && t.autoCategories.includes(a.category) && a.risk < t.autoMaxRisk && a.confidence >= t.autoMinConfidence) return 'auto';
  return 'approve';
}

// 자동 전송하지 않은 이유. 화면에서 "자동 모드인데 왜 대기 중인지" 보여주는 용도
export function holdReasons(a: Assessment, sendMode: SendMode, t: Thresholds = DEFAULT_THRESHOLDS): string[] {
  const r: string[] = [];
  if (ESCALATE.includes(a.category)) r.push(`'${a.category}'은 항상 직접 확인`);
  else if (!t.autoCategories.includes(a.category))
    r.push(`'${a.category}'은 자동 전송 대상이 아님 (${t.autoCategories.length ? `${t.autoCategories.join(', ')}만` : '허용 카테고리 없음'})`);
  if (a.needs_facts_i_dont_know) r.push('내가 모르는 사실이 필요함');
  if (a.risk >= t.escalateRisk) r.push(`위험 ${a.risk} (${t.escalateRisk} 이상은 직접 확인)`);
  else if (a.risk >= t.autoMaxRisk) r.push(`위험 ${a.risk} (자동 전송은 ${t.autoMaxRisk} 미만)`);
  if (a.confidence < t.autoMinConfidence) r.push(`확신 ${a.confidence} (자동 전송은 ${t.autoMinConfidence} 이상)`);
  if (sendMode === 'draft') r.unshift('전송 설정이 초안 모드');
  return r;
}
