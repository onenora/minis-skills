// 用心书源通用验证引擎（本地 JSONPath 模拟 + 可选 App Web API 调试链）
// 用法:
//   node heart-verify.js <书源.json> [--keyword 关键词] [--silent]
//   node heart-verify.js <书源.json> [--app-debug [baseUrl]] [--keyword 关键词] [--silent]
// 说明:
//   - 默认本地模式仅支持 engine=jsonpath，使用 mock App 桩能力，不能替代 App 实测
//   - --app-debug 模式通过用心读书 App Web API（默认 http://localhost:8080）执行真实链路调试
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const vm = require('vm');

const DEFAULT_APP_BASE_URL = 'http://localhost:8080';
const APP_DEBUG_TIMEOUT_MS = 30000;
const APP_PING_TIMEOUT_MS = 5000;
const APP_GUIDANCE = '请在「用心读书」App 进入书源列表，点击右上角「电脑写源」，再点击「开始连接」。';
const TRACE_KEYS = new Set([
  'httpStatus',
  'errorMag',
  'jsParsing',
  'responseBody',
  'responseNewBody',
  'originalUrl',
  'newUrl',
]);
const LIST_KEYS = ['list', 'items', 'books', 'chapters', 'chapterList'];
const CANCEL_TYPE_BY_ENDPOINT = {
  '/site/search': '0',
  '/site/bookinfo': '0',
  '/site/chapter': '1',
  '/site/content': '2',
  '/site/finder': '3',
};
const UA = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
};

// ---------- CLI 参数解析 ----------
function parseArgs(argv) {
  let srcPath = '';
  let keyword = '测试';
  let silent = false;
  let appDebug = false;
  let appBaseUrl = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--silent') {
      silent = true;
    } else if (arg === '--keyword') {
      if (i + 1 >= argv.length) {
        console.error('[FAIL] --keyword 缺少参数值');
        process.exit(2);
      }
      keyword = argv[++i];
    } else if (arg.startsWith('--keyword=')) {
      keyword = arg.slice('--keyword='.length);
    } else if (arg === '--app-debug') {
      appDebug = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        // 若尚未拿到书源路径且 next 是存在的本地文件而非 URL，不误吞为 baseUrl
        if (srcPath || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(next) || !fs.existsSync(next)) {
          appBaseUrl = argv[++i];
        }
      }
    } else if (arg.startsWith('--app-debug=')) {
      appDebug = true;
      appBaseUrl = arg.slice('--app-debug='.length);
    } else if (!arg.startsWith('-') && !srcPath) {
      srcPath = arg;
    }
  }
  return { srcPath, keyword, silent, appDebug, appBaseUrl };
}

// ---------- 输入解包 ----------
function unwrapSource(raw, notes) {
  let data = raw;
  if (Array.isArray(data)) {
    if (data.length === 0) throw new Error('输入 JSON 为空数组');
    notes.push(`输入为数组（共 ${data.length} 项），已解包 array[0]`);
    data = data[0];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('书源根节点必须是 JSON 对象');
  }
  const hasRuleData = Object.prototype.hasOwnProperty.call(data, 'ruleData');
  const hasSite = Object.prototype.hasOwnProperty.call(data, 'site');
  if (hasRuleData && hasSite) {
    throw new Error('书源 wrapper 不能同时包含 ruleData 与 site');
  }
  if (hasRuleData) {
    if (!data.ruleData || typeof data.ruleData !== 'object' || Array.isArray(data.ruleData)) {
      throw new Error('SiteModel.ruleData 必须是 JSON 对象');
    }
    notes.push('已解包 SiteModel.ruleData wrapper');
    return data.ruleData;
  }
  if (hasSite) {
    if (!data.site || typeof data.site !== 'object' || Array.isArray(data.site)) {
      throw new Error('legacy site wrapper 的 site 必须是 JSON 对象');
    }
    notes.push('已解包 legacy { site } wrapper');
    return data.site;
  }
  return data;
}

// ---------- App 桩环境（本地模拟专用） ----------
const store = {};
const get = k => (store[k] !== undefined ? store[k] : '');
const put = (k, v) => { store[k] = v; return v; };

function formatTimestamp(ts, fmt) {
  const num = Number(ts);
  const ms = num > 1e12 ? num : num * 1000;
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const p = n => String(n).padStart(2, '0');
  const f = fmt || 'yyyy-MM-dd HH:mm:ss';
  return f
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, p(d.getMonth() + 1))
    .replace(/dd/g, p(d.getDate()))
    .replace(/HH/g, p(d.getHours()))
    .replace(/mm/g, p(d.getMinutes()))
    .replace(/ss/g, p(d.getSeconds()))
    .replace(/SSS/g, String(d.getMilliseconds()).padStart(3, '0'));
}

const app = {
  md5: s => crypto.createHash('md5').update(String(s)).digest('hex'),
  sha1: s => crypto.createHash('sha1').update(String(s)).digest('hex'),
  sha256: s => crypto.createHash('sha256').update(String(s)).digest('hex'),
  sha512: s => crypto.createHash('sha512').update(String(s)).digest('hex'),
  base64: {
    encode: s => Buffer.from(String(s)).toString('base64'),
    decode: s => Buffer.from(String(s), 'base64').toString('utf8'),
    decodeToBytes: s => Array.from(Buffer.from(String(s), 'base64')),
  },
  unicode: {
    encode: s => String(s).replace(/[\u4e00-\u9fff]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')),
    decode: s => String(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
  },
  time: (ts, fmt) => formatTimestamp(ts, fmt),
  nlp: { chs: s => String(s), cht: s => String(s) },
  uuid: () => (crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000'),
  log: () => {},
  toast: () => {},
  showDialog: () => {},
  isJson: s => { try { JSON.parse(String(s)); return true; } catch { return false; } },
  jsonToString: o => JSON.stringify(o),
  stringToJson: s => JSON.parse(String(s)),
  strToBytes: s => Array.from(Buffer.from(String(s), 'utf8')),
  bytesToStr: (bytes, enc) => {
    const e = String(enc || 'utf8').toLowerCase();
    const nodeEnc = (e === 'utf-8' || e === 'utf8' || e === 'gbk') ? 'utf8' : e;
    return Buffer.from(bytes || []).toString(Buffer.isEncoding(nodeEnc) ? nodeEnc : 'utf8');
  },
  aes: {
    encrypt: s => Buffer.from(String(s)).toString('base64'),
    decrypt: s => Buffer.from(String(s), 'base64').toString('utf8'),
  },
  sp: {
    get: k => (store[k] !== undefined ? store[k] : ''),
    put: (k, v) => { store[k] = v; },
    delete: k => { delete store[k]; },
  },
};
const OS = {
  ...app,
  aesEncrypt: app.aes.encrypt,
  aesDecrypt: app.aes.decrypt,
  chs: app.nlp.chs,
  cht: app.nlp.cht,
  putValue: app.sp.put,
  getValue: app.sp.get,
  deleteValue: app.sp.delete,
};
const OSDocument = {
  load: () => ({ select: () => ({ text: () => '', attr: () => '', select() { return this; } }), title: () => '' }),
};

// ---------- publicJavascript 注入（顶层不暴露预解析 config 对象） ----------
function loadPublicJavascript(pubCode) {
  const pub = {};
  if (!pubCode || !String(pubCode).trim()) return pub;
  const code = String(pubCode);
  const reserved = new Set(['get', 'put', 'app', 'App', 'OS', 'OSDocument', 'console', '__exports']);
  const declaredNames = new Set();
  for (const m of code.matchAll(/(?:^|[\s;{}])(?:function\*?|var|let|const|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!reserved.has(m[1])) declaredNames.add(m[1]);
  }
  const exportLines = [...declaredNames].map(
    n => `try { if (typeof ${n} !== 'undefined') __exports[${JSON.stringify(n)}] = ${n}; } catch (_) {}`
  );
  const sandbox = {
    get,
    put,
    app,
    App: app,
    OS,
    OSDocument,
    console: { log: app.log, warn: app.log, error: app.log },
    // 注意：顶层语句不能依赖预解析的 config 对象
  };
  vm.createContext(sandbox);
  const wrapped = `${code}\n;(() => {\n  const __exports = Object.create(null);\n  ${exportLines.join('\n  ')}\n  return __exports;\n})();`;
  const exported = vm.runInContext(wrapped, sandbox, { timeout: 5000 });
  if (exported && typeof exported === 'object') {
    for (const [k, v] of Object.entries(exported)) {
      if (v !== undefined) pub[k] = v;
    }
  }
  for (const [k, v] of Object.entries(sandbox)) {
    if (!['get', 'put', 'app', 'App', 'OS', 'OSDocument', 'console'].includes(k) && v !== undefined && !(k in pub)) {
      pub[k] = v;
    }
  }
  return pub;
}

// ---------- 模板替换 & @tools{} ----------
function getNested(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = String(path).split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function parseToolArgs(argsStr) {
  if (!argsStr) return [];
  const args = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === ',') {
      args.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function evalToolsExpr(expr) {
  const m = String(expr).trim().match(/^(\w+)(?:\(([\s\S]*)\))?$/);
  if (!m) return `@tools{${expr}}`;
  const name = m[1];
  const args = parseToolArgs((m[2] || '').trim());
  switch (name) {
    case 'timestamp':
      return String(Math.floor(Date.now() / 1000));
    case 'timestampMs':
      return String(Date.now());
    case 'formatTime':
      return formatTimestamp(Date.now(), args[0] || 'YYYY-MM-dd HH:mm:ss');
    case 'urlEncode':
      return encodeURIComponent(args[0] || '');
    case 'urlDecode':
      return decodeURIComponent(args[0] || '');
    case 'base64Encode':
      return Buffer.from(args[0] || '').toString('base64');
    case 'base64Decode':
      return Buffer.from(args[0] || '', 'base64').toString('utf8');
    case 'md5':
      return app.md5(args[0] || '');
    case 'sha256':
      return app.sha256(args[0] || '');
    case 'uuid':
      return app.uuid();
    case 'random': {
      const min = Number(args[0]) || 0;
      const max = Number(args[1]) || 100;
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    default:
      return '';
  }
}

function applyTemplates(text, vars = {}, encodeKeyword = false) {
  if (typeof text !== 'string' || !text) return text;
  // V2 顺序: @get{} -> ${} -> @{} -> @tools{}
  let out = text.replace(/@get\{([^}]+)\}/g, (_, key) => {
    const val = getNested(store, key.trim());
    if (val === undefined || val === null) return '';
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  });
  out = out.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const k = key.trim();
    const val = getNested(vars, k);
    if (val === undefined || val === null) return `\${${key}}`;
    const s = String(val);
    return encodeKeyword && k === 'keyword' ? encodeURIComponent(s) : s;
  });
  out = out.replace(/@\{([^}]+)\}/g, (_, key) => {
    const k = key.trim();
    const val = getNested(vars, k);
    if (val === undefined || val === null) return '';
    const s = String(val);
    return encodeKeyword && k === 'keyword' ? encodeURIComponent(s) : s;
  });
  out = out.replace(/@tools\{([^}]+)\}/g, (_, expr) => evalToolsExpr(expr));
  return out;
}

// ---------- 简易 jsonpath（$.a.b[*] / $..key[*] / $.data[*]） ----------
function jp(obj, path) {
  if (obj == null || !path) return null;
  if (path.startsWith('$..')) {
    const key = path.slice(3).replace(/\[\*\]$/, '');
    const out = [];
    (function walk(o) {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === 'object') {
        if (key && o[key] !== undefined) {
          if (Array.isArray(o[key])) o[key].forEach(x => out.push(x));
          else out.push(o[key]);
        }
        Object.keys(o).forEach(k => walk(o[k]));
      }
    })(obj);
    return out;
  }
  const parts = path.replace(/^\$\.?/, '').split(/\.|\[\*\]|\.\./).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    const arrMatch = p.match(/^([^\[]+)\[(\d+)\]$/);
    if (arrMatch) {
      cur = cur[arrMatch[1]];
      if (Array.isArray(cur)) cur = cur[Number(arrMatch[2])];
      else return null;
    } else if (/^\d+$/.test(p) && Array.isArray(cur)) {
      cur = cur[Number(p)];
    } else {
      cur = cur[p];
    }
  }
  return cur;
}

// ---------- ## / # 正则后处理（不链式处理 ##@@##） ----------
function applyHashRegex(input, regexSpec) {
  const text = input === undefined || input === null ? '' : String(input);
  if (!regexSpec) return text;
  const doubleIdx = regexSpec.indexOf('##');
  const singleIdx = doubleIdx === -1 ? regexSpec.indexOf('#') : -1;
  if (doubleIdx === -1 && singleIdx === -1) {
    // 无分隔符：提取匹配分组 1 或全匹配
    try {
      const re = new RegExp(regexSpec, 'gs');
      const matches = [...text.matchAll(re)];
      if (matches.length === 0) return text;
      if (matches.length === 1) return matches[0][1] !== undefined ? matches[0][1] : matches[0][0];
      return matches.map(m => (m[1] !== undefined ? m[1] : m[0])).join('\n');
    } catch {
      return text;
    }
  }
  const isGlobal = doubleIdx !== -1;
  const sepIdx = isGlobal ? doubleIdx : singleIdx;
  const pattern = regexSpec.slice(0, sepIdx);
  const replacement = regexSpec.slice(sepIdx + (isGlobal ? 2 : 1));
  if (!pattern) return text;
  try {
    const re = new RegExp(pattern, isGlobal ? 'gs' : 's');
    if (!replacement) return text.replace(re, '');
    return text.replace(re, (_, ...args) => {
      const offsetIdx = args.findIndex(a => typeof a === 'number');
      const caps = offsetIdx === -1 ? args : args.slice(0, offsetIdx);
      let out = replacement;
      for (let i = 0; i < caps.length; i++) {
        if (typeof caps[i] === 'string') {
          out = out.replace(new RegExp(`\\$${i + 1}`, 'g'), caps[i]);
        }
      }
      return out;
    });
  } catch {
    return text;
  }
}

// ---------- 规则分割（按文本源码顺序解析 <js> 与 ##） ----------
function parseFieldRule(rule) {
  const ops = [];
  let i = 0;
  let baseEnd = rule.length;

  while (i < rule.length) {
    if (rule.slice(i, i + 4).toLowerCase() === '<js>') {
      if (baseEnd === rule.length) baseEnd = i;
      const closeIdx = rule.toLowerCase().indexOf('</js>', i + 4);
      if (closeIdx === -1) {
        ops.push({ type: 'js', code: rule.slice(i + 4) });
        i = rule.length;
      } else {
        ops.push({ type: 'js', code: rule.slice(i + 4, closeIdx) });
        i = closeIdx + 5;
      }
      continue;
    }
    if (rule.slice(i, i + 2) === '##') {
      if (baseEnd === rule.length) baseEnd = i;
      // 读取到下一个 <js> 或结尾
      const nextJsRel = rule.slice(i + 2).toLowerCase().indexOf('<js>');
      const endPos = nextJsRel === -1 ? rule.length : i + 2 + nextJsRel;
      ops.push({ type: 'regex', spec: rule.slice(i + 2, endPos) });
      i = endPos;
      continue;
    }
    i++;
  }
  return { baseRule: rule.slice(0, baseEnd).trim(), ops };
}

// ---------- HTTP 请求辅助（支持 GET/POST + params + header + response JS） ----------
function resolveUrl(rawUrl, host) {
  const u = String(rawUrl || '').trim();
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (host) return new URL(u, host).href;
  return u;
}

function mergeHeaders(srcHeader, secHeader, confHeader, vars) {
  const out = { ...UA };
  const hasSec = secHeader && typeof secHeader === 'object' && Object.keys(secHeader).length > 0;
  const baseHeader = hasSec ? secHeader : srcHeader;
  for (const h of [baseHeader, confHeader]) {
    if (!h || typeof h !== 'object') continue;
    for (const [k, v] of Object.entries(h)) {
      if (v !== undefined && v !== null) {
        out[k] = applyTemplates(String(v), vars, false);
      }
    }
  }
  return out;
}

function buildParams(secParams, confParams, vars) {
  const out = {};
  for (const p of [secParams, confParams]) {
    if (!p || typeof p !== 'object') continue;
    for (const [k, v] of Object.entries(p)) {
      if (v !== undefined && v !== null) {
        out[k] = typeof v === 'string' ? applyTemplates(v, vars, false) : String(v);
      }
    }
  }
  return out;
}

// ---------- 原点校验与 App Web API 客户端 ----------
function normalizeAppOrigin(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`App baseUrl 地址不是有效 URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`App baseUrl 仅允许 http/https 协议: ${input}`);
  }
  if (url.username || url.password) {
    throw new Error(`App baseUrl 不允许包含 userinfo: ${input}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`App baseUrl 只允许 origin，不允许 path/query/hash: ${input}`);
  }
  if (!isAllowedAppHost(url.hostname)) {
    throw new Error(`App baseUrl 仅允许本机回环或 RFC1918 内网地址: ${url.hostname}`);
  }
  return url.origin;
}

function isAllowedAppHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p))) return false;
  const octets = parts.map(Number);
  if (octets.some(v => v < 0 || v > 255)) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function encodeForm(body) {
  return Object.entries(body)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('&');
}

function isRecord(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function parseResultData(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function isTrace(item) {
  return Object.keys(item).some(k => TRACE_KEYS.has(k));
}

function extractItems(value) {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return undefined;
  for (const key of LIST_KEYS) {
    if (Array.isArray(value[key])) return value[key].filter(isRecord);
  }
  return undefined;
}

function getBusinessItems(res) {
  const parsed = parseResultData(res && res.data ? res.data.resultData : undefined);
  const resultItems = extractItems(parsed);
  if (resultItems !== undefined) return resultItems;
  const raw = res && res.data && Array.isArray(res.data.list) ? res.data.list : [];
  return raw.filter(item => isRecord(item) && !isTrace(item));
}

function getBusinessResult(chain, res) {
  const parsed = parseResultData(res && res.data ? res.data.resultData : undefined);
  if (chain !== 'content' || !isRecord(parsed)) return parsed;
  if (typeof parsed.contents === 'string') return parsed.contents;
  if (typeof parsed.content === 'string') return parsed.content;
  return parsed;
}

function transportFailureReason(res) {
  const list = res && res.data && Array.isArray(res.data.list) ? res.data.list : [];
  const traces = list.filter(isRecord);
  const formalTraces = traces.filter(t => Number(t.responseType) === 1);
  const candidates = formalTraces.length > 0 ? formalTraces : traces;
  for (const trace of candidates) {
    const errMsg = typeof trace.errorMag === 'string' ? trace.errorMag.trim() : '';
    if (errMsg) return errMsg;
    const respBody = typeof trace.responseBody === 'string' ? trace.responseBody.trim() : '';
    const status = typeof trace.httpStatus === 'number' ? trace.httpStatus : Number.NaN;
    if (status <= 0 && respBody) return respBody;
    if (Number.isFinite(status) && (status < 200 || status >= 300)) {
      return `HTTP 请求失败（状态码：${status}）`;
    }
  }
  return undefined;
}

async function bestEffortCancel(base, type) {
  try {
    await fetch(`${base}/api/site/cancelRequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: encodeForm({ type }),
      redirect: 'error',
    });
  } catch {
    // best effort
  }
}

async function callAppEndpoint(base, endpoint, body, timeoutMs = APP_DEBUG_TIMEOUT_MS) {
  const url = `${base}/api${endpoint}`;
  const controller = new AbortController();
  let timedOut = false;
  const onSig = () => controller.abort(new Error('SIGINT'));
  process.once('SIGINT', onSig);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: encodeForm(body),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      throw new Error(`App 接口 HTTP ${res.status} ${res.statusText}（${url}）。${APP_GUIDANCE}`);
    }
    const json = await res.json();
    if (!isRecord(json) || typeof json.code !== 'string' || !('data' in json)) {
      throw new Error(`App 返回非预期响应结构: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
  } catch (err) {
    if (controller.signal.aborted || (err && err.name === 'AbortError')) {
      const cancelType = CANCEL_TYPE_BY_ENDPOINT[endpoint];
      if (cancelType) await bestEffortCancel(base, cancelType);
      if (timedOut) throw new Error(`App 接口请求超时（${timeoutMs}ms）：${url}`);
      throw new Error(`App 接口请求已取消：${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSig);
  }
}

function normalizeCandidateUrls(item, keys) {
  if (!isRecord(item)) return undefined;
  const out = { ...item };
  for (const k of keys) {
    if (typeof out[k] === 'string') {
      out[k] = out[k].split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
    }
  }
  return out;
}

function isRequestable(val) {
  const v = typeof val === 'string' ? val.trim() : '';
  return Boolean(v && !/^\d+$/.test(v) && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(v) && !/\s/.test(v));
}

function hasNameAndUrl(item, keys) {
  if (!isRecord(item)) return false;
  const hasName = [item.name, item.bookName, item.chapterName, item.catalogName].some(
    v => (typeof v === 'string' ? v.trim().length > 0 : v !== null && v !== undefined)
  );
  return hasName && keys.some(k => isRequestable(item[k]));
}

function hasNonEmptyBookInfo(src) {
  const rbi = src.ruleBookInfo;
  if (!isRecord(rbi)) return false;
  const keys = ['request', 'bookName', 'bookAuthor', 'chapterListUrl', 'importUrl'];
  return keys.some(k => typeof rbi[k] === 'string' && rbi[k].trim() !== '') ||
    (isRecord(rbi.ruleExtra) && Object.values(rbi.ruleExtra).some(v => typeof v === 'string' && v.trim() !== ''));
}

async function runAppDebugMode(src, keyword, rawBaseUrl, silent) {
  const base = normalizeAppOrigin(rawBaseUrl || process.env.MRS_APP_BASE_URL || DEFAULT_APP_BASE_URL);
  const siteJson = JSON.stringify(src);
  let pass = 0;
  let fail = 0;
  const logStep = (name, ok, detail) => {
    if (!silent) console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
    if (ok) pass++;
    else fail++;
  };

  if (!silent) {
    console.log(`[App Debug] 连接 ${base}（canonical V2 siteJson，application/x-www-form-urlencoded;charset=utf-8）`);
  }

  // 0. /api/site/group 连通性探测
  const ping = await callAppEndpoint(base, '/site/group', {}, APP_PING_TIMEOUT_MS);
  if (ping.code !== '200') {
    logStep('连通性(/site/group)', false, ping.message || `code=${ping.code}`);
    process.exit(1);
  }
  logStep('连通性(/site/group)', true, 'App Web API 在线');

  // 1. /api/site/search
  const searchRes = await callAppEndpoint(base, '/site/search', { siteJson, keyword });
  if (!isRecord(searchRes.data) || !Array.isArray(searchRes.data.list) || !('resultData' in searchRes.data)) {
    logStep('搜索', false, '响应缺少 ResponsesModel 字段');
    process.exit(1);
  }
  const books = getBusinessItems(searchRes);
  const book = normalizeCandidateUrls(books[0], ['bookUrl', 'url', 'bookInfoUrl', 'infoUrl']);
  if (searchRes.code !== '200' || !hasNameAndUrl(book, ['bookUrl', 'url', 'bookInfoUrl', 'infoUrl'])) {
    const reason = searchRes.code === '200'
      ? (transportFailureReason(searchRes) || '搜索结果为空或缺少名称/可请求 URL')
      : searchRes.message;
    logStep('搜索', false, reason);
    process.exit(1);
  }
  logStep('搜索', true, `${books.length} 本 | ${String(book.bookName || book.name || '').slice(0, 24)}`);

  let bookContext = { ...book };

  // 2. /api/site/bookinfo（可选）
  if (hasNonEmptyBookInfo(src)) {
    const infoRes = await callAppEndpoint(base, '/site/bookinfo', {
      siteJson,
      bookJson: JSON.stringify(bookContext),
    });
    const infoData = getBusinessResult('bookinfo', infoRes);
    if (infoRes.code !== '200' || !isRecord(infoData)) {
      const reason = infoRes.code === '200'
        ? (transportFailureReason(infoRes) || '详情解析为空或核心字段缺失')
        : infoRes.message;
      logStep('详情', false, reason);
      process.exit(1);
    }
    for (const [k, v] of Object.entries(infoData)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') bookContext[k] = v;
    }
    logStep('详情', true, `${String(bookContext.bookName || bookContext.name || '').slice(0, 24)}`);
  }

  // 3. /api/site/chapter
  const chapRes = await callAppEndpoint(base, '/site/chapter', {
    siteJson,
    bookJson: JSON.stringify(bookContext),
  });
  const chapters = getBusinessItems(chapRes);
  const catalog = normalizeCandidateUrls(chapters[0], ['url', 'chapterUrl', 'catalogUrl', 'playUrl']);
  if (chapRes.code !== '200' || !hasNameAndUrl(catalog, ['url', 'chapterUrl', 'catalogUrl', 'playUrl'])) {
    const reason = chapRes.code === '200'
      ? (transportFailureReason(chapRes) || '章节列表为空或缺少名称/章节 URL')
      : chapRes.message;
    logStep('目录', false, reason);
    process.exit(1);
  }
  logStep('目录', true, `${chapters.length} 章 | ${String(catalog.chapterName || catalog.name || '').slice(0, 24)}`);

  // 4. /api/site/content
  const contentRes = await callAppEndpoint(base, '/site/content', {
    siteJson,
    bookJson: JSON.stringify(bookContext),
    catalogJson: JSON.stringify(catalog),
  });
  const text = getBusinessResult('content', contentRes);
  if (contentRes.code !== '200' || typeof text !== 'string' || text.trim().length < 10) {
    const reason = contentRes.code === '200'
      ? (transportFailureReason(contentRes) || '正文为空或少于 10 字符')
      : contentRes.message;
    logStep('正文', false, reason);
    process.exit(1);
  }
  logStep('正文', true, `${text.length} 字 | ${text.slice(0, 30).replace(/\s+/g, ' ')}`);

  console.log(`\n===== App Debug: ${pass}/${pass + fail} PASS (${src.siteName || '未命名'} v${src.version}) =====`);
  process.exit(fail ? 1 : 0);
}

// ---------- 主流程 ----------
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.srcPath || !fs.existsSync(opts.srcPath)) {
    console.error('用法: node heart-verify.js <书源.json> [--keyword 关键词] [--silent] [--app-debug [baseUrl]]');
    process.exit(2);
  }

  const notes = [];
  let src;
  try {
    const raw = JSON.parse(fs.readFileSync(opts.srcPath, 'utf8'));
    src = unwrapSource(raw, notes);
  } catch (e) {
    console.error('[FAIL] 读取/解包书源失败:', e.message);
    process.exit(2);
  }

  if (!opts.silent) {
    for (const n of notes) console.log(`[NOTE] ${n}`);
  }

  if (opts.appDebug) {
    await runAppDebugMode(src, opts.keyword, opts.appBaseUrl, opts.silent);
    return;
  }

  if ((src.ruleSearch || {}).engine !== 'jsonpath') {
    console.log('[SKIP] 仅支持 engine=jsonpath 的本地模拟（当前: ' + ((src.ruleSearch || {}).engine || '未配置') + '）；xpath/css 请使用 --app-debug 连接 App 实测');
    process.exit(0);
  }

  if (!opts.silent) {
    console.log('[NOTE] 本地模拟仅支持 engine=jsonpath（使用 mock App 桩能力，不能替代 App 实测）');
  }

  let pub = {};
  try {
    pub = loadPublicJavascript(src.publicJavascript || '');
  } catch (e) {
    console.log('[WARN] publicJavascript 注入失败:', e.message);
  }
  const PUB_NAMES = Object.keys(pub);
  const pubVals = PUB_NAMES.map(n => pub[n]);

  function runJs(js, scope) {
    const keys = ['get', 'put', 'app', 'App', 'OS', 'OSDocument', 'config', 'html', 'value', ...PUB_NAMES];
    const vals = [get, put, app, app, OS, OSDocument, scope.config, scope.html, scope.value, ...pubVals];
    const body = applyTemplates(String(js || '').replace(/^\s*@js:\s*/, ''), scope.config || {}, false);
    const fn = new Function(...keys, body);
    return fn(...vals);
  }

  function runRequestJs(js, conf) {
    const ret = runJs(js, { config: conf, html: '', value: '' });
    if (typeof ret === 'string' && ret.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(ret);
        if (parsed && typeof parsed === 'object') Object.assign(conf, parsed);
      } catch {}
    } else if (ret && typeof ret === 'object' && ret !== conf) {
      Object.assign(conf, ret);
    }
    return conf;
  }

  function field(node, rule, vars = {}) {
    if (typeof rule !== 'string' || rule === '') return '';
    const trimmed = rule.trim();
    const baseVars = { host: src.host || '', keyword: opts.keyword, ...vars };

    if (trimmed.startsWith('@js:')) {
      const htmlStr = typeof node === 'string' ? node : JSON.stringify(node || '');
      return runJs(trimmed, { config: baseVars, html: htmlStr, value: node });
    }

    const { baseRule, ops } = parseFieldRule(rule);
    let val;
    if (baseRule === '@all') {
      val = node;
    } else {
      const templatedBase = applyTemplates(baseRule, baseVars, false);
      if (templatedBase.includes('{{')) {
        val = templatedBase.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
          const extracted = jp(node, expr.trim());
          if (Array.isArray(extracted)) return extracted[0] !== undefined ? String(extracted[0]) : '';
          return extracted !== undefined && extracted !== null ? String(extracted) : '';
        });
      } else if (templatedBase.startsWith('.')) {
        return '';
      } else if (templatedBase.startsWith('$')) {
        val = jp(node, templatedBase);
      } else if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, templatedBase)) {
        val = node[templatedBase];
      } else if (templatedBase !== baseRule || ops.length === 0) {
        val = templatedBase;
      } else {
        val = node ? node[templatedBase] : '';
      }
    }

    if (val instanceof Array) {
      val = ops.length > 0 ? (val[0] !== undefined ? val[0] : '') : (val.length === 1 ? val[0] : val);
    }

    const htmlStr = typeof node === 'string' ? node : JSON.stringify(node || '');
    for (const op of ops) {
      if (op.type === 'js') {
        val = runJs(op.code, { config: baseVars, html: htmlStr, value: val });
      } else if (op.type === 'regex') {
        val = applyHashRegex(val, op.spec);
      }
    }
    return val;
  }

  async function requestJson(section, conf, vars = {}) {
    const mergedVars = { host: src.host || '', keyword: opts.keyword, pageIndex: '1', ...vars, ...conf };
    const method = String(conf.method || (section && section.method) || 'GET').toUpperCase();
    const headers = mergeHeaders(src.header, section && section.header, conf.header, mergedVars);
    const params = buildParams(section && section.params, conf.params, mergedVars);

    const rawUrl = conf.url || (section && section.url) || '';
    const templatedUrl = applyTemplates(rawUrl, mergedVars, true);
    let targetUrl = resolveUrl(templatedUrl, src.host);

    const fetchOpts = { method, headers };
    if (method === 'POST') {
      const ctKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-type');
      const ctVal = ctKey ? String(headers[ctKey]).toLowerCase() : '';
      if (typeof conf.body === 'string') {
        fetchOpts.body = conf.body;
      } else if (ctVal.includes('application/json')) {
        fetchOpts.body = JSON.stringify(params);
      } else {
        if (!ctKey) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=utf-8';
        fetchOpts.body = new URLSearchParams(params).toString();
      }
    } else if (Object.keys(params).length > 0) {
      const uObj = new URL(targetUrl);
      for (const [k, v] of Object.entries(params)) {
        if (!uObj.searchParams.has(k)) uObj.searchParams.set(k, v);
      }
      targetUrl = uObj.href;
    }

    const res = await fetch(targetUrl, fetchOpts);
    const rawText = await res.text();
    let finalData = rawText;
    if (section && section.response) {
      const transformed = runJs(section.response, { config: conf, html: rawText, value: rawText });
      if (transformed !== undefined && transformed !== null) finalData = transformed;
    }
    if (typeof finalData === 'string') {
      return JSON.parse(finalData);
    }
    return finalData;
  }

  let pass = 0;
  let fail = 0;
  const C = (name, ok, detail) => {
    if (!opts.silent) console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
    if (ok) pass++;
    else fail++;
  };

  // ===== 1. ruleSearch =====
  if (src.ruleSearch) {
    const conf = { keyword: opts.keyword, host: src.host || '', pageIndex: '1' };
    if (src.ruleSearch.request) runRequestJs(src.ruleSearch.request, conf);
    const r = await requestJson(src.ruleSearch, conf, { keyword: opts.keyword, pageIndex: '1' });
    const list = jp(r, src.ruleSearch.bookList) || [];
    C('搜索', r != null && list.length > 0, list.length + ' 本 | ' + String(field(list[0], src.ruleSearch.bookName) || '').slice(0, 16));
    if (list.length === 0) process.exit(1);
    const bookUrl = field(list[0], src.ruleSearch.bookUrl);
    C('bookUrl', !!bookUrl, String(bookUrl).slice(0, 66));

    // ===== 2. ruleBookInfo =====
    let chapUrl = bookUrl;
    if (hasNonEmptyBookInfo(src)) {
      const conf2 = { infoUrl: bookUrl, url: bookUrl, bookUrl, host: src.host || '' };
      if (src.ruleBookInfo.request) runRequestJs(src.ruleBookInfo.request, conf2);
      const r2 = await requestJson(src.ruleBookInfo, conf2, { infoUrl: bookUrl, bookUrl });
      const bn = field(r2, src.ruleBookInfo.bookName || '');
      C('详情', !!bn, bn + ' / ' + (field(r2, src.ruleBookInfo.bookAuthor || '') || ''));
      const clu = conf2.chapterListUrl || field(r2, src.ruleBookInfo.chapterListUrl || '');
      chapUrl = clu || src.ruleBookInfo.bookUrl || bookUrl;
    }

    // ===== 3. ruleChapter =====
    if (src.ruleChapter) {
      const conf3 = { bookUrl: chapUrl, url: chapUrl, host: src.host || '', pageIndex: '1' };
      if (src.ruleChapter.request) runRequestJs(src.ruleChapter.request, conf3);
      const r3 = await requestJson(src.ruleChapter, conf3, { bookUrl: chapUrl, pageIndex: '1' });
      const chs = jp(r3, src.ruleChapter.chapterList) || [];
      C('目录', chs.length > 0, chs.length + ' 章 | ' + String(field(chs[0], src.ruleChapter.chapterName || '') || '').slice(0, 20));
      const cid = field(chs[0], src.ruleChapter.chapterUrl || '');

      // ===== 4. ruleContent =====
      if (src.ruleContent && cid) {
        const conf4 = { bookUrl: chapUrl, chapterUrl: cid, url: resolveUrl(cid, src.host), host: src.host || '', pageIndex: '1' };
        if (src.ruleContent.request) runRequestJs(src.ruleContent.request, conf4);
        const r4 = await requestJson(src.ruleContent, conf4, { bookUrl: chapUrl, chapterUrl: cid, pageIndex: '1' });
        const raw = field(r4, src.ruleContent.contents);
        C('正文', raw && String(raw).length > 50, String(raw).length + ' 字 | ' + String(raw).slice(0, 30).replace(/\s+/g, ' '));
      }
    }
  }

  // ===== 5. ruleFinder =====
  if (Array.isArray(src.ruleFinder) && src.ruleFinder.length) {
    const buildFinderConf = (f, selectedOptions) => {
      const selectList = [];
      const filters = {};
      const conf = { host: src.host || '', pageIndex: '1', selectList, filters };
      for (const item of selectedOptions) {
        selectList.push({ name: item.name, type: item.type, value: item.value });
        filters[item.type] = item.value;
        conf['_' + item.type] = item.value;
      }
      if (!f.request && f.structure && !f.url) conf.url = f.structure;
      return conf;
    };

    for (const f of src.ruleFinder) {
      const defaults = [];
      const parsedGroups = [];
      if (Array.isArray(f.list)) {
        for (const grp of f.list) {
          if (!grp || !grp.list) continue;
          try {
            const groupOpts = JSON.parse(grp.list);
            if (Array.isArray(groupOpts) && groupOpts.length > 0) {
              parsedGroups.push({ type: grp.type || '', opts: groupOpts });
              defaults.push({ name: groupOpts[0].name, type: grp.type || '', value: groupOpts[0].value });
            }
          } catch {}
        }
      }
      const conf = buildFinderConf(f, defaults);
      if (f.request) runRequestJs(f.request, conf);
      const r = await requestJson(f, conf, { pageIndex: '1' });
      const items = jp(r, f.bookList || '') || [];
      C('发现「' + (f.name || f.uuid) + '」', items.length > 0, items.length + ' 本 | ' + String(field(items[0], f.bookName || '') || '').slice(0, 14));

      // 第一筛选器的第二个选项探测
      if (items.length > 0 && parsedGroups.length > 0 && parsedGroups[0].opts.length > 1 && f.request &&
          (/config\.(?:selectList|filters|_)/.test(f.request))) {
        try {
          const second = parsedGroups[0].opts[1];
          const probeOpts = [{ name: second.name, type: parsedGroups[0].type, value: second.value }, ...defaults.slice(1)];
          const conf2 = buildFinderConf(f, probeOpts);
          runRequestJs(f.request, conf2);
          const r2 = await requestJson(f, conf2, { pageIndex: '1' });
          C('  筛选「' + second.name + '」', true, (jp(r2, f.bookList) || []).length + ' 本');
        } catch {}
      }
    }
  }

  console.log('\n===== ' + pass + '/' + (pass + fail) + ' PASS (' + (src.siteName || '未命名') + ' v' + src.version + ') =====');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('ERR', e.message);
  process.exit(1);
});
