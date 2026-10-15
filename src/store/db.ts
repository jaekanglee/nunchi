// 로컬 SQLite 저장소 (Electron 내장 node:sqlite). (design.md §5)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type WatchMode = 'on' | 'off' | 'draft';
export type Watch = {
  key: string;
  channel: string;
  root_ts: string | null;
  source: string;
  mode: WatchMode;
  title: string | null;
  last_activity_at: number;
  last_ts: string | null;
  last_name: string | null;
  last_text: string | null;
  model: string | null; // null이면 전역 기본값
  effort: string | null;
  topic: string | null; // LLM이 붙인 짧은 주제 (목록 제목)
  channel_name: string | null; // #채널 이름, DM, 그룹 DM
  first_ts: string | null; // 대화 시작 시각 (스레드는 본문, DM은 읽은 것 중 가장 오래된 메시지)
  participants: string | null; // 참여자 이름 JSON 배열
};
export type Summary = { id: number; key: string; basis_ts: string; body: string; created_at: number };
export type SummaryState = 'none' | 'fresh' | 'outdated';

// 요약 시점 이후 새 메시지가 있으면 outdated
export function summaryState(lastTs: string | null, summaryTs: string | null): SummaryState {
  if (!summaryTs) return 'none';
  if (lastTs && Number(lastTs) > Number(summaryTs)) return 'outdated';
  return 'fresh';
}
// 목록 뱃지: 이 대화에 내 답이 필요한지
export type ReplyState = 'urgent' | 'need' | 'auto' | 'replied' | 'none' | 'unknown' | 'off';
export function replyState(w: Pick<Watch, 'mode' | 'last_ts' | 'last_name'>, draft: { status: string; basis_ts: string } | null): ReplyState {
  if (draft?.status === 'escalated') return 'urgent';
  if (draft?.status === 'pending') return 'need';
  if (draft?.status === 'scheduled') return 'auto';
  if (w.last_name === '나' || draft?.status === 'sent') return 'replied';
  // 마지막 메시지까지 보고 "내 차례 아님"이라 했거나 내가 무시했으면 답 불필요
  const judgedLatest = draft && (!w.last_ts || Number(draft.basis_ts) >= Number(w.last_ts));
  if (judgedLatest && (draft.status === 'skipped' || draft.status === 'ignored')) return 'none';
  return w.mode === 'off' ? 'off' : 'unknown';
}

// 앱 아이콘 뱃지 숫자: 내가 직접 봐야 하는 대화 수 (직접 확인 + 승인 대기)
export function badgeCount(watches: { reply_state: ReplyState }[]): number {
  return watches.filter((w) => w.reply_state === 'urgent' || w.reply_state === 'need').length;
}

export type DraftStatus = 'pending' | 'escalated' | 'scheduled' | 'sent' | 'ignored' | 'skipped' | 'superseded' | 'stale';
export type Draft = {
  id: number;
  key: string;
  channel: string;
  root_ts: string | null;
  basis_ts: string;
  category: string;
  risk: number;
  confidence: number;
  reason: string;
  draft_text: string;
  final_text: string | null;
  status: DraftStatus;
  created_at: number;
  sent_ts: string | null;
  hold_reason: string | null; // 자동 전송하지 않은 이유 (' · '로 연결)
};

const WATCH_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function openStore(file: string) {
  // 처음 설치한 맥에는 데이터 폴더가 아직 없다
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // 앱과 ctl(원격 제어 CLI)이 같은 DB를 동시에 쓴다
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS watches (
      key TEXT PRIMARY KEY, channel TEXT NOT NULL, root_ts TEXT, source TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'on', last_activity_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, channel TEXT NOT NULL, root_ts TEXT,
      basis_ts TEXT NOT NULL, category TEXT NOT NULL, risk INTEGER NOT NULL, confidence REAL NOT NULL,
      reason TEXT NOT NULL, draft_text TEXT NOT NULL, final_text TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, sent_ts TEXT
    );
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, basis_ts TEXT NOT NULL,
      body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  // 이전 버전 DB에 없는 컬럼 추가
  const cols = (db.prepare('PRAGMA table_info(watches)').all() as { name: string }[]).map((c) => c.name);
  for (const col of ['title', 'last_ts', 'last_name', 'last_text', 'model', 'effort', 'topic', 'channel_name', 'first_ts', 'participants']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE watches ADD COLUMN ${col} TEXT`);
  }
  const draftCols = (db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map((c) => c.name);
  if (!draftCols.includes('hold_reason')) db.exec('ALTER TABLE drafts ADD COLUMN hold_reason TEXT');

  return {
    getSetting(key: string, fallback: string): string {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? fallback;
    },
    setSetting(key: string, value: string) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },

    // 이미 있으면 모드는 유지하고 활동 시각만 갱신
    addWatch(key: string, channel: string, rootTs: string | null, source: string) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO watches (key, channel, root_ts, source, last_activity_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET last_activity_at = excluded.last_activity_at,
           source = CASE WHEN excluded.source = 'link' THEN 'link' ELSE watches.source END`,
      ).run(key, channel, rootTs, source, now, now);
    },
    getWatch(key: string): Watch | undefined {
      return db.prepare('SELECT * FROM watches WHERE key = ?').get(key) as Watch | undefined;
    },
    isWatched(key: string): boolean {
      const w = this.getWatch(key);
      return w !== undefined && w.mode !== 'off' && Date.now() - w.last_activity_at < WATCH_TTL_MS;
    },
    touchWatch(key: string) {
      db.prepare('UPDATE watches SET last_activity_at = ? WHERE key = ?').run(Date.now(), key);
    },
    setWatchTitle(key: string, title: string) {
      db.prepare('UPDATE watches SET title = ? WHERE key = ?').run(title, key);
    },
    // onlyIfEmpty: 판단·초안에서 나온 주제는 처음 한 번만, 요약에서 나온 주제는 항상 덮어쓴다
    setWatchTopic(key: string, topic: string, onlyIfEmpty = false) {
      if (!topic.trim()) return;
      db.prepare(`UPDATE watches SET topic = ? WHERE key = ?${onlyIfEmpty ? ' AND topic IS NULL' : ''}`).run(topic.trim(), key);
    },
    setChannelName(key: string, name: string) {
      db.prepare('UPDATE watches SET channel_name = ? WHERE key = ?').run(name, key);
    },
    // 참여자는 새로 읽은 것으로 바꾸고, 시작 시각은 더 이른 것만 남긴다
    setParticipants(key: string, firstTs: string, names: string[]) {
      db.prepare(
        'UPDATE watches SET participants = ?, first_ts = CASE WHEN first_ts IS NULL OR CAST(? AS REAL) < CAST(first_ts AS REAL) THEN ? ELSE first_ts END WHERE key = ?',
      ).run(JSON.stringify(names), firstTs, firstTs, key);
    },
    // 더 최신 메시지일 때만 갱신
    setLastMessage(key: string, ts: string, name: string, text: string) {
      db.prepare(
        'UPDATE watches SET last_ts = ?, last_name = ?, last_text = ? WHERE key = ? AND (last_ts IS NULL OR CAST(last_ts AS REAL) <= CAST(? AS REAL))',
      ).run(ts, name, text, key, ts);
    },
    setWatchLlm(key: string, model: string | null, effort: string | null) {
      db.prepare('UPDATE watches SET model = ?, effort = ? WHERE key = ?').run(model, effort, key);
    },
    setWatchMode(key: string, mode: WatchMode) {
      db.prepare('UPDATE watches SET mode = ? WHERE key = ?').run(mode, key);
    },
    listWatches(): (Watch & { summary_state: SummaryState; reply_state: ReplyState })[] {
      const rows = db
        .prepare(
          `SELECT w.*, (SELECT basis_ts FROM summaries s WHERE s.key = w.key ORDER BY id DESC LIMIT 1) AS summary_ts,
             (SELECT status FROM drafts d WHERE d.key = w.key ORDER BY id DESC LIMIT 1) AS draft_status,
             (SELECT basis_ts FROM drafts d WHERE d.key = w.key ORDER BY id DESC LIMIT 1) AS draft_basis_ts
           FROM watches w WHERE last_activity_at > ? ORDER BY last_activity_at DESC`,
        )
        .all(Date.now() - WATCH_TTL_MS) as (Watch & { summary_ts: string | null; draft_status: string | null; draft_basis_ts: string | null })[];
      return rows.map(({ draft_status, draft_basis_ts, ...w }) => ({
        ...w,
        summary_state: summaryState(w.last_ts, w.summary_ts),
        reply_state: replyState(w, draft_status ? { status: draft_status, basis_ts: draft_basis_ts! } : null),
      }));
    },

    insertSummary(key: string, basisTs: string, body: object) {
      db.prepare('INSERT INTO summaries (key, basis_ts, body, created_at) VALUES (?, ?, ?, ?)').run(key, basisTs, JSON.stringify(body), Date.now());
    },
    latestSummary(key: string): Summary | undefined {
      return db.prepare('SELECT * FROM summaries WHERE key = ? ORDER BY id DESC LIMIT 1').get(key) as Summary | undefined;
    },

    insertDraft(d: Omit<Draft, 'id' | 'created_at' | 'final_text' | 'sent_ts'>): number {
      const r = db
        .prepare(
          `INSERT INTO drafts (key, channel, root_ts, basis_ts, category, risk, confidence, reason, draft_text, status, hold_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(d.key, d.channel, d.root_ts, d.basis_ts, d.category, d.risk, d.confidence, d.reason, d.draft_text, d.status, d.hold_reason, Date.now());
      return Number(r.lastInsertRowid);
    },
    getDraft(id: number): Draft | undefined {
      return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined;
    },
    setDraftStatus(id: number, status: DraftStatus, extra: { final_text?: string; sent_ts?: string } = {}) {
      db.prepare('UPDATE drafts SET status = ?, final_text = COALESCE(?, final_text), sent_ts = COALESCE(?, sent_ts) WHERE id = ?').run(
        status,
        extra.final_text ?? null,
        extra.sent_ts ?? null,
        id,
      );
    },
    // 같은 대화의 아직 처리 안 된 초안을 무효화 (새 메시지가 왔거나 내가 직접 답한 경우)
    supersedeOpen(key: string) {
      db.prepare(`UPDATE drafts SET status = 'superseded' WHERE key = ? AND status IN ('pending', 'escalated', 'scheduled')`).run(key);
    },
    listDraftsByKey(key: string): Draft[] {
      return db.prepare('SELECT * FROM drafts WHERE key = ? ORDER BY id').all(key) as Draft[];
    },
    // 지금 내가 처리해야 하는 초안 (모든 대화)
    listOpenDrafts(): Draft[] {
      return db.prepare(`SELECT * FROM drafts WHERE status IN ('pending', 'escalated', 'scheduled') ORDER BY id DESC`).all() as Draft[];
    },
  };
}

export type Store = ReturnType<typeof openStore>;
