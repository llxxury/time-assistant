// 跨周滚动：起点必须跟着今天走，而且历史记录不能跟着错位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { rollStart, addDays, daysBetween } from '../web/roll.js';
import { makeState, plan, fixedBlocksOn, dateOf } from '../engine/plan.js';

const tpl = (intervals) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), intervals]));

test('滚动：同一天里调用是空操作', () => {
  const store = { startDate: '2026-10-26', log: [], pending: [], lastPlan: [] };
  assert.equal(rollStart(store, '2026-10-26'), 0);
  assert.equal(store.startDate, '2026-10-26');
});

test('滚动：老记录只有相对 day，滚动后补出绝对 date 并重算 day', () => {
  const store = {
    startDate: '2026-10-26',
    log: [
      { taskId: 't1', day: 0, start: 930, end: 1050, kind: 'done' },
      { taskId: 't2', day: 3, start: 600, end: 660, kind: 'done' },
    ],
    pending: [{ taskId: 't1', day: 5, start: 1140, end: 1200, key: 't1|5|1140' }],
    lastPlan: [{ taskId: 't1', day: 5, start: 1140, end: 1200 }],
  };
  assert.equal(rollStart(store, '2026-11-05'), 10);

  assert.equal(store.startDate, '2026-11-05');
  assert.equal(store.log[0].date, '2026-10-26');
  assert.equal(store.log[0].day, -10);
  assert.equal(store.log[1].date, '2026-10-29');
  assert.equal(store.log[1].day, -7);
  assert.equal(store.pending[0].date, '2026-10-31');
  assert.equal(store.pending[0].day, -5);
  // key 里含 day，必须跟着改，否则打勾后删不掉这条待处理
  assert.equal(store.pending[0].key, 't1|-5|1140');
});

test('滚动：幂等，且已经在场的 date 不会被改掉', () => {
  const store = {
    startDate: '2026-10-26',
    log: [{ taskId: 't1', day: 0, start: 930, end: 1050, kind: 'done' }],
    pending: [],
    lastPlan: [],
  };
  rollStart(store, '2026-11-05');
  rollStart(store, '2026-11-05');
  assert.equal(store.log[0].day, -10, '同一天里连滚两次，历史被挪了两次');
  assert.equal(store.log[0].date, '2026-10-26');

  rollStart(store, '2026-11-06');
  assert.equal(store.log[0].day, -11);
  assert.equal(store.log[0].date, '2026-10-26', '绝对日期不该随滚动漂移');
});

test('滚动：系统时间被拨回去时不倒滚', () => {
  const store = {
    startDate: '2026-11-05',
    log: [{ taskId: 't1', day: 0, date: '2026-11-05', start: 930, end: 1050, kind: 'done' }],
    pending: [],
    lastPlan: [],
  };
  assert.equal(rollStart(store, '2026-10-26'), 0);
  assert.equal(store.startDate, '2026-11-05');
  assert.equal(store.log[0].day, 0);
});

test('滚动：一周后仍然排得出块，且不撞固定占用', () => {
  // 起点 10-26，今天是 11-05（第 10 天）——按旧逻辑这里整个窗口都在过去，一块也排不出
  const store = {
    startDate: '2026-10-26',
    horizonDays: 7,
    template: tpl([[480, 720], [780, 1080], [1140, 1320]]),
    fixed: [{ kind: 'weekly', label: '例会', weekdays: [1, 3, 5], start: 1140, end: 1200 }],
    tasks: [
      {
        id: 'a',
        title: '课程论文',
        stars: 4,
        estMin: 120,
        deadlineDate: '2026-11-30',
        deadlineAt: 1439,
        split: { mode: 'free', minChunkMin: 45, maxChunks: 3, maxChunksPerDay: 2 },
      },
    ],
    log: [],
    pending: [],
    lastPlan: [],
  };

  rollStart(store, '2026-11-05');
  const st = makeState(store, { nowDay: 0, nowMinute: 0 });
  plan(st);

  assert.equal(dateOf(st, 0), '2026-11-05', '滚动后第 0 天必须是今天');
  assert.ok(st.placed.length > 0, '滚动后一块也排不出来');
  assert.equal(st.infeasible.length, 0, `不该有任务被判排不下：${st.infeasible.map((x) => x.why).join('；')}`);

  const buf = st.rules.classBufferMin;
  for (const p of st.placed) {
    assert.ok(p.day >= 0 && p.day < store.horizonDays, `块落在了窗口外：day=${p.day}`);
    for (const b of fixedBlocksOn(st, p.day)) {
      assert.ok(
        p.end <= b.start - buf || p.start >= b.end + buf,
        `${dateOf(st, p.day)} ${p.start}-${p.end} 撞上了「${b.label}」${b.start}-${b.end}`
      );
    }
  }
});

test('日期加减：跨月、跨年都对', () => {
  assert.equal(addDays('2026-10-26', 10), '2026-11-05');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-10-26', '2026-11-05'), 10);
  assert.equal(daysBetween('2026-11-05', '2026-10-26'), -10);
});
