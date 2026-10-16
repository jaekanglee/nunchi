// 재생 세트: 판단 당시 Sonnet까지 간(=Haiku가 통과시킨) 채널 스레드 행. 라벨은 Sonnet의 결정
import type { DatabaseSync } from 'node:sqlite';
import { CATEGORIES } from '../responder/policy.js';

export type ReplayRow = { id: number; key: string; channel: string; root_ts: string; basis_ts: string; label: boolean };

// DM(root_ts NULL), '규칙'·'1차 판단' skip 행(category가 CATEGORIES 밖), 직접 요청한 초안은 뺀다
export function selectReplaySet(db: DatabaseSync): ReplayRow[] {
  const rows = db
    .prepare(
      `SELECT id, key, channel, root_ts, basis_ts, status FROM drafts
       WHERE root_ts IS NOT NULL
         AND category IN (${CATEGORIES.map(() => '?').join(', ')})
         AND (hold_reason IS NULL OR hold_reason NOT LIKE '직접 요청한 초안%')
       ORDER BY id`,
    )
    .all(...CATEGORIES) as { id: number; key: string; channel: string; root_ts: string; basis_ts: string; status: string }[];
  return rows.map(({ status, ...r }) => ({ ...r, label: status !== 'skipped' }));
}
