// 引擎核心规则：排序、危机轮、留白、缓冲、拆分、不可行。
// 这些是 App 的"心脏"，改任何一行都必须先在这里证明行为没变坏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, plan, freeOf, capacity, scoreOf, fixedBlocksOn, parseWeeks, dateOf, semesterWeekOf } from '../engine/plan.js';

const tpl = (segs) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), segs]));
const DAY_SEGS = [[480, 720], [780, 1080], [1140, 1320]]; // 08-12 / 13-18 / 19-22

const base = (tasks, extra = {}) => ({
  startDate: '2026-10-26', // 周一
  horizonDays: 7,
  template: tpl(DAY_SEGS),
  fixed: [],
  tasks,
  ...extra,
});

const task = (over = {}) => ({
  id: 't1',
  title: '作业',
  stars: 3,
  estMin: 120,
  doneMin: 0,
  deadlineDay: 3,
  deadlineAt: 1439,
  split: { mode: 'free', minChunkMin: 45, maxChunks: 4, maxChunksPerDay: 2 },
  ...over,
});

const overlap = (a, b) => a.start < b.end && b.start < a.end;
const placedOf = (st, id) => st.placed.filter((p) => p.taskId === id);

/* ---------------- 同一天内不重叠、不越界 ---------------- */

test('不变量：所有落块互不重叠，且都在当天 0–1440 之内', () => {
  const st = makeState(
    base([
      task({ id: 'a', estMin: 300, deadlineDay: 4 }),
      task({ id: 'b', estMin: 240, deadlineDay: 2 }),
      task({ id: 'c', estMin: 180, deadlineDay: 6 }),
    ])
  );
  plan(st);
  const byDay = {};
  for (const p of st.placed) {
    assert.ok(p.start >= 0 && p.end <= 1440, `越界: ${p.start}-${p.end}`);
    assert.ok(p.end > p.start, '块长必须为正');
    (byDay[p.day] ||= []).push(p);
  }
  for (const [d, list] of Object.entries(byDay)) {
    list.sort((x, y) => x.start - y.start);
    for (let i = 1; i < list.length; i++) {
      assert.ok(!overlap(list[i - 1], list[i]), `day ${d} 出现重叠: ${list[i - 1].start}-${list[i - 1].end} / ${list[i].start}-${list[i].end}`);
    }
  }
});

test('不变量：块不会落在课表上，也不会落在课表缓冲里', () => {
  const st = makeState(
    base([task({ id: 'a', estMin: 600, deadlineDay: 6 })], {
      fixed: [{ label: '体育', weekday: 1, start: 600, end: 660 }], // 周一 10:00-11:00
    })
  );
  plan(st);
  const buf = 10;
  for (const p of st.placed) {
    if (p.day !== 0) continue;
    assert.ok(p.end <= 600 - buf || p.start >= 660 + buf, `撞上了课表缓冲: ${p.start}-${p.end}`);
  }
  // 缓冲区的确被留出来了
  const free = freeOf(st, 0);
  for (const [a, b] of free) assert.ok(b <= 590 || a >= 670, `空档 ${a}-${b} 侵入了缓冲`);
});

/* ---------------- 截止日 ---------------- */

test('任务不会被排到截止日之后', () => {
  const st = makeState(base([task({ id: 'a', estMin: 300, deadlineDay: 1 })]));
  plan(st);
  for (const p of st.placed) assert.ok(p.day <= 1, `排到了第 ${p.day} 天（截止第 1 天）`);
});

test('排不下的任务进 infeasible，并带上剩余量', () => {
  const st = makeState(base([task({ id: 'a', estMin: 4000, deadlineDay: 0 })]));
  plan(st);
  const f = st.infeasible.find((x) => x.task.id === 'a');
  assert.ok(f, '应该被标记为排不下');
  assert.ok(f.remain > 0, '应该还有剩余量');
  assert.equal(f.overdue, false);
});

test('截止日已过 → infeasible 且 overdue=true', () => {
  const st = makeState(base([task({ id: 'a', estMin: 120, deadlineDay: -2 })]));
  plan(st);
  const f = st.infeasible.find((x) => x.task.id === 'a');
  assert.ok(f?.overdue, '应该标成已过期');
  assert.equal(st.placed.length, 0, '过期任务不该落任何块');
});

/* ---------------- 留白 fillRatio ---------------- */

test('留白：单天用量不超过空档的 fillRatio（第一块例外）', () => {
  const st = makeState(base([task({ id: 'a', estMin: 900, deadlineDay: 0, split: { mode: 'free', minChunkMin: 45, maxChunks: 8, maxChunksPerDay: 8 } })]));
  plan(st);
  const day0 = placedOf(st, 'a').filter((p) => p.day === 0);
  const used = day0.reduce((s, p) => s + (p.end - p.start), 0);
  const raw = DAY_SEGS.reduce((s, [a, b]) => s + (b - a), 0); // 720 分钟
  assert.ok(used <= raw * 0.85 + 1, `当天用了 ${used} 分钟，超过留白上限 ${Math.round(raw * 0.85)}`);
});

test('留白：fillRatio=1 时能用满，0.5 时用得更少', () => {
  const mk = (ratio) => {
    const st = makeState(
      base([task({ id: 'a', estMin: 720, deadlineDay: 0, split: { mode: 'free', minChunkMin: 45, maxChunks: 8, maxChunksPerDay: 8 } })]),
      { fillRatio: ratio }
    );
    plan(st);
    return placedOf(st, 'a').filter((p) => p.day === 0).reduce((s, p) => s + (p.end - p.start), 0);
  };
  const half = mk(0.5);
  const full = mk(1);
  assert.ok(half < full, `0.5 应该比 1 用得少：${half} vs ${full}`);
});

/* ---------------- 拆分模式 ---------------- */

test('拆分 none：只排一块，且不超过剩余量', () => {
  const st = makeState(base([task({ id: 'a', estMin: 200, deadlineDay: 5, split: { mode: 'none' } })]));
  plan(st);
  const list = placedOf(st, 'a');
  assert.equal(list.length, 1);
  assert.ok(list[0].end - list[0].start <= 200);
});

test('拆分 fixed：块数不超过次数，每块不超过单次分钟', () => {
  const st = makeState(
    base([task({ id: 'a', estMin: 180, deadlineDay: 6, split: { mode: 'fixed', chunkMin: 30, chunks: 3 } })])
  );
  plan(st);
  const list = placedOf(st, 'a');
  assert.ok(list.length <= 3, `块数应该 ≤3，实际 ${list.length}`);
  for (const p of list) assert.ok(p.end - p.start <= 30, `单块 ${p.end - p.start} 分钟，超过 30`);
});

test('拆分 free：块数不超过 maxChunks，且不低于 minChunkMin（除尾块）', () => {
  const st = makeState(
    base([task({ id: 'a', estMin: 400, deadlineDay: 6, split: { mode: 'free', minChunkMin: 60, maxChunks: 3, maxChunksPerDay: 2 } })])
  );
  plan(st);
  const list = placedOf(st, 'a');
  assert.ok(list.length <= 3, `块数应该 ≤3，实际 ${list.length}`);
  const lens = list.map((p) => p.end - p.start).sort((x, y) => x - y);
  // 除最短的那块（可能是尾块）外，都不应低于 minChunkMin
  for (const len of lens.slice(1)) assert.ok(len >= 60, `块长 ${len} 低于 minChunkMin`);
});

test('拆分 free：maxChunksPerDay 限制每天块数', () => {
  const st = makeState(
    base([task({ id: 'a', estMin: 900, deadlineDay: 6, split: { mode: 'free', minChunkMin: 45, maxChunks: 9, maxChunksPerDay: 2 } })])
  );
  plan(st);
  const perDay = {};
  for (const p of placedOf(st, 'a')) perDay[p.day] = (perDay[p.day] || 0) + 1;
  for (const [d, n] of Object.entries(perDay)) assert.ok(n <= 2, `第 ${d} 天排了 ${n} 块`);
});

/* ---------------- 排序 ---------------- */

test('排序：更紧急（截止更近）的任务先落块', () => {
  const st = makeState(
    base([
      task({ id: 'later', estMin: 180, deadlineDay: 6, split: { mode: 'none' } }),
      task({ id: 'sooner', estMin: 180, deadlineDay: 0, split: { mode: 'none' } }),
    ])
  );
  plan(st);
  const first = st.placed[0];
  assert.equal(first.taskId, 'sooner', '更紧急的应该先排');
});

test('排序：同样截止，星级高的先排', () => {
  const st = makeState(
    base([
      task({ id: 'low', stars: 1, estMin: 180, deadlineDay: 3, split: { mode: 'none' } }),
      task({ id: 'high', stars: 5, estMin: 180, deadlineDay: 3, split: { mode: 'none' } }),
    ])
  );
  plan(st);
  assert.equal(st.placed[0].taskId, 'high');
});

test('scoreOf：星级越高分越高，余量越紧分越高', () => {
  const st = makeState(
    base([
      task({ id: 'a', stars: 1, estMin: 60, deadlineDay: 6 }),
      task({ id: 'b', stars: 5, estMin: 60, deadlineDay: 6 }),
      task({ id: 'c', stars: 3, estMin: 300, deadlineDay: 1 }),
    ])
  );
  const A = st.tasks.find((t) => t.id === 'a');
  const B = st.tasks.find((t) => t.id === 'b');
  const C = st.tasks.find((t) => t.id === 'c');
  assert.ok(scoreOf(st, B).score > scoreOf(st, A).score, '星级高的分应更高');
  assert.ok(scoreOf(st, C).score > scoreOf(st, A).score, '余量紧的分应更高');
});

/* ---------------- 危机轮 ---------------- */

test('危机轮：可用时间小于剩余量时，即使星级低也最先排', () => {
  // 只有一天、只有 08-12 一个空档（240 分钟），两件任务都要 200 分钟
  // 同样抢同一天的空档：urgent 400 分钟 > 当天 240 分钟（危机），relaxed 只要 200 分钟且五星
  const st = makeState({
    ...base([
      task({
        id: 'urgent',
        stars: 1,
        estMin: 400,
        deadlineDay: 0,
        split: { mode: 'free', minChunkMin: 45, maxChunks: 4, maxChunksPerDay: 2 },
      }),
      task({ id: 'relaxed', stars: 5, estMin: 200, deadlineDay: 0, split: { mode: 'none' } }),
    ]),
    template: tpl([[480, 720]]),
    horizonDays: 1,
  });
  plan(st);
  assert.equal(st.placed[0].taskId, 'urgent', '危机任务应该抢在高手星任务前面');
  // 危机任务吃掉了当天空档，relaxed 应该排不下
  assert.ok(
    st.infeasible.some((f) => f.task.id === 'relaxed'),
    'relaxed 应该因为空间被抢而排不下'
  );
});

/* ---------------- 容量与空档 ---------------- */

test('capacity：已排的块会减少当天可用容量', () => {
  const st = makeState(base([task({ id: 'a', estMin: 200, deadlineDay: 0 })]));
  const before = capacity(st, st.tasks[0]);
  plan(st);
  const after = capacity(st, st.tasks[0]);
  assert.ok(after < before, `排完块后容量应该变少：${before} → ${after}`);
});

test('freeOf：今天之前的整天返回空', () => {
  const st = makeState(base([task({ id: 'a', estMin: 60, deadlineDay: 3 })]), { nowDay: 2 });
  assert.deepEqual(freeOf(st, 1), [], '过去的天不该有空档');
  assert.ok(freeOf(st, 2).length > 0, '今天应该有');
});

test('freeOf：今天已过去的部分被裁掉', () => {
  const st = makeState(base([task({ id: 'a', estMin: 60, deadlineDay: 3 })]), { nowDay: 0, nowMinute: 800 });
  for (const [a] of freeOf(st, 0)) assert.ok(a >= 800, `空档不该早于 13:20（800 分），出现 ${a}`);
});

/* ---------------- 课表规则 ---------------- */

test('fixedBlocksOn：学期课只在指定周生效', () => {
  const fx = base([]);
  fx.semester = { enabled: true, startDate: '2026-10-26', totalWeeks: 16 };
  fx.fixed = [{ label: '高数', weekday: 1, start: 480, end: 600, kind: 'semester', weeks: '1-2' }];
  const st = makeState(fx);
  assert.equal(fixedBlocksOn(st, 0).length, 1, '第 1 周周一应该上课');
  assert.equal(fixedBlocksOn(st, 7).length, 1, '第 2 周周一应该上课');
  assert.equal(fixedBlocksOn(st, 14).length, 0, '第 3 周不该有');
});

test('fixedBlocksOn：一次性占用只在那一天生效', () => {
  const fx = base([]);
  fx.fixed = [{ label: '班会', start: 600, end: 660, kind: 'once', date: '2026-10-28' }];
  const st = makeState(fx);
  assert.equal(fixedBlocksOn(st, 2).length, 1, '10-28 是第 3 天');
  assert.equal(fixedBlocksOn(st, 3).length, 0);
});

test('学期开关关掉时，不产生任何固定占用', () => {
  const fx = base([]);
  fx.semester = { enabled: false, startDate: '2026-10-26', totalWeeks: 16 };
  fx.fixed = [{ label: '高数', weekday: 1, start: 480, end: 600, kind: 'semester', weeks: '1-16' }];
  const st = makeState(fx);
  assert.equal(fixedBlocksOn(st, 0).length, 0);
});

test('parseWeeks：单双周与区间', () => {
  assert.deepEqual([...parseWeeks('1-3')], [1, 2, 3]);
  assert.deepEqual([...parseWeeks('2-6/双')], [2, 4, 6]);
  assert.deepEqual([...parseWeeks('1-6/单')], [1, 3, 5]);
  assert.deepEqual(parseWeeks(''), null);
});

test('dateOf / semesterWeekOf：日期与周次换算', () => {
  const fx = base([]);
  fx.semester = { enabled: true, startDate: '2026-10-26', totalWeeks: 16 };
  const st = makeState(fx);
  assert.equal(dateOf(st, 0), '2026-10-26');
  assert.equal(dateOf(st, 7), '2026-11-02');
  assert.equal(semesterWeekOf(st, '2026-10-26'), 1);
  assert.equal(semesterWeekOf(st, '2026-11-02'), 2);
  assert.equal(semesterWeekOf(st, '2027-06-01'), null, '超出学期应返回 null');
});

/* ---------------- 完成量 ---------------- */

test('doneMin：已完成的部分不会再被排', () => {
  const st = makeState(base([task({ id: 'a', estMin: 180, doneMin: 120, deadlineDay: 5, split: { mode: 'none' } })]));
  plan(st);
  const total = placedOf(st, 'a').reduce((s, p) => s + (p.end - p.start), 0);
  assert.ok(total <= 60, `只剩 60 分钟可排，实际排了 ${total}`);
});

test('已全部完成的任务不产生任何块', () => {
  const st = makeState(base([task({ id: 'a', estMin: 120, doneMin: 120 })]));
  plan(st);
  assert.equal(st.placed.length, 0);
});
