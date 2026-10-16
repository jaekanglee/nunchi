import 'dotenv/config';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell } from 'electron';
import { startGateway } from './slack/gateway.js';
import { createConversationReader } from './slack/conversation.js';
import { hasPersona, loadPersona } from './responder/draft.js';
import { badgeCount, openStore, type WatchMode } from './store/db.js';
import { createEngine } from './engine.js';
import { EFFORTS, MODELS } from './llm/claude.js';
import { SETTINGS, parseGroups, validateSetting } from './ctl/settings.js';
import { AUTO_ELIGIBLE } from './responder/policy.js';
import { DB_PATH } from './paths.js';
import { checkClaude, loadTokens, saveTokens, verifyTokens, type Tokens } from './setup.js';
import { collectPersona } from './persona/collect.js';
import { analyzePersona } from './persona/analyze.js';
import { toParts } from './slack/mrkdwn.js';
import { WINDOW_MIN, parseWindowState, restoreBounds } from './windowState.js';
import { buildDeepLink, buildPermalink } from './slack/permalink.js';
import { SCOPES, buildManifest, createAppUrl, toYaml, type ManifestOptions } from './slack/manifest.js';

async function boot() {
  const store = openStore(DB_PATH);

  // 화면이 뜨자마자 상태를 요청하므로 IPC 핸들러를 먼저 등록한다
  let myUserId = '';
  let teamUrl = '';
  let teamId = '';
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
    autoEligible: AUTO_ELIGIBLE,
    openDrafts: store.listOpenDrafts(),
    watches: store.listWatches(),
    timers: engine?.timers() ?? { judge: {}, running: [], send: {} },
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
      messages: messages.map((m) => ({ ...m, parts: toParts(m.text) })),
      drafts: store.listDraftsByKey(key),
      summary: summary && { ...JSON.parse(summary.body), basis_ts: summary.basis_ts, created_at: summary.created_at },
    };
  });
  // 대화 목록 우클릭 메뉴. 항목은 여기에 추가한다
  ipcMain.handle('watch:contextMenu', (_ev, key: string) => {
    const w = store.getWatch(key);
    if (!w) return;
    const openApp = () => void shell.openExternal(buildDeepLink(teamId, w.channel, w.root_ts));
    Menu.buildFromTemplate([
      { label: 'Slack 앱에서 열기', enabled: teamId !== '', click: openApp },
      { label: '브라우저로 열기', enabled: teamUrl !== '', click: () => void shell.openExternal(buildPermalink(teamUrl, w.channel, w.root_ts)) },
      { type: 'separator' },
      {
        label: '원문 링크 복사',
        enabled: teamUrl !== '',
        click: () => {
          clipboard.writeText(buildPermalink(teamUrl, w.channel, w.root_ts));
          win.webContents.send('toast', '원문 링크를 복사했습니다');
        },
      },
      { type: 'separator' },
      { label: '보관', click: () => ready().archive(key) },
      {
        label: '대화창 삭제',
        click: async () => {
          const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['삭제', '취소'],
            defaultId: 1,
            cancelId: 1,
            message: '이 대화를 삭제할까요?',
            detail: 'DB에서 완전히 지워지고, 이후 이 대화의 메시지는 감지하지 않습니다.',
          });
          if (response === 0) ready().forget(key);
        },
      },
    ]).popup({ window: win });
  });
  ipcMain.handle('archive:list', () => store.listArchived());
  ipcMain.handle('archive:restore', (_ev, key: string) => ready().restore(key));
  ipcMain.handle('archive:delete', async (_ev, key: string) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['삭제', '취소'],
      defaultId: 1,
      cancelId: 1,
      message: '보관한 대화를 삭제할까요?',
      detail: 'DB에서 완전히 지워지고, 이후 이 대화의 메시지는 감지하지 않습니다.',
    });
    if (response === 0) ready().forget(key);
  });
  ipcMain.handle('draft:request', (_ev, key: string, hint: string) => ready().requestDraft(key, hint));
  ipcMain.handle('watch:openSlack', (_ev, key: string) => {
    const w = store.getWatch(key);
    if (w && teamId) return shell.openExternal(buildDeepLink(teamId, w.channel, w.root_ts));
  });
  ipcMain.handle('summary:run', (_ev, key: string) => ready().summarize(key));
  ipcMain.handle('summary:runStale', () => ready().summarizeStale());
  ipcMain.handle('link:add', (_ev, url: string) => ready().addLink(url));
  ipcMain.handle('draft:send', (_ev, id: number, text: string) => ready().send(id, text));
  ipcMain.handle('message:reply', (_ev, key: string, text: string) => ready().reply(key, text));
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
  // 메시지 속 링크: 클릭하면 기본 브라우저로, 우클릭하면 열기·복사 메뉴
  const safeUrl = (url: string) => {
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error('열 수 없는 주소입니다');
    return url;
  };
  ipcMain.handle('link:open', (_ev, url: string) => shell.openExternal(safeUrl(url)));
  ipcMain.handle('link:contextMenu', (_ev, url: string, text: string) => {
    safeUrl(url);
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: '링크 열기', click: () => void shell.openExternal(url) },
      { label: '링크 주소 복사', click: () => clipboard.writeText(url) },
    ];
    if (text && text !== url) items.push({ label: '링크 텍스트 복사', click: () => clipboard.writeText(text) });
    Menu.buildFromTemplate(items).popup();
  });
  ipcMain.handle('setup:copy', (_ev, text: string) => clipboard.writeText(text));
  // Slack 페이지만 연다
  ipcMain.handle('setup:openSlack', (_ev, url: string) => {
    if (!url.startsWith('https://api.slack.com/')) throw new Error('Slack 주소가 아닙니다');
    return shell.openExternal(url);
  });

  const icon = path.join(__dirname, '..', 'assets', 'icon.png');
  app.dock?.setIcon(icon);
  const isMac = process.platform === 'darwin';
  // 지난번 창 크기·위치로 연다
  const savedWindow = parseWindowState(store.getSetting('windowState', ''));
  const win = new BrowserWindow({
    ...restoreBounds(savedWindow, screen.getAllDisplays().map((d) => d.workArea)),
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    icon,
    // macOS는 제목줄을 숨기고 신호등 버튼을 상단 바 위에 얹는다. Windows·Linux는 OS 기본 제목줄
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } } : { autoHideMenuBar: true }),
    backgroundColor: '#f6f5fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  // 광고 iframe 등에서 새 창을 열려고 하면 앱 창 대신 기본 브라우저로. 앱 화면 자체는 다른 주소로 이동하지 않는다
  if (savedWindow?.maximized) win.maximize();
  // 최대화 중에도 되돌릴 크기(normal bounds)를 저장한다
  let saveTimer: NodeJS.Timeout | undefined;
  const saveWindow = () => {
    clearTimeout(saveTimer);
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    store.setSetting('windowState', JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  };
  const saveLater = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindow, 500);
  };
  win.on('resize', saveLater);
  win.on('move', saveLater);
  win.on('maximize', saveLater);
  win.on('unmaximize', saveLater);
  win.on('close', saveWindow);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(path.join(__dirname, '..', 'static', 'index.html'));
  // 앱 아이콘 뱃지: macOS 독·Linux는 숫자, Windows는 작업 표시줄 아이콘에 빨간 점
  const redDot = (() => {
    const n = 16;
    const buf = Buffer.alloc(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 7.5 ** 2) buf.set([0x4d, 0x48, 0xe5, 0xff], (y * n + x) * 4); // BGRA
    return nativeImage.createFromBitmap(buf, { width: n, height: n });
  })();
  let lastBadge = -1;
  const updateBadge = () => {
    const count = badgeCount(store.listWatches());
    if (count === lastBadge) return;
    lastBadge = count;
    if (process.platform === 'win32') win.setOverlayIcon(count ? redDot : null, count ? `처리 필요 ${count}건` : '');
    else app.setBadgeCount(count);
  };
  const onChange = () => {
    win.webContents.send('state:changed');
    updateBadge();
  };
  updateBadge();

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
    teamUrl = gateway.teamUrl;
    teamId = gateway.teamId;
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

// 두 번 실행되면 같은 메시지에 자동 전송도 두 번 나간다. 이미 떠 있으면 그 창을 앞으로 가져오고 끝낸다
if (!app.requestSingleInstanceLock()) {
  console.log('Slmmury가 이미 실행 중입니다');
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(boot).catch((err) => {
    console.error(err);
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
