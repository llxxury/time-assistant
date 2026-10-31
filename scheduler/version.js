// 版本号的唯一来源。改版本只改这里：
//   app.js 通过 import 拿到（诊断报告用）
//   apk/pack.js 用正则读同一份文件（写进 AndroidManifest 的 versionName / versionCode）
//   scheduler/package.json 的 version 必须和 VERSION 一致（有测试守着）
// 别再在别处写死版本号。
export const VERSION = '1.0.0';
export const VERSION_CODE = 10;
