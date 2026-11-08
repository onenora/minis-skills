#!/usr/bin/env node
/**
 * xs.js — 香色/StandarReader 书源工具（零依赖，Node >= 18；输入 .xbs 或 .json 自动识别）
 *
 *   lint  <src...>                         结构/闪退约束检查；退出码 0 通过 / 1 警告 / 2 失败
 *   fmt   <in> <out.json|out.xbs> [--alias A] [--touch]   规范化：补齐 action 桩、类型修正、键排序
 *   probe <src|dir...> [--keyword 词1,词2] [--alias A] [--chapter N] [--jobs 4] [--timeout 15] [--report r.json]
 *                                          可用性评估：真实请求跑 搜索→详情→目录→正文（批量汇总）
 *   try   <url|file> [k=rule...] [--list 规则] [--post 'a=1&b=2'] [--encode gbk] [--header 'K: V'] [--save f]
 *                                          写源试算：取页面并执行 XPath/JSONPath/@js: 规则
 *   sniff <url>                            站点侦察：编码、表单、og:novel、链接模式、疑似接口
 *
 * 规则引擎为近似模拟（HTML 容错解析 + XPath 1.0 子集 + JSONPath 子集 + vm 执行 @js:/JSParser）；
 * 模拟通过 ≠ App 通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { xbsToJsonBytes, jsonToXbsBytes } = require('./xbs.js');

// ---------------- 常量 ----------------
const CORE = ['searchBook', 'bookDetail', 'chapterList', 'chapterContent'];
const STUBS = ['relatedWord', 'searchShudan', 'shudanDetail', 'shudanList', 'shupingHome', 'shupingList'];
const ACTIONS = CORE.concat(['bookWorld'], STUBS);
const TOP_ORDER = ['sourceName', 'sourceUrl', 'sourceType', 'enable', 'weight', 'desc', 'authorId', 'lastModifyTime',
  'miniAppVersion', 'loginUrl', 'httpHeaders'].concat(ACTIONS);
const ACT_ORDER = ['actionID', 'parserID', 'host', 'validConfig', 'httpHeaders', 'requestInfo', 'responseFormatType',
  'responseEncode', 'requestParamsEncode', 'list', 'bookName', 'title', 'author', 'cover', 'cat', 'status', 'wordCount',
  'desc', 'lastChapterTitle', 'updateTime', 'detailUrl', 'url', 'content', 'nextPageUrl', 'moreKeys', 'JSParser', '_sIndex'];
const META_KEYS = new Set(['actionID', 'parserID', 'host', 'validConfig', 'httpHeaders', 'responseFormatType',
  'responseEncode', 'requestParamsEncode', '_sIndex']);
const BOOK_FIELDS = ['bookName', 'author', 'cover', 'cat', 'status', 'wordCount', 'desc', 'lastChapterTitle', 'updateTime', 'detailUrl'];
const FIELDS = {
  searchBook: BOOK_FIELDS, bookWorld: BOOK_FIELDS, bookDetail: BOOK_FIELDS,
  chapterList: ['title', 'url', 'detailUrl', 'updateTime'], chapterContent: ['title', 'content'],
};
const REQUIRED = { searchBook: ['list', 'bookName', 'detailUrl'], bookWorld: ['list', 'bookName', 'detailUrl'],
  chapterList: ['list', 'title', 'url'], chapterContent: ['content'] };
const LIST_ACTIONS = new Set(['searchBook', 'bookWorld', 'chapterList']);
const URL_FIELDS = new Set(['detailUrl', 'url', 'cover', 'nextPageUrl']);
const LEGADO_TOP = ['bookSourceName', 'bookSourceUrl', 'bookSourceGroup', 'bookSourceType', 'ruleSearch',
  'ruleBookInfo', 'ruleToc', 'ruleContent', 'searchUrl', 'exploreUrl'];
const LEGADO_ACT = ['method', 'body', 'headers', 'header', 'data', 'java.getParams'];
const RFT = ['', 'base64str', 'html', 'xml', 'json', 'data'];
// NSStringEncoding = 0x80000000 | CFStringEncoding
const ENC = { '4': 'utf-8', '2147485232': 'gbk', '2147485233': 'gbk', '2147485234': 'gb18030', '2147486211': 'big5' };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

class SimError extends Error {}   // 模拟器不支持
class NetError extends Error {}   // 网络/HTTP
class BlockError extends Error {} // 反爬/盾/登录
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------- 读写 ----------------
function readSource(file) {
  const b = fs.readFileSync(file);
  const head = b.subarray(0, 64).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<!DOCTYPE') || head.startsWith('bplist')) {
    throw new Error('plist 文件（香色主题/配置），非书源');
  }
  const txt = head.startsWith('{') || head.startsWith('[')
    ? b.toString('utf8').replace(/^﻿/, '')
    : Buffer.from(xbsToJsonBytes(new Uint8Array(b))).toString('utf8');
  let j = JSON.parse(txt);
  if (Array.isArray(j)) throw new Error('顶层为数组：疑似 Legado/其他 App 书源');
  if (typeof j.sourceName === 'string' && isObj(j.searchBook)) j = { [j.sourceName]: j };
  return j;
}

function writeSource(obj, out) {
  if (/\.xbs$/i.test(out)) {
    const src = Buffer.from(JSON.stringify(obj), 'utf8');
    const xbs = Buffer.from(jsonToXbsBytes(src));
    if (Buffer.compare(Buffer.from(xbsToJsonBytes(new Uint8Array(xbs))), src) !== 0) throw new Error('roundtrip mismatch');
    fs.writeFileSync(out, xbs);
    return crypto.createHash('sha256').update(xbs).digest('hex');
  }
  fs.writeFileSync(out, JSON.stringify(obj, null, 2) + '\n');
  return '';
}

function expandInputs(list) {
  const out = [];
  for (const p of list) {
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (/\.(xbs|json)$/i.test(f)) out.push(path.join(p, f));
    } else out.push(p);
  }
  return out;
}

// ---------------- lint ----------------
function splitRule(rule) {
  const m = /(^|\|\|?)\s*@js:/.exec(rule);
  const head = m ? rule.slice(0, m.index) : rule;
  const js = m ? rule.slice(m.index + m[0].length) : null;
  return { alts: head.trim() ? splitTop(head, '||').map((s) => s.replace(/^\s+/, '').replace(/[\r\n]+\s*$/, '')).filter(Boolean) : [], js };
}

function splitTop(s, sep) {
  const out = [];
  let depth = 0, q = '', cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    if (depth === 0 && s.startsWith(sep, i) && (sep !== '|' || (s[i + 1] !== '|' && s[i - 1] !== '|'))) {
      out.push(cur); cur = ''; i += sep.length - 1; continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function jsCodes(A) {
  const out = [];
  for (const [k, v] of Object.entries(A)) {
    if (typeof v !== 'string') continue;
    if (k === 'JSParser' || k === 'requestJavascript' || k === 'responseJavascript') out.push([k, v, true]);
    else if (k === 'requestInfo') { if (/^\s*@js:/.test(v)) out.push([k, v.replace(/^\s*@js:/, ''), false]); }
    else { const js = splitRule(v).js; if (js !== null) out.push([k, js, false]); }
  }
  return out;
}

function isStub(A) { return Object.keys(A).every((k) => META_KEYS.has(k)); }

function lintAction(add, kind, A, where) {
  const fix = (v) => (v === undefined ? '（缺失，fmt 可补齐）' : '');
  if (A.actionID !== kind) add('fail', `${where}.actionID 应为 "${kind}"${fix(A.actionID)}`);
  if (!['DOM', 'JS'].includes(A.parserID)) add('fail', `${where}.parserID 仅 DOM/JS（当前 ${JSON.stringify(A.parserID)}）${fix(A.parserID)}`);
  if (A.responseFormatType !== undefined && !RFT.includes(A.responseFormatType)) add('fail', `${where}.responseFormatType 非法：${JSON.stringify(A.responseFormatType)}`);
  if (A.requestInfo !== undefined && typeof A.requestInfo !== 'string') add('fail', `${where}.requestInfo 须为字符串`);
  if (A.httpHeaders !== undefined && !isObj(A.httpHeaders)) add('fail', `${where}.httpHeaders 须为字典`);
  for (const k of LEGADO_ACT) if (k in A) add('fail', `${where} 含 Legado 字段 ${k}`);
  for (const k of ['responseEncode', 'requestParamsEncode']) if (A[k] !== undefined && !ENC[String(A[k])]) add('warn', `${where}.${k} 未知编码号 ${A[k]}`);
  const mk = A.moreKeys;
  if (mk !== undefined) {
    if (!isObj(mk)) add('fail', `${where}.moreKeys 须为字典`);
    else if (mk.requestFilters !== undefined) {
      if (Array.isArray(mk.requestFilters)) add('warn', `${where}.requestFilters 为数组格式（旧源可见）；2.56.1 优先字符串 "key\\n标题::值"`);
      else if (typeof mk.requestFilters !== 'string') add('fail', `${where}.requestFilters 须为字符串`);
    }
  }
  if (A.nextPageUrl && !(isObj(mk) && mk.maxPage)) add('warn', `${where}.nextPageUrl 未配 moreKeys.maxPage`);
  const custom = A.JSParser || A.parserID === 'JS';
  if (!custom && REQUIRED[kind]) {
    if (isStub(A) && kind !== 'chapterContent' && kind !== 'chapterList') add('warn', `${where} 为空桩`);
    else if (!A.indexOnly && !/\bresponse\s*['"]?\s*:/.test(A.requestInfo || '')) {
      const jsList = typeof A.list === 'string' && splitRule(A.list).js !== null;
      for (const f of REQUIRED[kind]) if (!A[f] && !(jsList && f !== 'list')) add('fail', `${where} 缺 ${f}`);
    }
  }
  if (LIST_ACTIONS.has(kind)) {
    for (const f of FIELDS[kind]) {
      if (typeof A[f] === 'string' && /^\s*\.\/?\//.test(A[f])) add('warn', `${where}.${f} 用 "./" 相对写法；列表子字段写 "//…"`);
    }
  }
  for (const [k, code, whole] of jsCodes(A)) {
    try { new vm.Script(whole ? code : '(function(){' + code + '\n})', { filename: where + '.' + k }); }
    catch (e) { add('fail', `${where}.${k} JS 语法错误：${e.message}`); continue; }
    const bare = code.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""');
    if (/[\w)\]]\?\.[A-Za-z_$[(]|\?\?/.test(bare)) add('warn', `${where}.${k} 用了 ?. / ??（旧 JavaScriptCore 不支持）`);
    if (/\bCryptoJS\b/.test(bare) && !/CryptoJS\s*=/.test(bare)) add('warn', `${where}.${k} 引用 CryptoJS 但未内联（App 不内置）`);
    if (/\b(atob|btoa)\s*\(/.test(bare) && !/function\s+(atob|btoa)\b/.test(bare)) add('warn', `${where}.${k} 用 atob/btoa（App 不保证提供，改 params.nativeTool.base64Decode）`);
  }
}

function lint(J) {
  const R = [];
  if (!isObj(J)) return [{ alias: '-', level: 'fail', msg: '顶层须为对象 {别名: 书源}' }];
  for (const [alias, S] of Object.entries(J)) {
    const add = (level, msg) => R.push({ alias, level, msg });
    if (!isObj(S)) { add('fail', '书源须为对象'); continue; }
    for (const k of LEGADO_TOP) if (k in S) add('fail', `含 Legado 字段 ${k}`);
    if (!S.sourceName) add('fail', '缺 sourceName');
    if (!S.sourceUrl) add('warn', '缺 sourceUrl');
    if (typeof S.weight !== 'string') add('fail', 'weight 须为字符串（数字会闪退 -[__NSCFNumber length]）');
    if (S.enable !== undefined && typeof S.enable !== 'number') add('warn', 'enable 建议整数 1/0');
    if (S.lastModifyTime !== undefined && typeof S.lastModifyTime !== 'string') add('warn', 'lastModifyTime 建议字符串');
    if (S.sourceType && !['text', 'comic', 'video', 'audio'].includes(S.sourceType)) add('warn', `未知 sourceType ${S.sourceType}`);
    if (/公众号|微信|[Qq]{2}群|t\.me|tg群|关注|加群/.test(S.sourceName || '')) add('warn', 'sourceName 含宣传信息');
    if (S.desc === '') add('info', 'desc 为空串会在源列表显示「名()」，无描述时删掉该键（fmt 可处理）');
    else if (typeof S.desc === 'string' && [...S.desc].length > 12) add('info', 'desc 会以「sourceName(desc)」显示在源列表，建议 ≤12 字');
    if (S.httpHeaders !== undefined && !isObj(S.httpHeaders)) add('fail', 'httpHeaders 须为字典');
    const noRule = (A, f) => isObj(A) && !A[f] && !A.JSParser && A.parserID !== 'JS';
    const indexOnly = noRule(S.chapterList, 'list') && noRule(S.chapterContent, 'content');
    if (indexOnly) add('warn', '目录/正文为空桩：索引源（仅搜索，供换源）');
    for (const a of CORE) {
      if (!isObj(S[a])) add('fail', `缺 ${a}`);
      else lintAction(add, a, indexOnly ? Object.assign({ indexOnly }, S[a]) : S[a], a);
    }
    const bw = S.bookWorld;
    if (bw !== undefined) {
      if (!isObj(bw)) add('fail', 'bookWorld 须为分类字典（数组会闪退 -[__NSArrayI allKeys]）');
      else {
        if (Array.isArray(bw.categories)) add('fail', 'bookWorld.categories 数组会闪退；改分类字典');
        for (const [c, v] of Object.entries(bw)) {
          if (!isObj(v)) add('fail', `bookWorld.${c} 须为对象`);
          else lintAction(add, 'bookWorld', v, 'bookWorld.' + c);
        }
      }
    }
    for (const a of STUBS) if (a in S && !isObj(S[a])) add('fail', `${a} 须为对象`);
    const miss = ['bookWorld'].concat(STUBS).filter((a) => !(a in S));
    if (miss.length) add('info', `缺空桩 ${miss.join(',')}（fmt 可补齐）`);
  }
  return R;
}

function lintLevel(R) {
  return R.some((r) => r.level === 'fail') ? 'fail' : R.some((r) => r.level === 'warn') ? 'warn' : 'pass';
}

// ---------------- fmt ----------------
function ordered(o, order) {
  const out = {};
  for (const k of order) if (k in o) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k];
  return out;
}

function fmtAction(kind, A0, host) {
  const A = Object.assign({}, A0, { actionID: kind, parserID: A0.parserID || 'DOM' });
  if (!isStub(A0)) {
    if (!A.host && host) A.host = host;
    if (A.validConfig === undefined) A.validConfig = '';
  }
  return ordered(A, ACT_ORDER);
}

function fmtSource(S0, opt) {
  const S = Object.assign({}, S0);
  S.weight = S.weight === undefined || S.weight === null ? '9999' : String(S.weight);
  S.enable = S.enable === undefined ? 1 : (Number(S.enable) ? 1 : 0);
  if (opt.touch || !S.lastModifyTime) S.lastModifyTime = String(Math.floor(Date.now() / 1000));
  else S.lastModifyTime = String(S.lastModifyTime);
  if (!S.miniAppVersion) S.miniAppVersion = '2.56.1';
  for (const k of ['authorId', 'loginUrl']) if (typeof S[k] !== 'string') S[k] = S[k] == null ? '' : String(S[k]);
  if (S.desc == null || String(S.desc).trim() === '') delete S.desc; // 空 desc 在源列表显示为「名()」
  else S.desc = String(S.desc);
  if (!isObj(S.httpHeaders)) S.httpHeaders = {};
  const host = String(S.sourceUrl || '').replace(/\/+$/, '');
  for (const a of ACTIONS) {
    if (a === 'shudanList') { if (!isObj(S[a])) S[a] = {}; continue; }
    if (a === 'bookWorld') {
      const nv = {};
      let i = 0;
      for (const [c, v] of Object.entries(isObj(S[a]) ? S[a] : {})) {
        if (isObj(v)) nv[c] = Object.assign(fmtAction('bookWorld', v, host), { _sIndex: i++ });
      }
      S[a] = nv;
      continue;
    }
    S[a] = fmtAction(a, isObj(S[a]) ? S[a] : {}, host);
  }
  return ordered(S, TOP_ORDER);
}

// ---------------- HTML ----------------
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const RAWTXT = new Set(['script', 'style', 'textarea', 'title', 'xmp']);
const BLOCK = new Set('address article aside blockquote br dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td th thead tr ul'.split(' '));
const AUTOCLOSE = { li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'], tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'], p: ['p'] };
const SCOPE = new Set(['ul', 'ol', 'dl', 'table', 'tbody', 'select', 'div', 'body']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—',
  ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', times: '×', emsp: ' ', ensp: ' ', raquo: '»', laquo: '«' };

function decodeEnt(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+;?|#\d+;?|amp;?|[a-zA-Z][a-zA-Z0-9]*;)/g, (m, e) => {
    if (e[0] === '#') {
      const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m;
    }
    const v = ENT[e.replace(/;$/, '').toLowerCase()];
    return v === undefined ? m : v;
  });
}

function parseAttrs(s) {
  const a = {};
  const re = /([^\s=\/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const k = m[1].toLowerCase();
    if (!(k in a)) a[k] = decodeEnt(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '');
  }
  return a;
}

function parseHTML(html) {
  let idx = 0;
  const doc = { type: 'doc', tag: '#doc', children: [], parent: null, i: 0 };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  const add = (n) => { const p = top(); n.parent = p; n.i = ++idx; p.children.push(n); return n; };
  const text = (s) => { if (s) add({ type: 'text', text: decodeEnt(s) }); };
  const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s>\/]*)[^>]*>|<([a-zA-Z][^\s>\/]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0, m;
  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) {
      const t = m[1].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === t) { stack.length = k; break; }
    } else if (m[2]) {
      const t = m[2].toLowerCase();
      const ac = AUTOCLOSE[t] || (BLOCK.has(t) ? ['p'] : null);
      if (ac) {
        for (let k = stack.length - 1; k > 0; k--) {
          if (ac.includes(stack[k].tag)) { stack.length = k; break; }
          if (SCOPE.has(stack[k].tag)) break;
        }
      }
      const el = add({ type: 'el', tag: t, attrs: parseAttrs(m[3]), children: [] });
      if (RAWTXT.has(t)) {
        const endRe = new RegExp('</' + t + '\\s*>', 'ig');
        endRe.lastIndex = last;
        const em = endRe.exec(html);
        const raw = html.slice(last, em ? em.index : html.length);
        if (raw) { el.children.push({ type: 'text', text: t === 'title' || t === 'textarea' ? decodeEnt(raw) : raw, parent: el, i: ++idx }); }
        last = em ? endRe.lastIndex : html.length;
        re.lastIndex = last;
      } else if (!VOID.has(t) && !/\/\s*$/.test(m[3])) stack.push(el);
    }
  }
  text(html.slice(last));
  return doc;
}

function strValue(n) {
  if (n.type === 'text') return n.text;
  if (n.type === 'attr') return n.value;
  let s = '';
  for (const c of n.children) if (!(c.type === 'el' && (c.tag === 'script' || c.tag === 'style'))) s += strValue(c);
  return s;
}

function readable(n) {
  if (n.type !== 'el' && n.type !== 'doc') return strValue(n).trim();
  const out = [];
  (function walk(x) {
    if (x.type === 'text') { out.push(x.text); return; }
    if (x.tag === 'script' || x.tag === 'style') return;
    const b = BLOCK.has(x.tag);
    if (b) out.push('\n');
    for (const c of x.children) walk(c);
    if (b) out.push('\n');
  })(n);
  return out.join('').replace(/[ \t\r ]*\n[\s ]*/g, '\n').replace(/[ \t ]{2,}/g, ' ').trim();
}

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function outer(n) {
  if (n.type === 'text') return escText(n.text);
  if (n.type === 'attr') return n.value;
  if (n.type === 'doc') return n.children.map(outer).join('');
  const a = Object.entries(n.attrs).map(([k, v]) => ' ' + k + '="' + v.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"').join('');
  if (VOID.has(n.tag)) return '<' + n.tag + a + '>';
  const inner = RAWTXT.has(n.tag) ? n.children.map((c) => c.text).join('') : n.children.map(outer).join('');
  return '<' + n.tag + a + '>' + inner + '</' + n.tag + '>';
}

// ---------------- XPath 1.0 子集 ----------------
function xtokens(s) {
  const t = [];
  const re = /\s*(\/\/|::|!=|<=|>=|\.\.|[\/\[\]()@,|=<>+*.-]|"[^"]*"|'[^']*'|\d+(?:\.\d+)?|\.\d+|[A-Za-z_À-￿][\wÀ-￿-]*(?::(?!:)[A-Za-z_][\w-]*)?)/y;
  let m;
  while (re.lastIndex < s.length) {
    const at = re.lastIndex;
    if (!(m = re.exec(s))) { if (/^\s*$/.test(s.slice(at))) break; throw new Error('XPath 无法解析：' + s.slice(at, at + 20)); }
    t.push(m[1]);
  }
  return t;
}

function xparse(src) {
  const tk = xtokens(src);
  let p = 0;
  const peek = (o = 0) => tk[p + o];
  const eat = (v) => { if (tk[p] !== v) throw new Error(`XPath 期望 ${v}：${src}`); p++; };
  const isLit = (x) => x && (x[0] === '"' || x[0] === "'");
  const isNum = (x) => x && /^\.?\d/.test(x);
  const isName = (x) => x && /^[A-Za-z_À-￿]/.test(x);
  function bin(next, ops) {
    return function () {
      let a = next();
      while (ops.includes(peek())) { const op = tk[p++]; a = { t: 'bin', op, a, b: next() }; }
      return a;
    };
  }
  function orExpr() { let a = andExpr(); while (peek() === 'or') { p++; a = { t: 'or', a, b: andExpr() }; } return a; }
  function andExpr() { let a = eqExpr(); while (peek() === 'and') { p++; a = { t: 'and', a, b: eqExpr() }; } return a; }
  const addExpr = bin(unary, ['+', '-']);
  const relExpr = bin(addExpr, ['<', '<=', '>', '>=']);
  const eqExpr = bin(relExpr, ['=', '!=']);
  function unary() { if (peek() === '-') { p++; return { t: 'neg', a: unary() }; } return union(); }
  function union() {
    const list = [pathExpr()];
    while (peek() === '|') { p++; list.push(pathExpr()); }
    return list.length === 1 ? list[0] : { t: 'union', list };
  }
  function preds() { const r = []; while (peek() === '[') { p++; r.push(orExpr()); eat(']'); } return r; }
  function step() {
    if (peek() === '.') { p++; return { axis: 'self', test: 'node()', preds: [] }; }
    if (peek() === '..') { p++; return { axis: 'parent', test: 'node()', preds: [] }; }
    let axis = 'child';
    if (peek() === '@') { p++; axis = 'attribute'; }
    else if (isName(peek()) && peek(1) === '::') { axis = tk[p]; p += 2; }
    let test = tk[p++];
    if (test === undefined) throw new Error('XPath 不完整：' + src);
    if (peek() === '(' && ['text', 'node', 'comment'].includes(test)) { p++; eat(')'); test += '()'; }
    else if (test !== '*') test = test.toLowerCase();
    return { axis, test, preds: preds() };
  }
  const canStep = (x) => x === '.' || x === '..' || x === '@' || x === '*' || isName(x);
  function steps(list) {
    list.push(step());
    while (peek() === '/' || peek() === '//') {
      if (tk[p++] === '//') list.push({ axis: 'descendant-or-self', test: 'node()', preds: [] });
      list.push(step());
    }
    return list;
  }
  function pathExpr() {
    const x = peek();
    if (x === '/' || x === '//') {
      p++;
      const s = x === '//' ? [{ axis: 'descendant-or-self', test: 'node()', preds: [] }] : [];
      if (canStep(peek())) steps(s);
      return { t: 'path', abs: true, steps: s };
    }
    if (isLit(x) || isNum(x) || x === '(' || (isName(x) && peek(1) === '(' && !['text', 'node', 'comment'].includes(x))) {
      let base;
      if (isLit(x)) { p++; base = { t: 'lit', v: x.slice(1, -1) }; }
      else if (isNum(x)) { p++; base = { t: 'num', v: parseFloat(x) }; }
      else if (x === '(') { p++; base = orExpr(); eat(')'); }
      else {
        p += 2;
        const args = [];
        if (peek() !== ')') { args.push(orExpr()); while (peek() === ',') { p++; args.push(orExpr()); } }
        eat(')');
        base = { t: 'fn', name: x, args };
      }
      const pr = preds();
      if (pr.length) base = { t: 'filter', base, preds: pr };
      if (peek() === '/' || peek() === '//') {
        const s = [];
        if (tk[p++] === '//') s.push({ axis: 'descendant-or-self', test: 'node()', preds: [] });
        steps(s);
        return { t: 'path', base, steps: s };
      }
      return base;
    }
    return { t: 'path', steps: steps([]) };
  }
  const ast = orExpr();
  if (p < tk.length) throw new Error('XPath 多余内容：' + tk.slice(p).join(''));
  return ast;
}

function attrNodes(el) {
  if (!el._an) el._an = Object.entries(el.attrs).map(([name, value], k) => ({ type: 'attr', name, value, parent: el, i: el.i + (k + 1) / 1e4 }));
  return el._an;
}

function axisNodes(n, ax) {
  const kids = (x) => x.children || [];
  const desc = (x, self) => { const r = self ? [x] : []; (function w(y) { for (const c of kids(y)) { r.push(c); w(c); } })(x); return r; };
  switch (ax) {
    case 'child': return kids(n);
    case 'attribute': return n.type === 'el' ? attrNodes(n) : [];
    case 'self': return [n];
    case 'parent': return n.parent ? [n.parent] : [];
    case 'descendant': return desc(n, false);
    case 'descendant-or-self': return desc(n, true);
    case 'ancestor': case 'ancestor-or-self': {
      const r = ax === 'ancestor-or-self' ? [n] : [];
      for (let x = n.parent; x; x = x.parent) r.push(x);
      return r;
    }
    case 'following-sibling': case 'preceding-sibling': {
      if (!n.parent || n.type === 'attr') return [];
      const sib = n.parent.children, k = sib.indexOf(n);
      return ax === 'following-sibling' ? sib.slice(k + 1) : sib.slice(0, k).reverse();
    }
    default: throw new SimError('XPath 轴未模拟：' + ax);
  }
}

function nodeTest(n, st) {
  if (st.test === 'node()') return true;
  if (st.test === 'text()') return n.type === 'text';
  if (st.test === 'comment()') return false;
  if (st.axis === 'attribute') return st.test === '*' || n.name === st.test;
  return n.type === 'el' && (st.test === '*' || n.tag === st.test);
}

const uniqSort = (arr) => Array.from(new Set(arr)).sort((a, b) => a.i - b.i);
const toStr = (v) => (Array.isArray(v) ? (v.length ? strValue(v[0]) : '') : typeof v === 'boolean' ? String(v) : String(v));
const toNum = (v) => (typeof v === 'number' ? v : Number(toStr(v).trim() || NaN));
const toBool = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'number' ? v !== 0 && !isNaN(v) : typeof v === 'string' ? v.length > 0 : !!v);

function cmpAtom(op, a, b) {
  if (op === '=' || op === '!=') {
    let r;
    if (typeof a === 'boolean' || typeof b === 'boolean') r = toBool(a) === toBool(b);
    else if (typeof a === 'number' || typeof b === 'number') r = Number(a) === Number(b);
    else r = String(a) === String(b);
    return op === '=' ? r : !r;
  }
  a = Number(a); b = Number(b);
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
}
function compare(op, a, b) {
  const A = Array.isArray(a), B = Array.isArray(b);
  if (A && B) return a.some((x) => b.some((y) => cmpAtom(op, strValue(x), strValue(y))));
  if (A) return typeof b === 'boolean' ? cmpAtom(op, toBool(a), b) : a.some((x) => cmpAtom(op, typeof b === 'number' ? Number(strValue(x)) : strValue(x), b));
  if (B) return typeof a === 'boolean' ? cmpAtom(op, a, toBool(b)) : b.some((y) => cmpAtom(op, a, typeof a === 'number' ? Number(strValue(y)) : strValue(y)));
  return cmpAtom(op, a, b);
}

const XFN = {
  last: (c) => c.size, position: (c) => c.pos, count: (c, a) => a[0].length,
  contains: (c, a) => toStr(a[0]).includes(toStr(a[1])),
  'starts-with': (c, a) => toStr(a[0]).startsWith(toStr(a[1])),
  'ends-with': (c, a) => toStr(a[0]).endsWith(toStr(a[1])),
  not: (c, a) => !toBool(a[0]), true: () => true, false: () => false, boolean: (c, a) => toBool(a[0]),
  string: (c, a) => (a.length ? toStr(a[0]) : strValue(c.node)),
  'normalize-space': (c, a) => (a.length ? toStr(a[0]) : strValue(c.node)).replace(/\s+/g, ' ').trim(),
  'string-length': (c, a) => (a.length ? toStr(a[0]) : strValue(c.node)).length,
  concat: (c, a) => a.map(toStr).join(''),
  'substring-before': (c, a) => { const s = toStr(a[0]), k = s.indexOf(toStr(a[1])); return k < 0 ? '' : s.slice(0, k); },
  'substring-after': (c, a) => { const s = toStr(a[0]), t = toStr(a[1]), k = s.indexOf(t); return k < 0 ? '' : s.slice(k + t.length); },
  substring: (c, a) => { const s = toStr(a[0]), st = Math.round(toNum(a[1])); return a.length > 2 ? s.substr(st - 1, Math.round(toNum(a[2]))) : s.slice(st - 1); },
  translate: (c, a) => { const f = toStr(a[1]), t = toStr(a[2]); return toStr(a[0]).split('').map((ch) => { const k = f.indexOf(ch); return k < 0 ? ch : (t[k] || ''); }).join(''); },
  number: (c, a) => toNum(a.length ? a[0] : strValue(c.node)),
  name: (c, a) => { const n = a.length ? a[0][0] : c.node; return n ? n.tag || n.name || '' : ''; },
  'lower-case': (c, a) => toStr(a[0]).toLowerCase(),
};
XFN['local-name'] = XFN.name;

function applySteps(nodes, steps, c) {
  for (const st of steps) {
    const out = [];
    for (const n of nodes) {
      let cand = axisNodes(n, st.axis).filter((m) => nodeTest(m, st));
      for (const pr of st.preds) cand = filterPreds(cand, pr, c);
      for (const m of cand) out.push(m);
    }
    nodes = uniqSort(out);
  }
  return nodes;
}
function filterPreds(cand, pr, c) {
  const size = cand.length;
  return cand.filter((m, k) => {
    const v = xeval(pr, { node: m, pos: k + 1, size, root: c.root });
    return typeof v === 'number' ? v === k + 1 : toBool(v);
  });
}

function xeval(e, c) {
  switch (e.t) {
    case 'lit': return e.v;
    case 'num': return e.v;
    case 'or': return toBool(xeval(e.a, c)) || toBool(xeval(e.b, c));
    case 'and': return toBool(xeval(e.a, c)) && toBool(xeval(e.b, c));
    case 'neg': return -toNum(xeval(e.a, c));
    case 'bin': {
      const a = xeval(e.a, c), b = xeval(e.b, c);
      if (e.op === '+') return toNum(a) + toNum(b);
      if (e.op === '-') return toNum(a) - toNum(b);
      return compare(e.op, a, b);
    }
    case 'union': return uniqSort([].concat(...e.list.map((x) => { const v = xeval(x, c); if (!Array.isArray(v)) throw new Error('XPath | 两侧须为节点集'); return v; })));
    case 'fn': {
      const f = XFN[e.name];
      if (!f) throw new SimError('XPath 函数未模拟：' + e.name + '()');
      return f(c, e.args.map((a) => xeval(a, c)));
    }
    case 'filter': {
      let v = xeval(e.base, c);
      for (const pr of e.preds) v = filterPreds(v, pr, c);
      return v;
    }
    case 'path': {
      let start;
      if (e.abs) start = [c.root];
      else if (e.base) { start = xeval(e.base, c); if (!Array.isArray(start)) throw new Error('XPath 路径基须为节点集'); }
      else start = [c.node];
      return applySteps(start, e.steps, c);
    }
    default: throw new Error('XPath 未知节点 ' + e.t);
  }
}

const XCACHE = new Map();
function xpath(expr, node, root) {
  let ast = XCACHE.get(expr);
  if (!ast) { ast = xparse(expr); XCACHE.set(expr, ast); }
  return xeval(ast, { node, pos: 1, size: 1, root: root || node });
}

// 列表项按「独立文档」求值：子字段 //x 只在该项内查找（香色语义）
function itemRoot(n) { return n.type === 'doc' ? n : { type: 'doc', tag: '#doc', children: [n], parent: null, i: n.i - 0.5 }; }

// ---------------- JSONPath 子集 ----------------
function jsonPath(expr, data) {
  const s = expr.trim();
  if (s === '$' || s === '') return [data];
  if (s[0] !== '$') {
    let cur = [data];
    for (const k of s.split('/').map((x) => x.trim()).filter(Boolean)) cur = childKey(cur, k);
    return cur;
  }
  let i = 1, cur = [data];
  const all = (vals) => { const r = []; (function w(v) { r.push(v); if (v && typeof v === 'object') for (const x of Object.values(v)) w(x); })(vals); return r; };
  while (i < s.length) {
    if (s.startsWith('..', i)) {
      i += 2;
      const m = /^(\*|[^.[\]\s]+)/.exec(s.slice(i));
      const pool = [].concat(...cur.map(all));
      if (m) { i += m[0].length; cur = m[0] === '*' ? [].concat(...pool.map(children)) : childKey(pool.filter((v) => v && typeof v === 'object' && !Array.isArray(v)), m[0]); }
      else cur = pool;
    } else if (s[i] === '.') {
      i++;
      const m = /^(\*|[^.[\]\s]+)/.exec(s.slice(i));
      if (!m) break;
      i += m[0].length;
      cur = m[0] === '*' ? [].concat(...cur.map(children)) : childKey(cur, m[0]);
    } else if (s[i] === '[') {
      let d = 0, j = i;
      for (; j < s.length; j++) { if (s[j] === '[') d++; else if (s[j] === ']' && --d === 0) break; }
      const inner = s.slice(i + 1, j).trim();
      i = j + 1;
      cur = bracket(cur, inner);
    } else if (/\s/.test(s[i])) i++;
    else throw new Error('JSONPath 无法解析：' + s.slice(i));
  }
  return cur;
}
function children(v) { return v && typeof v === 'object' ? Object.values(v) : []; }
function childKey(cur, k) {
  const r = [];
  for (const v of cur) {
    if (Array.isArray(v) && /^\d+$/.test(k)) { if (v[+k] !== undefined) r.push(v[+k]); }
    else if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && x[k] !== undefined) r.push(x[k]); }
    else if (v && typeof v === 'object' && v[k] !== undefined) r.push(v[k]);
  }
  return r;
}
function bracket(cur, inner) {
  if (inner === '*') return [].concat(...cur.map(children));
  if (/^-?\d+$/.test(inner)) { const n = +inner; return cur.filter(Array.isArray).map((a) => a[n < 0 ? a.length + n : n]).filter((x) => x !== undefined); }
  let m = /^(-?\d*):(-?\d*)$/.exec(inner);
  if (m) return [].concat(...cur.filter(Array.isArray).map((a) => a.slice(m[1] === '' ? 0 : +m[1], m[2] === '' ? undefined : +m[2])));
  if (/^\?\(/.test(inner)) {
    const cond = inner.slice(2, -1).replace(/@\./g, '__x.').replace(/@/g, '__x');
    const fn = new vm.Script('(function(__x){try{return (' + cond + ')}catch(e){return false}})').runInNewContext({});
    return [].concat(...cur.map((v) => (Array.isArray(v) ? v : children(v)).filter((x) => fn(x))));
  }
  const keys = inner.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, ''));
  return [].concat(...keys.map((k) => childKey(cur, k)));
}

// ---------------- 编码 ----------------
let GBK = null;
function gbkBytes(str) {
  if (!GBK) {
    GBK = new Map();
    const dec = new TextDecoder('gb18030');
    const b = Buffer.alloc(2);
    for (let h = 0x81; h <= 0xfe; h++) for (let l = 0x40; l <= 0xfe; l++) {
      if (l === 0x7f) continue;
      b[0] = h; b[1] = l;
      const ch = dec.decode(b);
      if (ch.length === 1 && ch !== '�' && !GBK.has(ch)) GBK.set(ch, [h, l]);
    }
  }
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else { const m = GBK.get(ch); if (m) out.push(m[0], m[1]); else for (const x of Buffer.from(ch, 'utf8')) out.push(x); }
  }
  return Buffer.from(out);
}
function pct(str, enc) {
  str = String(str);
  if (!enc || enc === 'utf-8') return encodeURIComponent(str);
  let s = '';
  for (const x of gbkBytes(str)) {
    const ch = String.fromCharCode(x);
    s += /[A-Za-z0-9\-_.~]/.test(ch) ? ch : '%' + x.toString(16).toUpperCase().padStart(2, '0');
  }
  return s;
}
const encUrl = (u, enc) => u.replace(/[^\x21-\x7e]+/g, (s) => pct(s, enc));
function decodeBody(buf, enc, ctype) {
  let cs = enc || (/charset=["']?([\w-]+)/i.exec(ctype || '') || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
  cs = (cs || 'utf-8').toLowerCase();
  if (cs === 'gb2312' || cs === 'x-gbk') cs = 'gbk';
  try { return { text: new TextDecoder(cs).decode(buf), charset: cs }; }
  catch (e) { return { text: new TextDecoder('utf-8').decode(buf), charset: 'utf-8' }; }
}

// ---------------- HTTP ----------------
const JAR = new Map();
function storeCookies(host, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!list.length) return;
  const j = JAR.get(host) || {};
  for (const c of list) { const m = /^\s*([^=;]+)=([^;]*)/.exec(c); if (m) j[m[1]] = m[2]; }
  JAR.set(host, j);
}

async function http(req, timeoutSec) {
  const t0 = Date.now();
  let url = req.url, method = req.method || 'GET', body = req.body;
  const headers = { 'User-Agent': UA, Accept: 'text/html,application/json,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' };
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (typeof v === 'string' && v.length < 4096 && !/[\r\n]/.test(v)) headers[k] = v;
  }
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const origin = new URL(url).host;
  const site = (h) => h.split('.').slice(-2).join('.');
  const moved = () => (site(new URL(url).host) !== site(origin) ? `（跳转至 ${new URL(url).host}，疑似换域/停放）` : '');
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(url);
    const jar = JAR.get(u.host);
    const h = Object.assign({}, headers);
    if (jar && !req.forbidCookie && !Object.keys(h).some((k) => k.toLowerCase() === 'cookie')) {
      h.Cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
    }
    let res;
    try {
      res = await fetch(url, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutSec * 1000) });
    } catch (e) {
      const code = (e.cause && (e.cause.code || e.cause.message)) || e.name || e.message;
      throw new NetError(`${code === 'TimeoutError' ? '超时' : code} ${u.host}${moved()}`);
    }
    storeCookies(u.host, res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const { text, charset } = decodeBody(buf, req.encode, res.headers.get('content-type'));
    const out = { status: res.status, url, text, charset, headers: res.headers, ms: Date.now() - t0 };
    const cf = res.headers.get('cf-ray') || res.headers.get('cf-mitigated');
    if ([403, 429, 503].includes(res.status) && (cf || /cf-chl|challenge-platform|Just a moment|Attention Required/i.test(text))) {
      throw new BlockError(`Cloudflare 盾（HTTP ${res.status}）`);
    }
    if ([502, 503, 504].includes(res.status) && (req.retry || 0) < 2) { // 网关抖动：退避重试
      await new Promise((r) => setTimeout(r, 1000 * ((req.retry || 0) + 1)));
      return http(Object.assign({}, req, { retry: (req.retry || 0) + 1 }), timeoutSec);
    }
    if (res.status >= 400) throw new NetError(`HTTP ${res.status} ${u.host}${moved()}`);
    if (text.length < 3000 && /验证码|captcha|请登录|登录后/i.test(text) && !/<\/a>[\s\S]*<\/a>[\s\S]*<\/a>/.test(text)) {
      throw new BlockError('疑似验证码/登录墙');
    }
    return out;
  }
  throw new NetError('重定向过多');
}

// ---------------- JS 沙箱 ----------------
const WRAP = new WeakMap();
function wrapNode(n, root) {
  const w = {
    content: () => (n.type === 'el' || n.type === 'doc' ? readable(n) : strValue(n)),
    text: () => strValue(n), raw: () => outer(n), rawContent: () => outer(n),
    tagName: n.tag || n.name || '', attributes: n.attrs || {},
    objectForKey: (k) => (n.attrs || {})[String(k).toLowerCase()],
    queryWithXPath: (xp) => asNodes(xpath(String(xp), n, itemRoot(n))).map((m) => wrapNode(m)),
  };
  w.searchWithXPathQuery = w.queryWithXPath;
  WRAP.set(w, { node: n, root });
  return w;
}
const asNodes = (v) => (Array.isArray(v) ? v : [{ type: 'text', text: String(v), i: 0 }]);

function nativeTool(env) {
  const t = {
    XPathParserWithSource: (html) => { const d = parseHTML(String(html)); return { queryWithXPath: (xp) => asNodes(xpath(String(xp), d, d)).map((m) => wrapNode(m, d)) }; },
    log: (...a) => env.logs.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')),
    md5Encode: (s) => crypto.createHash('md5').update(String(s)).digest('hex'),
    base64Decode: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
    base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    setCache: (k, v) => { env.cache[k] = v; }, getCache: (k) => env.cache[k],
    stringByObject: (o) => (typeof o === 'string' ? o : JSON.stringify(o)),
    dataByAesDecryptWithBase64StringWithKeyWithIv: (b64, key, iv) => {
      const k = Buffer.from(String(key), 'utf8');
      const d = crypto.createDecipheriv('aes-' + k.length * 8 + '-cbc', k, Buffer.from(String(iv), 'utf8'));
      return Buffer.concat([d.update(Buffer.from(String(b64), 'base64')), d.final()]).toString('utf8');
    },
  };
  return new Proxy(t, { get(o, k) { if (k in o || typeof k !== 'string') return o[k]; throw new SimError('nativeTool.' + k + ' 未模拟'); } });
}

function runCode(code, env, vars, label) {
  const ctx = vm.createContext(Object.assign({
    params: env.params, config: env.config, result: vars && 'result' in vars ? vars.result : undefined,
    console: { log: (...a) => env.logs.push(a.join(' ')) },
  }, vars || {}));
  try {
    return new vm.Script(code, { filename: label || 'source.js' }).runInContext(ctx, { timeout: 5000 });
  } catch (e) {
    if (e instanceof SimError) throw e;
    const msg = e && e.message ? e.message : String(e);
    if (/XMLHttpRequest|webView|fetch is not defined/i.test(msg)) throw new SimError('JS 依赖未模拟能力：' + msg);
    throw new Error(`${label || 'JS'}：${msg}`);
  }
}
const runJS = (body, env, result, label) => runCode('(function(){' + body + '\n}).call(this)', env, { result }, label);
function runFn(code, fname, env, args, label) {
  const name = fname || (/function\s+([\w$]+)\s*\(/.exec(code) || [])[1] || 'functionName';
  return runCode(code + '\n;' + name + '.apply(this, __args)', env, { __args: args }, label);
}

// ---------------- 规则求值 ----------------
function mkCtx(text, json, url) {
  if (json !== undefined) return { kind: 'json', value: json, raw: text, url };
  const d = parseHTML(text);
  return { kind: 'html', node: d, root: d, raw: text, url };
}
function itemCtx(it, parent) {
  const w = it && typeof it === 'object' ? WRAP.get(it) : null;
  const n = w ? w.node : it && typeof it === 'object' && it.type && it.i !== undefined ? it : null;
  if (n) return { kind: 'html', node: n, root: itemRoot(n), url: parent.url };
  if (typeof it === 'string' && /<[a-z]/i.test(it)) { const d = parseHTML(it); return { kind: 'html', node: d, root: d, raw: it, url: parent.url }; }
  return { kind: 'json', value: it, url: parent.url };
}
const ctxRaw = (c) => (c.kind === 'json' ? c.value : c.node.type === 'doc' && c.raw !== undefined ? c.raw : outer(c.node));

function extract(rule, c) {
  if (c.kind === 'json') return jsonPath(rule, c.value);
  if (rule[0] === '$') { try { return jsonPath(rule, JSON.parse(c.raw)); } catch (e) { return []; } }
  const v = xpath(rule, c.node, c.root);
  return Array.isArray(v) ? v : [String(v)];
}
const nodesText = (r) => r.map((n) => (typeof n === 'string' ? n : readable(n))).map((s) => s.trim()).filter(Boolean).join('\n');
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
function stringify(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(stringify).filter(Boolean).join('\n');
  if (typeof v === 'object') { const w = WRAP.get(v); return w ? readable(w.node) : JSON.stringify(v); }
  return String(v);
}

// JSONPath 确定路径（$.a.b[0]）返回值本身；含 .. * ?() , : 的不确定路径返回数组（Jayway 语义）
const definite = (e) => !/\.\.|\*|\[\s*\?|\[[^\]]*[,:][^\]]*\]/.test(e);
const isPost = (p) => /^\s*@replace:/.test(p) || /%@result/.test(p);
function fieldValue(rule, c, env, label) {
  const { alts, js } = splitRule(rule);
  // 管道：|| 分段；抽取段在值为空时依次尝试（备选），@replace: / 含 %@result 的模板段对已有值做后处理
  const steps = [];
  for (const alt of alts) {
    let expr = [];
    const flush = () => { if (expr.length) steps.push({ expr: expr.join('|').trim() }); expr = []; };
    for (const p of splitTop(alt, '|')) { if (isPost(p)) { flush(); steps.push({ post: p.replace(/^\s+/, '') }); } else expr.push(p); }
    flush();
  }
  let val;
  for (const st of steps) {
    if (st.expr !== undefined) {
      if (!isEmpty(val)) continue;
      if (/^%?@result$/.test(st.expr)) { val = ctxRaw(c); continue; }
      const r = extract(st.expr, c);
      val = c.kind === 'json' ? (definite(st.expr) ? r[0] : r) : nodesText(r);
    } else if (!isEmpty(val)) {
      const sv = stringify(val);
      val = /^@replace:/.test(st.post) ? sv.split(st.post.slice(9)).join('').trim() : st.post.trim().replace(/%@result/g, sv);
    }
  }
  if (js !== null) val = runJS(js, env, isEmpty(val) && !alts.length ? ctxRaw(c) : val, label);
  return val;
}

function listItems(rule, c, env, label) {
  const { alts, js } = splitRule(rule);
  let items = [];
  for (const alt of alts) {
    const r = extract(alt, c);
    items = c.kind === 'json' ? (r.length === 1 && Array.isArray(r[0]) ? r[0] : r) : r;
    if (items.length) break;
  }
  if (js !== null) {
    const v = runJS(js, env, alts.length ? (c.kind === 'json' ? items : items.map((n) => wrapNode(n))) : ctxRaw(c), label);
    items = Array.isArray(v) ? v : v && Array.isArray(v.list) ? v.list : [];
  }
  return Array.from(items).map((it) => itemCtx(it, c));
}

const firstLine = (v) => String(v || '').trim().split('\n')[0].trim();
function absUrl(v, base) {
  if (typeof v !== 'string' || !v) return v;
  v = v.trim().split('\n')[0].trim(); // 多个匹配取首个
  if (/^(https?:|data:)/i.test(v) || !base) return v;
  if (!/^\/\/|^\/|^\.\.?\/|\/|\.s?html?$|\.php|\?/.test(v)) return v; // 纯 ID 保持原样，供 %@result 拼接
  try { return new URL(v, /^\//.test(v) && !/^\/\//.test(v) ? base.origin || base : base.href || base).href; } catch (e) { return v; }
}

// ---------------- 请求构建 ----------------
function parseFilters(rf) {
  if (Array.isArray(rf)) return rf.filter(isObj).map((g) => ({ key: g.key, items: (g.items || []).map((x) => ({ title: x.title, value: x.value })) }));
  if (typeof rf !== 'string') return [];
  return rf.split(/\n\s*\n/).map((blk) => {
    const lines = blk.split('\n').map((s) => s.trim()).filter(Boolean);
    return { key: lines[0], items: lines.slice(1).map((l) => { const k = l.indexOf('::'); return { title: k < 0 ? l : l.slice(0, k), value: k < 0 ? l : l.slice(k + 2) }; }) };
  }).filter((g) => g.key);
}

function mkConfig(S, A) {
  const host = String(A.host || S.sourceUrl || '').replace(/\/+$/, '');
  return { host, httpHeaders: Object.assign({}, S.httpHeaders || {}, A.httpHeaders || {}), sourceName: S.sourceName, sourceUrl: S.sourceUrl };
}

function buildRequest(A, env, result) {
  const { params, config } = env;
  const reqEnc = ENC[String(A.requestParamsEncode)];
  let ri = A.requestInfo, r;
  if (A.requestJavascript) r = runFn(A.requestJavascript, A.requestFunction, env, [config, params], 'requestJavascript');
  else if (typeof ri !== 'string' || !ri.trim()) r = String(result || '');
  else if (/^\s*@js:/.test(ri)) r = runJS(ri.replace(/^\s*@js:/, ''), env, result, 'requestInfo');
  else {
    const f = params.filters || {};
    r = ri.trim().replace(/%@(\w+)/g, (m, k) => {
      if (k === 'keyWord') return pct(params.keyWord, reqEnc);
      if (k === 'pageIndex') return String(params.pageIndex);
      if (k === 'offset') return String(params.offset);
      if (k === 'result') return String(result || '');
      if (k in f) return pct(f[k], reqEnc);
      if (k === 'filter') { const v = Object.values(f)[0]; return v === undefined ? '' : pct(v, reqEnc); }
      return m;
    });
  }
  const req = typeof r === 'string' ? { url: r } : isObj(r) ? Object.assign({}, r) : null;
  if (req && req.webView) throw new SimError('webView 请求（webViewJs 在页面内执行）需 App 实测');
  if (req && req.response !== undefined) return { url: req.url || config.host, response: req.response, method: 'GET', headers: {} };
  if (!req || !req.url) throw new Error('requestInfo 未得到 url（返回 ' + JSON.stringify(r) + '）');
  let url = String(req.url).trim();
  if (/^\/\//.test(url)) url = 'https:' + url;
  if (!/^https?:/i.test(url)) url = config.host + (url[0] === '/' ? '' : '/') + url;
  let body;
  const hp = req.httpParams;
  const encParam = (v) => (/%[0-9A-Fa-f]{2}/.test(String(v)) && /^[\x21-\x7e]*$/.test(String(v)) ? String(v) : pct(v, reqEnc));
  const qs = isObj(hp) ? Object.entries(hp).map(([k, v]) => k + '=' + encParam(v)).join('&') : typeof hp === 'string' ? hp : '';
  const post = req.POST === true || req.POST === 'true' || req.POST === 1;
  if (post) body = qs;
  else if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  return {
    url: encUrl(url, reqEnc), method: post ? 'POST' : 'GET', body,
    headers: Object.assign({}, config.httpHeaders, isObj(req.httpHeaders) ? req.httpHeaders : {}),
    forbidCookie: !!req.forbidCookie, encode: ENC[String(A.responseEncode)],
  };
}

// ---------------- 动作执行 ----------------
async function runAction(kind, A, S, st, input) {
  const config = mkConfig(S, A);
  const params = Object.assign({ keyWord: st.keyword, pageIndex: 1, offset: 0, filters: {}, queryInfo: {}, nativeTool: st.native }, input.params || {});
  const env = { params, config, logs: st.logs, cache: st.cache };
  const isJson = A.responseFormatType === 'json';
  let lastReq = null, lastRes = null;
  const fetchParse = async (req) => {
    const key = req.method + ' ' + req.url + ' ' + (req.body || '');
    let res = st.http.get(key);
    if (req.response !== undefined) res = { status: 200, url: /^https?:/.test(req.url) ? req.url : config.host + '/', text: typeof req.response === 'string' ? req.response : JSON.stringify(req.response), direct: req.response };
    if (!res) { res = await http(req, st.timeout); st.http.set(key, res); }
    lastReq = req; lastRes = res;
    params.responseUrl = res.url;
    let text = res.text, json;
    if (A.responseFormatType === 'base64str') text = Buffer.from(text.trim(), 'base64').toString('utf8');
    if (isJson || /^\s*[\[{]/.test(text)) { try { json = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { if (isJson) throw new Error('响应非 JSON：' + text.slice(0, 80)); } }
    return { text, json, ctx: mkCtx(text, isJson ? json : (json !== undefined && /^\s*\$/.test(A.list || A.content || A.bookName || '') ? json : undefined), res.url) };
  };

  let page = await fetchParse(buildRequest(A, env, input.result));
  let out;
  const custom = A.JSParser || (A.parserID === 'JS' && A.responseJavascript);
  if (isObj(lastRes.direct) || Array.isArray(lastRes.direct)) {
    out = lastRes.direct;
    if (LIST_ACTIONS.has(kind)) out = { list: Array.isArray(out) ? out : Array.isArray(out.list) ? out.list : [] };
    else if (kind === 'chapterContent') out = { content: stringify(out.content !== undefined ? out.content : out) };
  } else if (custom) {
    for (let round = 0; ; round++) {
      const data = page.json !== undefined && isJson ? page.json : page.text;
      out = A.JSParser ? runFn(A.JSParser, null, env, [config, params, data], kind + '.JSParser')
        : runFn(A.responseJavascript, A.responseFunction, env, [config, params, data], kind + '.responseJavascript');
      if (!(out && out.autoRequestMore) || round >= 5) break;
      params.lastResponse = page.text;
      page = await fetchParse(out.nextPageUrl
        ? buildRequest({ requestInfo: absUrl(String(out.nextPageUrl), new URL(lastRes.url)), host: A.host, responseEncode: A.responseEncode, requestParamsEncode: A.requestParamsEncode }, env, '')
        : buildRequest(A, env, input.result));
    }
    if (LIST_ACTIONS.has(kind)) out = { list: Array.isArray(out) ? out : out && Array.isArray(out.list) ? out.list : [], next: out && out.nextPageUrl };
    else if (kind === 'chapterContent') out = { content: stringify(typeof out === 'object' && out && 'content' in out ? out.content : out), next: out && out.nextPageUrl };
    else out = isObj(out) ? out : {};
  } else {
    const fields = FIELDS[kind] || [];
    const get = (rule, c, f) => {
      let v;
      try { v = stringify(fieldValue(rule, c, env, kind + '.' + f)); } catch (e) {
        if (e instanceof SimError) throw e;
        st.fieldErrs.add(e.message); v = ''; // App 中单字段 JS 异常只置空该字段
      }
      return URL_FIELDS.has(f) ? firstLine(v) : v; // 保持原值（相对路径到请求时按 host 补全，与 App 一致）
    };
    if (LIST_ACTIONS.has(kind)) {
      const items = listItems(A.list || '', page.ctx, env, kind + '.list');
      out = { list: items.map((ic) => {
        const o = {};
        for (const f of fields) {
          if (typeof A[f] === 'string' && A[f]) o[f] = get(A[f], ic, f);
          else if (ic.kind === 'json' && isObj(ic.value) && ic.value[f] !== undefined) o[f] = URL_FIELDS.has(f) ? firstLine(stringify(ic.value[f])) : stringify(ic.value[f]);
        }
        return o;
      }) };
    } else {
      out = {};
      for (const f of fields) if (typeof A[f] === 'string' && A[f]) out[f] = get(A[f], page.ctx, f);
    }
    if (typeof A.nextPageUrl === 'string' && A.nextPageUrl) out.next = get(A.nextPageUrl, page.ctx, 'nextPageUrl');
  }
  if (out.next) out.next = absUrl(stringify(out.next), new URL(lastRes.url));
  return { req: lastReq, res: lastRes, out };
}

// ---------------- probe ----------------
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
// 通用词命中面广，评估可用性；指定书名（单个）时额外检查同名命中（App 换源只列同名书）
const pickKeywords = (S, kw) => String(kw || ({ comic: '海贼王,恋爱', video: '庆余年,我的' }[S.sourceType] || '都市,我的')).split(',').map((x) => x.trim()).filter(Boolean);

async function probeSource(alias, S, opt) {
  const kws = pickKeywords(S, opt.keyword);
  const checkExact = !!opt.keyword && kws.length === 1;
  const st = { keyword: kws[0], timeout: opt.timeout, logs: [], cache: {}, http: new Map() };
  st.native = nativeTool(st);
  st.fieldErrs = new Set();
  const R = { alias, name: S.sourceName || alias, type: S.sourceType || 'text', url: S.sourceUrl, keyword: st.keyword, stages: [], verdict: '', note: '' };
  const L = lint({ [alias]: S });
  R.lint = lintLevel(L);
  R.lintMsgs = L.filter((x) => x.level !== 'info').map((x) => x.level + ': ' + x.msg);
  const t0 = Date.now();
  const stage = (name, ok, msg) => { R.stages.push({ name, ok, msg }); return ok; };
  let cur = 'search';
  try {
    if (R.lint === 'fail' && L.some((x) => /缺 (searchBook|chapterList|chapterContent)$|JS 语法/.test(x.msg))) throw new Error('lint 失败：' + L.find((x) => x.level === 'fail').msg);
    // 1. 入口：搜索；无搜索时用发现首个分类
    let book;
    const sb = S.searchBook || {};
    if (!isStub(sb) || sb.JSParser) {
      let r, list = [];
      for (const kw of kws) {
        st.keyword = R.keyword = kw;
        r = await runAction('searchBook', sb, S, st, {});
        list = r.out.list.filter((b) => b.bookName || b.detailUrl);
        if (list.length) break;
      }
      const exact = list.find((b) => String(b.bookName || '').trim() === st.keyword);
      book = exact || list.find((b) => b.bookName && b.bookName.includes(st.keyword)) || list[0];
      if (checkExact) R.exact = !!exact;
      const miss = checkExact && !exact ? `（无同名《${st.keyword}》，App 换源列表不会出现）` : '';
      if (!stage('search', list.length > 0, list.length ? `${list.length} 项 | 《${short(book.bookName, 20)}》${short(book.author, 10)} → ${short(book.detailUrl, 70)}${miss}` : `0 项（关键词「${kws.join('、')}」均未命中或规则失效）${r.res ? ' ← ' + short(r.req.url, 80) : ''}`)) throw new Stop();
    } else {
      cur = 'world';
      const cats = Object.entries(S.bookWorld || {}).filter(([, v]) => isObj(v));
      if (!cats.length) { stage('search', false, '无搜索且无发现'); throw new Stop(); }
      const [cname, A] = cats[0];
      const filters = {};
      for (const g of parseFilters((A.moreKeys || {}).requestFilters)) if (g.items.length) { filters[g.key] = g.items[0].value; filters[g.key.replace(/^_/, '')] = g.items[0].value; }
      const r = await runAction('bookWorld', A, S, st, { params: { filters } });
      const list = r.out.list.filter((b) => b.bookName || b.detailUrl);
      if (!stage('world', list.length > 0, `[${cname}] ${list.length} 项` + (list.length ? ` | 《${short(list[0].bookName, 20)}》→ ${short(list[0].detailUrl, 70)}` : ''))) throw new Stop();
      book = list[0];
    }
    const jsReq = (A) => isObj(A) && (A.requestJavascript || /^\s*@js:/.test(A.requestInfo || ''));
    if (!book.detailUrl && !jsReq(S.bookDetail) && !jsReq(S.chapterList)) { stage('detail', false, 'detailUrl 为空'); throw new Stop(); }
    // 2. 详情
    cur = 'detail';
    const bd = S.bookDetail || {};
    if (isStub(bd) && !bd.JSParser) stage('detail', true, '空桩，沿用搜索结果');
    else {
      const r = await runAction('bookDetail', bd, S, st, { result: book.detailUrl, params: { queryInfo: Object.assign({}, book) } });
      const got = Object.entries(r.out).filter(([k, v]) => k !== 'next' && v && typeof v !== 'object');
      for (const [k, v] of got) if (!(k === 'detailUrl' && !v)) book[k] = v;
      stage('detail', got.length > 0, got.length ? got.map(([k, v]) => `${k}=${short(v, 16)}`).join(' ') : '字段全空');
    }
    // 3. 目录
    cur = 'toc';
    const cl = S.chapterList || {};
    const maxPage = Number((cl.moreKeys || {}).maxPage) || 1;
    let chapters = [], pages = 0, next = null, seen = new Set();
    let r = await runAction('chapterList', cl, S, st, { result: book.detailUrl, params: { queryInfo: Object.assign({}, book) } });
    for (;;) {
      pages++;
      chapters = chapters.concat(r.out.list.filter((c) => c.title || c.url));
      seen.add(r.res.url);
      next = r.out.next;
      if (!next || seen.has(next) || pages >= Math.min(maxPage, opt.pages)) break;
      r = await runAction('chapterList', Object.assign({}, cl, { requestInfo: '%@result' }), S, st, { result: next, params: { queryInfo: Object.assign({}, book), pageIndex: pages + 1 } });
    }
    const ch = chapters[Math.min(opt.chapter, chapters.length - 1)];
    const relWarn = ch && ch.url && !/^(https?:)?\/|^@js|^[\w-]+$/.test(ch.url) ? ' ⚠ 相对路径无前导 /，App 按 host 补全' : '';
    if (!stage('toc', chapters.length > 0 && !!(ch && ch.url), chapters.length ? `${chapters.length} 章${pages > 1 ? `（${pages} 页${next && !seen.has(next) ? '，未翻完' : ''}）` : ''} | ${short(ch.title, 24)} → ${short(ch.url, 70)}${relWarn}` : '0 章')) throw new Stop();
    // 4. 正文
    cur = 'content';
    const cc = S.chapterContent || {};
    let content = '', cp = 0;
    const cseen = new Set();
    const nextChapter = chapters[chapters.indexOf(ch) + 1];
    r = await runAction('chapterContent', cc, S, st, { result: ch.url, params: { queryInfo: Object.assign({}, ch) } });
    for (;;) {
      cp++;
      content += (content ? '\n' : '') + (r.out.content || '');
      cseen.add(r.res.url);
      const n = r.out.next;
      if (!n || cseen.has(n) || (nextChapter && n === nextChapter.url) || cp >= opt.pages) break;
      r = await runAction('chapterContent', Object.assign({}, cc, { requestInfo: '%@result' }), S, st, { result: n, params: { queryInfo: Object.assign({}, ch), pageIndex: cp + 1 } });
    }
    const len = content.replace(/\s/g, '').length;
    const media = R.type !== 'text';
    stage('content', media ? len > 0 : len >= 50, `${len} 字${cp > 1 ? `（${cp} 页）` : ''} | 「${short(content, 40)}」`);
  } catch (e) {
    if (!(e instanceof Stop)) {
      R.error = e.message;
      stage(cur, false, (e instanceof NetError ? '网络 ' : e instanceof BlockError ? '拦截 ' : e instanceof SimError ? '模拟不支持 ' : '错误 ') + short(e.message, 140));
      R.verdict = e instanceof NetError && R.stages.length === 1 ? 'dead' : e instanceof BlockError ? 'blocked' : e instanceof SimError ? 'sim' : '';
    }
  }
  const bad = R.stages.find((s) => !s.ok);
  if (!R.verdict) R.verdict = bad ? 'broken' : 'ok';
  R.stage = bad ? bad.name : '';
  R.note = bad ? bad.msg : '';
  R.ms = Date.now() - t0;
  if (st.fieldErrs.size) R.lintMsgs.push(...[...st.fieldErrs].slice(0, 3).map((m) => 'warn: 字段异常（已置空）' + m));
  if (opt.verbose) R.logs = st.logs.slice(0, 20);
  return R;
}
class Stop extends Error {}

const VERDICT = { ok: '可用', broken: '失效', dead: '站点不可达', blocked: '被拦截', sim: '需 App 实测' };
function printProbe(R) {
  const lines = [`▶ ${R.name} [${R.type}] ${R.url || ''}  lint:${R.lint}  关键词:${R.keyword}`];
  for (const s of R.stages) lines.push(`  ${s.name.padEnd(8)} ${s.ok ? '✓' : '✗'} ${s.msg}`);
  for (const m of R.lintMsgs.slice(0, 5)) lines.push(`  · ${m}`);
  for (const m of R.logs || []) lines.push(`  log ${short(m, 160)}`);
  lines.push(`  ⇒ ${R.verdict} ${VERDICT[R.verdict] || ''}${R.stage ? ' @' + R.stage : ''}（${(R.ms / 1000).toFixed(1)}s）`);
  console.log(lines.join('\n'));
}

async function cmdProbe(files, f) {
  const opt = { keyword: f.keyword, timeout: Number(f.timeout) || 15, chapter: Number(f.chapter) || 0, pages: Number(f.pages) || 3, verbose: !!f.v };
  const tasks = [];
  for (const file of expandInputs(files)) {
    let J;
    try { J = readSource(file); } catch (e) { console.log(`▶ ${path.basename(file)}\n  ⇒ skip ${e.message}`); continue; }
    for (const [alias, S] of Object.entries(J)) if (!f.alias || String(f.alias).split(',').includes(alias)) tasks.push([alias, S, file]);
  }
  const results = [];
  let k = 0;
  const worker = async () => { while (k < tasks.length) { const [alias, S, file] = tasks[k++]; const R = await probeSource(alias, S, opt); R.file = path.basename(file); printProbe(R); results.push(R); } };
  await Promise.all(Array.from({ length: Math.max(1, Number(f.jobs) || 4) }, worker));
  if (results.length > 1) {
    const cnt = {};
    for (const R of results) cnt[R.verdict] = (cnt[R.verdict] || 0) + 1;
    console.log('\n== 汇总 ' + results.length + ' 源：' + Object.entries(cnt).map(([v, n]) => `${v}(${VERDICT[v]}) ${n}`).join(' · '));
    for (const R of results.sort((a, b) => a.verdict.localeCompare(b.verdict))) {
      console.log(`${R.verdict.padEnd(8)} ${short(R.name, 18).padEnd(20)} ${R.type.padEnd(6)} ${R.stage ? '@' + R.stage.padEnd(8) : ''.padEnd(9)} ${short(R.note, 60)}`);
    }
  }
  if (f.report) fs.writeFileSync(f.report, JSON.stringify(results, null, 2));
  return results.every((R) => R.verdict === 'ok') ? 0 : 1;
}

// ---------------- try / sniff ----------------
async function loadPage(target, f) {
  if (fs.existsSync(target)) {
    const { text, charset } = decodeBody(fs.readFileSync(target), f.encode);
    return { status: 'file', url: f.base || 'http://localhost/', text, charset, ms: 0 };
  }
  const headers = {};
  for (const h of [].concat(f.header || [])) { const k = h.indexOf(':'); if (k > 0) headers[h.slice(0, k).trim()] = h.slice(k + 1).trim(); }
  const enc = f.encode ? f.encode.toLowerCase().replace('gb2312', 'gbk') : '';
  const body = f.post ? f.post.split('&').map((kv) => { const k = kv.indexOf('='); return k < 0 ? kv : kv.slice(0, k) + '=' + pct(kv.slice(k + 1), enc || 'utf-8'); }).join('&') : undefined;
  return http({ url: encUrl(target, enc || 'utf-8'), method: f.post ? 'POST' : 'GET', body, headers, encode: enc || undefined }, Number(f.timeout) || 15);
}

async function cmdTry(args, f) {
  const res = await loadPage(args[0], f);
  if (f.save) fs.writeFileSync(f.save, res.text);
  let json;
  if (/^\s*[\[{]/.test(res.text)) { try { json = JSON.parse(res.text); } catch (e) { /* html */ } }
  const c = mkCtx(res.text, json, res.url);
  const st = { logs: [], cache: {} };
  const env = { params: { keyWord: '', pageIndex: 1, filters: {}, queryInfo: {}, responseUrl: res.url, nativeTool: nativeTool(st) }, config: { host: new URL(res.url).origin, httpHeaders: {} }, logs: st.logs, cache: st.cache };
  console.log(`# ${res.status} ${res.url} ${res.charset} ${res.text.length}B ${json !== undefined ? 'json' : 'html'}`);
  const rules = args.slice(1).map((a) => { const m = /^(\w+)=([\s\S]+)$/.exec(a); return m ? [m[1], m[2]] : ['value', a]; });
  const show = (rule, ctx, k) => {
    const v = stringify(fieldValue(rule, ctx, env, k));
    return URL_FIELDS.has(k) ? absUrl(v, new URL(res.url)) : v;
  };
  if (f.list) {
    const items = listItems(f.list, c, env, 'list');
    console.log(`list → ${items.length} 项`);
    items.slice(0, Number(f.n) || 5).forEach((ic, i) => {
      console.log(`[${i}]` + (rules.length ? '' : ' ' + short(ic.kind === 'json' ? JSON.stringify(ic.value) : outer(ic.node), 200)));
      for (const [k, r] of rules) console.log(`  ${k}: ${short(show(r, ic, k), 200)}`);
    });
  } else if (rules.length) {
    for (const [k, r] of rules) {
      const v = show(r, c, k);
      console.log(`${k}: ${v.length > 600 ? v.slice(0, 600) + `…（共 ${v.length} 字）` : v}`);
    }
  } else if (json === undefined) {
    const t = xpath('//title', c.node, c.root);
    console.log('title: ' + nodesText(t));
  } else console.log(short(JSON.stringify(json), 800));
  for (const m of st.logs) console.log('log ' + m);
  return 0;
}

async function cmdSniff(args, f) {
  const res = await loadPage(args[0], f);
  const d = parseHTML(res.text);
  const q = (x) => xpath(x, d, d);
  const out = [`# ${res.status} ${res.url}  charset=${res.charset}  ${res.text.length}B  ${res.ms}ms`];
  out.push('title: ' + short(nodesText(q('//title')), 80));
  if (/name=["']?viewport/i.test(res.text)) out.push('移动版页面（含 viewport）');
  const og = q("//meta[starts-with(@property,'og:')]").map((m) => m.attrs.property.replace(/^og:/, '') + '=' + short(m.attrs.content, 30));
  if (og.length) out.push('og: ' + og.join(' | '));
  for (const form of q('//form')) {
    const inputs = xpath('.//input|.//select', form, form).map((i) => (i.attrs.name || '?') + (i.attrs.type === 'hidden' ? '=' + short(i.attrs.value, 20) : '')).join(' ');
    out.push(`form: ${(form.attrs.method || 'GET').toUpperCase()} ${absUrl(form.attrs.action || '', new URL(res.url)) || '(当前页)'}  [${inputs}]`);
  }
  const pat = new Map();
  for (const a of q('//a[@href]')) {
    let u;
    try { u = new URL(a.attrs.href, res.url); } catch (e) { continue; }
    if (!/^https?:/.test(u.protocol)) continue;
    const key = (u.host === new URL(res.url).host ? '' : u.host) + u.pathname.replace(/\d+/g, '{n}') + (u.search ? '?…' : '');
    const e = pat.get(key) || { n: 0, ex: u.href, txt: readable(a) };
    e.n++;
    pat.set(key, e);
  }
  out.push('链接模式（前 12）:');
  for (const [k, e] of Array.from(pat).sort((a, b) => b[1].n - a[1].n).slice(0, 12)) out.push(`  ${String(e.n).padStart(4)}  ${k}   例：${short(e.txt, 16)} ${e.ex}`);
  const api = Array.from(new Set((res.text.match(/["'`](?:https?:)?\/\/?[^"'`\s<>]*(?:\/api\/|\.json|ajax|search)[^"'`\s<>]*["'`]/gi) || []).map((s) => s.slice(1, -1)))).slice(0, 10);
  if (api.length) out.push('疑似接口: ' + api.join('  '));
  const bodyText = nodesText(q('//body')).length;
  if (bodyText < 300 && q('//script').length > 3) out.push('⚠ 正文极少且脚本多：疑似 SPA，找接口或改 webView');
  console.log(out.join('\n'));
  return 0;
}

// ---------------- CLI ----------------
const USAGE = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).map((l) => l.replace(/^ \*\s?/, '')).join('\n');
const BOOL_FLAGS = new Set(['touch', 'v', 'verbose', 'insecure']);

function parseArgs(argv) {
  const pos = [], f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v') f.v = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2) === 'verbose' ? 'v' : a.slice(2);
      if (BOOL_FLAGS.has(k)) f[k] = true;
      else { const v = argv[++i]; f[k] = k in f ? [].concat(f[k], v) : v; }
    } else pos.push(a);
  }
  return { pos, f };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, f } = parseArgs(rest);
  if (['probe', 'try', 'sniff'].includes(cmd) && !process.env.NODE_USE_ENV_PROXY &&
      (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)) {
    const r = require('child_process').spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1' }) });
    return r.status === null ? 1 : r.status;
  }
  if (cmd === 'lint' && pos.length) {
    let worst = 0;
    for (const file of expandInputs(pos)) {
      let R;
      try { R = lint(readSource(file)); } catch (e) { R = [{ alias: '-', level: 'fail', msg: e.message }]; }
      const lv = lintLevel(R);
      worst = Math.max(worst, lv === 'fail' ? 2 : lv === 'warn' ? 1 : 0);
      console.log(`${lv.toUpperCase()} ${file}`);
      for (const r of R) console.log(`  ${r.level.padEnd(4)} [${r.alias}] ${r.msg}`);
    }
    return worst;
  }
  if (cmd === 'fmt' && pos.length === 2) {
    const J = readSource(pos[0]);
    const out = {};
    for (const [alias, S] of Object.entries(J)) if (!f.alias || f.alias === alias) out[alias] = isObj(S) ? fmtSource(S, f) : S;
    if (!Object.keys(out).length) throw new Error('无匹配别名 ' + f.alias);
    const sha = writeSource(out, pos[1]);
    const lv = lintLevel(lint(out));
    console.log(`${pos[1]}  ${Object.keys(out).length} 源  lint:${lv}${sha ? '  sha256 ' + sha : ''}`);
    return lv === 'fail' ? 2 : 0;
  }
  if (f.insecure) { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; process.removeAllListeners('warning'); }
  if (cmd === 'probe' && pos.length) return cmdProbe(pos, f);
  if (cmd === 'try' && pos.length) return cmdTry(pos, f);
  if (cmd === 'sniff' && pos.length) return cmdSniff(pos, f);
  console.log(USAGE);
  return 1;
}

module.exports = { lint, fmtSource, readSource, writeSource, parseHTML, xpath, jsonPath, fieldValue, listItems, probeSource };

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error('ERROR: ' + (e && e.message ? e.message : String(e))); process.exit(2); });
}
