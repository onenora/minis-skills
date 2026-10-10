#!/usr/bin/env node
/**
 * legado-sim.js — Legado(阅读) 书源通用验证器
 *
 * 用法:
 *   node legado-sim.js <书源.json>                       # 默认端到端: 搜索"测试"→详情→目录→正文
 *   node legado-sim.js <书源.json> --search 凡人修仙传     # 指定关键词
 *   node legado-sim.js <书源.json> --search X --book 2    # 验证第3本书
 *   node legado-sim.js <书源.json> --search X --chapter 5 # 验证第6章正文
 *   node legado-sim.js <书源.json> --page 2               # 搜索翻页
 *   node legado-sim.js <书源.json> --only search          # 只跑指定环节: search|detail|toc|content
 *   node legado-sim.js <书源.json> --timeout 20           # 请求超时(秒)
 *
 * 特性:
 *   - 通用规则引擎: <js> / @js: / JSONPath($.a.b[0]) / 模板{{}} / @get: @post: / 纯URL
 *   - 光遇式 data:;base64,<b64>,{params} data URL 自动识别
 *   - jsLib 顶层函数/变量自动挂到全局对象(模拟 Rhino)
 *   - cookie jar 用 curl -b/-c 文件持久化
 *   - URL 只编码非 ASCII 字符, 不二次编码已编码部分
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const srcFile = argv.find(a => !a.startsWith('--'));
if (!srcFile || !fs.existsSync(srcFile)) {
  console.error('用法: node legado-sim.js <书源.json> [--search 词] [--book N] [--chapter N] [--page N] [--only search|detail|toc|content] [--timeout 秒]');
  process.exit(1);
}

const KEY = arg('search', '测试');
const PAGE = parseInt(arg('page', '1'), 10) || 1;
const BOOK_N = parseInt(arg('book', '0'), 10) || 0;
const CHAPTER_N = parseInt(arg('chapter', '0'), 10) || 0;
const ONLY = arg('only', '');
const TIMEOUT = parseInt(arg('timeout', '15'), 10) || 15;
const DEVICE = arg('device', 'sim-android-0001');
const JAR = path.join(require('os').tmpdir(), `legado-sim-cookies-${process.pid}.txt`);
try { fs.unlinkSync(JAR); } catch (e) {}
process.on('exit', () => { try { fs.unlinkSync(JAR); } catch (e) {} });

// ---------------- 书源加载 ----------------
let raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
const src = Array.isArray(raw) ? raw[0] : raw;
const SRC_NAME = src.bookSourceName || srcFile;
console.log(`\n=== Legado 书源验证器 ===`);
console.log(`书源: ${SRC_NAME}`);
console.log(`分组: ${src.bookSourceGroup || '-'} | URL: ${src.bookSourceUrl || '-'}`);
console.log(`关键词: "${KEY}" | 页码: ${PAGE} | 书序: #${BOOK_N} | 章序: #${CHAPTER_N} | 设备: ${DEVICE}\n`);

// ---------------- 环境 stub ----------------
const store = {};          // java.put / java.get
const srcVar = {};         // source 变量
let lastReq = null;        // 最近请求信息
let reqCount = 0;
const stats = { search: 0, detail: 0, toc: 0, content: 0 };

const java = {
  base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
  base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
  hexEncode: (s) => Buffer.from(String(s), 'utf8').toString('hex'),
  hexDecodeToString: (h) => Buffer.from(String(h), 'hex').toString('utf8'),
  ajax: (...a) => httpReq(...a),
  put: (k, v) => { store[k] = v; },
  get: (k) => store[k],
  remove: (k) => { delete store[k]; },
  androidId: () => DEVICE,
  deviceID: () => { throw new Error('deviceID unavailable (android sim)'); },
  log: () => {}, toast: () => {}, longToast: () => {},
  random: Math.random, floor: Math.floor, ceil: Math.ceil,
  getWebViewUA: () => 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  getAppVariable: () => '', setAppVariable: () => {},
  startBrowser: () => {}, startBrowserAwait: () => ({ body: () => '' })
};

const cookie = {
  getCookie: (d) => jarGet(d) || '',
  setCookie: (d, v) => jarSet(d, v),
  removeCookie: (d) => { try { fs.rmSync(JAR); } catch (e) {} },
  getCookieJar: () => ({})
};

const source = {
  getVariable: () => JSON.stringify(srcVar),
  setVariable: (v) => { try { Object.assign(srcVar, JSON.parse(v)); } catch (e) {} },
  getLoginInfo: () => '{}',
  getLoginInfoMap: () => ({}),
  loginUi: () => {},
  getBookSource: () => src
};

const book = {
  type: 0, durChapterIndex: 0, durChapterTitle: '', name: '', author: '', coverUrl: '', intro: '',
  getVariable: () => '', setVariable: () => {}, get: () => {}, put: () => {},
  setUseReplaceRule: () => {}, imageStyle: 'TEXT', order: 0
};

// 模拟 Rhino: java/source/cookie/book 注入全局对象(jsLib 函数用 this 解构)
Object.assign(globalThis, { java, source, cookie, book });

// ---------------- cookie jar (curl 文件) ----------------
function jarGet() { return ''; }
function jarSet(d, v) {
  // 简单落盘: domain cookie=value
  try { fs.appendFileSync(JAR, `${d}\t${v}\n`); } catch (e) {}
}

// 相对路径拼接书源域名
function fullUrl(u) {
  if (/^https?:\/\//.test(u) || u.startsWith('data:')) return u;
  if (u.startsWith('/')) return (src.bookSourceUrl || '').replace(/\/+$/, '') + u;
  return u;
}

// ---------------- HTTP 请求 (java.ajax) ----------------
function httpReq(u, opts) {
  reqCount++;
  // 形式1: ajax("url,{jsonOptions}") — 光遇式; 形式2: ajax(url, {method,headers,body}); 形式3: ajax(url, "POST")
  let url = String(u), method = 'GET', headers = {}, body = null;
  if (typeof opts === 'string') { method = opts.toUpperCase(); }
  else if (opts && typeof opts === 'object') {
    method = (opts.method || 'GET').toUpperCase();
    headers = opts.headers || {};
    body = opts.body !== undefined && opts.body !== null ? String(opts.body) : null;
  } else if (typeof u === 'string' && u.includes(',{')) {
    // 字符串内嵌 options: 从后往前找 ",{" 尝试解析
    let idx = u.length;
    while ((idx = u.lastIndexOf(',{', idx - 1)) >= 0) {
      try {
        const o = JSON.parse(u.slice(idx + 1));
        if (o && typeof o === 'object' && (o.method || o.headers || o.body !== undefined)) {
          url = u.slice(0, idx); method = (o.method || 'GET').toUpperCase();
          headers = o.headers || {}; body = o.body !== undefined && o.body !== null ? String(o.body) : null;
          break;
        }
      } catch (e) {}
    }
  }
  lastReq = { url, method, headers, body };
  // data URL 直接解码返回(光遇式机制)
  if (url.startsWith('data:')) return decodeDataUrl(url);

  const args = ['-sL', '--compressed', '-m', String(TIMEOUT), '-b', JAR, '-c', JAR];
  const ua = headers['User-Agent'] || headers['user-agent'] || java.getWebViewUA();
  args.push('-H', 'User-Agent: ' + ua);
  for (const [k, v] of Object.entries(headers)) {
    if (!/user-agent/i.test(k)) args.push('-H', `${k}: ${v}`);
  }
  if (body && method !== 'GET' && method !== 'HEAD') args.push('-d', body);
  if (method !== 'GET') args.push('-X', method);
  // 只编码非 ASCII(避免二次编码)
  args.push(url.replace(/[^\x00-\x7F]/g, (c) => encodeURIComponent(c)));
  const cmd = 'curl ' + args.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: (TIMEOUT + 5) * 1000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.stdout) return String(e.stdout); // 部分响应(如 4xx body)
    throw new Error('HTTP 请求失败: ' + e.message.slice(0, 600));
  }
}

// data:;base64,<b64>,{params} → 返回 hex(模拟 Legado data URL result 形态)
function decodeDataUrl(u) {
  const rest = u.slice('data:;base64,'.length);
  const comma = rest.indexOf(',');
  const b64 = comma >= 0 ? rest.slice(0, comma) : rest;
  try { return Buffer.from(b64, 'base64').toString('hex'); }
  catch (e) { return ''; }
}

// ---------------- 规则引擎 ----------------
function splitRule(rule) {
  const s = String(rule);
  const m = s.match(/^<js>\n?(.*?)\n?<\/js>(.*)$/s);
  if (m) return { js: m[1], suffix: m[2] };
  const m2 = s.match(/^@(js|get|post|put|delete|header|cookie):\n?(.*)$/s);
  if (m2) return { prefix: m2[1], body: m2[2], suffix: '' };  return { plain: s };
}

// 把规则脚本最后一行表达式转为 return(模拟 Rhino evaluateString 完成值)
function lastExprReturn(js) {
  const lines = js.trim().split('\n');
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0) return js;
  lines[i] = 'return ' + lines[i];
  return lines.join('\n');
}

// 提取 jsLib 顶层(顶格声明) function/let/const 名, 生成挂载代码
function buildGlue(jsLib) {
  const names = [];
  const re = /^(?:function\s+([A-Za-z_$][\w$]*)|(?:let|const|var)\s+([A-Za-z_$][\w$]*))/gm;
  let m;
  while ((m = re.exec(jsLib))) names.push(m[1] || m[2]);
  const uniq = [...new Set(names)].filter(Boolean);
  return uniq.map(n => `this.${n} = ${n};`).join('\n');
}

// 执行规则 JS(Rhino 语义: 全局对象注入 + 完成值返回)
function execJs(ruleJs, env) {
  const sp = splitRule(ruleJs);
  const js = sp.js !== undefined ? sp.js : (sp.prefix === 'js' ? sp.body : (sp.plain || ''));
  const ctx = { java, source, cookie, book, result: '', baseUrl: '', chapter: {},
    key: KEY, page: PAGE, searchKey: KEY, tag: '', ...env };
  const lib = (src.jsLib || '');
  const code = lib + '\n' + buildGlue(lib) + '\n(function(){ ' + lastExprReturn(js) + '\n})()';
  try {
    const v = new Function('ctx', 'code', 'with(ctx){ return eval(code); }').call(ctx, ctx, code);
    return v;
  } catch (e) {
    if (process.env.SIM_DEBUG) console.log('  [execJs ERROR]', e.message);
    throw e;
  }
}

// JSONPath 提取: $.a.b[0].c / a[0].b / $.a[*] / $.a||$.b
function extractPath(data, pathStr) {
  if (pathStr === undefined || pathStr === null || pathStr === '') return data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { return undefined; }
  }
  let p = String(pathStr).trim().replace(/^\$\.?/, '');
  if (!p) return data;
  // || 或逻辑: 逐个尝试
  const alts = p.split('||').map(x => x.trim()).filter(Boolean);
  if (alts.length > 1) {
    for (const alt of alts) {
      const r = extractPath(data, '$.' + alt);
      if (r !== undefined && r !== null && !(Array.isArray(r) && r.length === 0)) return r;
    }
    return undefined;
  }
  p = alts[0];
  // [*] 通配: 返回该数组本身
  if (p.includes('[*]')) {
    const before = p.split('[*]')[0].replace(/\.$/, '');
    const arr = extractPath(data, '$.' + before);
    return Array.isArray(arr) ? arr : undefined;
  }
  let cur = data;
  const tokens = p.split(/\.|\[|\]/).filter(t => t !== '' && t !== "'" && t !== '"');
  for (const t of tokens) {
    const key = t.replace(/^['"]|['"]$/g, '');
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (/^\d+$/.test(key)) cur = cur[parseInt(key, 10)];
      else cur = cur.map(x => (x || {})[key]);
    } else if (typeof cur === 'object') cur = cur[key];
    else return undefined;
  }
  return cur;
}

// ---------------- HTML / CSS 规则 (Legado 风格) ----------------
// 支持: @css:选择器@提取##正则 / class.x@tag.li / id.x@html##re / || or / !N 跳过
function evalHtmlRule(rule, htmlText) {
  let cheerio;
  try { cheerio = require('cheerio'); }
  catch (e) { throw new Error('HTML/CSS 规则需要 cheerio: npm install cheerio（全局安装时设置 NODE_PATH）'); }
  const $ = cheerio.load(String(htmlText || ''));
  const hashIdx = rule.indexOf('##');
  const head = hashIdx >= 0 ? rule.slice(0, hashIdx) : rule;
  const regexPart = hashIdx >= 0 ? rule.slice(hashIdx + 2) : '';
  const candidates = head.split('||');
  let result = null;
  for (const cand of candidates) {
    const r = evalHtmlOne(cand.trim(), $);
    if (r !== null && r !== undefined && r !== '' && !(Array.isArray(r) && r.length === 0)) {
      result = r; break;
    }
  }
  // ## 正则替换: pattern|replacement
  if (regexPart && result !== null && result !== undefined) {
    const parts = regexPart.split('|');
    try {
      const re = new RegExp(parts[0], 'g');
      result = String(result).replace(re, parts.length > 1 ? parts[1] : '');
    } catch (e) {}
  }
  return result;
}

function evalHtmlOne(cand, $) {
  // !N 跳过前 N 个
  let skip = 0;
  const bang = cand.match(/!(\d+)$/);
  if (bang) { skip = parseInt(bang[1], 10); cand = cand.slice(0, bang.index); }
  let sel = cand, extract = '';
  if (cand.startsWith('@css:')) {
    sel = cand.slice(5);
    const at = sel.lastIndexOf('@');
    if (at > 0 && /^(text|textNodes|ownText|html|href|src|all|tag\..+|attr\..+)$/.test(sel.slice(at + 1))) {
      extract = sel.slice(at + 1); sel = sel.slice(0, at);
    }
  } else {
    const at = cand.lastIndexOf('@');
    if (at > 0) {
      const after = cand.slice(at + 1);
      if (/^(text|textNodes|ownText|html|href|src|all|tag\..+|attr\..+)$/.test(after)) {
        sel = cand.slice(0, at); extract = after;
      }
    }
  }
  sel = sel.trim();
  if (sel.startsWith('class.')) sel = sel.replace(/^class\./, '.');
  else if (sel.startsWith('id.')) sel = sel.replace(/^id\./, '#');
  else if (sel.startsWith('tag.')) sel = sel.slice(4);
  let nodes;
  try { nodes = $(sel).toArray(); } catch (e) { return ''; }
  nodes = nodes.slice(skip);
  if (!nodes.length) return '';
  const values = nodes.map(node => {
    const el = $(node);
    switch (extract) {
      case 'text': case 'textNodes': return el.text();
      case 'ownText': return el.clone().children().remove().end().text();
      case 'html': return el.html() || '';
      case 'href': return el.attr('href') || '';
      case 'src': return el.attr('src') || '';
      case 'all': return $.html(node) || '';
      default:
        if (extract.startsWith('tag.')) return el.find(extract.slice(4)).toArray().map(n => $(n).text());
        if (extract.startsWith('attr.')) return el.attr(extract.slice(5)) || '';
        return $.html(node) || '';
    }
  });
  if (values.length === 1) return values[0];
  return values;
}

// 模板 {{...}} 渲染(支持 $.path 与 java.xxx 表达式)
function renderTemplate(str, env) {
  if (!String(str).includes('{{')) return str;
  const ctx = { java, source, cookie, book, key: KEY, page: PAGE, ...env };
  return String(str).replace(/\{\{(.*?)\}\}/g, (_, expr) => {
    try {
      const fn = new Function('ctx', 'with(ctx){ return (' + expr + '); }');
      const v = fn(ctx);
      return v === undefined || v === null ? '' : String(v);
    } catch (e) { return ''; }
  });
}

// 完整规则求值: 返回 { value, raw, isList }
function evalRule(rule, env, depth = 0) {
  // 模板预处理(URL/字符串规则)后统一走各分支
  const s = renderTemplate(String(rule).trim(), env);
  if (!s) return { value: '', raw: '' };
  const parts = splitRule(s);

  // 1. JS 规则
  if (parts.js !== undefined) {
    const v = execJs(s, env);
    return { value: v, raw: v };
  }
  // 2. @js:
  if (parts.prefix === 'js') {
    const v = execJs('@js:' + parts.body, env);
    return { value: v, raw: v };
  }
  // 3. @get/@post/@put/@delete: URL[提取器]
  if (['get', 'post', 'put', 'delete'].includes(parts.prefix)) {
    const url = fullUrl(parts.body.trim().split(/\s+/)[0]);
    const resp = httpReq(url, parts.prefix.toUpperCase());
    return { value: resp, raw: resp, http: true };
  }
  // 4. @header/@cookie: 透传文本
  if (parts.prefix === 'header' || parts.prefix === 'cookie') {
    return { value: parts.body.trim(), raw: parts.body.trim() };
  }
  // 5. HTML/CSS 规则(Legado 风格)
  if (/^@css:/.test(s) || /^(class\.|id\.|tag\.)/.test(s) || (s.includes('##') && s.includes('@') && !s.startsWith('@js'))) {
    const htmlText = typeof env.result === 'string' ? env.result : String(env.result || '');
    const v = evalHtmlRule(s, htmlText);
    return { value: v, raw: v, html: true };
  }
  // 6. 纯 JSONPath(对 env.result 提取)
  if (/^\$\.?/.test(s) || /^\[?\d/.test(s)) {
    return { value: extractPath(env.result, s), raw: s };
  }
  // 7. data URL / http URL / 路径 → 请求
  if (/^data:/.test(s)) {
    return { value: decodeDataUrl(s), raw: decodeDataUrl(s) };
  }
  if (/^https?:\/\//.test(s) || s.startsWith('/')) {
    const resp = httpReq(fullUrl(s), 'GET');
    return { value: resp, raw: resp, http: true };
  }
  // 8. 普通文本
  return { value: s, raw: s };
}

// 规则(可能带提取后缀)执行: "<js>...</js>$.data" / "@get:url$.data"
function applyRule(rule, env) {
  const s = String(rule).trim();
  const m = s.match(/^(<js>\n?.*?\n?<\/js>|@js:.*?|@(?:get|post|put|delete):.*?)(\$\..*)?$/s);
  if (m) {
    const main = m[1], suffix = m[2] || '';
    const r = evalRule(main, env);
    if (suffix) return extractPath(r.value, suffix);
    return r.value;
  }
  return evalRule(s, env).value;
}

// ---------------- 报告 ----------------
function ok(label, msg) { console.log(`  ✅ ${label}${msg ? ' — ' + msg : ''}`); }
function fail(label, err) { console.log(`  ❌ ${label} — ${String(err && err.message || err).slice(0, 160)}`); }
function brief(v, n = 80) {
  if (v === undefined || v === null) return String(v);
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------------- 端到端流程 ----------------
async function run() {
  const only = ONLY;
  // ========== 1. 搜索 ==========
  if (!only || only === 'search') {
    console.log('── 1. 搜索 ─────────────────────────');
    if (!src.searchUrl) { console.log('  (无 searchUrl, 跳过)'); stats.search = -1; }
    else {
      try {
        const env0 = { result: '' };
        const url = applyRule(src.searchUrl, env0);
        let resp;
        if (typeof url === 'string' && url.startsWith('data:')) resp = decodeDataUrl(url);
        else if (typeof url === 'string') resp = httpReq(fullUrl(url), 'GET');
        else resp = String(url);
        stats.search = reqCount;
        const list = applyRule(src.ruleSearch.bookList || '', { result: resp });
        const arr = Array.isArray(list) ? list : (list && typeof list === 'object' ? Object.values(list) : []);
        console.log(`  命中 ${arr.length} 条`);
        if (!arr.length) { console.log('  ⚠️ 搜索结果为空'); }
        else {
          arr.slice(0, 5).forEach((b, i) => {
            const nm = (b && (b.book_name || b.name || b.title)) || '';
            const au = (b && (b.author || '')) || '';
            console.log(`   #${i} ${nm} | ${au}`);
          });
          // ========== 2. 详情 ==========
          const bk = arr[BOOK_N] || arr[0];
          if (!only || only === 'detail') {
            console.log('── 2. 详情 ─────────────────────────');
            try {
              const bookUrlRule = src.ruleSearch.bookUrl;
              let detailSrc = bk;
              if (bookUrlRule) {
                const burl = applyRule(bookUrlRule, { result: bk });
                if (typeof burl === 'string' && burl.startsWith('data:')) detailSrc = decodeDataUrl(burl);
                else if (typeof burl === 'string' && /^https?:/.test(burl)) detailSrc = httpReq(burl, 'GET');
                else detailSrc = burl;
              } else if (bk.url) detailSrc = httpReq(bk.url, 'GET');
              const dEnv = { result: detailSrc, baseUrl: 'data:;base64,' };
              let detail = detailSrc;
              if (src.ruleBookInfo && src.ruleBookInfo.init) detail = applyRule(src.ruleBookInfo.init, dEnv);
              const nm = extractPath(detail, '$.book_name') || extractPath(detail, '$.name') || (bk.book_name || '');
              const au = extractPath(detail, '$.author') || (bk.author || '');
              stats.detail = reqCount;
              ok('详情', `《${nm}》 ${au}`);
              if (src.ruleBookInfo && src.ruleBookInfo.intro) {
                try {
                  const intro = applyRule(src.ruleBookInfo.intro, { result: detail });
                  console.log(`   简介: ${brief(intro, 100)}`);
                } catch (e) { fail('intro', e); }
              }
              // ========== 3. 目录 ==========
              if (!only || only === 'toc' || only === 'content') {
                console.log('── 3. 目录 ─────────────────────────');
                try {
                  const tocRule = (src.ruleBookInfo && src.ruleBookInfo.tocUrl) || '';
                  let tocSrc = detail;
                  if (tocRule) {
                    const turl = applyRule(tocRule, { result: detail });
                    if (typeof turl === 'string' && turl.startsWith('data:')) tocSrc = decodeDataUrl(turl);
                    else if (typeof turl === 'string' && /^https?:/.test(turl)) tocSrc = httpReq(turl, 'GET');
                    else tocSrc = turl;
                  }
                  const tEnv = { result: tocSrc, baseUrl: 'data:;base64,' };
                  const chapterList = src.ruleToc && src.ruleToc.chapterList
                    ? applyRule(src.ruleToc.chapterList, tEnv) : tocSrc;
                  const chs = Array.isArray(chapterList) ? chapterList : [];
                  stats.toc = reqCount;
                  ok('目录', `${chs.length} 章`);
                  const ch = chs[CHAPTER_N] || chs[0];
                  if (ch) {
                    const chName = extractPath(ch, '$.title') || (ch.title || '');
                    console.log(`   章节 #${CHAPTER_N}: ${brief(chName, 60)}`);
                    // ========== 4. 正文 ==========
                    if (!only || only === 'content') {
                      console.log('── 4. 正文 ─────────────────────────');
                      try {
                        const chUrlRule = (src.ruleToc && src.ruleToc.chapterUrl) || '';
                        let cSrc = ch;
                        if (chUrlRule) {
                          const curl = applyRule(chUrlRule, { result: ch, chapter: ch });
                          if (typeof curl === 'string' && curl.startsWith('data:')) cSrc = decodeDataUrl(curl);
                          else if (typeof curl === 'string' && /^https?:/.test(curl)) cSrc = httpReq(curl, 'GET');
                          else cSrc = curl;
                        } else if (ch.content_url || ch.url) {
                          cSrc = httpReq(ch.content_url || ch.url, 'GET');
                        }
                        const cEnv = { result: cSrc, baseUrl: 'data:;base64,', chapter: ch };
                        let content = src.ruleContent && src.ruleContent.content
                          ? applyRule(src.ruleContent.content, cEnv) : cSrc;
                        const txt = typeof content === 'string' ? content
                          : (content && typeof content === 'object' ? JSON.stringify(content) : String(content));
                        stats.content = reqCount;
                        ok('正文', `${txt.length} 字符`);
                        console.log(`   开头: ${txt.replace(/\s+/g, ' ').slice(0, 100)}`);
                        if (src.ruleContent && src.ruleContent.title) {
                          try {
                            const t = applyRule(src.ruleContent.title, cEnv);
                            console.log(`   标题: ${brief(t, 60)}`);
                          } catch (e) { fail('content.title', e); }
                        }
                      } catch (e) { fail('正文', e); }
                    }
                  }
                } catch (e) { fail('目录', e); }
              }
            } catch (e) { fail('详情', e); }
          }
        }
      } catch (e) { fail('搜索', e); }
    }
  }
  // ========== 汇总 ==========
  console.log('\n── 汇总 ─────────────────────────');
  console.log(`请求次数: ${reqCount}`);
  if (!src.searchUrl) console.log('(无 searchUrl, 跳过端到端)');
  else if (ONLY) console.log(`环节: ${ONLY} 完成`);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
