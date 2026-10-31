'use strict';
// Minimal, dependency-free Android APK assembler:
//  - binary AndroidManifest.xml (AXML)
//  - resources.arsc with a single mipmap entry (launcher icon)
//  - zip container with 4-byte aligned stored resources.arsc / icon
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ utils */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

class W {
  constructor() { this.parts = []; this.len = 0; }
  raw(b) { this.parts.push(b); this.len += b.length; return this; }
  u8(v) { const b = Buffer.alloc(1); b[0] = v & 0xff; return this.raw(b); }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); return this.raw(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return this.raw(b); }
  pad(align, base) {
    const cur = (this.len + (base || 0)) % align;
    if (cur !== 0) this.raw(Buffer.alloc(align - cur));
    return this;
  }
  bytes() { return Buffer.concat(this.parts, this.len); }
}

/* ------------------------------------------------- string pool (utf-16) */
// UTF-16 pools avoid any ambiguity about the varint prefix encoding and are
// what aapt writes for most tables.
function poolString(s) {
  const len = s.length;
  const body = Buffer.alloc((len + 2) * 2);   // u16 length + chars + u16 NUL
  body.writeUInt16LE(len, 0);
  for (let i = 0; i < len; i++) body.writeUInt16LE(s.charCodeAt(i), 2 + i * 2);
  return body;
}

class StringPool {
  constructor(strings) {
    this.strings = strings.slice();
    this.index = new Map();
    this.strings.forEach((s, i) => { if (!this.index.has(s)) this.index.set(s, i); });
    const chunks = strings.map(poolString);
    let off = 0;
    this.offsets = chunks.map((c) => { const o = off; off += c.length; return o; });
    this.data = Buffer.concat(chunks);
    this.count = strings.length;
  }
  idx(s) {
    if (s === null || s === undefined) return 0xffffffff;
    if (!this.index.has(s)) throw new Error('string not in pool: ' + s);
    return this.index.get(s);
  }
  build() {
    const headerSize = 0x1c;
    const stringsStart = headerSize + 4 * this.count;
    const data = Buffer.concat([this.data, Buffer.alloc((4 - (this.data.length % 4)) % 4)]);
    const size = stringsStart + data.length;
    const w = new W();
    w.u16(0x0001).u16(headerSize).u32(size);
    w.u32(this.count).u32(0).u32(0x00000000).u32(stringsStart).u32(0); // flags: UTF-16, unsorted
    this.offsets.forEach((o) => w.u32(o));
    w.raw(data);
    return w.bytes();
  }
}

/* ------------------------------------------------------------- AXML build */
// attr: { ns:'android'|null, name, type, data, raw }
// type: 'string' | 'int' | 'bool' | 'ref'
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const ATTR = {
  theme: 0x01010000,
  label: 0x01010001,
  icon: 0x01010002,
  name: 0x01010003,
  permission: 0x01010006,
  exported: 0x01010010,
  launchMode: 0x0101001d,
  screenOrientation: 0x0101001e,
  configChanges: 0x0101001f,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
  maxSdkVersion: 0x01010271,
  windowSoftInputMode: 0x0101022b,
  drawable: 0x01010199,
  allowBackup: 0x01010280,
  authorities: 0x01010018,
  grantUriPermissions: 0x0101001b,
  largeHeap: 0x0101035a,
  debuggable: 0x0101000f,
  usesCleartextTraffic: 0x010104ec,
};

function buildAxml(root) {
  // collect strings
  const strings = [];
  const seen = new Set();
  const add = (s) => { if (s !== null && s !== undefined && !seen.has(s)) { seen.add(s); strings.push(s); } };
  const attrNames = [];
  add('android'); add(ANDROID_NS);
  const walk = (n) => {
    add(n.tag);
    (n.attrs || []).forEach((a) => {
      add(a.name);
      if (a.ns === 'android' && !attrNames.includes(a.name)) attrNames.push(a.name);
      if (a.raw) add(a.raw);
      if (a.type === 'string') add(a.data);
    });
    (n.children || []).forEach(walk);
  };
  walk(root);

  const pool = new StringPool(strings);
  const resMap = new Array(strings.length).fill(0);
  attrNames.forEach((n) => {
    const id = ATTR[n];
    if (!id) throw new Error('unknown framework attr: ' + n);
    resMap[pool.idx(n)] = id;
  });

  const nodes = new W();
  const node = (type, headerSize, body) => {
    const w = new W();
    w.u16(type).u16(headerSize).u32(headerSize + body.len);
    w.u32(1).u32(0xffffffff);   // lineNumber, comment
    w.raw(body.bytes());
    return w.bytes();
  };

  // start namespace
  nodes.raw(node(0x0100, 16, new W().u32(pool.idx('android')).u32(pool.idx(ANDROID_NS))));

  const emit = (n) => {
    const body = new W();
    body.u32(pool.idx(null)).u32(pool.idx(n.tag)); // ns, name
    const attrs = n.attrs || [];
    body.u16(20).u16(20).u16(attrs.length).u16(0).u16(0).u16(0);
    // note: attributeStart is relative to the attrExt struct (after the 16-byte node header)
    attrs.forEach((a) => {
      const nsIdx = a.ns === 'android' ? pool.idx(ANDROID_NS) : 0xffffffff;
      body.u32(nsIdx).u32(pool.idx(a.name));
      let rawIdx = 0xffffffff, dt, data;
      if (a.type === 'string') { rawIdx = pool.idx(a.data); dt = 0x03; data = pool.idx(a.data); }
      else if (a.type === 'int') { dt = 0x10; data = a.data; }
      else if (a.type === 'bool') { dt = 0x12; data = a.data ? 0xffffffff : 0; }
      else if (a.type === 'ref') { rawIdx = a.raw ? pool.idx(a.raw) : 0xffffffff; dt = 0x01; data = a.data; }
      else throw new Error('bad attr type ' + a.type);
      body.u32(rawIdx).u16(8).u8(0).u8(dt).u32(data);
    });
    nodes.raw(node(0x0102, 16, body));
    (n.children || []).forEach(emit);
    nodes.raw(node(0x0103, 16, new W().u32(pool.idx(null)).u32(pool.idx(n.tag))));
  };
  emit(root);
  nodes.raw(node(0x0101, 16, new W().u32(pool.idx('android')).u32(pool.idx(ANDROID_NS))));

  // resource map chunk
  const rmBody = new W();
  resMap.forEach((id) => rmBody.u32(id));
  const rm = Buffer.concat([Buffer.from([0x80, 0x01, 0x08, 0x00]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(8 + rmBody.len, 0); return b; })(), rmBody.bytes()]);

  const poolBytes = pool.build();
  const total = 8 + poolBytes.length + rm.length + nodes.len;
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0); head.writeUInt16LE(8, 2); head.writeUInt32LE(total, 4);
  return Buffer.concat([head, poolBytes, rm, nodes.bytes()]);
}

/* ------------------------------------------------------------- ARSC build */
// One package, one type ("mipmap"), N entries, and several configuration
// variants of that type (default + anydpi-v26 for the adaptive icon).
function configBytes(sdk, density) {
  const b = Buffer.alloc(64);
  b.writeUInt32LE(64, 0);        // size
  b.writeUInt16LE(density || 0, 18);   // orientation(16) touchscreen(17) density(18)
  b.writeUInt16LE(sdk || 0, 28);       // sdkVersion
  return b;
}

function buildArsc(pkgName, typeName, entries, variants) {
  // global value pool: every file path referenced by an entry
  const paths = [];
  variants.forEach((v) => v.files.forEach((f) => { if (f && !paths.includes(f)) paths.push(f); }));
  const vpool = new StringPool(paths);
  const pathIdx = (p) => paths.indexOf(p);

  const typePool = new StringPool([typeName]);
  const keyPool = new StringPool(entries);
  const typePoolBytes = typePool.build();
  const keyPoolBytes = keyPool.build();

  const entryCount = entries.length;
  const spec = new W();
  spec.u16(0x0202).u16(16).u32(16 + 4 * entryCount);
  spec.u8(1).u8(0).u16(0).u32(entryCount);
  for (let i = 0; i < entryCount; i++) spec.u32(0);   // no config flags
  const specBytes = spec.bytes();

  const typeChunks = variants.map((v) => {
    const configSize = 64;
    const headerSize = 20 + configSize;              // 84
    const entriesStart = headerSize + 4 * entryCount;
    const body = new W();
    let cursor = 0;
    const offsets = [];
    const values = [];
    for (let i = 0; i < entryCount; i++) {
      const file = v.files[i];
      if (!file) { offsets.push(0xffffffff); continue; }
      offsets.push(cursor);
      const e = new W();
      e.u16(8).u16(0).u32(i);                        // ResTable_entry: size, flags, key
      e.u16(8).u8(0).u8(0x03).u32(pathIdx(file));    // Res_value: TYPE_STRING -> path
      const eb = e.bytes();
      values.push(eb);
      cursor += eb.length;
    }
    const total = entriesStart + cursor;
    body.u16(0x0201).u16(headerSize).u32(total);
    body.u8(1).u8(0).u16(0).u32(entryCount).u32(entriesStart);
    body.raw(v.config);
    offsets.forEach((o) => body.u32(o));
    values.forEach((b) => body.raw(b));
    return body.bytes();
  });

  const pkgHeaderSize = 0x011c;
  const pkgBody = new W();
  pkgBody.u32(0x7f);
  const nameBuf = Buffer.alloc(256);
  Buffer.from(pkgName, 'utf8').copy(nameBuf, 0);
  pkgBody.raw(nameBuf);
  const typeStringsOff = pkgHeaderSize;
  const keyStringsOff = pkgHeaderSize + typePoolBytes.length;
  pkgBody.u32(typeStringsOff).u32(1).u32(keyStringsOff).u32(entries.length);
  // ResChunk_header(8) + ResTable_package body(276) == pkgHeaderSize(284);
  // the package header therefore embeds the id/name/offsets block.
  const pkgLen = 8 + pkgBody.len + typePoolBytes.length + keyPoolBytes.length
      + specBytes.length + typeChunks.reduce((a, b) => a + b.length, 0);
  const chunkHead = Buffer.alloc(8);
  chunkHead.writeUInt16LE(0x0200, 0);
  chunkHead.writeUInt16LE(pkgHeaderSize, 2);
  chunkHead.writeUInt32LE(pkgLen, 4);
  const pkg = Buffer.concat([chunkHead, pkgBody.bytes(), typePoolBytes, keyPoolBytes, specBytes, ...typeChunks]);

  const vpoolBytes = vpool.build();
  const tableHeaderSize = 12;
  const head = Buffer.alloc(tableHeaderSize);
  head.writeUInt16LE(0x0002, 0);
  head.writeUInt16LE(tableHeaderSize, 2);
  head.writeUInt32LE(tableHeaderSize + vpoolBytes.length + pkg.length, 4);
  head.writeUInt32LE(1, 8);
  return Buffer.concat([head, vpoolBytes, pkg]);
}

/* --------------------------------------------------------------- zip build */
function buildZip(entries) {
  // entries: [{name, data, method:0|8, align:4|0}]
  const locals = [];
  const centrals = [];
  let offset = 0;
  entries.forEach((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    let stored = e.data;
    let method = e.method;
    if (method === 8) stored = zlib.deflateRawSync(e.data, { level: 9 });
    let extra = Buffer.alloc(0);
    const align = e.align || 0;
    if (align) {
      // data offset must be a multiple of `align`: pad the extra field (a valid
      // TLV: id 0x0000, length k) so that absolute offset lines up
      const base = offset + 30 + nameBuf.length;
      const k = (align - ((base + 4) % align) + align) % align;
      extra = Buffer.alloc(4 + k);
      extra.writeUInt16LE(0x0000, 0);
      extra.writeUInt16LE(k, 2);
    }
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);   // 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    const local = Buffer.concat([lh, nameBuf, extra, stored]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0014, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    const central = Buffer.concat([ch, nameBuf]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}


/* ------------------------------------------------------------------- main */
const ROOT = path.resolve(__dirname, '..');
const PKG = 'ai.cosmos.timeassistant';
const ICON_RES = 0x7f010000;
const FG_RES = 0x7f010001;
const BG_RES = 0x7f010002;

const RES = {
  icon: 'res/mipmap/ic_launcher.png',
  fg: 'res/mipmap/ic_launcher_foreground.png',
  bg: 'res/mipmap/ic_launcher_background.png',
  iconXml: 'res/mipmap/ic_launcher.xml',
};

const AT = (name, v, raw) => {
  if (typeof v === 'number') {
    if (raw) return { ns: 'android', name, type: 'ref', data: v, raw };
    return { ns: 'android', name, type: 'int', data: v };
  }
  if (typeof v === 'boolean') return { ns: 'android', name, type: 'bool', data: v };
  return { ns: 'android', name, type: 'string', data: v };
};

const perm = (name) => ({ tag: 'uses-permission', attrs: [AT('name', name)] });

// 版本号唯一来源是 scheduler/version.js，这里读文本即可（它是 ES 模块，CJS 不能直接 require）
const VERSION_SRC = fs.readFileSync(path.join(ROOT, 'scheduler/version.js'), 'utf8');
const VER_NAME = (VERSION_SRC.match(/VERSION\s*=\s*'([^']+)'/) || [])[1];
const VER_CODE = Number((VERSION_SRC.match(/VERSION_CODE\s*=\s*(\d+)/) || [])[1]);
if (!VER_NAME || !Number.isFinite(VER_CODE)) {
  throw new Error('读不到 scheduler/version.js 里的 VERSION / VERSION_CODE');
}

const manifest = {
  tag: 'manifest',
  attrs: [
    { ns: null, name: 'package', type: 'string', data: PKG },
    AT('versionCode', VER_CODE),
    AT('versionName', VER_NAME),
  ],
  children: [
    { tag: 'uses-sdk', attrs: [AT('minSdkVersion', 26), AT('targetSdkVersion', 34)] },
    perm('android.permission.POST_NOTIFICATIONS'),
    perm('android.permission.SCHEDULE_EXACT_ALARM'),
    perm('android.permission.USE_EXACT_ALARM'),
    perm('android.permission.VIBRATE'), // 通知震动和直接震动都要它，少了会静默失败
  perm('android.permission.RECEIVE_BOOT_COMPLETED'),
    perm('android.permission.WAKE_LOCK'),
    // 调试壳要能从电脑的 dev server 加载界面；正式包是纯本地的，不申请网络权限
    ...(process.env.TA_DEV ? [perm('android.permission.INTERNET')] : []),
    {
      tag: 'application',
      attrs: [
        AT('label', 'time-assistant'),
        AT('icon', ICON_RES, '@mipmap/ic_launcher'),
        AT('allowBackup', true),
        AT('largeHeap', true),
        // 自测包：TA_DEBUG=1 node pack.js 打出来的包能用 run-as 读写 app 数据（真机上灌旧数据测跨周）
        ...(process.env.TA_DEBUG ? [AT('debuggable', true)] : []),
        // 调试壳：TA_DEV=1 时允许明文 http，好从电脑 dev server 取页面（adb reverse 8090）
        ...(process.env.TA_DEV ? [AT('usesCleartextTraffic', true)] : []),
      ],
      children: [
        {
          tag: 'activity',
          attrs: [
            AT('name', '.MainActivity'),
            AT('exported', true),
            AT('launchMode', 1),
            AT('configChanges', 0x000007a0),
            AT('windowSoftInputMode', 0x00000010),
          ],
          children: [
            {
              tag: 'intent-filter',
              attrs: [],
              children: [
                { tag: 'action', attrs: [AT('name', 'android.intent.action.MAIN')] },
                { tag: 'category', attrs: [AT('name', 'android.intent.category.LAUNCHER')] },
              ],
            },
          ],
        },
        { tag: 'receiver', attrs: [AT('name', '.AlarmReceiver'), AT('exported', false)] },
        {
          tag: 'receiver',
          attrs: [AT('name', '.BootReceiver'), AT('exported', true)],
          children: [
            {
              tag: 'intent-filter',
              attrs: [],
              children: [
                { tag: 'action', attrs: [AT('name', 'android.intent.action.BOOT_COMPLETED')] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const iconXmlSrc = {
  tag: 'adaptive-icon',
  attrs: [],
  children: [
    { tag: 'background', attrs: [AT('drawable', BG_RES, '@mipmap/ic_launcher_background')] },
    { tag: 'foreground', attrs: [AT('drawable', FG_RES, '@mipmap/ic_launcher_foreground')] },
  ],
};

const axml = buildAxml(manifest);
const iconXml = buildAxml(iconXmlSrc);
const arsc = buildArsc(
  PKG,
  'mipmap',
  ['ic_launcher', 'ic_launcher_foreground', 'ic_launcher_background'],
  [{ config: configBytes(0, 0), files: [RES.iconXml, RES.fg, RES.bg] }]
);

const dexPath = path.join(ROOT, 'apk/build/classes.dex');
fs.mkdirSync(path.join(ROOT, 'apk/build/out'), { recursive: true });

const readApk = (rel) => fs.readFileSync(path.join(ROOT, 'apk', rel));

/* 网页资源：只放运行时真正用到的文件 */
const ASSETS = [
  ['assets/web/index.html', 'scheduler/web/index.html'],
  ['assets/web/app.js', 'scheduler/web/app.js'],
  ['assets/web/roll.js', 'scheduler/web/roll.js'],
  ['assets/web/skin-exam.css', 'scheduler/web/skin-exam.css'],
  ['assets/web/skin-glass.css', 'scheduler/web/skin-glass.css'],
  ['assets/web/skin-dark.css', 'scheduler/web/skin-dark.css'],
  ['assets/version.js', 'scheduler/version.js'],
  ['assets/web/style.css', 'scheduler/web/style.css'],
  ['assets/engine/plan.js', 'scheduler/engine/plan.js'],
  ['assets/engine/time.js', 'scheduler/engine/time.js'],
  ['assets/data/seed.js', 'scheduler/data/seed.js'],
  ['assets/web/fonts/inter-400.woff2', 'scheduler/web/fonts/inter-400.woff2'],
  ['assets/web/fonts/inter-500.woff2', 'scheduler/web/fonts/inter-500.woff2'],
  ['assets/web/fonts/inter-600.woff2', 'scheduler/web/fonts/inter-600.woff2'],
  ['assets/web/fonts/inter-700.woff2', 'scheduler/web/fonts/inter-700.woff2'],
];

const entries = [
  { name: 'AndroidManifest.xml', data: axml, method: 8 },
  { name: 'classes.dex', data: fs.readFileSync(dexPath), method: 8 },
  { name: 'resources.arsc', data: arsc, method: 0, align: 4 },
  { name: RES.fg, data: readApk(RES.fg), method: 0, align: 4 },
  { name: RES.bg, data: readApk(RES.bg), method: 0, align: 4 },
  { name: RES.iconXml, data: iconXml, method: 8, align: 4 },
];
for (const [dest, src] of ASSETS) {
  entries.push({ name: dest, data: fs.readFileSync(path.join(ROOT, src)), method: 8 });
}

const apk = buildZip(entries);
const outPath = path.join(ROOT, 'apk/build/out/scheduler-unsigned.apk');
fs.writeFileSync(outPath, apk);
console.log('assets    :', ASSETS.length);
console.log('dex       :', fs.statSync(dexPath).size, 'bytes');
console.log('apk       :', apk.length, 'bytes ->', outPath);
