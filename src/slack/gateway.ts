import { App, LogLevel } from '@slack/bolt';
import type { MessageEvent } from './router.js';

// User Token(xoxp)으로 Socket Mode에 연결한다. 이벤트는 "내 권한"으로 구독한 user event.
// 어떤 메시지를 처리할지는 engine이 router로 판단한다.
export async function startGateway(opts: {
  userToken: string;
  appToken: string;
  onMessage: (event: MessageEvent) => void;
}): Promise<{ app: App; myUserId: string }> {
  const app = new App({
    token: opts.userToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
    // 기본 ignoreSelf는 내 메시지를 버린다. 감시 스레드에서 "내가 직접 답함"을 알아야 하므로 끈다
    ignoreSelf: false,
  });

  const auth = await app.client.auth.test();
  const myUserId = auth.user_id as string;

  app.event('message', async ({ event }) => {
    opts.onMessage(event as unknown as MessageEvent);
  });

  await app.start();
  return { app, myUserId };
}
