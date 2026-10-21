// 수집한 내 메시지로 말투 가이드와 상대별 관계 정보를 만든다.
// 앱 첫 설정 화면에서 collect 다음에 실행된다. 직접 돌릴 때: npm run persona:analyze
// 결과: PERSONA_DIR/style_guide.md, PERSONA_DIR/relationships.json, PERSONA_DIR/my_scope.txt
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from '../llm/claude.js';
import { PERSONA_DIR as DIR } from '../paths.js';
import type { Pair } from './pairs.js';
import { MY_SCOPE_FILE } from '../responder/draft.js';

const readJsonl = <T>(file: string): T[] =>
  fs.readFileSync(path.join(DIR, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['style_guide', 'relationships', 'my_scope'],
  properties: {
    style_guide: { type: 'string' },
    my_scope: { type: 'string' },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['user_id', 'name', 'register', 'tone', 'notes'],
        properties: {
          user_id: { type: 'string' },
          name: { type: 'string' },
          register: { type: 'string', enum: ['존댓말', '반말', '혼용'] },
          tone: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  },
} as const;

const INSTRUCTIONS = `아래는 한 사람이 회사 Slack 공개 채널에 쓴 메시지들이다. 이 사람 대신 답장을 쓰는 다른 모델이 이 사람처럼 쓸 수 있도록 두 가지를 만들어라.

1. style_guide (마크다운): 이 사람의 글쓰기 습관을 구체적인 규칙과 실제 예시로 정리한다.
   - 문장 길이, 종결어미, 존댓말/반말 쓰는 방식
   - ㅋㅋ/ㅎㅎ/ㅠㅠ, 이모지, 느낌표 같은 표현의 빈도와 쓰는 상황
   - 띄어쓰기·맞춤법·줄임말 습관 (일부러 틀리는 것 포함)
   - 한 번에 몰아 쓰는지, 여러 메시지로 끊어 보내는지
   - 동의·확인·거절·보류할 때 자주 쓰는 표현
   - 이 사람이 하지 않는 것 (예: 장문 설명, 격식체 인사)
   일반론은 쓰지 말고, 데이터에서 관찰된 것만 쓴다. 각 규칙마다 실제 메시지 예시를 1~3개 붙인다.

2. relationships: 대화 쌍에 등장한 상대마다 이 사람이 쓰는 말투(register), 분위기(tone), 참고할 점(notes)을 정리한다. 근거가 2개 미만인 상대는 제외한다.

3. my_scope: 이 사람이 담당하는 업무·제품을 쉼표로 나눈 키워드로 쓴다 (예: "<제품 A> 앱, <서비스 B> 관리자 웹"). 다른 모델이 "이 대화가 이 사람 담당인지" 가를 때 쓴다. 데이터에서 드러난 것만 쓰고, 알 수 없으면 빈 문자열.

공개 채널 데이터라서 DM보다 격식체로 치우쳤을 수 있다. 이 점은 style_guide 끝에 짧게 적어둔다.`;

export async function analyzePersona(log: (line: string) => void = console.log) {
  const pairs = readJsonl<Pair>('pairs.jsonl');
  const mine = readJsonl<{ text: string }>('my_messages.jsonl');

  const body = [
    `## 대화 쌍 (${pairs.length}개)`,
    ...pairs.map((p) => `[${p.partnerName ?? p.partner} (${p.partner})] ${p.context}\n[나] ${p.reply}`),
    `\n## 내 메시지 전체 (${mine.length}개)`,
    ...mine.map((m) => `- ${m.text}`),
  ].join('\n');

  const { output: result, costUsd } = await runClaude<{ style_guide: string; relationships: unknown[]; my_scope: string }>({
    system: INSTRUCTIONS,
    prompt: body,
    schema: SCHEMA,
    llm: { effort: 'high' }, // 한 번 돌려서 계속 쓰는 결과라 깊게
    timeoutMs: 15 * 60_000, // 메시지 1000개를 high로 분석해 기본 제한(5분)보다 오래 걸릴 수 있다
  });

  fs.writeFileSync(path.join(DIR, 'style_guide.md'), result.style_guide);
  fs.writeFileSync(path.join(DIR, 'relationships.json'), JSON.stringify(result.relationships, null, 2));
  fs.writeFileSync(path.join(DIR, MY_SCOPE_FILE), result.my_scope.trim());
  log(`완료: 말투 가이드, 상대 ${result.relationships.length}명 · $${costUsd.toFixed(3)}`);
}

if (require.main === module) {
  analyzePersona().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
