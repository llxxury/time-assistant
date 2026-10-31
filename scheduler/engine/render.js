// 纯文本渲染：命令行调试与快照测试共用。
// 排版有任何非预期变化，快照测试会立刻发现。

import { makeState, plan, freeOf, parseWeeks, semesterWeekOf } from './plan.js';
import { fmtClock, fmtDur, total } from './time.js';

const W = (s) =>
  [...String(s)].reduce(
    (n, ch) => n + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1),
    0
  );
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - W(s)));

const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const DAY_MS = 86400000;

const baseWeekday = (fx) => new Date(Date.parse(fx.startDate + 'T00:00:00Z')).getUTCDay() || 7;
const wdOf = (fx, d) => ((baseWeekday(fx) - 1 + d) % 7) + 1;
const dateOf = (fx, d) =>
  new Date(Date.parse(fx.startDate + 'T00:00:00Z') + d * DAY_MS).toISOString().slice(0, 10);

/** 完整流水线：建状态 → 记排程前容量 → 排程 → 渲染 */
export function renderWeek(fixture, rules = {}) {
  const state = makeState(fixture, rules);
  const baseFree = [];
  for (let d = 0; d < fixture.horizonDays; d++) baseFree.push(total(freeOf(state, d)));
  plan(state);
  return renderPlanned(fixture, state, baseFree);
}

export function renderPlanned(fixture, state, baseFree) {
  const R = state.rules;
  const out = [''];
  const sem = fixture.semester;
  const semNote =
    sem && sem.enabled !== false
      ? `学期「${sem.label}」第 ${semesterWeekOf(state, fixture.startDate) ?? '—'} 周 / 共 ${sem.totalWeeks} 周`
      : '非学期（课表不生效）';
  out.push(`${fixture.startDate} 起 ${fixture.horizonDays} 天 · ${semNote}`);
  out.push(
    `规则  w(重要)=${R.wImportance}  λ=${R.lam}  minChunk=${R.minChunkMin}m  break=${R.breakMin}m  留白 ${Math.round((1 - (R.fillRatio ?? 1)) * 100)}%`
  );
  out.push('');

  /* 每日时间轴 */
  let grandFree = 0;
  for (let d = 0; d < fixture.horizonDays; d++) {
    const wd = wdOf(fixture, d);
    grandFree += baseFree[d];
    const rows = [];

    const date = dateOf(fixture, d);
    for (const b of fixture.fixed) {
      const kind = b.kind ?? (b.date != null ? 'once' : b.weeks != null ? 'semester' : 'weekly');
      if (kind === 'once') {
        if (b.date !== date && b.day !== d) continue;
      } else if (kind === 'semester') {
        if (!(b.weekdays ?? (b.weekday != null ? [b.weekday] : [])).includes(wd)) continue;
        const w = semesterWeekOf(state, date);
        if (w == null) continue;
        const weeks = parseWeeks(b.weeks);
        if (weeks && !weeks.has(w)) continue;
      } else if (!(b.weekdays ?? (b.weekday != null ? [b.weekday] : [])).includes(wd)) continue;
      rows.push({ s: b.start, e: b.end, label: b.label, kind: 'fixed' });
    }
    for (const p of state.placed) {
      if (p.day !== d) continue;
      const t = state.tasks.find((x) => x.id === p.taskId);
      rows.push({ s: p.start, e: p.end, label: t.title, kind: 'task' });
    }
    rows.sort((a, b) => a.s - b.s || a.e - b.e);

    out.push(`${WD[wd]} ${date.slice(5)}   可用 ${fmtDur(baseFree[d])}`);
    if (!rows.length) out.push('    （无课、无任务）');
    for (const r of rows) {
      const tag = r.kind === 'fixed' ? '  ' : '██';
      out.push(`  ${fmtClock(r.s)}–${fmtClock(r.e)} ${tag} ${r.label}`);
    }
    out.push('');
  }

  /* 决策追踪 */
  out.push('─'.repeat(52));
  out.push('决策追踪（按放置顺序）');
  out.push('');
  const byTask = new Map();
  for (const tr of state.trace) {
    if (!byTask.has(tr.task.id)) byTask.set(tr.task.id, []);
    byTask.get(tr.task.id).push(tr);
  }
  let n = 0;
  for (const [id, list] of byTask) {
    const t = state.tasks.find((x) => x.id === id);
    const s = list[0].s;
    out.push(
      `${String(++n).padStart(2)}  ${pad(t.title, 18)} 重要 ${t.stars}★(${s.i.toFixed(2)})  紧急 ${s.u.toFixed(2)}  分数 ${s.score.toFixed(3)}`
    );
    out.push(
      `    剩余 ${fmtDur(s.R)}  截止 ${dateOf(fixture, t.deadlineDay).slice(5)} ${WD[wdOf(fixture, t.deadlineDay)]} ${t.deadlineAt == null ? '日末' : fmtClock(t.deadlineAt)}` +
        `  可用余量 ${fmtDur(s.A)}  p=${s.p.toFixed(2)}  slack=${fmtDur(s.slack)}`
    );
    const slots = list.map(
      (x) => `${WD[wdOf(fixture, x.chunk.day)]} ${fmtClock(x.chunk.start)}–${fmtClock(x.chunk.end)}(${fmtDur(x.chunk.end - x.chunk.start)})`
    );
    out.push(`    → ${slots.join(' + ')}`);
    out.push('');
  }

  /* 汇总 */
  out.push('─'.repeat(52));
  const placedMin = total(state.placed.map((p) => [p.start, p.end]));
  out.push(
    `本周可用 ${fmtDur(grandFree)}   已排 ${fmtDur(placedMin)}   利用率 ${((placedMin / grandFree) * 100).toFixed(0)}%`
  );
  for (const t of state.tasks) {
    const got = t.chunks.reduce((a, c) => a + (c.end - c.start), 0);
    const st = got >= t.estMin ? '✓' : t.stuck ? '✖' : '…';
    out.push(`  ${st} ${pad(t.title, 18)} ${fmtDur(got)} / ${fmtDur(t.estMin)}   分 ${t.chunks.length} 块`);
  }
  for (const f of state.infeasible) out.push(`  ✖ ${f.task.title}：${f.why}`);
  out.push('');
  return out.join('\n');
}
