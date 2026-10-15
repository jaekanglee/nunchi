import 'dotenv/config';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, Notification, shell } from 'electron';
import { startGateway } from './slack/gateway.js';
import { createConversationReader } from './slack/conversation.js';
import { hasPersona, loadPersona } from './responder/draft.js';
import { openStore, type WatchMode } from './store/db.js';
import { createEngine } from './engine.js';
import { EFFORTS, MODELS } from './llm/claude.js';
import { SETTINGS, parseGroups, validateSetting } from './ctl/settings.js';
import { DB_PATH } from './paths.js';
import { checkClaude, loadTokens, saveTokens, verifyTokens, type Tokens } from './setup.js';
import { collectPersona } from './persona/collect.js';
import { analyzePersona } from './persona/analyze.js';
import { SCOPES, buildManifest, createAppUrl, toYaml, type ManifestOptions } from './slack/manifest.js';

async function boot() {
  const store = openStore(DB_PATH);

  // 화면이 뜨자마자 상태를 요청하므로 IPC 핸들러를 먼저 등록한다
  let myUserId = '';
  let engine: ReturnType<typeof createEngine> | undefined;
  const ready = () => {
    if (!engine) throw new Error('Slack 연결 중입니다');
    return engine;
  };
  ipcMain.handle('state:get', () => ({
    me: myUserId,
    settings: Object.fromEntries(Object.entries(SETTINGS).map(([k, def]) => [k, store.getSetting(k, def.fallback)])),
    models: MODELS,
    efforts: EFFORTS,
    openDrafts: store.listOpenDrafts(),
    watches: store.listWatches(),
  }));
  ipcMain.handle('settings:set', (_ev, key: string, value: string) => {
    const err = validateSetting(key, value);
    if (err) throw new Error(err);
    store.setSetting(key, value);
    onChange();
  });
  ipcMain.handle('watch:setMode', (_ev, key: string, mode: WatchMode) => {
    store.setWatchMode(key, mode);
    onChange();
  });
  ipcMain.handle('watch:setLlm', (_ev, key: string, model: string | null, effort: string | null) => {
    store.setWatchLlm(key, model, effort);
    onChange();
  });
  ipcMain.handle('conversation:get', async (_ev, key: string) => {
    const w = store.getWatch(key);
    if (!w) throw new Error('감시 중인 대화가 아닙니다');
    const e = ready();
    const messages = await e.read(w.channel, w.root_ts);
    e.remember(key, messages, w.root_ts === null);
    const summary = store.latestSummary(key);
    return {
      me: myUserId,
      messages,
      drafts: store.listDraftsByKey(key),
      summary: summary && { ...JSON.parse(summary.body), basis_ts: summary.basis_ts, created_at: summary.created_at },
    };
  });
  ipcMain.handle('summary:run', (_ev, key: string) => ready().summarize(key));
  ipcMain.handle('summary:runStale', () => ready().summarizeStale());
  ipcMain.handle('link:add', (_ev, url: string) => ready().addLink(url));
  ipcMain.handle('draft:send', (_ev, id: number, text: string) => ready().send(id, text));
  ipcMain.handle('draft:ignore', (_ev, id: number) => ready().ignore(id));

  // 첫 실행 설정
  ipcMain.handle('setup:status', async () => ({
    claude: await checkClaude(),
    tokens: loadTokens() !== null,
    persona: hasPersona(),
    running: engine !== undefined,
  }));
  ipcMain.handle('setup:saveTokens', async (_ev, t: Tokens) => {
    const who = await verifyTokens(t);
    return { ...who, ...saveTokens(t) };
  });
  ipcMain.handle('setup:learn', async (_ev, months: number) => {
    const tokens = loadTokens();
    if (!tokens) throw new Error('Slack 토큰을 먼저 저장하세요');
    const log = (line: string) => win.webContents.send('setup:log', line);
    await collectPersona(tokens.userToken, months, 1000, log);
    log('말투 분석 중… (1~3분)');
    await analyzePersona(log);
  });
  ipcMain.handle('setup:start', () => start());
  ipcMain.handle('setup:manifest', (_ev, o: ManifestOptions) => {
    const m = buildManifest(o);
    return { yaml: toYaml(m), url: createAppUrl(m) };
  });
  ipcMain.handle('setup:scopes', () => SCOPES);
  ipcMain.handle('setup:copy', (_ev, text: string) => clipboard.writeText(text));
  // Slack 페이지만 연다
  ipcMain.handle('setup:openSlack', (_ev, url: string) => {
    if (!url.startsWith('https://api.slack.com/')) throw new Error('Slack 주소가 아닙니다');
    return shell.openExternal(url);
  });

  const icon = path.join(__dirname, '..', 'assets', 'icon.png');
  app.dock?.setIcon(icon);
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    icon,
    // macOS는 제목줄을 숨기고 신호등 버튼을 상단 바 위에 얹는다. Windows·Linux는 OS 기본 제목줄
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } } : { autoHideMenuBar: true }),
    backgroundColor: '#f6f5fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'static', 'index.html'));
  const onChange = () => win.webContents.send('state:changed');

  // 토큰과 말투 데이터가 준비돼야 Slack에 연결한다. 없으면 화면이 설정 단계를 보여준다
  async function start() {
    if (engine) return;
    const tokens = loadTokens();
    if (!tokens) throw new Error('Slack 토큰이 없습니다');
    if (!hasPersona()) throw new Error('말투 학습을 먼저 하세요');
    const persona = loadPersona();
    const gateway = await startGateway({
      userToken: tokens.userToken,
      appToken: tokens.appToken,
      onMessage: (e) => void engine?.handleEvent(e).catch((err) => console.error("[engine] 이벤트 처리 실패", err)),
    });
    myUserId = gateway.myUserId;
    engine = createEngine({
      client: gateway.app.client,
      myUserId,
      store,
      readConversation: createConversationReader(gateway.app.client, myUserId, () => parseGroups(store.getSetting('mentionGroups', 'none'))),
      persona,
      notify: (title, body) => new Notification({ title, body }).show(),
      onChange,
    });

    console.log(`Socket Mode 연결됨 (me=${myUserId})`);
    onChange();
  }

  if (loadTokens() && hasPersona()) await start();
}

// Windows 알림은 AppUserModelID가 있어야 뜬다 (개발 실행은 electron.exe 경로를 쓴다)
if (process.platform === 'win32') app.setAppUserModelId(process.execPath);

app.whenReady().then(boot).catch((err) => {
  console.error(err);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
