#!/usr/bin/env python3
"""source-check.py — 用心读书（Read With Heart）书源结构与静态安全自检

用法:
  python3 source-check.py <书源.json> [--strict]

检查（对齐 mrs-skills 1.0.6 BookRule V2 合同与安全边界）:
  - 输入解包: flat 对象 / array[0] / SiteModel.ruleData / legacy { site }
  - JSON 重复键检测 (object_pairs_hook)
  - 顶层必查: siteName / host / type / version
  - type: 1(文本) / 4(听书) 合法；0 警告兼容回退；2/3/bool/其他 FAIL
  - 官方必填最小集: ruleSearch=url+bookList; ruleChapter=chapterList; ruleContent=contents
  - 字典/数组/编码校验: header/cookies({str:str}), filterErrorCodes(list[int]), requestEncode/responseEncode(utf-8/gbk)
  - forbidRedirect 位置限制（仅 preRequests[] 持久化）
  - ruleFinder[] / openParams[] / preRequests[] 深层结构校验
  - 纯静态 JS/规则/安全扫描（不执行任何 JS）

退出码: 0=pass  1=warning(strict 模式)  2=fail(必填缺失/格式错误)
"""

import json
import re
import sys

TOP_PRESENCE = ["siteName", "host", "type", "version"]

OLD_FIELDS = {
    "baseUrl": "改用 host",
    "list": "目录规则改用 chapterList",
    "name": "目录规则改用 chapterName",
    "lines": "正文规则改用 contents",
    "encode": "区分 requestEncode / responseEncode",
    "imageUrl": "正文/详情封面改用 coverUrl",
    "encoding": "改用 requestEncode / responseEncode",
    "headers": "改用 header",
    "requestInfo": "改用 request",
}

COMMON_DEPRECATED = {
    "encode": "区分 requestEncode / responseEncode",
    "encoding": "改用 requestEncode / responseEncode",
    "headers": "改用 header",
    "requestInfo": "改用 request",
}

SECRET_HEADER_KEYS = {
    "authorization",
    "x-api-key",
    "api-key",
    "apikey",
    "x-auth-token",
}

URL_FIELDS_BY_SECTION = {
    "top": ("host", "loginUrl"),
    "ruleSearch": ("url", "bookUrl"),
    "ruleBookInfo": ("chapterListUrl", "importUrl", "toolsUrl"),
    "ruleChapter": ("chapterUrl",),
    "ruleContent": ("commentUrl", "playUrl"),
    "ruleFinder": ("url", "structure", "bookUrl"),
    "preRequest": ("url",),
}

RE_FIELD_JS = re.compile(r"<js>([\s\S]*?)</js>", re.IGNORECASE)
RE_CONFIG_PARSE = re.compile(r"\bJSON\.parse\s*\(\s*config\s*\)")
RE_AWAIT = re.compile(r"\bawait\s+")
RE_UNSAFE_GLOBAL = re.compile(r"(?:\beval\s*\(|\bnew\s+Function\s*\(|\bfetch\s*\()")
RE_TOOLS_NOTE = re.compile(r"@tools\s*\{\s*(md5|sha256|sortAsc|sortDesc)\b")
RE_HTTP_URL = re.compile(r"http://(\[[^\]]+\]|[^\s/'\"`:<>?#,}]+)", re.IGNORECASE)
RE_COMMENT_TAG = re.compile(r"<comment\b([^>]*?)>", re.IGNORECASE)
RE_IDENT_ATTR = re.compile(r"""\bident\s*=\s*(["'])(.*?)\1""", re.IGNORECASE)
RE_FINDER_LEGACY_CFG = re.compile(r"\bconfig\._[A-Za-z0-9_$]+")


def make_dup_hook(warns):
    """通过 object_pairs_hook 检测同一 JSON 对象内的重复键。"""
    def hook(pairs):
        counts = {}
        result = {}
        for k, v in pairs:
            counts[k] = counts.get(k, 0) + 1
            result[k] = v
        for k, cnt in counts.items():
            if cnt > 1:
                warns.append(f"检测到重复 JSON 键 '{k}'（同一对象内出现 {cnt} 次）")
        return result
    return hook


def load_source(path, warns, notes):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f, object_pairs_hook=make_dup_hook(warns))
    except FileNotFoundError:
        print(f"[FAIL] 文件不存在: {path}")
        sys.exit(2)
    except json.JSONDecodeError as e:
        print(f"[FAIL] JSON 解析失败: {e}")
        sys.exit(2)

    if isinstance(data, list):
        if len(data) == 0:
            print("[FAIL] 空数组")
            sys.exit(2)
        notes.append(f"输入为数组（共 {len(data)} 项），已解包 array[0] 进行检查")
        data = data[0]

    if not isinstance(data, dict):
        print("[FAIL] 书源根节点（或数组首项）必须是 JSON 对象")
        sys.exit(2)

    has_rule_data = "ruleData" in data
    has_site = "site" in data
    if has_rule_data and has_site:
        print("[FAIL] 书源 wrapper 不能同时包含 ruleData 与 site")
        sys.exit(2)

    if has_rule_data:
        if not isinstance(data["ruleData"], dict):
            print("[FAIL] SiteModel.ruleData 必须是 JSON 对象")
            sys.exit(2)
        if any(k in data for k in ("siteName", "host", "baseUrl")):
            warns.append("ruleData wrapper 外层混入了 flat 书源字段 (siteName/host/baseUrl)")
        notes.append("检测到 SiteModel.ruleData wrapper，已解包 ruleData 进行检查")
        data = data["ruleData"]
    elif has_site:
        if not isinstance(data["site"], dict):
            print("[FAIL] legacy-site-wrapper 的 site 必须是 JSON 对象")
            sys.exit(2)
        if any(k in data for k in ("siteName", "host", "baseUrl")):
            warns.append("site wrapper 外层混入了 flat 书源字段 (siteName/host/baseUrl)")
        notes.append("检测到 legacy-site-wrapper ({ site })，已解包 site 进行检查")
        data = data["site"]

    return data


def present(obj, fields):
    return [f for f in fields if f not in obj]


def missing(obj, fields):
    return [f for f in fields if not obj.get(f)]


def check_string_dict(val, path, fails, warns):
    if val is None:
        return
    if not isinstance(val, dict):
        fails.append(f"{path} 必须是对象 {{key: value}}")
        return
    for k, v in val.items():
        if not isinstance(v, str):
            warns.append(f"{path}.{k} 值应为字符串，当前为 {type(v).__name__}")
        if path.endswith(".header") or path == "header":
            if k.lower() in SECRET_HEADER_KEYS and v != "":
                warns.append(f"{path}.{k} 包含硬编码敏感请求头（建议使用 openParams 或运行时登录注入）")


def check_error_codes(val, path, warns):
    if val is None:
        return
    if not isinstance(val, list):
        warns.append(f"{path} 必须是整数数组 list[int]")
        return
    for idx, item in enumerate(val):
        if isinstance(item, bool) or not isinstance(item, int):
            warns.append(f"{path}[{idx}] 必须是整数（当前: {item!r}），不能是布尔值或字符串")


def check_encode(obj, path, warns):
    for field in ("requestEncode", "responseEncode"):
        if field in obj and obj[field] is not None:
            val = obj[field]
            if not isinstance(val, str) or val.lower() not in ("", "utf-8", "gbk"):
                warns.append(f"{path}.{field} 仅支持 \"\" / \"utf-8\" / \"gbk\"（忽略大小写），当前: {val!r}")


def check_plaintext_http(val, path, warns):
    if not isinstance(val, str) or not val:
        return
    for host in RE_HTTP_URL.findall(val):
        host_clean = host.lower()
        if host_clean in ("localhost", "127.0.0.1", "[::1]", "::1"):
            continue
        if host_clean.startswith("${") or host_clean.startswith("@{"):
            continue
        warns.append(f"{path} 使用明文 http://（{host}），建议改用 https://")
        break


def check_request_object(obj, path, fails, warns, allow_forbid_redirect=False):
    if "header" in obj:
        check_string_dict(obj["header"], f"{path}.header", fails, warns)
    if "cookies" in obj:
        check_string_dict(obj["cookies"], f"{path}.cookies", fails, warns)
    if "filterErrorCodes" in obj:
        check_error_codes(obj["filterErrorCodes"], f"{path}.filterErrorCodes", warns)
    check_encode(obj, path, warns)
    if obj.get("forbidSSL") is True:
        warns.append(f"{path}.forbidSSL 为 true（已禁用 SSL 校验，存在安全风险）")
    if not allow_forbid_redirect and "forbidRedirect" in obj:
        warns.append(f"{path}.forbidRedirect 不会被 App 持久化读取（仅 preRequests[] 支持 forbidRedirect）")


def check_pre_requests(pre_reqs, parent_path, fails, warns, notes):
    if pre_reqs is None:
        return
    if not isinstance(pre_reqs, list):
        fails.append(f"{parent_path}.preRequests 必须是数组")
        return
    for idx, pr in enumerate(pre_reqs):
        p = f"{parent_path}.preRequests[{idx}]"
        if not isinstance(pr, dict):
            fails.append(f"{p} 必须是对象")
            continue
        url = pr.get("url")
        if not isinstance(url, str) or not url.strip():
            warns.append(f"{p}.url 不能为空")
        else:
            check_plaintext_http(url, f"{p}.url", warns)
        if "preRequestType" in pr and pr["preRequestType"] is not None:
            prt = pr["preRequestType"]
            if isinstance(prt, bool) or not isinstance(prt, int) or prt not in (0, 1, 2):
                warns.append(f"{p}.preRequestType 应为 0（常规）/1（浏览器过盾）/2（图片验证码），当前: {prt!r}")
        for old, hint in COMMON_DEPRECATED.items():
            if old in pr:
                warns.append(f"{p}.{old} 旧字段: {hint}")
        check_request_object(pr, p, fails, warns, allow_forbid_redirect=True)
        if isinstance(pr.get("request"), str) and pr["request"].strip():
            scan_js_text(pr["request"], f"{p}.request", is_field_js=False, allow_await=False, warns=warns)
        if "response" in pr and pr["response"] is not None:
            resp = pr["response"]
            if not isinstance(resp, dict):
                warns.append(f"{p}.response 必须是对象")
            else:
                if "responses" in resp:
                    warns.append(f"{p}.response 使用了 'responses'，App 实际读取历史拼写 'respones'")
                for rkey in ("respones", "responses"):
                    if isinstance(resp.get(rkey), str) and resp[rkey].strip():
                        scan_js_text(resp[rkey], f"{p}.response.{rkey}", is_field_js=False, allow_await=False, warns=warns)
        if "preRequests" in pr:
            check_pre_requests(pr["preRequests"], p, fails, warns, notes)


def scan_js_text(js_code, path, is_field_js, allow_await, warns):
    if RE_CONFIG_PARSE.search(js_code):
        warns.append(f"{path} 包含 JSON.parse(config)（App 进入规则体前已解析 config 为对象，切勿重复 parse）")
    if not allow_await and RE_AWAIT.search(js_code):
        warns.append(f"{path} 包含 await（普通规则/请求/响应为同步执行，仅 toolsUrl/commentUrl 的 @js: 支持 await）")
    if is_field_js and RE_UNSAFE_GLOBAL.search(js_code):
        warns.append(f"{path} 包含不安全全局调用 (eval / new Function / fetch)")


def scan_rule_string(val, path, allow_await, warns, notes):
    if not isinstance(val, str) or not val:
        return

    # 1. JS blocks (<js>...</js> or @js:...)
    stripped = val.lstrip()
    if stripped.startswith("@js:"):
        js_code = stripped[4:]
        scan_js_text(js_code, path, is_field_js=not allow_await, allow_await=allow_await, warns=warns)
    else:
        for match in RE_FIELD_JS.finditer(val):
            scan_js_text(match.group(1), path, is_field_js=True, allow_await=allow_await, warns=warns)

    # 2. Rule-level patterns outside <js>...</js>
    non_js = RE_FIELD_JS.sub("", val) if not stripped.startswith("@js:") else ""
    if "##@@##" in non_js:
        warns.append(f"{path} 包含 '##@@##'（App 不支持 ##@@## 链式正则替换）")

    m_tools = RE_TOOLS_NOTE.search(val)
    if m_tools:
        notes.append(f"{path} 使用了 @tools{{{m_tools.group(1)}}}（推荐改用 <js>return app.{m_tools.group(1)}(...);</js>）")


def scan_rule_section_strings(obj, section_path, warns, notes):
    for k, v in obj.items():
        if k in ("preRequests", "header", "cookies", "filterErrorCodes", "list"):
            continue
        p = f"{section_path}.{k}"
        if k in ("request", "response"):
            if isinstance(v, str) and v.strip():
                scan_js_text(v, p, is_field_js=False, allow_await=False, warns=warns)
        elif k in ("toolsUrl", "commentUrl"):
            if isinstance(v, str):
                scan_rule_string(v, p, allow_await=True, warns=warns, notes=notes)
        elif k == "ruleExtra" and isinstance(v, dict):
            scan_rule_section_strings(v, p, warns, notes)
        elif isinstance(v, str):
            scan_rule_string(v, p, allow_await=False, warns=warns, notes=notes)


def check_comment_tags(contents_val, notes):
    if not isinstance(contents_val, str) or "<comment" not in contents_val.lower():
        return
    for match in RE_COMMENT_TAG.finditer(contents_val):
        attrs = match.group(1)
        m_ident = RE_IDENT_ATTR.search(attrs)
        if not m_ident:
            continue
        ident = m_ident.group(2).strip()
        if not ident:
            continue
        # Skip dynamic JS string concatenation inside <js> blocks
        if "'+" in ident or '"+' in ident or "' +" in ident or '" +' in ident:
            continue
        if not re.match(r"^https?://", ident, re.IGNORECASE):
            notes.append(f"ruleContent.contents 中 <comment ident=\"{ident}\"> 为相对/非 HTTP(S) 地址（Swift 客户端要求绝对 http(s):// URL 才可点击）")
            break


def check_rule_finder(finder_val, fails, warns, notes):
    if finder_val is None:
        return
    if not isinstance(finder_val, list):
        fails.append("ruleFinder 必须是数组")
        return
    for idx, item in enumerate(finder_val):
        p = f"ruleFinder[{idx}]"
        if not isinstance(item, dict):
            fails.append(f"{p} 必须是对象")
            continue
        if not isinstance(item.get("uuid"), str) or not item.get("uuid").strip():
            warns.append(f"{p}.uuid 缺失或为空")
        if not isinstance(item.get("name"), str) or not item.get("name").strip():
            warns.append(f"{p}.name 缺失或为空")
        if item.get("page") and item.get("next"):
            warns.append(f"{p} 同时配置 page 与 next，官方要求二选一")

        req_js = item.get("request")
        if isinstance(req_js, str) and RE_FINDER_LEGACY_CFG.search(req_js) and "config.selectList" not in req_js:
            notes.append(f"{p}.request 使用了 config._<type>，建议改用 config.selectList")

        if "list" in item and item["list"] is not None:
            flist = item["list"]
            if not isinstance(flist, list):
                warns.append(f"{p}.list 必须是数组")
            else:
                for f_idx, f_item in enumerate(flist):
                    fp = f"{p}.list[{f_idx}]"
                    if not isinstance(f_item, dict):
                        warns.append(f"{fp} 必须是对象")
                        continue
                    raw_opts = f_item.get("list")
                    if not isinstance(raw_opts, str):
                        warns.append(f"{fp}.list 必须是 JSON 数组序列化字符串")
                        continue
                    try:
                        parsed_opts = json.loads(raw_opts)
                    except json.JSONDecodeError:
                        warns.append(f"{fp}.list 不是合法的 JSON 数组字符串")
                        continue
                    if not isinstance(parsed_opts, list):
                        warns.append(f"{fp}.list 解析后必须是数组")
                        continue
                    for o_idx, opt in enumerate(parsed_opts):
                        if not isinstance(opt, dict) or not isinstance(opt.get("name"), str) or not isinstance(opt.get("value"), str):
                            warns.append(f"{fp}.list[{o_idx}] 必须是包含字符串 name 和 value 的对象")

        for old, hint in COMMON_DEPRECATED.items():
            if old in item:
                warns.append(f"{p}.{old} 旧字段: {hint}")
        if isinstance(item.get("ruleExtra"), dict) and "imageUrl" in item["ruleExtra"]:
            warns.append(f"{p}.ruleExtra.imageUrl 旧字段: 改用 coverUrl")

        check_request_object(item, p, fails, warns, allow_forbid_redirect=False)
        for uf in URL_FIELDS_BY_SECTION["ruleFinder"]:
            check_plaintext_http(item.get(uf), f"{p}.{uf}", warns)
        check_pre_requests(item.get("preRequests"), p, fails, warns, notes)
        scan_rule_section_strings(item, p, warns, notes)


def check_open_params(open_params, fails, warns):
    if open_params is None:
        return
    if not isinstance(open_params, list):
        fails.append("openParams 必须是数组")
        return
    seen_keys = set()
    allowed_types = ("", "input", "single", "multiple")
    for idx, item in enumerate(open_params):
        p = f"openParams[{idx}]"
        if not isinstance(item, dict):
            fails.append(f"{p} 必须是对象")
            continue
        key = item.get("key")
        if not isinstance(key, str) or not key.strip():
            fails.append(f"{p}.key 必须是非空字符串")
        elif key in seen_keys:
            fails.append(f"{p}.key '{key}' 重复")
        else:
            seen_keys.add(key)

        if "type" in item and item["type"] is not None:
            ptype = item["type"]
            if not isinstance(ptype, str):
                fails.append(f"{p}.type 必须是字符串")
            elif ptype not in allowed_types:
                warns.append(f"{p}.type '{ptype}' 未知，应为 \"\" / \"input\" / \"single\" / \"multiple\"")


def main():
    if len(sys.argv) < 2:
        print("用法: python3 source-check.py <书源.json> [--strict]")
        sys.exit(2)
    path = sys.argv[1]
    strict = "--strict" in sys.argv[2:]

    fails, warns, notes = [], [], []
    src = load_source(path, warns, notes)

    # 顶层必查
    gone = present(src, TOP_PRESENCE)
    if gone:
        fails.append(f"顶层缺失: {', '.join(gone)}")
    if not src.get("siteName") or not isinstance(src.get("siteName"), str):
        fails.append("siteName 不能为空且必须是字符串")
    if not src.get("host") or not isinstance(src.get("host"), str):
        fails.append("host 不能为空且必须是字符串")

    # type 校验：1 / 4 合法；0 WARN；2 / 3 / bool / 其他 FAIL
    if "type" in src:
        t = src.get("type")
        if isinstance(t, bool) or not isinstance(t, int):
            fails.append(f"type 值 {t!r} 无效，必须为整数 1（文本）或 4（听书）")
        elif t == 0:
            warns.append("type=0 仅为 App 兼容回退，新源应明确为 1（文本）或 4（听书）")
        elif t not in (1, 4):
            fails.append(f"type 值 {t!r} 无效，V2 仅支持 1（文本）或 4（听书）")
    else:
        t = None

    # 顶层 header / cookies / password / 明文 http
    if "header" in src:
        check_string_dict(src["header"], "header", fails, warns)
    if "cookies" in src:
        check_string_dict(src["cookies"], "cookies", fails, warns)
        cval = src["cookies"]
        if (isinstance(cval, dict) and len(cval) > 0) or (isinstance(cval, str) and cval.strip()):
            warns.append("顶层 cookies 非空：请勿在书源中硬编码 Cookie 凭据")
    if isinstance(src.get("password"), str) and src["password"].strip():
        warns.append("顶层 password 非空：请勿在公开/分享书源中保留明文密码")
    elif src.get("password") not in (None, ""):
        warns.append("顶层 password 非空")

    for uf in URL_FIELDS_BY_SECTION["top"]:
        check_plaintext_http(src.get(uf), uf, warns)

    if isinstance(src.get("publicJavascript"), str) and src["publicJavascript"].strip():
        scan_js_text(src["publicJavascript"], "publicJavascript", is_field_js=False, allow_await=False, warns=warns)

    # 至少一个规则段
    has_any = any(
        src.get(k) is not None for k in ("ruleSearch", "ruleChapter", "ruleContent", "ruleBookInfo", "ruleFinder")
    )
    if not has_any:
        fails.append("书源必须包含至少一个规则段 (ruleSearch/ruleChapter/ruleContent/ruleBookInfo/ruleFinder)")

    # 各规则段读取与类型校验
    def get_dict_section(name):
        val = src.get(name)
        if val is None:
            return {}
        if not isinstance(val, dict):
            fails.append(f"{name} 必须是对象")
            return {}
        return val

    rs = get_dict_section("ruleSearch")
    rbi = get_dict_section("ruleBookInfo")
    rc = get_dict_section("ruleChapter")
    rco = get_dict_section("ruleContent")

    # ruleSearch：官方必填 url+bookList；bookName/bookUrl 为建议
    miss = missing(rs, ["url", "bookList"])
    if miss:
        fails.append(f"ruleSearch 必填缺失: {', '.join(miss)}")
    for rec in ("bookName", "bookUrl"):
        if rs and not rs.get(rec):
            warns.append(f"ruleSearch.{rec} 建议配置（官方不强制）")
    if rs.get("engine") not in (None, "", "xpath", "jsonpath", "css"):
        warns.append(f"ruleSearch.engine 应为 xpath/jsonpath/css，当前: {rs.get('engine')!r}")

    if not rbi:
        notes.append("ruleBookInfo 为空（目录在详情页时可接受）")
    elif not rbi.get("chapterListUrl") and not rbi.get("toolsUrl"):
        notes.append("ruleBookInfo 未配置 chapterListUrl/toolsUrl（为空时目录地址回退详情地址）")

    if rs.get("aliasName"):
        notes.append("ruleSearch.aliasName 已配置（bookName OR aliasName 匹配，别名作显示名）")
    if rbi.get("toolsUrl"):
        notes.append("ruleBookInfo.toolsUrl 已配置（V2 书籍工具页）")
    if rco.get("commentUrl"):
        notes.append("ruleContent.commentUrl 已配置（V2 支持异步 @js:）")

    # ruleChapter：官方必填 chapterList；chapterName/chapterUrl 为建议
    miss = missing(rc, ["chapterList"])
    if miss:
        fails.append(f"ruleChapter 必填缺失: {', '.join(miss)}")
    for rec in ("chapterName", "chapterUrl"):
        if rc and not rc.get(rec):
            warns.append(f"ruleChapter.{rec} 建议配置（官方不强制；旧名 url 等效）")

    # ruleContent：官方必填 contents
    miss = missing(rco, ["contents"])
    if miss:
        fails.append(f"ruleContent 必填缺失: {', '.join(miss)}")

    # 听书 playUrl
    if not isinstance(t, bool) and t == 4 and not rco.get("playUrl"):
        warns.append("听书源 (type 4)：ruleContent.playUrl 应提取音频地址（为空时用正文 URL/Header）")

    # 旧字段
    for old, hint in OLD_FIELDS.items():
        if old in src:
            warns.append(f"顶层旧字段 '{old}': {hint}")
        for sec_name, sec in (("ruleSearch", rs), ("ruleBookInfo", rbi), ("ruleChapter", rc), ("ruleContent", rco)):
            if old in sec:
                warns.append(f"{sec_name}.{old} 旧字段: {hint}")
            if isinstance(sec.get("ruleExtra"), dict) and old in sec["ruleExtra"]:
                warns.append(f"{sec_name}.ruleExtra.{old} 旧字段: {hint}")
    if rc.get("url") and not rc.get("chapterUrl"):
        warns.append("ruleChapter.url 是章节地址旧名，建议改用 chapterUrl")

    # 分页互斥
    for sec_name, sec in (("ruleChapter", rc), ("ruleContent", rco)):
        if sec.get("page") and sec.get("next"):
            warns.append(f"{sec_name} 同时配置 page 与 next，官方要求二选一")

    # 请求配置 / preRequests / 明文 http / 静态 JS 扫描
    for sec_name, sec in (("ruleSearch", rs), ("ruleBookInfo", rbi), ("ruleChapter", rc), ("ruleContent", rco)):
        if not sec:
            continue
        check_request_object(sec, sec_name, fails, warns, allow_forbid_redirect=False)
        for uf in URL_FIELDS_BY_SECTION[sec_name]:
            check_plaintext_http(sec.get(uf), f"{sec_name}.{uf}", warns)
        if "preRequests" in sec:
            check_pre_requests(sec["preRequests"], sec_name, fails, warns, notes)
        scan_rule_section_strings(sec, sec_name, warns, notes)

    # 富文本 <comment ident=...> 检查
    check_comment_tags(rco.get("contents"), notes)

    # ruleFinder[] & openParams[]
    if "ruleFinder" in src:
        check_rule_finder(src["ruleFinder"], fails, warns, notes)
    if "openParams" in src:
        check_open_params(src["openParams"], fails, warns)

    print(f"书源: {src.get('siteName') or '(未命名)'}")
    print(f"host: {src.get('host') or '(缺失)'}")
    print(f"version: {src.get('version')}")
    for n in notes:
        print(f"[NOTE] {n}")
    for w in warns:
        print(f"[WARN] {w}")
    for f in fails:
        print(f"[FAIL] {f}")

    if fails:
        print("\n结果: FAIL")
        sys.exit(2)
    if warns and strict:
        print("\n结果: PASS (strict 模式含警告)")
        sys.exit(1)
    print("\n结果: PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
