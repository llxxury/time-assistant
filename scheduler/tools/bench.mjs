// 引擎性能体检：最坏情况（120 天跨度、多任务、大量固定占用）下 plan() 要多久。
import { makeState, plan, capacity } from '../engine/plan.js';

const tpl = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), [[480, 720], [780, 1080], [1140, 1320]]]));

function fixture({ days, tasks, fixedCount }) {
  const fixed = [];
  let day = 0;
  for (let i = 0; i < fixedCount; i++) {
    fixed.push({
      label: '课' + i,
      start: 480 + (i % 4) * 120,
      end: 480 + (i % 4) * 120 + 90,
      kind: 'once',
      date: new Date(Date.UTC(2026, 9, 26) + (i % days) * 86400000).toISOString().slice(0, 10),
    });
  }
  return {
    startDate: '2026-10-26',
    horizonDays: days,
    template: tpl,
    fixed,
    tasks: Array.from({ length: tasks }, (_, i) => ({
      id: 't' + i,
      title: '任务' + i,
      stars: (i % 5) + 1,
      estMin: 120 + (i % 6) * 60,
      doneMin: 0,
      deadlineDay: Math.min(days - 1, 2 + (i % 20)),
      deadlineAt: 1439,
      split: { mode: 'free', minChunkMin: 45, maxChunks: 6, maxChunksPerDay: 2 },
    })),
  };
}

function bench(label, cfg, iters = 5) {
  const times = [];
  let placed = 0;
  for (let i = 0; i < iters; i++) {
    const st = makeState(fixture(cfg), { spanDays: cfg.days });
    const t0 = process.hrtime.bigint();
    plan(st);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
    placed = st.placed.length;
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const max = Math.max(...times);
  console.log(`${label.padEnd(34)} 平均 ${avg.toFixed(1).padStart(7)} ms   最慢 ${max.toFixed(1).padStart(7)} ms   落块 ${placed}`);
  return avg;
}

console.log('=== plan() 耗时 ===');
bench('7 天 / 3 任务 / 0 课', { days: 7, tasks: 3, fixedCount: 0 });
bench('7 天 / 10 任务 / 10 课', { days: 7, tasks: 10, fixedCount: 10 });
bench('30 天 / 10 任务 / 40 课', { days: 30, tasks: 10, fixedCount: 40 });
bench('60 天 / 20 任务 / 60 课', { days: 60, tasks: 20, fixedCount: 60 });
bench('120 天 / 40 任务 / 120 课', { days: 120, tasks: 40, fixedCount: 120 }, 3);

console.log('\n=== capacity() 耗时（单次打分也要算）===');
{
  const cfg = { days: 120, tasks: 40, fixedCount: 120 };
  const st = makeState(fixture(cfg), { spanDays: cfg.days });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) capacity(st, st.tasks[i % st.tasks.length]);
  const t1 = process.hrtime.bigint();
  console.log(`200 次 capacity: ${(Number(t1 - t0) / 1e6).toFixed(1)} ms（每次 ${(Number(t1 - t0) / 1e6 / 200).toFixed(2)} ms）`);
}
