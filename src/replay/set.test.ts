import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type DraftInput } from '../store/db.js';
import { selectReplaySet } from './set.js';

const row = (over: Partial<DraftInput>): DraftInput => ({
  key: 'C1:1.0', channel: 'C1', root_ts: '1.0', basis_ts: '2.0', category: '정보질문', risk: 10, confidence: 0.9,
  reason: 'r', draft_text: '', status: 'pending', hold_reason: null, ...over,
});

test('재생 세트: DM·규칙·1차 판단·직접 요청 행을 빼고, skipped면 라벨 false', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-replay-')), 'db.sqlite');
  const s = openStore(file);
  s.insertDraft(row({ status: 'pending' })); // 1 포함, true
  s.insertDraft(row({ status: 'skipped' })); // 2 포함, false
  s.insertDraft(row({ status: 'sent', hold_reason: '위험 높음' })); // 3 포함, true
  s.insertDraft(row({ root_ts: null, key: 'D1:dm', channel: 'D1' })); // DM 제외
  s.insertDraft(row({ category: '규칙', status: 'skipped' })); // 제외
  s.insertDraft(row({ category: '1차 판단', status: 'skipped' })); // 제외
  s.insertDraft(row({ hold_reason: '직접 요청한 초안 · 위험 높음' })); // 제외
  const db = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(selectReplaySet(db).map((r) => [r.id, r.label]), [[1, true], [2, false], [3, true]]);
});
