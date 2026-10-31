// 时间区间代数。
// 约定：一天 = 1440 分钟，区间一律左闭右开 [start, end)。
// 全部按「本地墙钟 + 当天分钟数」处理，不做 UTC 换算。

export const DAY = 1440;

export const fmtClock = (m) => {
  const r = ((m % DAY) + DAY) % DAY;
  return String(Math.floor(r / 60)).padStart(2, '0') + ':' + String(r % 60).padStart(2, '0');
};

export const fmtDur = (m) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (!h) return mm + 'm';
  return mm ? h + 'h' + mm + 'm' : h + 'h';
};

/** 合并重叠 / 相接的区间，返回升序不相交列表 */
export function merge(list) {
  const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** base 里挖掉 holes，返回升序不相交列表 */
export function subtract(base, holes) {
  let cur = merge(base);
  for (const [ha, hb] of merge(holes)) {
    const next = [];
    for (const [a, b] of cur) {
      if (hb <= a || ha >= b) {
        next.push([a, b]);
        continue;
      }
      if (ha > a) next.push([a, ha]);
      if (hb < b) next.push([hb, b]);
    }
    cur = next;
  }
  return cur.filter(([a, b]) => b > a);
}

export const total = (list) => list.reduce((s, [a, b]) => s + (b - a), 0);

/** 把区间裁剪到 [lo, hi] */
export function clip(list, lo, hi) {
  const out = [];
  for (const [a, b] of list) {
    const s = Math.max(a, lo);
    const e = Math.min(b, hi);
    if (e > s) out.push([s, e]);
  }
  return out;
}
