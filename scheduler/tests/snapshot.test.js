// 输出快照：锁住「计划文本长什么样」。
// 引擎测试只验证逻辑对不对，验证不了输出有没有悄悄少东西——上次课表整段消失就是这么溜过去的。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderWeek } from '../engine/render.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../data/week6.json', import.meta.url)));
const dir = new URL('./__snapshots__/', import.meta.url);

function check(name, text) {
  const p = new URL(name + '.txt', dir);
  if (process.env.UPDATE_SNAPSHOT) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, text);
    return;
  }
  assert.ok(fs.existsSync(p), `快照 ${name}.txt 不存在，先跑 UPDATE_SNAPSHOT=1 node --test`);
  const want = fs.readFileSync(p, 'utf8');
  const a = text.split('\n');
  const b = want.split('\n');
  const i = a.findIndex((line, k) => line !== b[k]);
  if (i >= 0) {
    assert.fail(
      `输出与快照不一致，第 ${i + 1} 行：\n  现在: ${JSON.stringify(a[i]) ?? '(缺失)'}\n  快照: ${JSON.stringify(b[i]) ?? '(缺失)'}` +
        `\n\n确认是有意改动后，运行 UPDATE_SNAPSHOT=1 node --test 更新快照。`
    );
  }
}

test('学期中的周计划输出快照', () => {
  check('semester-on', renderWeek(fixture));
});

test('非学期的周计划输出快照（暑假也能用）', () => {
  check('semester-off', renderWeek({ ...fixture, semester: { ...fixture.semester, enabled: false } }));
});

test('滑杆改变后输出快照', () => {
  check('w-0.05', renderWeek(fixture, { wImportance: 0.05 }));
  check('w-0.95', renderWeek(fixture, { wImportance: 0.95 }));
});

test('课表不会静默消失：学期中每天都应有固定课', () => {
  const text = renderWeek(fixture);
  for (const day of ['周一', '周二', '周三', '周四', '周五']) {
    const block = text.split(`${day} `)[1]?.split('\n\n')[0] ?? '';
    assert.ok(/^\s{2}\d{2}:\d{2}–\d{2}:\d{2}\s{2}\s/m.test(block), `${day} 的课表整段不见了`);
  }
});
