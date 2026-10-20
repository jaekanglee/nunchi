// Claude Code CLI(`claude -p`)를 LLM 엔진으로 호출한다. 로그인된 Claude Code 계정을 그대로 쓴다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_MISSING =
  process.platform === 'win32'
    ? 'claude 명령을 찾을 수 없습니다. Claude Code를 네이티브 설치(claude.exe)하고 PATH에 있는지 확인하세요'
    : 'claude 명령을 찾을 수 없습니다. Claude Code를 설치하세요';

export const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const;
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Llm = { model: string; effort: string };

export const DEFAULT_LLM: Llm = { model: 'claude-sonnet-5-5', effort: 'medium' };

// 대화별 설정이 있으면 그것, 없으면 전역 기본값
export function resolveLlm(override: { model: string | null; effort: string | null } | undefined, global: Llm): Llm {
  return { model: override?.model ?? global.model, effort: override?.effort ?? global.effort };
}

export type ClaudeOptions = {
  system: string;
  prompt: string;
  schema: object;
  llm?: Partial<Llm>;
  timeoutMs?: number; // 이 시간 안에 안 끝나면 claude를 죽이고 실패로 본다
};

// 판단·초안·요약은 보통 20~40초. claude가 멈춰도 프로세스(수백 MB)와 대화 처리 상태가 영원히 남지 않게 끊는다
const TIMEOUT_MS = 5 * 60_000;

// 없는 필드는 null로 둔다(DB에도 NULL로 저장)
export type Usage = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  thinking: number | null;
};

export type ClaudeResult<T> = { output: T; costUsd: number; usage: Usage };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// usage 아래 어디에 있든 이름에 thinking/reasoning이 들어간 첫 숫자 필드를 thinking 토큰으로 본다
function findThinking(v: unknown, depth = 0): number | null {
  if (v == null || typeof v !== 'object' || depth > 3) return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (/thinking|reasoning/i.test(k) && num(x) != null) return num(x);
  }
  for (const x of Object.values(v as Record<string, unknown>)) {
    const t = findThinking(x, depth + 1);
    if (t != null) return t;
  }
  return null;
}

export function parseUsage(res: unknown): Usage {
  const u = res != null && typeof res === 'object' ? (res as { usage?: Record<string, unknown> }).usage : undefined;
  if (u == null || typeof u !== 'object') {
    return { input: null, output: null, cacheRead: null, cacheCreation: null, thinking: null };
  }
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    thinking: findThinking(u),
  };
}

export function runClaude<T>(opts: ClaudeOptions): Promise<ClaudeResult<T>> {
  // system 프롬프트(말투 가이드 포함)는 길어질 수 있어 파일로 넘긴다. Windows 명령줄 길이 제한(약 32K자) 대비
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nunchi-'));
  const systemFile = path.join(dir, 'system.txt');
  fs.writeFileSync(systemFile, opts.system);
  const args = [
    '-p',
    '--model', opts.llm?.model ?? DEFAULT_LLM.model,
    '--effort', opts.llm?.effort ?? DEFAULT_LLM.effort,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(opts.schema),
    '--system-prompt-file', systemFile,
    // Slack 메시지는 남이 쓴 입력이다. 프롬프트 인젝션에 대비해 도구·MCP·사용자 설정(hook, 플러그인)을 전부 끈다
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--no-session-persistence',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // 한글이 청크 경계에서 잘려도 깨지지 않게 디코더를 스트림에 맡긴다
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      cleanup();
      reject(err.code === 'ENOENT' ? new Error(CLAUDE_MISSING) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (timedOut) return reject(new Error(`claude가 제한 시간(${timeoutMs / 1000}초) 안에 끝나지 않아 중단했습니다`));
      if (code !== 0) return reject(new Error(`claude 종료 코드 ${code}: ${stderr.trim()}`));
      // 여기서 던지면 Promise가 끝나지 않고 그 대화는 앱을 다시 켤 때까지 "판단 중"에 묶인다
      let res;
      try {
        res = JSON.parse(stdout);
      } catch {
        return reject(new Error(`claude 출력이 JSON이 아닙니다: ${stdout.trim().slice(0, 200)}`));
      }
      if (res.is_error || res.structured_output == null) {
        return reject(new Error(`claude 오류 (${res.subtype ?? res.terminal_reason}): ${res.result ?? ''}`));
      }
      const usage = parseUsage(res);
      const costUsd: number = res.total_cost_usd ?? 0;
      console.log(`[claude] ${opts.llm?.model ?? DEFAULT_LLM.model} 캐시읽기 ${usage.cacheRead ?? 0} · 캐시쓰기 ${usage.cacheCreation ?? 0} · 입력 ${usage.input ?? 0} · 출력 ${usage.output ?? 0} (thinking ${usage.thinking ?? '-'}) · $${costUsd.toFixed(4)}`);
      resolve({ output: res.structured_output as T, costUsd, usage });
    });
    child.stdin.end(opts.prompt);
  });
}
