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

const ESCALATE: Category[] = ['업무지시·결정', '장애·긴급', '민감'];
const AUTO_OK: Category[] = ['인사/잡담', '단순확인·리액션'];
const ESCALATE_RISK = 60;
const AUTO_MAX_RISK = 20; // 미만
const AUTO_MIN_CONFIDENCE = 0.8;

export function decide(a: Assessment, sendMode: SendMode): Decision {
  if (!a.needs_my_reply) return 'skip';
  // 위급·민감은 모드와 상관없이 항상 나에게 알림
  if (ESCALATE.includes(a.category) || a.needs_facts_i_dont_know || a.risk >= ESCALATE_RISK) return 'escalate';
  if (sendMode === 'auto' && AUTO_OK.includes(a.category) && a.risk < AUTO_MAX_RISK && a.confidence >= AUTO_MIN_CONFIDENCE) return 'auto';
  return 'approve';
}

// 자동 전송하지 않은 이유. 화면에서 "자동 모드인데 왜 대기 중인지" 보여주는 용도
export function holdReasons(a: Assessment, sendMode: SendMode): string[] {
  const r: string[] = [];
  if (ESCALATE.includes(a.category)) r.push(`'${a.category}'은 항상 직접 확인`);
  else if (!AUTO_OK.includes(a.category)) r.push(`'${a.category}'은 자동 전송 대상이 아님 (${AUTO_OK.join(', ')}만)`);
  if (a.needs_facts_i_dont_know) r.push('내가 모르는 사실이 필요함');
  if (a.risk >= AUTO_MAX_RISK) r.push(`위험 ${a.risk} (자동 전송은 ${AUTO_MAX_RISK} 미만)`);
  if (a.confidence < AUTO_MIN_CONFIDENCE) r.push(`확신 ${a.confidence} (자동 전송은 ${AUTO_MIN_CONFIDENCE} 이상)`);
  if (sendMode === 'draft') r.unshift('전송 설정이 초안 모드');
  return r;
}
