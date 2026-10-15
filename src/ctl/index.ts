// 원격 제어 CLI. 퇴근 후 SSH로 들어와서 앱 설정을 바꾼다. 앱은 설정을 매번 DB에서 읽으므로 즉시 반영된다.
// 사용: npm run ctl -- <명령>
//   status                       현재 설정, 감시 중인 대화, 처리 필요 초안
//   pause | resume               전체 일시정지 / 재개
//   set <설정> <값>               예) set sendMode draft
//   watch <번호|키> <on|draft|off> 대화별 모드
//   drafts                       처리 필요 초안 본문까지 보기
import { DB_PATH } from '../paths.js';
import { openStore, type WatchMode } from '../store/db.js';
import { SETTINGS, validateSetting } from './settings.js';

const store = openStore(DB_PATH);
const [cmd, ...args] = process.argv.slice(2);

const fmtTime = (ts: string | null) => (ts ? new Date(Number(ts) * 1000).toLocaleString('ko-KR') : '-');
const short = (s: string | null, n = 50) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);

function status() {
  console.log('== 설정 ==');
  for (const [k, def] of Object.entries(SETTINGS)) console.log(`${k.padEnd(14)} ${store.getSetting(k, def.fallback).padEnd(18)} ${def.desc}`);

  console.log('\n== 감시 중인 대화 ==');
  store.listWatches().forEach((w, i) => {
    const llm = w.model || w.effort ? ` [${w.model ?? '기본'}/${w.effort ?? '기본'}]` : '';
    console.log(`${String(i + 1).padStart(2)}. [${w.mode}] ${short(w.title ?? w.key, 40)}${llm} · 요약:${w.summary_state}`);
    console.log(`    ${w.key} · 마지막 ${fmtTime(w.last_ts)} ${w.last_name ?? ''}: ${short(w.last_text)}`);
  });

  const open = store.listOpenDrafts();
  console.log(`\n== 처리 필요 초안 ${open.length}개 ==`);
  for (const d of open) console.log(`#${d.id} ${d.status} · ${d.category} · 위험 ${d.risk} · ${d.key} — ${short(d.reason, 60)}`);
}

function resolveWatchKey(ref: string): string {
  const n = Number(ref);
  const watches = store.listWatches();
  const key = Number.isInteger(n) && n > 0 ? watches[n - 1]?.key : ref;
  if (!key || !store.getWatch(key)) throw new Error(`대화를 찾을 수 없습니다: ${ref} (status의 번호나 키를 쓰세요)`);
  return key;
}

function set(key: string, value: string) {
  const err = validateSetting(key, value);
  if (err) throw new Error(err);
  store.setSetting(key, value);
  console.log(`${key} = ${value}`);
}

try {
  switch (cmd) {
    case 'status':
    case undefined:
      status();
      break;
    case 'pause':
      set('paused', 'on');
      break;
    case 'resume':
      set('paused', 'off');
      break;
    case 'set':
      set(args[0], args[1]);
      break;
    case 'watch': {
      const mode = args[1] as WatchMode;
      if (!['on', 'draft', 'off'].includes(mode)) throw new Error('모드는 on | draft | off');
      const key = resolveWatchKey(args[0]);
      store.setWatchMode(key, mode);
      console.log(`${key} → ${mode}`);
      break;
    }
    case 'drafts':
      for (const d of store.listOpenDrafts()) console.log(`#${d.id} [${d.status}] ${d.key}\n  이유: ${d.reason}${d.hold_reason ? `\n  자동 전송 안 함: ${d.hold_reason}` : ""}\n  초안: ${d.draft_text}\n`);
      break;
    default:
      throw new Error(`알 수 없는 명령: ${cmd} (status | pause | resume | set | watch | drafts)`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
