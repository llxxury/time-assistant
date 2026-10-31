// 版本号必须是单一来源：version.js 说了算，package.json 跟着它走。
// 这条测试防的是「发版时改了 App 版本，忘了改 package.json」以及反过来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION, VERSION_CODE } from '../version.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('版本号：version.js 与 package.json 一致', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, `VERSION 应该是 x.y.z，现在是 ${VERSION}`);
  assert.equal(pkg.version, VERSION, 'package.json 的 version 和 version.js 不一致');
});

test('版本号：versionCode 是正整数，且随版本递增', () => {
  assert.ok(Number.isInteger(VERSION_CODE) && VERSION_CODE > 0, `VERSION_CODE 不合法：${VERSION_CODE}`);
  // 发版时 versionCode 必须 +1，这里只保证它至少是 9（当前已发布的最低值）
  assert.ok(VERSION_CODE >= 9, 'versionCode 不能比已经发出去的包小，否则装不上');
});
