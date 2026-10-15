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
};

export type ClaudeResult<T> = { output: T; costUsd: number };

export function runClaude<T>(opts: ClaudeOptions): Promise<ClaudeResult<T>> {
  // system 프롬프트(말투 가이드 포함)는 길어질 수 있어 파일로 넘긴다. Windows 명령줄 길이 제한(약 32K자) 대비
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slmmury-'));
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
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === 'ENOENT' ? new Error(CLAUDE_MISSING) : err);
    });
    child.on('close', (code) => {
      cleanup();
      if (code !== 0) return reject(new Error(`claude 종료 코드 ${code}: ${stderr.trim()}`));
      const res = JSON.parse(stdout);
      if (res.is_error || res.structured_output == null) {
        return reject(new Error(`claude 오류 (${res.subtype ?? res.terminal_reason}): ${res.result ?? ''}`));
      }
      const u = res.usage ?? {};
      console.log(`[claude] ${opts.llm?.model ?? DEFAULT_LLM.model} 캐시읽기 ${u.cache_read_input_tokens ?? 0} · 캐시쓰기 ${u.cache_creation_input_tokens ?? 0} · 입력 ${u.input_tokens ?? 0} · 출력 ${u.output_tokens ?? 0} · $${(res.total_cost_usd ?? 0).toFixed(4)}`);
      resolve({ output: res.structured_output as T, costUsd: res.total_cost_usd ?? 0 });
    });
    child.stdin.end(opts.prompt);
  });
}
