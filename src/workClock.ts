// 자동 퇴근 판정: 지난번 확인(prev) 뒤부터 이번 확인(now, 포함)까지 사이에 그날의 hh:mm이 있었는지. 자정을 넘는 구간도 본다
export function crossedTime(prev: Date, now: Date, hhmm: string): boolean {
  const [h, m] = hhmm.split(':').map(Number);
  return [prev, now].some((day) => {
    const t = new Date(day);
    t.setHours(h, m, 0, 0);
    return t > prev && t <= now;
  });
}
