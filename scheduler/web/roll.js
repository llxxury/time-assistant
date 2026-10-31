// 跨周滚动：把排程起点前移到今天，并把所有「离起点第几天」的字段一起挪过去。
// 纯函数：不认识 DOM，不认识时钟，today 由调用方给定（和 engine 一样好测）。

const DAY_MS = 86400000;

/** dateStr 往后 d 天（UTC 计算，不涉及时区） */
export function addDays(dateStr, d) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + d * DAY_MS).toISOString().slice(0, 10);
}

/** from 到 to 相差几天 */
export function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

const LISTS = ['log', 'pending', 'lastPlan'];

/**
 * 起点滚到 today，返回挪了几天（0 = 没动）。
 * 幂等：同一天里重复调用不会二次位移。
 * 只往前走：系统时间被拨回去时原地不动，免得历史记录来回错位。
 */
export function rollStart(store, today) {
  if (!store?.startDate || !today) return 0;
  const shift = daysBetween(store.startDate, today);
  if (shift <= 0) return 0;
  const old = store.startDate;

  for (const name of LISTS) {
    const list = store[name];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e) continue;
      // 老记录只有相对的 day：先补出绝对日期，再按新起点重算 day。
      // 之后 day 可以为负（过去的记录），所以凡是要显示或比较日期的地方都得看 date。
      if (e.date == null) {
        if (e.day == null) continue;
        e.date = addDays(old, e.day);
      }
      e.day = daysBetween(today, e.date);
    }
  }

  // pending 的去重键里含 day，跟着改；否则打勾时按新 day 拼出来的键对不上，
  // 那条待处理会一直删不掉。
  if (Array.isArray(store.pending)) {
    for (const p of store.pending) {
      if (p && p.taskId != null && p.day != null) p.key = `${p.taskId}|${p.day}|${p.start}`;
    }
  }

  store.startDate = today;
  return shift;
}
