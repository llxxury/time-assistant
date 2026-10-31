// 排程核心：纯函数，input = fixture，output = plan + trace。
// 不认识 DOM，不认识时钟，now 由调用方给定（默认周一 00:00）。

import { DAY, subtract, total, clip, fmtDur, fmtClock } from './time.js';

export const DEFAULT_RULES = {
  wImportance: 0.45, // 重要度权重（滑杆）
  lam: 1.8, // 紧急度饱和系数
  breakMin: 10, // 块后自动休息
  minChunkMin: 45, // 默认最短块
  maxChunks: 3, // 默认最多切几块
  maxChunksPerDay: 2, // 每天最多几块
  minTailMin: 15, // 尾块不低于这个
  hungerWeight: 0.12,
  classBufferMin: 10, // 固定占用前后各留多少（换教室、路上）
  maxLookaheadDays: 120, // 算容量时最多往后看多少天（长期目标的截止可能很远）
  fillRatio: 0.85, // 每天最多用掉多少空档，剩下的是留白
  // 运行时参数，由调用方注入，不是可调规则
  nowDay: 0, // 今天离起点的天数（之前的整段都算过去）
  nowMinute: 0, // 今天已经过去的分钟数
};

/**
 * 解析周次规则："2-16/双" | "1-17/单" | "8-11" | "1" | "all"
 * 返回 Set 或 null（null = 每周都有）
 */
export function parseWeeks(spec) {
  if (spec == null || spec === 'all') return null;
  const [range, parity] = String(spec).split('/');
  const parts = range.includes('-') ? range.split('-').map(Number) : [Number(range), Number(range)];
  const [a, b] = parts;
  const set = new Set();
  for (let w = a; w <= b; w++) {
    if (parity === '双' && w % 2 === 1) continue;
    if (parity === '单' && w % 2 === 0) continue;
    set.add(w);
  }
  return set;
}

export function makeState(fixture, rules = {}) {
  const r = { ...DEFAULT_RULES, ...(fixture.rules || {}), ...rules };
  const horizon = fixture.horizonDays ?? 7;

  // 用户钉住的块：它们是「既定事实」，排程要绕开，也要从剩余量里扣掉。
  // 非法数据直接丢弃（宁可少一个 pin，也不要排出一张自相矛盾的时间轴）。
  const pins = (fixture.pins || []).filter(
    (p) =>
      p &&
      p.taskId != null &&
      Number.isFinite(p.day) &&
      Number.isFinite(p.start) &&
      Number.isFinite(p.end) &&
      p.day >= 0 &&
      p.day < horizon &&
      p.start >= 0 &&
      p.end <= DAY &&
      p.end > p.start
  );

  const pinnedMin = {};
  for (const p of pins) pinnedMin[p.taskId] = (pinnedMin[p.taskId] || 0) + (p.end - p.start);

  return {
    fixture,
    rules: r,
    tasks: fixture.tasks.map((t) => ({
      ...t,
      // 截止支持两种写法：绝对日期 deadlineDate，或相对天数 deadlineDay。
      // 统一折算成「离起点第几天」，可以为负（已过期）或远大于 horizon（长期目标）。
      deadlineDay:
        t.deadlineDate != null
          ? Math.round(
              (Date.parse(t.deadlineDate + 'T00:00:00Z') -
                Date.parse(fixture.startDate + 'T00:00:00Z')) /
                DAY_MS
            )
          : t.deadlineDay,
      // 剩余量 = 预计 − 已完成 − 已钉住（钉住的那部分不用再排）
      remain: Math.max(0, t.estMin - (t.doneMin || 0) - (pinnedMin[t.id] || 0)),
      chunks: [],
      stuck: false,
      done: false,
    })),
    pins: pins.map((p) => ({ taskId: p.taskId, day: p.day, start: p.start, end: p.end })),
    placed: [],
    trace: [],
    infeasible: [],
  };
}

const weekdayOf = (state, d) => {
  const fx = state.fixture;
  const base =
    fx.startWeekday ??
    (new Date(Date.parse(fx.startDate + 'T00:00:00Z')).getUTCDay() || 7); // 0=周日 → 7
  return ((base - 1 + d) % 7) + 1;
};

const DAY_MS = 86400000;

/** 第 d 天的真实日期（YYYY-MM-DD，UTC 计算，不涉及时区） */
export function dateOf(state, d) {
  const base = Date.parse(state.fixture.startDate + 'T00:00:00Z');
  return new Date(base + d * DAY_MS).toISOString().slice(0, 10);
}

/** 这一天是学期第几周；学期关闭或不在学期内返回 null */
export function semesterWeekOf(state, dateStr) {
  const s = state.fixture.semester;
  if (!s || s.enabled === false) return null;
  const start = Date.parse(s.startDate + 'T00:00:00Z');
  const cur = Date.parse(dateStr + 'T00:00:00Z');
  const w = Math.floor((cur - start) / (7 * DAY_MS)) + 1;
  if (w < 1 || w > (s.totalWeeks ?? 99)) return null;
  return w;
}

const daysOf = (b) => b.weekdays ?? (b.weekday != null ? [b.weekday] : []);

function kindOf(b) {
  if (b.kind) return b.kind;
  if (b.date != null) return 'once';
  if (b.weeks != null) return 'semester';
  return 'weekly';
}

/**
 * 某天的固定占用。三种形式：
 *   semester  跟学期走，按周次过滤（课表）；学期关闭时整体失效
 *   weekly    每周固定，与学期无关（社团、通勤）
 *   once      某一天（活动、会议）
 * 每个固定块前后各留 classBufferMin 分钟，用于赶路 / 换教室。
 */
export function fixedBlocksOn(state, d) {
  const out = [];
  const wd = weekdayOf(state, d);
  const date = dateOf(state, d);
  for (const b of state.fixture.fixed) {
    const kind = kindOf(b);
    if (kind === 'once') {
      if (b.date !== date && b.day !== d) continue;
    } else if (kind === 'semester') {
      if (!daysOf(b).includes(wd)) continue;
      const w = semesterWeekOf(state, date);
      if (w == null) continue; // 学期外：整条不生效
      const set = parseWeeks(b.weeks);
      if (set && !set.has(w)) continue;
    } else {
      if (!daysOf(b).includes(wd)) continue;
    }
    out.push({ label: b.label, start: b.start, end: b.end });
  }
  return out;
}

function fixedOn(state, d) {
  const buf = state.rules.classBufferMin;
  const out = [];
  for (const b of fixedBlocksOn(state, d)) {
    out.push([b.start, b.end]);
    if (buf > 0) {
      out.push([Math.max(0, b.start - buf), b.start]);
      out.push([b.end, Math.min(DAY, b.end + buf)]);
    }
  }
  return out;
}

function busyOn(state, d) {
  const out = fixedOn(state, d);
  for (const p of state.placed) {
    if (p.day !== d) continue;
    out.push([p.start, p.end]);
    out.push([p.end, Math.min(DAY, p.end + state.rules.breakMin)]);
  }
  return out;
}

/** 某天的真实空闲区间（已扣课表、已排块、块后休息） */
export function freeOf(state, d) {
  const { nowDay = 0, nowMinute = 0, minTailMin } = state.rules;
  if (d < nowDay) return []; // 整天都过去了
  const wd = weekdayOf(state, d);
  const base = state.fixture.template[String(wd)] ?? [];
  let out = subtract(base, busyOn(state, d));
  if (d === nowDay && nowMinute > 0) {
    out = out.map(([a, b]) => [Math.max(a, nowMinute), b]).filter(([a, b]) => b > a);
  }
  return out.filter(([a, b]) => b - a >= minTailMin);
}

/** 只扣课表、不扣已排任务的空档 —— 用来算当天的「留白上限」 */
function rawFreeOf(state, d) {
  const wd = weekdayOf(state, d);
  const base = state.fixture.template[String(wd)] ?? [];
  return subtract(base, fixedOn(state, d)).filter(([a, b]) => b - a >= state.rules.minTailMin);
}

/** 当天已经排掉多少分钟（含块后休息） */
function placedMinutesOn(state, d) {
  return state.placed
    .filter((p) => p.day === d)
    .reduce((s, p) => s + (p.end - p.start) + state.rules.breakMin, 0);
}

/**
 * 到截止为止还能用多少分钟（A）。
 * 注意：范围可以远超排程窗口 —— 两周后交的任务，必须按两周的空档来算压力，
 * 否则会被误判成「马上就要交」。远期日期靠模板 + 固定块投影得出。
 */
export function capacity(state, task) {
  const limitDay = task.deadlineDay ?? state.fixture.horizonDays - 1;
  if (limitDay < 0) return 0;
  const limitMin = task.deadlineAt ?? DAY;
  let sum = 0;
  const last = Math.min(limitDay, state.rules.maxLookaheadDays ?? 120);
  for (let d = 0; d <= last; d++) {
    const f = d === last ? clip(freeOf(state, d), 0, limitMin) : freeOf(state, d);
    sum += total(f);
  }
  // 真正能用的只有 fillRatio 那一部分，剩下的要留白
  return Math.round(sum * (state.rules.fillRatio ?? 1));
}

/** 打分：i 重要度、u 紧急度（可行性压力）、score 合成 */
export function scoreOf(state, task) {
  const R = Math.max(0, task.remain);
  const overdue = (task.deadlineDay ?? 0) < 0;
  const A = Math.max(1, capacity(state, task));
  const p = R / A;
  const u = overdue ? 1 : 1 - Math.exp(-state.rules.lam * p);
  const i = Math.pow((task.stars - 1) / 4, 0.8);
  const base = state.rules.wImportance * i + (1 - state.rules.wImportance) * u;
  return { R, A, p, u, i, score: base, slack: A - R, overdue };
}

/**
 * 为任务找「最早的一个可放块」，找不到返回 null。
 * - mode none：整块放下，不切
 * - mode free：按 minChunk 切，受 maxChunks / maxChunksPerDay 约束
 * - mode fixed：按每段 segMin 分钟放，每段独立
 */
export function placeOneChunk(state, task) {
  const { rules, fixture } = state;
  const isHabit = task.split?.mode === 'fixed';
  const segCount = task.split?.segments ?? task.segments ?? 1;
  const segMin = task.split?.segMin ?? task.segMin ?? rules.minTailMin;
  const maxChunks = isHabit ? segCount : task.split?.maxChunks ?? rules.maxChunks;
  const perDay = task.split?.maxChunksPerDay ?? rules.maxChunksPerDay;
  const minChunk = task.split?.minChunkMin ?? rules.minChunkMin;
  const unit = isHabit ? segMin : null;

  if (task.chunks.length >= maxChunks) return null;

  // 只在排程窗口内落块；截止再远也只在未来 7 天里排
  const limitDay = Math.min(task.deadlineDay ?? fixture.horizonDays - 1, fixture.horizonDays - 1);
  if (limitDay < 0) return null; // 已经过期，不排

  for (let d = 0; d <= limitDay; d++) {
    if (task.chunks.filter((c) => c.day === d).length >= perDay) continue;

    // 当天留白：最多只用掉当天空档的 fillRatio，剩下的不碰。
    // 例外：当天还是空的时候，第一块不受限制 —— 否则「只有 1 小时空、任务正好 1 小时」
    // 这种日子会既排不上、又白留 15%，毫无意义。
    const freeMin = total(rawFreeOf(state, d));
    const usedToday = placedMinutesOn(state, d);
    let budget = usedToday === 0 ? freeMin : Math.round(freeMin * (rules.fillRatio ?? 1)) - usedToday;
    if (budget < rules.minTailMin) continue;

    for (const [s, e0] of freeOf(state, d)) {
      // 截止时刻把当天的可用区间截断，而不是整段丢弃
      let e = d === limitDay && task.deadlineAt != null ? Math.min(e0, task.deadlineAt) : e0;
      const avail = e - s;
      if (avail <= 0) continue;
      let take = isHabit ? Math.min(unit, task.remain) : Math.min(task.remain, avail);
      take = Math.min(take, budget); // 不越过当天的留白上限
      if (take < rules.minTailMin) continue;

      // 整块任务：必须一次放下全部
      if (task.split?.mode === 'none' && take < task.remain) continue;

      // 自由拆：一块至少要 minChunk，除非这就是最后一点
      if (!isHabit && take < minChunk && take < task.remain) continue;

      // 避免留下不足 minChunk 的尾巴：宁可这块少拿一点，让剩下的够一块
      const tail = task.remain - take;
      if (!isHabit && tail > 0 && tail < minChunk) {
        const alt = task.remain - minChunk;
        if (alt >= minChunk && alt <= avail) take = alt;
        else if (tail < rules.minTailMin) continue;
      }

      return { day: d, start: s, end: s + take };
    }
  }
  return null;
}

export function plan(state) {
  // 用户钉住的块先落位：它们是既定事实。放进来之后 freeOf() 自然会绕开它们，
  // 而 remain 已经在 makeState 里扣掉了这部分时长，不会重复排。
  for (const p of state.pins || []) {
    state.placed.push({ ...p, pinned: true });
  }

  let guard = 0;
  while (guard++ < 500) {
    const pending = state.tasks.filter((t) => !t.done && t.remain > 0);
    if (!pending.length) break;

    const ranked = pending
      .map((t) => {
        const s = scoreOf(state, t);
        const crisis = s.slack < 0 ? 1 : 0;
        return { t, s, crisis, key: crisis * 1000 + s.score };
      })
      .sort((a, b) => b.key - a.key);

    const pick = ranked[0];
    const chunk = placeOneChunk(state, pick.t);

    if (!chunk) {
      pick.t.stuck = true;
      pick.t.done = true;
      state.infeasible.push({
        task: pick.t,
        remain: pick.t.remain,
        overdue: pick.s.overdue === true,
        why: pick.s.overdue
          ? `已过截止，还有 ${fmtDur(pick.t.remain)} 没做`
          : `剩余 ${fmtDur(pick.t.remain)} 找不到合规空档`,
      });
      continue;
    }

    pick.t.remain -= chunk.end - chunk.start;
    pick.t.chunks.push(chunk);
    state.placed.push({ ...chunk, taskId: pick.t.id });
    state.trace.push({ task: pick.t, chunk, s: pick.s, crisis: pick.crisis });
    if (pick.t.remain <= 0) pick.t.done = true;
  }
  return state;
}
