// 三个对抗场景：排程器最容易骗自己的地方。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, plan, scoreOf } from '../engine/plan.js';

const tpl = (intervals) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), intervals]));
const base = (template, tasks, extra = {}) => ({
  startDate: '2026-10-26',
  horizonDays: 7,
  template,
  fixed: [],
  tasks,
  ...extra,
});
const got = (t) => t.chunks.reduce((s, c) => s + (c.end - c.start), 0);

test('场景 A · 紧急陷阱：一堆明天到期的小任务不该把长期项目挤死', () => {
  const smalls = Array.from({ length: 8 }, (_, i) => ({
    id: 's' + i,
    title: '小任务' + i,
    stars: 2,
    estMin: 30,
    deadlineDay: 1,
    deadlineAt: 1439,
    split: { mode: 'free', minChunkMin: 30, maxChunks: 1, maxChunksPerDay: 1 },
  }));
  const project = {
    id: 'p',
    title: '课程设计',
    stars: 5,
    estMin: 300,
    deadlineDay: 6,
    deadlineAt: 1439,
    split: { mode: 'free', minChunkMin: 60, maxChunks: 4, maxChunksPerDay: 1 },
  };
  const st = makeState(base(tpl([[1140, 1260]]), [...smalls, project]));
  plan(st);
  const p = st.tasks.find((t) => t.id === 'p');
  assert.equal(got(p), 300, `项目只排了 ${got(p)}/300，被紧急任务饿死了`);
});

test('场景 B · 容量幻觉：装不下必须报排不下，不许假装没事', () => {
  const task = {
    id: 'big',
    title: '大作业',
    stars: 4,
    estMin: 480,
    deadlineDay: 2,
    deadlineAt: 1439,
    split: { mode: 'free', minChunkMin: 45, maxChunks: 4, maxChunksPerDay: 2 },
  };
  const st = makeState(base(tpl([[1140, 1200]]), [task])); // 每天只有 1 小时
  plan(st);
  const t = st.tasks[0];
  assert.ok(got(t) < 480, '竟然排满了，说明容量计算有问题');
  assert.equal(st.infeasible.length, 1, '缺口没有被记录为 infeasible');
});

test('场景 C · 重要度通胀：全体 5 星时应退化为按紧急度排序', () => {
  const mk = (id, day) => ({
    id,
    title: id,
    stars: 5,
    estMin: 60,
    deadlineDay: day,
    deadlineAt: 1439,
    split: { mode: 'free', minChunkMin: 60, maxChunks: 1, maxChunksPerDay: 1 },
  });
  const st = makeState(base(tpl([[1140, 1200]]), [mk('later', 6), mk('sooner', 1)]));
  plan(st);
  assert.equal(st.trace[0].task.id, 'sooner', '全部同星级时，先排的应该是更紧急的那个');
});

test('场景 D · 硬截止插队：slack 为负的任务必须最先排', () => {
  const impossible = {
    id: 'impossible',
    title: '来不及的活',
    stars: 1,
    estMin: 600,
    deadlineDay: 0,
    deadlineAt: 1200,
    split: { mode: 'free', minChunkMin: 45, maxChunks: 3, maxChunksPerDay: 3 },
  };
  const normal = {
    id: 'normal',
    title: '正常的活',
    stars: 5,
    estMin: 60,
    deadlineDay: 6,
    deadlineAt: 1439,
    split: { mode: 'free', minChunkMin: 60, maxChunks: 1, maxChunksPerDay: 1 },
  };
  const st = makeState(base(tpl([[1140, 1260]]), [normal, impossible]));
  plan(st);
  assert.equal(st.trace[0].task.id, 'impossible', '危机轮没有生效');
});

test('场景 E · 长截止：三周后的目标不该被当成紧急', () => {
  const t = {
    id: 'long',
    title: '长期目标',
    stars: 3,
    estMin: 60,
    deadlineDate: '2026-11-30',
    split: { mode: 'free', minChunkMin: 60, maxChunks: 1, maxChunksPerDay: 1 },
  };
  const st = makeState(base(tpl([[1140, 1260]]), [t]));
  const s = scoreOf(st, st.tasks[0]);
  assert.ok(s.A > 7 * 120, `容量只看了 ${s.A} 分钟，没跨过排程窗口`);
  assert.ok(s.u < 0.2, `紧急度 ${s.u.toFixed(2)} 偏高，长期目标被当成急事`);
});

test('场景 F · 过期：截止在起点之前，要明说且不占时间', () => {
  const t = {
    id: 'late',
    title: '过期的活',
    stars: 3,
    estMin: 60,
    deadlineDate: '2026-10-20',
    split: { mode: 'free', minChunkMin: 60, maxChunks: 1, maxChunksPerDay: 1 },
  };
  const st = makeState(base(tpl([[1140, 1260]]), [t]));
  plan(st);
  assert.equal(st.placed.length, 0, '过期的任务不该占用时间');
  assert.ok(st.infeasible[0]?.why.includes('已过截止'), '没有标明已过截止');
});

test('场景 G · 长截止的任务仍然只排在近 7 天内', () => {
  const t = {
    id: 'long2',
    title: '长期目标',
    stars: 5,
    estMin: 120,
    deadlineDate: '2026-12-20',
    split: { mode: 'free', minChunkMin: 60, maxChunks: 2, maxChunksPerDay: 1 },
  };
  const st = makeState(base(tpl([[1140, 1260]]), [t]));
  plan(st);
  assert.ok(st.placed.length > 0, '长期目标一个块都没排上');
  assert.ok(st.placed.every((p) => p.day <= 6), '落块跑出了排程窗口');
});

test('场景 H · 过去的时间不再安排', () => {
  const t = {
    id: 'x',
    title: '今晚的活',
    stars: 3,
    estMin: 60,
    deadlineDay: 0,
    deadlineAt: 1439,
    split: { mode: 'free', minChunkMin: 60, maxChunks: 1, maxChunksPerDay: 1 },
  };
  const st = makeState(base(tpl([[1140, 1260]]), [t]), { nowDay: 0, nowMinute: 1200 });
  plan(st);
  assert.ok(st.placed.length === 1, '应该能用到 20:00 之后那 60 分钟');
  assert.ok(
    st.placed.every((p) => !(p.day === 0 && p.start < 1200)),
    '排到了已经过去的时间'
  );
});
