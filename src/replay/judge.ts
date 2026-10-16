// judge(Haiku) 재생 검증. 앱 DB는 읽기 전용으로 열고, Slack은 읽기만 한다 (전송·DB 쓰기 없음)
// 사용:
//   npm run replay:judge -- --arms new@low,new@medium,base@low#1,base@low#2 --gate new@low --out data/replay-A.json  (--my-scope를 빼면 말투 분석의 담당 업무를 쓴다)
//   npm run replay:judge -- --from data/replay-A.json --gate new@medium   (LLM·Slack 호출 없이 다시 판정)
// 종료 코드: 2 재조회 실패가 라벨 true 행의 20% 초과, 1 gate arm이 놓친 행 있음, 0 통과
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebClient } from '@slack/web-api';
import { DB_PATH } from '../paths.js';
import { EFFORTS } from '../llm/claude.js';
import { parseGroups } from '../ctl/settings.js';
import { createConversationReader, trimThread } from '../slack/conversation.js';
import { judgeTurn } from '../responder/judge.js';
import { loadPersona } from '../responder/draft.js';
import { PROMPTS, usesMyScope } from './prompts.js';
import { selectReplaySet, type ReplayRow } from './set.js';
import { agreement, gateExitCode, parseArm, summarizeArm, type ArmOutcome, type ReplayResult, type ResultRow } from './verdict.js';

const EXPECTED_SET_SIZE = 105;
const THREAD_KEEP = 60; // 앱이 판단할 때 읽는 양과 같게 자른다
const CONCURRENCY = 4;

function args(): Map<string, string> {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`인자 형식 오류: ${argv[i]}`);
    out.set(argv[i].slice(2), argv[i + 1]);
  }
  return out;
}

function report(result: ReplayResult, gate: string): number {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  for (const arm of result.arms) {
    const s = summarizeArm(result.rows, arm);
    console.log(
      `${arm.padEnd(12)} missed ${s.missed} · filtered ${s.filtered} · kept ${s.kept} · hit ${s.hit} · unavailable ${s.unavailable} · failed ${s.failed}` +
        ` · 라벨 일치 ${pct(s.labelAgreement)} · thinking 평균 ${s.avgThinking?.toFixed(0) ?? '-'} · output 평균 ${s.avgOutput?.toFixed(0) ?? '-'} · $${s.costUsd.toFixed(4)}`,
    );
  }
  const pairs = [['new@low', 'new@medium'], ['base@low#1', 'base@low#2']].filter(([a, b]) => result.arms.includes(a) && result.arms.includes(b));
  for (const [a, b] of pairs) {
    const ag = agreement(result.rows, a, b);
    console.log(`${a} vs ${b}: 일치 ${pct(ag.rate)}, 뒤집힘 ${ag.differing.length}건${ag.differing.length ? ` (drafts.id ${ag.differing.join(', ')})` : ''}`);
  }
  const code = gateExitCode(result.rows, gate);
  console.log(`gate ${gate} → 종료 코드 ${code}`);
  return code;
}

async function replayRow(
  row: ReplayRow,
  arms: ReturnType<typeof parseArm>[],
  ctx: { read: ReturnType<typeof createConversationReader>['read']; myUserId: string; judgeModel: string; myScope: string; persona: ReturnType<typeof loadPersona> },
): Promise<ResultRow> {
  const base: ResultRow = { id: row.id, key: row.key, label: row.label, unavailable: false, outcomes: {} };
  let thread;
  try {
    const all = await ctx.read(row.channel, row.root_ts, Number.MAX_SAFE_INTEGER);
    thread = trimThread(all.filter((m) => Number(m.ts) <= Number(row.basis_ts)), row.root_ts, THREAD_KEEP);
  } catch (err) {
    console.warn(`[replay] ${row.id} Slack 재조회 실패: ${(err as Error).message}`);
    return { ...base, unavailable: true };
  }
  if (thread.length === 0) return { ...base, unavailable: true };

  for (const arm of arms) {
    let outcome: ArmOutcome = { needs: null, costUsd: 0, usage: null };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await judgeTurn(thread, ctx.persona, ctx.myUserId, { model: ctx.judgeModel, effort: arm.effort }, {
          system: PROMPTS[arm.prompt],
          myScope: usesMyScope(arm.prompt) ? ctx.myScope : undefined,
        });
        outcome = { needs: r.output.needs_my_reply, costUsd: r.costUsd, usage: r.usage };
        break;
      } catch (err) {
        console.warn(`[replay] ${row.id} ${arm.name} 호출 실패 (${attempt + 1}/2): ${(err as Error).message}`);
      }
    }
    base.outcomes[arm.name] = outcome;
  }
  return base;
}

async function main(): Promise<number> {
  const a = args();
  const gate = a.get('gate');
  if (!gate) throw new Error('--gate <arm>이 필요합니다');
  parseArm(gate);

  const from = a.get('from');
  if (from) {
    const result = JSON.parse(fs.readFileSync(from, 'utf8')) as ReplayResult;
    if (!result.arms.includes(gate)) throw new Error(`${from}에 ${gate} 결과가 없습니다 (있음: ${result.arms.join(', ')})`);
    return report(result, gate);
  }

  const arms = (a.get('arms') ?? '').split(',').filter(Boolean).map(parseArm);
  if (!arms.some((x) => x.name === gate)) throw new Error('--gate arm은 --arms에 들어 있어야 합니다');
  for (const arm of arms) if (!(EFFORTS as readonly string[]).includes(arm.effort)) throw new Error(`effort는 ${EFFORTS.join(', ')} 중 하나: ${arm.name}`);
  const out = a.get('out');
  if (!out) throw new Error('--out <json 경로>가 필요합니다');
  const persona = loadPersona();
  const myScope = a.get('my-scope') ?? persona.myScope ?? 'none';

  const db = new DatabaseSync(a.get('db') ?? DB_PATH, { readOnly: true });
  const setting = (key: string, fallback: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? fallback;
  const set = selectReplaySet(db);
  const positives = set.filter((r) => r.label).length;
  console.log(`재생 세트 ${set.length}건 (라벨 true ${positives} · false ${set.length - positives})`);
  if (set.length !== EXPECTED_SET_SIZE) console.warn(`[replay] 경고: 예상 ${EXPECTED_SET_SIZE}건과 다릅니다`);

  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error('.env에 SLACK_USER_TOKEN이 없습니다');
  const client = new WebClient(token);
  const myUserId = (await client.auth.test()).user_id as string;
  const groups = parseGroups(setting('mentionGroups', 'none'));
  const { read } = createConversationReader(client, myUserId, () => groups);
  const ctx = { read, myUserId, judgeModel: setting('judgeModel', 'claude-haiku-5-5'), myScope, persona };
  console.log(`judge 모델 ${ctx.judgeModel} · arms ${arms.map((x) => x.name).join(', ')} · myScope ${myScope}`);

  const rows: ResultRow[] = new Array(set.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < set.length) {
        const i = next++;
        rows[i] = await replayRow(set[i], arms, ctx);
        if (++done % 10 === 0 || done === set.length) console.log(`[replay] ${done}/${set.length}`);
      }
    }),
  );

  const result: ReplayResult = { createdAt: new Date().toISOString(), arms: arms.map((x) => x.name), myScope, rows };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`행별 결과: ${out}`);
  return report(result, gate);
}

main().then(
  (code) => (process.exitCode = code),
  (err) => {
    console.error(err);
    process.exitCode = 3;
  },
);
