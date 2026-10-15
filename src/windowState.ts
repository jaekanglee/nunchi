// 창 크기·위치를 기억했다가 다음 실행 때 그대로 연다.
// 모니터를 뺐거나 해상도가 바뀌어 저장된 위치가 화면 밖이면 크기만 살리고 위치는 OS에 맡긴다.

export type Rect = { x: number; y: number; width: number; height: number };
export type WindowState = Rect & { maximized: boolean };

const MIN = { width: 900, height: 600 };
const DEFAULT = { width: 1200, height: 820 };

export function parseWindowState(raw: string | null): WindowState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(s[k])) ? { ...s, maximized: s.maximized === true } : null;
  } catch {
    return null;
  }
}

// 창의 제목줄 부근이 어느 모니터 작업 영역 안에 걸쳐 있어야 위치를 살린다 (잡아서 옮길 수 있게)
const visibleOn = (r: Rect, area: Rect) =>
  r.x + 100 <= area.x + area.width && r.x + r.width - 100 >= area.x && r.y >= area.y && r.y + 40 <= area.y + area.height;

export function restoreBounds(saved: WindowState | null, workAreas: Rect[]): Partial<Rect> {
  if (!saved) return DEFAULT;
  const size = { width: Math.max(saved.width, MIN.width), height: Math.max(saved.height, MIN.height) };
  return workAreas.some((a) => visibleOn(saved, a)) ? { ...size, x: saved.x, y: saved.y } : size;
}

export const WINDOW_MIN = MIN;
