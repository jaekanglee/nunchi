# Slmmury

내 Slack 계정으로 들어온 메시지를 받아 **내 말투로 답장 초안**을 쓰고, 위험도에 따라 자동 전송 / 승인 대기 / 직접 확인으로 나누는 데스크톱 앱입니다. macOS · Windows · Linux에서 돌아갑니다. 대화 요약과 SSH 원격 제어도 됩니다.

- LLM은 이 컴퓨터에 로그인된 **Claude Code**(`claude -p`)를 씁니다. API 키는 필요 없습니다.
- Slack은 각자 만든 Slack 앱의 **User Token**으로 동작합니다. 보내는 메시지는 내 이름으로 나갑니다.

## 준비물

| 항목 | 확인 방법 |
|---|---|
| macOS, Windows 10/11, Linux(데스크톱) 중 하나 | |
| Node.js 22.5 이상 | `node --version` |
| Claude Code 설치·로그인 | `claude auth status`에서 `"loggedIn": true` |
| Slack 워크스페이스에 앱 설치 권한 | 관리자 승인이 필요한 워크스페이스도 있습니다 |

**Windows**: Claude Code는 네이티브 설치(`claude.exe`)를 쓰세요. npm으로 설치한 `claude.cmd`는 앱에서 실행할 수 없습니다. 터미널에서 `where claude`로 `claude.exe`가 나오는지 확인하세요.

## 설치

```bash
git clone <이 저장소> slmmury
cd slmmury
npm install
npm link        # slmmury 명령 등록 (한 번만)
slmmury start
```

처음 켜면 설정 화면이 뜹니다. 순서대로 따라 하면 됩니다.

1. **Claude Code 로그인 확인**
2. **Slack 앱 연결**: "📖 연결 가이드 열기"를 누르면 앱 안에서 안내합니다.
   - **매니페스트 만들기**: 앱 이름과 쓸 기능(비공개 채널, 그룹 DM, 말투 학습)을 고르면 필요한 권한만 넣은 매니페스트를 만듭니다. 버튼 하나로 Slack 앱 생성 화면이 매니페스트가 채워진 채로 열립니다.
   - **연결 튜토리얼**: 앱 설치 → User OAuth Token(`xoxp-`) → App-Level Token(`xapp-`, scope `connections:write`) 순서로 화면 위치를 안내합니다.
   - **권한·설정 설명**: 권한마다 왜 필요한지, 없으면 무엇이 안 되는지 보여줍니다.
   - **문제 해결**: 자주 나는 오류와 해결법입니다.
   - 토큰을 저장하면 실제 연결과 필수 권한을 점검합니다. 토큰은 OS 보안 저장소로 암호화해 저장합니다.
   - 기본 매니페스트는 `slack-manifest.yaml`에도 있습니다.
3. **말투 학습**: 공개 채널에 내가 쓴 메시지(기본 6개월, 최대 1000개)로 말투 가이드를 만듭니다. 몇 분 걸립니다.
4. **그룹 멘션 (선택)**: 내가 속한 사용자 그룹 ID(`S…`)를 넣으면 그 그룹이 멘션돼도 반응합니다.
5. **시작하기**

설정 화면은 상단 ⚙︎ 버튼으로 다시 열 수 있습니다. 토큰 교체나 말투 재학습을 할 때 씁니다.

## 동작

- **자동 감지**: DM, 그룹 DM, 나를 멘션한 메시지, 등록한 그룹의 멘션을 감시 대화로 등록합니다.
- **링크 등록**: 메시지 링크를 붙여넣으면 그 대화를 처음부터 읽고, 이후 멘션이 없어도 계속 지켜봅니다.
- **판정**:
  - 잡담·단순확인이면서 위험 20 미만, 확신 0.8 이상이면 자동 모드에서 1~5분 뒤 전송합니다. 보내기 전에 대화가 바뀌었는지 다시 확인합니다.
  - 그 밖의 건은 승인 대기로 둡니다. 카드에 자동 전송하지 않은 이유가 나옵니다.
  - 업무지시, 장애, 민감한 건, 모르는 사실이 필요한 건은 항상 직접 확인으로 보냅니다.
- **대화별 설정**: ON / 초안만 / OFF, 모델·effort를 대화마다 바꿀 수 있습니다.

## slmmury 명령

`npm link`로 등록하면 어느 폴더에서든 씁니다. SSH로 들어와서도 같은 명령을 씁니다. Windows는 OpenSSH 서버를 켜면 됩니다.

```bash
slmmury start            # 백그라운드로 실행
slmmury stop | restart
slmmury logs [-f]        # 최근 로그 (-f: 계속 보기)
slmmury update           # git pull → npm install → 빌드 → 실행 중이면 재시작
slmmury doctor           # Node, Claude Code 로그인, 토큰, 말투 데이터 점검

slmmury status           # 설정, 감시 중인 대화, 처리 필요 초안
slmmury pause | resume   # 전체 일시정지 / 재개
slmmury set sendMode draft           # draft | auto
slmmury set mentionGroups S0123ABCD  # 쉼표로 여러 개, none이면 끔
slmmury set autoSendMinSec 30        # 타이밍(초): urgentDelaySec, batchDelaySec, autoSendMinSec, autoSendMaxSec
slmmury watch 3 off      # 대화별 on | draft | off
slmmury drafts           # 처리 필요 초안 본문
```

설정은 재시작 없이 바로 반영됩니다. 앱은 하나만 뜨게 되어 있어서, 두 번 실행하면 두 번째는 바로 끝납니다. `npm link` 없이 쓰려면 저장소 폴더에서 `node bin/slmmury.js <명령>`을 실행하세요.

## 데이터 위치

모든 데이터는 아래 폴더에 있고 저장소에는 들어가지 않습니다.

| OS | 위치 |
|---|---|
| macOS | `~/Library/Application Support/slmmury/` |
| Windows | `%APPDATA%\slmmury\` |
| Linux | `~/.config/slmmury/` (`$XDG_CONFIG_HOME`이 있으면 그 아래) |

| 파일 | 내용 |
|---|---|
| `slmmury.db` | 설정, 감시 대화, 초안, 요약 (SQLite) |
| `credentials.json` | 암호화된 Slack 토큰 |
| `persona/` | 수집한 내 메시지, 말투 가이드, 상대별 관계 |

개발할 때는 `.env`(`.env.example` 참고)에 토큰을 넣어도 됩니다. 저장된 토큰이 없을 때만 `.env`를 읽습니다.

## 주의

- 컴퓨터가 잠들거나 앱이 꺼져 있는 동안 온 메시지는 놓칩니다.
- 내가 멤버가 아닌 채널의 링크는 첫 초안까지만 만들고, 이후 새 답글은 감지하지 못합니다.
- 자동 전송한 메시지에는 Slack 앱 흔적(`app_id`)이 남습니다.
- 프롬프트와 말투 분석은 한국어 기준입니다.

## OS별 참고

- **Linux**
  - 토큰 암호화에 gnome-keyring이나 KWallet이 필요합니다. 없으면 권한 600 파일에 평문으로 저장하고 설정 화면에 경고를 띄웁니다.
  - 배포판에 따라 Electron 샌드박스 오류(`chrome-sandbox ... not configured correctly`)가 나면 `npm start -- --no-sandbox`로 실행하세요.
- **Windows**
  - `npm start`로 실행할 때 알림은 Electron 이름으로 뜹니다.
  - SSH로 원격 제어하려면 "설정 → 선택적 기능 → OpenSSH 서버"를 켜세요.

## 개발

```bash
npm test                 # 빌드 + 단위 테스트
npm run persona:collect  # 말투 수집만 따로 (.env 토큰 사용)
npm run persona:analyze  # 말투 분석만 따로
```

설계 문서: `docs/design.md`
