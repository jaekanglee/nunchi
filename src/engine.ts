// 이벤트 → 감시 등록 → (디바운스) → 초안 생성 → 정책 결정 → 승인 큐 / 알림 / 자동 전송
import type { WebClient } from '@slack/web-api';
import { addressedToOthersOnly, isUrgent, route, threadKey, type MessageEvent } from './slack/router.js';
import { parsePermalink } from './slack/permalink.js';
import { conversationTitle, type ConversationReader } from './slack/conversation.js';
import { generateDraft } from './responder/draft.js';
import { judgeTurn } from './responder/judge.js';
import { decide, holdReasons, type SendMode } from './responder/policy.js';
import type { Persona } from './responder/prompt.js';
import { summarizeConversation } from './summary/summarize.js';
import type { ThreadMessage } from './responder/prompt.js';
import type { Store } from './store/db.js';
import { resolveLlm, type Llm } from './llm/claude.js';
import { parseGroups } from './ctl/settings.js';

const DEBOUNCE_MS = 10_000; // 연달아 오는 메시지는 모아서 한 번만 처리
const BATCH_MS = 120_000; // 감시 스레드에서 나를 부르지 않은 댓글은 2분 동안 모아서 처리
const AUTO_DELAY_MS = [60_000, 300_000]; // 자동 전송 지연 1~5분
const SUMMARY_KEEP = 300; // 요약은 긴 스레드도 최근 300개까지 읽는다

export type EngineDeps = {
  client: WebClient;
  myUserId: string;
  store: Store;
  readConversation: ConversationReader;
  persona: Persona;
  notify: (title: string, body: string) => void;
  onChange: () => void;
};

const splitKey = (key: string) => {
  const [channel, rest] = key.split(':');
  return { channel, rootTs: rest === 'dm' ? null : rest };
};

export function createEngine(deps: EngineDeps) {
  const { client, myUserId, store } = deps;
  const read = deps.readConversation.read;

  // 전역 기본값(초안·요약별 effort) 위에 대화별 설정을 얹는다
  function llmFor(key: string, kind: 'draft' | 'summary'): Llm {
    const global = {
      model: store.getSetting('model', 'claude-sonnet-5-5'),
      effort: kind === 'draft' ? store.getSetting('draftEffort', 'medium') : store.getSetting('summaryEffort', 'low'),
    };
    return resolveLlm(store.getWatch(key), global);
  }

  // 대화를 읽을 때마다 목록용 제목과 마지막 메시지를 갱신
  function remember(key: string, thread: ThreadMessage[], isDm: boolean) {
    store.setWatchTitle(key, conversationTitle(thread, isDm, myUserId));
    const last = thread.at(-1);
    if (last) store.setLastMessage(key, last.ts, last.user === myUserId ? '나' : last.name, last.text);
  }
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Set<string>();
  const rerun = new Set<string>();

  const due = new Map<string, number>();

  // 급한 메시지는 10초 디바운스, 나머지는 첫 댓글부터 2분 창을 유지한다 (댓글이 계속 와도 무한히 밀리지 않게)
  function schedule(key: string, delay = DEBOUNCE_MS) {
    const at = Date.now() + delay;
    if (delay > DEBOUNCE_MS && timers.has(key) && due.get(key)! <= at) return;
    clearTimeout(timers.get(key));
    due.set(key, at);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      due.delete(key);
      void process(key);
    }, delay));
  }

  // LLM 없이 "내 차례 아님"을 기록한다
  function skipWithoutDraft(key: string, channel: string, rootTs: string | null, basisTs: string, category: string, reason: string) {
    store.supersedeOpen(key);
    store.insertDraft({ key, channel, root_ts: rootTs, basis_ts: basisTs, category, risk: 0, confidence: 1, reason, draft_text: '', status: 'skipped', hold_reason: null });
    deps.onChange();
  }

  async function process(key: string) {
    if (running.has(key)) {
      rerun.add(key);
      return;
    }
    running.add(key);
    try {
      if (store.getSetting('paused', 'off') === 'on') return; // 전체 일시정지
      const watch = store.getWatch(key);
      if (!watch || watch.mode === 'off') return;
      const { channel, rootTs } = splitKey(key);
      const thread = await read(channel, rootTs);
      remember(key, thread, rootTs === null);
      const last = thread.at(-1);
      if (!last || last.user === myUserId) return; // 마지막이 내 말이면 내 차례 아님

      // 다른 사람만 콕 집어 부른 메시지는 LLM 없이 건너뛴다. 링크로 직접 등록한 대화는 예외 (LLM이 판단)
      const groups = parseGroups(store.getSetting('mentionGroups', 'none'));
      if (watch.source !== 'link' && addressedToOthersOnly(last.mentions ?? [], myUserId, groups)) {
        return skipWithoutDraft(key, channel, rootTs, last.ts, '규칙', '다른 사람만 멘션한 메시지라 판단 생략');
      }
      // 채널 스레드의 1차 판단은 싼 모델로. 내 차례일 때만 기본 모델이 다시 판단하고 초안을 쓴다.
      // DM은 제외: 잡담 맞장구도 답할 차례인데 Haiku는 "대화가 끝났다"로 보고 놓쳤다 (재생 검증 DM 9건 누락, 채널 0건)
      const judgeModel = store.getSetting('judgeModel', 'claude-haiku-5-5');
      const main = llmFor(key, 'draft');
      if (rootTs !== null && judgeModel !== 'off' && judgeModel !== main.model) {
        const j = await judgeTurn(thread, deps.persona, myUserId, { model: judgeModel, effort: 'low' });
        if (!j.needs_my_reply) return skipWithoutDraft(key, channel, rootTs, last.ts, '1차 판단', j.reason);
      }

      const result = await generateDraft(thread, deps.persona, myUserId, main);
      const sendMode: SendMode = watch.mode === 'draft' ? 'draft' : (store.getSetting('sendMode', 'draft') as SendMode);
      const decision = decide(result, sendMode);
      // 대화별 '초안만'과 전역 초안 모드를 구분해서 보여준다
      const hold = holdReasons(result, sendMode).map((r) => (r === '전송 설정이 초안 모드' && watch.mode === 'draft' ? "이 대화가 '초안만'" : r));

      store.supersedeOpen(key);
      const status = { skip: 'skipped', escalate: 'escalated', approve: 'pending', auto: 'scheduled' } as const;
      const id = store.insertDraft({
        key,
        channel,
        root_ts: rootTs,
        basis_ts: last.ts,
        category: result.category,
        risk: result.risk,
        confidence: result.confidence,
        reason: result.reason,
        draft_text: result.reply,
        status: status[decision],
        hold_reason: decision === 'approve' || decision === 'escalate' ? hold.join(' · ') : null,
      });

      if (decision === 'escalate') deps.notify(`⚠️ 직접 확인 필요 · ${last.name}`, `${last.text}\n— ${result.reason}`);
      if (decision === 'approve') deps.notify(`초안 승인 대기 · ${last.name}`, `${result.reply}\n— 자동 전송 안 함: ${hold.join(' · ')}`);
      if (decision === 'auto') {
        const [min, max] = AUTO_DELAY_MS;
        setTimeout(() => void sendIfFresh(id), min + Math.random() * (max - min));
      }
      deps.onChange();
    } catch (err) {
      console.error(`[engine] ${key} 처리 실패`, err);
    } finally {
      running.delete(key);
      if (rerun.delete(key)) schedule(key);
    }
  }

  async function post(id: number, text: string) {
    const d = store.getDraft(id);
    if (!d) throw new Error(`초안 ${id} 없음`);
    const res = await client.chat.postMessage({ channel: d.channel, text, thread_ts: d.root_ts ?? undefined });
    store.setDraftStatus(id, 'sent', { final_text: text, sent_ts: res.ts });
    store.touchWatch(d.key);
    if (res.ts) store.setLastMessage(d.key, res.ts, '나', text);
    deps.onChange();
  }

  // 자동 전송 직전: 그 사이 새 메시지가 왔으면 버린다 (design.md §6)
  async function sendIfFresh(id: number) {
    const d = store.getDraft(id);
    if (!d || d.status !== 'scheduled') return;
    // 예약 뒤에 일시정지했거나 초안 모드로 바꿨으면 보내지 않고 승인 대기로 돌린다
    if (store.getSetting('paused', 'off') === 'on' || store.getSetting('sendMode', 'draft') !== 'auto') {
      store.setDraftStatus(id, 'pending');
      deps.onChange();
      return;
    }
    const thread = await read(d.channel, d.root_ts);
    if (thread.at(-1)?.ts !== d.basis_ts) {
      store.setDraftStatus(id, 'stale');
      deps.onChange();
      return;
    }
    await post(id, d.draft_text);
  }

  async function summarize(key: string) {
    const w = store.getWatch(key);
    if (!w) throw new Error('감시 중인 대화가 아닙니다');
    const thread = await read(w.channel, w.root_ts, SUMMARY_KEEP);
    const last = thread.at(-1);
    if (!last) throw new Error('대화에 메시지가 없습니다');
    remember(key, thread, w.root_ts === null);
    const summary = await summarizeConversation(thread, myUserId, llmFor(key, 'summary'));
    store.insertSummary(key, last.ts, summary);
    deps.onChange();
  }

  // 요약이 없거나 요약 뒤 새 메시지가 생긴 대화만 차례로 요약
  async function summarizeStale(): Promise<number> {
    const targets = store.listWatches().filter((w) => w.summary_state !== 'fresh');
    for (const w of targets) {
      await summarize(w.key).catch((err) => console.error(`[summary] ${w.key} 실패`, err));
    }
    return targets.length;
  }

  return {
    async handleEvent(e: MessageEvent) {
      const key = threadKey(e);
      // 감시 중인 대화면 마지막 메시지를 목록에 반영
      if (e.subtype === undefined && e.user && store.getWatch(key)) {
        const name = e.user === myUserId ? '나' : await deps.readConversation.nameOf(e.user);
        store.setLastMessage(key, e.ts, name, e.text ?? '');
      }
      // 감시 중인 대화에 내가 직접 답했으면 열린 초안은 무효
      if (e.user === myUserId && e.subtype === undefined && store.getWatch(key)) {
        store.supersedeOpen(key);
        store.touchWatch(key);
        deps.onChange();
        return;
      }
      const reason = route(e, myUserId, {
        autoDetect: store.getSetting('autoDetect', 'on') === 'on',
        isWatched: (k) => store.isWatched(k),
        mentionGroups: parseGroups(store.getSetting('mentionGroups', 'none')),
      });
      if (!reason) return;
      const { channel, rootTs } = splitKey(key);
      if (reason === 'watched') store.touchWatch(key);
      else store.addWatch(key, channel, rootTs, reason);
      schedule(key, isUrgent(e, myUserId, parseGroups(store.getSetting('mentionGroups', 'none'))) ? DEBOUNCE_MS : BATCH_MS);
      deps.onChange();
    },

    async addLink(url: string): Promise<void> {
      const target = parsePermalink(url);
      if (!target) throw new Error('Slack 메시지 링크가 아닙니다');
      // DM 본문 링크는 DM 전체를 대화로 본다
      const isDm = target.channel.startsWith('D') && target.rootTs === target.ts;
      const rootTs = isDm ? null : target.rootTs;
      const key = `${target.channel}:${rootTs ?? 'dm'}`;
      store.addWatch(key, target.channel, rootTs, 'link');
      deps.onChange();
      await process(key);
    },

    summarize,
    summarizeStale,
    read,
    remember,
    send: post,
    ignore(id: number) {
      store.setDraftStatus(id, 'ignored');
      deps.onChange();
    },
  };
}
