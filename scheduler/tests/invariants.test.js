// 排程不变式：这些断言比任何截图都可靠。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeState, plan, parseWeeks, freeOf } from '../engine/plan.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../data/week6.json', import.meta.url)));
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];

const MS_DAY = 86400000;
const startWd =
  new Date(Date.parse(fixture.startDate + 'T00:00:00Z')).getUTCDay() || 7; // 0=周日 → 7
const wdOf = (d) => ((startWd - 1 + d) % 7) + 1;
const dateOf = (d) => new Date(Date.parse(fixture.startDate + 'T00:00:00Z') + d * MS_DAY).toISOString().slice(0, 10);

function semWeek(dateStr) {
  const s = fixture.semester;
  if (!s || s.enabled === false) return null;
  const w =
    Math.floor(
      (Date.parse(dateStr + 'T00:00:00Z') - Date.parse(s.startDate + 'T00:00:00Z')) / (7 * MS_DAY)
    ) + 1;
  return w >= 1 && w <= s.totalWeeks ? w : null;
}

function appliesOn(b, d) {
  const kind = b.kind ?? (b.date != null ? 'once' : b.weeks != null ? 'semester' : 'weekly');
  if (kind === 'once') return b.date === dateOf(d) || b.day === d;
  const days = b.weekdays ?? (b.weekday != null ? [b.weekday] : []);
  if (!days.includes(wdOf(d))) return false;
  if (kind === 'weekly') return true;
  const w = semWeek(dateOf(d));
  if (w == null) return false;
  const set = parseWeeks(b.weeks);
  return !set || set.has(w);
}

test('任务块绝不与固定占用（含前后缓冲）重叠', () => {
  const st = makeState(fixture);
  plan(st);
  const buf = st.rules.classBufferMin;
  for (const p of st.placed) {
    for (const b of fixture.fixed) {
      if (!appliesOn(b, p.day)) continue;
      const zone = [b.start - buf, b.end + buf];
      assert.ok(
        !overlap([p.start, p.end], zone),
        `块 ${p.taskId} ${p.start}-${p.end} 撞上「${b.label}」缓冲区 ${zone[0]}-${zone[1]}`
      );
    }
  }
});

test('任务块之间不重叠，且保留足够休息', () => {
  const st = makeState(fixture);
  plan(st);
  const byDay = new Map();
  for (const p of st.placed) {
    if (!byDay.has(p.day)) byDay.set(p.day, []);
    byDay.get(p.day).push(p);
  }
  for (const [d, list] of byDay) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      assert.ok(
        list[i].start >= list[i - 1].end + st.rules.breakMin,
        `第 ${d} 天两块之间休息不足`
      );
    }
  }
});

test('每个自由拆块都不小于 minChunk（尾块不少于 minTail）', () => {
  const st = makeState(fixture);
  plan(st);
  for (const t of st.tasks) {
    if (t.split?.mode !== 'free') continue;
    const min = t.split.minChunkMin ?? st.rules.minChunkMin;
    t.chunks.forEach((c, i) => {
      const len = c.end - c.start;
      const isLast = i === t.chunks.length - 1;
      if (!isLast) assert.ok(len >= min, `${t.title} 第 ${i + 1} 块 ${len}m < ${min}m`);
      else assert.ok(len >= st.rules.minTailMin, `${t.title} 尾块 ${len}m 过短`);
    });
  }
});

test('能排下的必须排满，排不下的必须出现在 infeasible 里', () => {
  const st = makeState(fixture);
  plan(st);
  for (const t of st.tasks) {
    const got = t.chunks.reduce((s, c) => s + (c.end - c.start), 0);
    if (got < t.estMin) {
      assert.ok(
        st.infeasible.some((f) => f.task.id === t.id),
        `${t.title} 只排了 ${got}/${t.estMin}，却没被记录为排不下`
      );
    }
  }
});

test('学期关闭时，学期类占用整体消失（暑假也能用）', () => {
  const on = makeState(fixture);
  const off = makeState({ ...fixture, semester: { ...fixture.semester, enabled: false } });

  const dayOn = freeOf(on, 0); // 周一，学期内
  const dayOff = freeOf(off, 0); // 同一天，学期关闭

  const longest = (list) => Math.max(0, ...list.map(([a, b]) => b - a));
  assert.ok(longest(dayOn) <= 150, '开学时周一白天被课切碎，不该有长时间空档');
  assert.ok(longest(dayOff) > 200, '学期关闭后白天应出现大段空闲，说明课表没失效');
});

test('每天排掉的量不超过留白上限', () => {
  const st = makeState(fixture);
  plan(st);
  const { rules } = st;
  for (let d = 0; d < fixture.horizonDays; d++) {
    const wd = ((startWd - 1 + d) % 7) + 1;
    const tpl = fixture.template[String(wd)] ?? [];
    // 当天空档（模板 − 固定占用，含缓冲）
    const fixed = fixture.fixed
      .filter((b) => {
        const kind = b.kind ?? (b.date != null ? 'once' : b.weeks != null ? 'semester' : 'weekly');
        if (kind === 'once') return b.date === dateOf(d) || b.day === d;
        if (b.weekday !== wd) return false;
        if (kind === 'weekly') return true;
        const w = semWeek(dateOf(d));
        if (w == null) return false;
        const set = parseWeeks(b.weeks);
        return !set || set.has(w);
      })
      .flatMap((b) => [
        [b.start - rules.classBufferMin, b.end + rules.classBufferMin],
      ]);
    const freeMin = tpl.reduce((s, [a, b]) => s + (b - a), 0) -
      fixed.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, 1440) - Math.max(a, 0)), 0);
    const cap = Math.round(freeMin * rules.fillRatio);
    const used = st.placed
      .filter((p) => p.day === d)
      .reduce((s, p) => s + (p.end - p.start), 0);
    const biggest = Math.max(0, ...st.placed.filter((p) => p.day === d).map((p) => p.end - p.start));
    assert.ok(
      used <= Math.max(cap, biggest),
      `第 ${d} 天排了 ${used} 分钟，超过留白上限 ${cap}（最大单块 ${biggest}）`
    );
  }
});
