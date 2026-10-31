// 钉住的块（pin）：用户手动改过的计划，重排时必须被当成既定事实。
// 这是「计划可编辑」的地基——没有它，用户改完 5 分钟后就被算回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, plan, freeOf, dateOf } from '../engine/plan.js';

const tpl = (intervals) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), intervals]));
const base = (tasks, extra = {}) => ({
  startDate: '2026-10-26',
  horizonDays: 7,
  template: tpl([[480, 720], [780, 1080], [1140, 1320]]),
  fixed: [],
  tasks,
  ...extra,
});
const task = (over = {}) => ({
  id: 't1',
  title: '论文',
  stars: 4,
  estMin: 180,
  doneMin: 0,
  deadlineDay: 6,
  deadlineAt: 1439,
  split: { mode: 'free', minChunkMin: 45, maxChunks: 4, maxChunksPerDay: 2 },
  ...over,
});
const overlap = (a, b) => a.start < b.end && b.start < a.end;

test('pin：钉住的块一定出现在计划里，并带 pinned 标记', () => {
  const st = makeState(base([task()], { pins: [{ taskId: 't1', day: 1, start: 540, end: 660 }] }));
  plan(st);
  const pin = st.placed.find((p) => p.pinned);
  assert.ok(pin, '钉住的块没进 placed');
  assert.equal(pin.day, 1);
  assert.equal(pin.start, 540);
  assert.equal(pin.end, 660);
});

test('pin：钉住的时长会从剩余量里扣掉，不会重复排', () => {
  // 任务 180 分钟，钉了 120 分钟，剩下只该排 60
  const st = makeState(base([task()], { pins: [{ taskId: 't1', day: 1, start: 540, end: 660 }] }));
  plan(st);
  const t = st.tasks.find((x) => x.id === 't1');
  assert.equal(t.remain, 0, '剩余量应该已经扣完');
  const total = st.placed.filter((p) => p.taskId === 't1').reduce((s, p) => s + (p.end - p.start), 0);
  assert.equal(total, 180, `总排入时长应为 180，实际 ${total}`);
});

test('pin：其余任务不会排到钉住的时间上', () => {
  const st = makeState(
    base([task({ id: 't1' }), task({ id: 't2', estMin: 120, deadlineDay: 3 })], {
      pins: [{ taskId: 't1', day: 0, start: 780, end: 1080 }],
    })
  );
  plan(st);
  const pin = st.placed.find((p) => p.pinned);
  for (const p of st.placed) {
    if (p === pin) continue;
    assert.ok(!overlap(pin, p), `排到了钉住的区间上：day=${p.day} ${p.start}-${p.end}`);
  }
});

test('pin：空的当天空档会扣掉钉住的块', () => {
  const st = makeState(base([task()], { pins: [{ taskId: 't1', day: 0, start: 480, end: 720 }] }));
  plan(st);
  const free = freeOf(st, 0);
  for (const [a, b] of free) {
    assert.ok(b <= 480 || a >= 720, `空档 ${a}-${b} 和钉住的块重叠了`);
  }
});

test('pin：非法数据被丢弃，不会污染排程', () => {
  const bad = [
    { taskId: 't1', day: -1, start: 480, end: 600 },
    { taskId: 't1', day: 9, start: 480, end: 600 },
    { taskId: 't1', day: 0, start: 600, end: 600 },
    { taskId: 't1', day: 0, start: 900, end: 600 },
    { taskId: 't1', day: 'x', start: 480, end: 600 },
    null,
  ];
  const st = makeState(base([task()], { pins: bad }));
  assert.equal(st.pins.length, 0, '非法 pin 应该被全部丢掉');
  plan(st);
  assert.equal(st.placed.filter((p) => p.pinned).length, 0);
});

test('pin：没有 pin 时行为完全不变（回归）', () => {
  const a = makeState(base([task()]));
  plan(a);
  const b = makeState(base([task()], { pins: [] }));
  plan(b);
  assert.deepEqual(
    a.placed.map((p) => [p.day, p.start, p.end]),
    b.placed.map((p) => [p.day, p.start, p.end])
  );
});

test('pin：钉一整天的那一天，其余任务自动去别的天', () => {
  const st = makeState(
    base([task({ id: 't1' }), task({ id: 't2', estMin: 60, deadlineDay: 2 })], {
      pins: [
        { taskId: 't1', day: 0, start: 480, end: 720 },
        { taskId: 't1', day: 0, start: 780, end: 1020 },
        { taskId: 't1', day: 0, start: 1140, end: 1380 },
      ],
    })
  );
  plan(st);
  const t2 = st.placed.filter((p) => p.taskId === 't2');
  assert.ok(t2.length > 0, 't2 应该被排到别的天');
  for (const p of t2) assert.notEqual(p.day, 0, 't2 不该排到被钉满的那天');
});

// ---- 「有多少排多少」：超过 7 天的任务也要被排进来 ----
test('跨度：80 小时的任务会排到第 7 天之后', () => {
  // 模板每天约 12h，按 0.85 留白约 10h/天；80h 塞不进 7 天，必须往后排
  const big = task({
    estMin: 4800,
    deadlineDay: 20,
    split: { mode: 'free', minChunkMin: 45, maxChunks: 40, maxChunksPerDay: 3 },
  });
  const st = makeState({ ...base([big]), pins: [] }, { spanDays: 21 });
  plan(st);
  assert.ok(st.placed.length >= 8, `应该排出 8 块以上，实际 ${st.placed.length}`);
  const maxDay = Math.max(...st.placed.map((p) => p.day));
  assert.ok(maxDay >= 7, `块应该排到第 7 天之后，实际最大 day=${maxDay}`);
});

test('跨度：不传 spanDays 时退化为 7 天（老行为不变）', () => {
  const st = makeState({ ...base([task({ estMin: 2400, deadlineDay: 20 })]), pins: [] });
  plan(st);
  const maxDay = Math.max(...st.placed.map((p) => p.day));
  assert.ok(maxDay <= 6, `没给跨度时应限制在 7 天内，实际 ${maxDay}`);
});