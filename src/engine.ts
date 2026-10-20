// 이벤트 → 감시 등록 → (디바운스) → 초안 생성 → 정책 결정 → 승인 큐 / 알림 / 자동 전송
import type { WebClient } from '@slack/web-api';
import { addressedToOthersOnly, isUrgent, route, threadKey, type MessageEvent } from './slack/router.js';
import { parsePermalink } from './slack/permalink.js';
import { conversationTitle, participantNames, type ConversationReader } from './slack/conversation.js';
import { generateDraft } from './responder/draft.js';
import { JUDGE_EFFORT, judgeTurn } from './responder/judge.js';
import { decide, holdReasons, type SendMode } from './responder/policy.js';
import type { Persona } from './responder/prompt.js';
import { editMark, planSummary, summarizeConversation } from './summary/summarize.js';
import type { ThreadMessage } from './responder/prompt.js';
import type { CostFields, Store } from './store/db.js';
import { resolveLlm, type Llm, type Usage } from './llm/claude.js';
import { SETTINGS, parseDirs, parseGroups, thresholdsFrom } from './ctl/settings.js';

const SUMMARY_KEEP = 300; // 요약은 긴 스레드도 최근 300개까지 읽는다
const LLM_CONCURRENCY = 2; // claude -p 하나가 수백 MB를 쓴다 (실측 약 260MB). 여러 대화가 한꺼번에 와도 이만큼만 띄운다

// 동시에 max개까지만 실행하고 나머지는 온 순서대로 기다린다. 끝난 자리는 기다리던 다음 호출에 바로 넘긴다
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (active < max) active++;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await fn(...args);
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    };
}

// runClaude 비용·토큰을 drafts·summaries 비용 컬럼 형태로 바꾼다
function costFields(r: { costUsd: number; usage: Usage }): CostFields {
  return {
    cost_usd: r.costUsd,
    input_tokens: r.usage.input,
    output_tokens: r.usage.output,
    cache_read_tokens: r.usage.cacheRead,
    cache_creation_tokens: r.usage.cacheCreation,
    thinking_tokens: r.usage.thinking,
  };
}

export type EngineDeps = {
  client: WebClient;
  myUserId: string;
  store: Store;
  readConversation: ConversationReader;
  persona: Persona;
  notify: (title: string, body: string) => void;
  onChange: () => void;
  // 테스트에서 LLM 대신 넣는 대역
  judge?: typeof judgeTurn;
  draft?: typeof generateDraft;
  summarize?: typeof summarizeConversation;
};

const splitKey = (key: string) => {
  const [channel, rest] = key.split(':');
  return { channel, rootTs: rest === 'dm' ? null : rest };
};

export function createEngine(deps: EngineDeps) {
  const { client, myUserId, store } = deps;
  const read = deps.readConversation.read;
  // 판단·초안·요약이 claude 실행 자리를 함께 나눠 쓴다
  const limit = limiter(LLM_CONCURRENCY);
  const judge = limit(deps.judge ?? judgeTurn);
  const draft = limit(deps.draft ?? generateDraft);
  const summarizeLlm = limit(deps.summarize ?? summarizeConversation);
  // 판단·초안을 기다리는 동안 삭제·보관됐으면 결과를 버린다
  const gone = (key: string) => store.isBlocked(key) || !store.getWatch(key);

  // 전역 기본값(초안·요약별 effort) 위에 대화별 설정을 얹는다
  function llmFor(key: string, kind: 'draft' | 'summary'): Llm {
    const global = {
      model: store.getSetting('model', 'claude-sonnet-5-5'),
      effort: kind === 'draft' ? store.getSetting('draftEffort', 'medium') : store.getSetting('summaryEffort', 'low'),
    };
    return resolveLlm(store.getWatch(key), global);
  }

  // 대화를 읽을 때마다 목록용 제목·참여자·시작 시각·마지막 메시지를 갱신
  function remember(key: string, thread: ThreadMessage[], isDm: boolean) {
    store.setWatchTitle(key, conversationTitle(thread, isDm, myUserId));
    const last = thread.at(-1);
    if (last) store.setLastMessage(key, last.ts, last.user === myUserId ? '나' : last.name, last.text);
    if (thread[0]) store.setParticipants(key, thread[0].ts, participantNames(thread, myUserId));
    void ensureChannelName(key);
  }

  // 채널 이름은 한 번만 찾는다. conversations.info는 channels:read 권한이 필요해서, 이미 있는 search 권한으로 찾는다
  async function ensureChannelName(key: string) {
    const w = store.getWatch(key);
    if (!w || w.channel_name) return;
    if (w.channel.startsWith('D')) return store.setChannelName(key, 'DM');
    try {
      const r = await client.search.messages({ query: `in:<#${w.channel}>`, count: 1 });
      const ch = r.messages?.matches?.[0]?.channel as { name?: string; is_mpim?: boolean } | undefined;
      if (ch?.name) store.setChannelName(key, ch.is_mpim ? '그룹 DM' : `#${ch.name}`);
    } catch (err) {
      console.warn(`[engine] ${key} 채널 이름 조회 실패`, (err as Error).message);
    }
  }
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Set<string>();
  const sendDue = new Map<number, number>(); // 자동 전송 예약 시각 (draft id → ms)
  const summarizing = new Set<string>(); // 화면 로딩 표시용
  const drafting = new Set<string>();

  // 오래 걸리는 작업을 하는 동안 화면에 "…중"을 보이게 한다
  async function track<T>(set: Set<string>, key: string, fn: () => Promise<T>): Promise<T> {
    set.add(key);
    deps.onChange();
    try {
      return await fn();
    } finally {
      set.delete(key);
      deps.onChange();
    }
  }

  // 앱이 꺼지면 예약 타이머도 사라지므로, 남아 있던 예약은 승인 대기로 돌린다
  for (const d of store.listOpenDrafts()) if (d.status === 'scheduled') store.setDraftStatus(d.id, 'pending');

  // 목록 정보(채널·참여자·시작 시각)가 없는 예전 대화는 시작할 때 한 번 채운다
  void (async () => {
    for (const w of store.listWatches().filter((x) => !x.participants || !x.channel_name)) {
      try {
        remember(w.key, await read(w.channel, w.root_ts), w.root_ts === null);
      } catch (err) {
        console.warn(`[engine] ${w.key} 목록 정보 채우기 실패`, (err as Error).message);
      }
    }
    deps.onChange();
  })();
  const rerun = new Set<string>();

  const due = new Map<string, number>();

  // 타이밍 설정(초)을 ms로. 설정 화면·ctl에서 바꾸면 다음 메시지부터 바로 반영된다
  const setting = (key: string) => store.getSetting(key, SETTINGS[key].fallback);
  const ms = (key: string) => Number(setting(key)) * 1000;
  // 설정으로 덮어쓰지 않았으면 말투 분석이 뽑은 담당 업무를 쓴다
  const myScope = () => (setting('myScope') !== 'none' ? setting('myScope') : (deps.persona.myScope ?? 'none'));
  // 자동 전송 기준도 판단할 때마다 읽어서 바로 반영
  const thresholds = () => thresholdsFrom(setting);

  // urgent(나를 부름·DM)는 디바운스: 새 메시지가 오면 다시 잰다.
  // batch(나머지 댓글)는 첫 댓글부터 창을 유지한다 (댓글이 계속 와도 무한히 밀리지 않게)
  function schedule(key: string, kind: 'urgent' | 'batch' = 'urgent') {
    const delay = ms(kind === 'urgent' ? 'urgentDelaySec' : 'batchDelaySec');
    const at = Date.now() + delay;
    if (kind === 'batch' && timers.has(key) && due.get(key)! <= at) return;
    clearTimeout(timers.get(key));
    due.set(key, at);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      due.delete(key);
      void process(key);
    }, delay));
  }

  // 대화의 대기 중인 판단 예약을 취소한다
  function cancel(key: string) {
    clearTimeout(timers.get(key));
    timers.delete(key);
    due.delete(key);
    rerun.delete(key);
  }

  // LLM 없이 "내 차례 아님"을 기록한다
  function skipWithoutDraft(key: string, channel: string, rootTs: string | null, basisTs: string, category: string, reason: string, judgeCost: number | null = null) {
    if (gone(key)) return;
    store.supersedeOpen(key);
    store.insertDraft({
      key, channel, root_ts: rootTs, basis_ts: basisTs, category, risk: 0, confidence: 1, reason, draft_text: '', status: 'skipped', hold_reason: null,
      judge_cost_usd: judgeCost,
    });
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
      if (!watch || watch.mode === 'off' || store.isBlocked(key)) return;
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
      let judgeCost: number | null = null;
      if (rootTs !== null && judgeModel !== 'off' && judgeModel !== main.model) {
        const judged = await judge(thread, deps.persona, myUserId, { model: judgeModel, effort: JUDGE_EFFORT }, { myScope: myScope() });
        if (gone(key)) return;
        const j = judged.output;
        judgeCost = judged.costUsd;
        store.setWatchTopic(key, j.topic, true);
        if (!j.needs_my_reply) return skipWithoutDraft(key, channel, rootTs, last.ts, '1차 판단', j.reason, judgeCost);
      }

      const drafted = await draft(thread, deps.persona, myUserId, main, undefined, myScope());
      const result = drafted.output;
      if (gone(key)) return;
      const sendMode: SendMode = watch.mode === 'draft' ? 'draft' : (store.getSetting('sendMode', 'draft') as SendMode);
      const t = thresholds();
      const decision = decide(result, sendMode, t);
      store.setWatchTopic(key, result.topic, true);
      // 대화별 '초안만'과 전역 초안 모드를 구분해서 보여준다
      const hold = holdReasons(result, sendMode, t).map((r) => (r === '전송 설정이 초안 모드' && watch.mode === 'draft' ? "이 대화가 '초안만'" : r));

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
        judge_cost_usd: judgeCost,
        ...costFields(drafted),
      });

      if (decision === 'escalate') deps.notify(`⚠️ 직접 확인 필요 · ${last.name}`, `${last.text}\n— ${result.reason}`);
      if (decision === 'approve') deps.notify(`초안 승인 대기 · ${last.name}`, `${result.reply}\n— 자동 전송 안 함: ${hold.join(' · ')}`);
      if (decision === 'auto') {
        const [min, max] = [ms('autoSendMinSec'), ms('autoSendMaxSec')].sort((a, b) => a - b);
        const delay = min + Math.random() * (max - min);
        sendDue.set(id, Date.now() + delay);
        setTimeout(() => {
          sendDue.delete(id);
          void sendIfFresh(id);
        }, delay);
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

  function summarize(key: string) {
    return track(summarizing, key, () => summarizeNow(key));
  }

  async function summarizeNow(key: string) {
    const w = store.getWatch(key);
    if (!w) throw new Error('감시 중인 대화가 아닙니다');
    const thread = await read(w.channel, w.root_ts, SUMMARY_KEEP);
    const last = thread.at(-1);
    if (!last) throw new Error('대화에 메시지가 없습니다');
    remember(key, thread, w.root_ts === null);
    const prev = store.latestSummary(key);
    const plan = planSummary(thread, prev && { body: prev.body, basis_ts: prev.basis_ts, edit_mark: prev.edit_mark });
    if (plan.kind === 'none') return; // 이전 요약 뒤 새 메시지 없음: LLM을 부르지 않는다
    const summarized =
      plan.kind === 'incremental'
        ? await summarizeLlm(plan.newMessages, myUserId, llmFor(key, 'summary'), plan.prevBody)
        : await summarizeLlm(thread, myUserId, llmFor(key, 'summary'));
    const summary = summarized.output;
    store.insertSummary(key, last.ts, summary, { edit_mark: editMark(thread, last.ts), ...costFields(summarized) });
    store.setWatchTopic(key, summary.topic);
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

  // 화면의 "답장 초안 만들기": 차례 판단 없이 초안을 쓰고, 자동 전송 없이 항상 승인 대기로 둔다
  // withCode: "코드 보고 다시 쓰기". 설정한 프로젝트 폴더의 코드를 읽고 쓴다
  async function requestDraftNow(key: string, hint: string, withCode: boolean) {
    const w = store.getWatch(key);
    if (!w) throw new Error('감시 중인 대화가 아닙니다');
    const dirs = withCode ? parseDirs(setting('projectDirs')) : undefined;
    if (dirs?.length === 0) throw new Error('설정에서 프로젝트 폴더를 먼저 추가하세요');
    const thread = await read(w.channel, w.root_ts);
    remember(key, thread, w.root_ts === null);
    const last = thread.at(-1);
    if (!last) throw new Error('대화에 메시지가 없습니다');
    const drafted = await draft(thread, deps.persona, myUserId, llmFor(key, 'draft'), hint, myScope(), dirs);
    const result = drafted.output;
    if (!result.reply) throw new Error('초안을 만들지 못했습니다');
    const t = thresholds();
    const decision = decide({ ...result, needs_my_reply: true }, 'draft', t);
    store.supersedeOpen(key);
    store.insertDraft({
      key, channel: w.channel, root_ts: w.root_ts, basis_ts: last.ts,
      category: result.category, risk: result.risk, confidence: result.confidence, reason: result.reason,
      draft_text: result.reply, status: decision === 'escalate' ? 'escalated' : 'pending',
      hold_reason: [withCode ? '코드 보고 쓴 초안' : '직접 요청한 초안', ...holdReasons(result, 'draft', t).filter((r) => r !== '전송 설정이 초안 모드')].join(' · '),
      ...costFields(drafted),
    });
  }

  return {
    // 화면 카운트다운용: 판단 예정 시각(대화별), 판단 중인 대화, 자동 전송 예정 시각(초안별)
    timers() {
      return {
        judge: Object.fromEntries(due),
        running: [...running],
        send: Object.fromEntries(sendDue),
        summarizing: [...summarizing],
        drafting: [...drafting],
      };
    },

    async handleEvent(e: MessageEvent) {
      const key = threadKey(e);
      if (store.isBlocked(key)) return; // 삭제·보관한 대화는 완전히 무시
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
      schedule(key, isUrgent(e, myUserId, parseGroups(store.getSetting('mentionGroups', 'none'))) ? 'urgent' : 'batch');
      deps.onChange();
    },

    async addLink(url: string): Promise<void> {
      const target = parsePermalink(url);
      if (!target) throw new Error('Slack 메시지 링크가 아닙니다');
      // DM 본문 링크는 DM 전체를 대화로 본다
      const isDm = target.channel.startsWith('D') && target.rootTs === target.ts;
      const rootTs = isDm ? null : target.rootTs;
      const key = `${target.channel}:${rootTs ?? 'dm'}`;
      store.unblock(key); // 직접 링크로 등록하면 삭제·보관을 풀고 다시 감시
      store.addWatch(key, target.channel, rootTs, 'link');
      deps.onChange();
      await process(key);
    },

    // 삭제: DB에서 지우고 이후 이벤트는 무시
    forget(key: string) {
      cancel(key);
      store.deleteWatch(key);
      deps.onChange();
    },
    // 보관: 목록에서 빼고 감지를 멈춘다. 열린 초안은 무효
    archive(key: string) {
      cancel(key);
      store.supersedeOpen(key);
      store.archiveWatch(key);
      deps.onChange();
    },
    // 복원: 목록에 다시 나타나고 감지를 재개한다
    restore(key: string) {
      store.unarchiveWatch(key);
      deps.onChange();
    },

    summarize,
    summarizeStale,

    requestDraft(key: string, hint: string, withCode = false) {
      return track(drafting, key, () => requestDraftNow(key, hint, withCode));
    },
    read,
    remember,
    send: post,
    // 초안 없이 내가 직접 쓴 답장. 보내면 열린 초안은 무효
    async reply(key: string, text: string) {
      const w = store.getWatch(key);
      if (!w) throw new Error('감시 중인 대화가 아닙니다');
      if (!text.trim()) throw new Error('보낼 내용이 없습니다');
      const res = await client.chat.postMessage({ channel: w.channel, text, thread_ts: w.root_ts ?? undefined });
      store.supersedeOpen(key);
      store.touchWatch(key);
      if (res.ts) store.setLastMessage(key, res.ts, '나', text);
      deps.onChange();
    },
    ignore(id: number) {
      store.setDraftStatus(id, 'ignored');
      deps.onChange();
    },
  };
}
