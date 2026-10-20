#!/usr/bin/env node
// 눈치 명령줄 도구. 저장소에서 `npm link` 한 번 하면 어디서든 `nunchi <명령>`으로 쓴다.
// 빌드 전에도 돌아야 해서 TypeScript가 아닌 그냥 JS로 둔다. macOS·Windows·Linux 공통.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

// src/paths.ts와 같은 규칙 (빌드 전에도 쓰려고 여기서 직접 계산)
function dataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'nunchi');
  if (isWin) return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'nunchi');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'nunchi');
}
const DATA = dataDir();
const PID_FILE = path.join(DATA, 'app.pid');
const LOG_FILE = path.join(DATA, 'app.log');

const HELP = `사용: nunchi <명령>

앱
  start            백그라운드로 실행 (로그: nunchi logs)
  stop             종료
  restart          다시 시작
  logs [-f] [줄수] 최근 로그 (-f: 계속 보기)
  update           최신 코드 받기 → 설치 → 빌드 → 실행 중이면 재시작
  doctor           실행 환경 점검 (Node, Claude Code, 토큰, 말투 데이터)

원격 제어 (앱이 켜져 있으면 바로 반영)
  status           설정, 감시 중인 대화, 처리 필요 초안
  pause | resume   전체 일시정지 / 재개
  set <키> <값>    설정 변경 (예: set sendMode draft)
  watch <번호> <on|draft|off>
  drafts           처리 필요 초안 본문

개발
  test             빌드 + 테스트
  dev              터미널에 붙여서 실행 (로그가 바로 보임)`;

function run(cmd, args, opts = {}) {
  // Windows의 npm·npx는 .cmd라 shell이 필요하다
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWin, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function build() {
  run(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')]);
}

function runningPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 0); // 살아 있는지만 확인
    return pid;
  } catch {
    return null;
  }
}

function start() {
  const pid = runningPid();
  if (pid) return console.log(`이미 실행 중입니다 (pid ${pid})`);
  build();
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(log, `\n==== ${new Date().toLocaleString()} 시작 ====\n`);
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(electron, ['.'], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: false });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`시작했습니다 (pid ${child.pid}). 로그: nunchi logs`);
}

function stop() {
  const pid = runningPid();
  if (!pid) return console.log('실행 중이 아닙니다');
  process.kill(pid);
  fs.rmSync(PID_FILE, { force: true });
  console.log(`종료했습니다 (pid ${pid})`);
}

async function waitStopped(ms = 5000) {
  const until = Date.now() + ms;
  while (runningPid() && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
}

function logs(args) {
  if (!fs.existsSync(LOG_FILE)) return console.log(`로그가 없습니다 (${LOG_FILE})`);
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 80);
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
  // Electron 내부 경고(GPU 등)는 빼고 보여준다
  const keep = (l) => !/^\[\d+:\d+\/\d+\.\d+:(ERROR|WARNING|INFO):/.test(l);
  console.log(lines.filter(keep).slice(-n).join('\n'));
  if (!args.includes('-f')) return;
  let size = fs.statSync(LOG_FILE).size;
  fs.watchFile(LOG_FILE, { interval: 500 }, (cur) => {
    if (cur.size < size) size = 0;
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(cur.size - size);
    fs.readSync(fd, buf, 0, buf.length, size);
    fs.closeSync(fd);
    size = cur.size;
    const text = buf.toString('utf8').split('\n').filter(keep).join('\n');
    if (text.trim()) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  });
}

async function update() {
  const wasRunning = runningPid();
  run('git', ['pull', '--ff-only']);
  run('npm', ['install', '--no-audit', '--no-fund']);
  build();
  if (wasRunning) {
    stop();
    await waitStopped();
    start();
  }
  console.log('업데이트 완료');
}

function doctor() {
  const ok = (cond, label, hint) => console.log(`${cond ? '✓' : '✗'} ${label}${!cond && hint ? `\n    → ${hint}` : ''}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  ok(major > 22 || (major === 22 && minor >= 5), `Node ${process.versions.node}`, 'Node 22.5 이상이 필요합니다');
  ok(fs.existsSync(path.join(ROOT, 'node_modules', 'electron')), '의존성 설치', 'npm install');
  ok(fs.existsSync(path.join(ROOT, 'dist', 'main.js')), '빌드', 'nunchi update 또는 npx tsc');
  const claude = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
  let logged = false;
  try { logged = JSON.parse(claude.stdout).loggedIn === true; } catch {}
  ok(logged, 'Claude Code 로그인', claude.error ? 'Claude Code를 설치하세요' + (isWin ? ' (네이티브 설치 claude.exe)' : '') : '터미널에서 claude 실행 후 로그인');
  const envFile = fs.existsSync(path.join(ROOT, '.env')) && /SLACK_USER_TOKEN=xoxp-/.test(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
  ok(fs.existsSync(path.join(DATA, 'credentials.json')) || envFile, 'Slack 토큰', '앱을 켜서 설정 화면에서 토큰을 저장하세요');
  ok(['style_guide.md', 'relationships.json', 'pairs.jsonl'].every((f) => fs.existsSync(path.join(DATA, 'persona', f))), '말투 데이터', '앱 설정 화면에서 말투 학습을 하세요');
  const pid = runningPid();
  console.log(`${pid ? '●' : '○'} 앱 ${pid ? `실행 중 (pid ${pid})` : '꺼짐'}`);
  console.log(`  데이터: ${DATA}`);
}

function ctl(args) {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'ctl', 'index.js'))) build();
  run(process.execPath, ['--no-warnings', path.join(ROOT, 'dist', 'ctl', 'index.js'), ...args]);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'start': return start();
    case 'stop': return stop();
    case 'restart': stop(); await waitStopped(); return start();
    case 'logs': return logs(args);
    case 'update': return update();
    case 'doctor': return doctor();
    case 'test': return run('npm', ['test']);
    case 'dev': build(); return run(require(path.join(ROOT, 'node_modules', 'electron')), ['.']);
    case 'status': case 'pause': case 'resume': case 'set': case 'watch': case 'drafts': return ctl([cmd, ...args]);
    case undefined: case 'help': case '-h': case '--help': return console.log(HELP);
    default:
      console.error(`알 수 없는 명령: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
