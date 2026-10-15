// "나로서 전송" 검증용. 채널을 안 주면 나에게 보내는 DM(나와의 대화)에 보낸다.
// 사용: npm run send-as-me -- [channel] [text]
import 'dotenv/config';
import { WebClient } from '@slack/web-api';

async function main() {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error('.env에 SLACK_USER_TOKEN이 없습니다');
  const client = new WebClient(token);

  const auth = await client.auth.test();
  const channel = process.argv[2] ?? (auth.user_id as string);
  const text = process.argv[3] ?? 'Slmmury 전송 테스트';

  const res = await client.chat.postMessage({ channel, text });
  console.log('보낸 채널:', res.channel, 'ts:', res.ts);
  // 메시지에 앱 흔적(app_id, bot_id 등)이 남는지 확인
  console.log(JSON.stringify(res.message, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
