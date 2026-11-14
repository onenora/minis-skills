# 用心读书 V2 协议细节（对齐 mrs-skills 1.0.6）

权威：Swift V2 运行时 > BookRuleModel > 官方文档 https://freenovel123.github.io/read-with-heart-docs/、`common.js` 与 `mrs-skills 1.0.6`。上方 `SKILL.md` 已列核心硬约束，本页补充协议细节与运行时差异。

## 1. `config.*` 键总表与 JS 运行时机

| 键 | 场景 |
|---|---|
| `config.url` | 当前首屏请求地址 |
| `config.method` / `mode` / `engine` | GET/POST / http\|webview / xpath\|jsonpath\|css |
| `config.header` / `cookies` / `params` | 合并后请求头 / Cookie / 显式参数 |
| `config.keyword` / `pageIndex` | 搜索词 / 页码 |
| `config.bookUrl` / `bookName` / `bookAuthor` | 书籍（章节、正文） |
| `config.chapterUrl` / `chapterName` | 章节（正文） |
| `config.infoUrl` | 详情地址（详情、章节列表） |
| `config.siteIdent` / `host` / `siteName` | 站点标识 / 主地址 / 名称 |
| `config.jsLib` / `openParams` / `verifyCode` | 公共 JS / 开放参数字典 / 验证码 |
| `config.deviceId` | App 设备标识（勿上传非必要第三方） |
| `config.selectList` / `filters` | 仅发现场景筛选当前选中（见 §7.5） |

- **`config` 解析时机**：底层先传入 JSON 字符串，Swift 包装器会在业务体前执行 `config = JSON.parse(config)`。因此字段/`request`/`response`/`preRequests` 业务体中的 `config` **已是对象**，禁止再写 `JSON.parse(config)`。**例外**：`publicJavascript` 顶层立即语句运行在 `JSON.parse(config)` 之前，此时看到的仍是字符串；`publicJavascript` 应**只保留纯函数声明**，由业务体把已解析的 `config` 作为参数传入。
- **同步 vs 异步边界**：普通字段 `<js>`、`request`、`response`、`preRequests` **不等待 Promise**（默认 30s 超时）；只有 `ruleBookInfo.toolsUrl` 与 `ruleContent.commentUrl` 的 `@js:` 使用专用异步 resolver，支持 `await app.get/post`。`loginUrl` 无 `@js:` 入口（仅远程绝对 HTTP(S) URL 或本地 `@html:`）。
- **安全约束**：字段 `<js>` 内禁止使用 `eval`、`new Function`、`fetch`、`OS` 等危险/绕过全局符号。
- **`@get{}` 与 `putData`**：`putData` 按 `siteIdent` 隔离持久化（UserDefaults），**读改写（`get -> 修改 -> put`）不是原子事务**，并发分页或章节请求避免修改同一 key。`@get{key}` 优先于规则引擎执行，支持点路径 `@get{preRepHeader1.contentType}`；Header 键在保存时统一转为 **camelCase**（如 `Content-Type` → `contentType`）。`@get{loginCookies}` 等对象/数组值在 JS 上下文中会序列化为 JSON 字符串（含 JS 转义），不宜直接当数组调用 `.map()`，JS 内优先使用 `app.sp.get(key)` 读原生对象。全局兼容 `get(key)`/`put(key, value)` 与 `@get{}`/`@put{}` 同层，但新代码优先 `@get{}` 与 `app.sp.get/put`。

## 2. toolsUrl / commentUrl 支持形式

| 形式 | 写法/返回值 | 请求头 |
|---|---|---|
| 直接 URL | `https://x.com/t?id=1` | 场景 header |
| 相对 URL | `/t?id=1` | 场景 header（按 host 补全） |
| 同步 `@js:` | `@js:return config.url + '/tools';` | 场景 header |
| 异步 `@js:` | `@js:const r = await app.get({...}); return r.url;` | 场景 header |
| URL+尾随 Header | `URL,{"header":{"X-Token":"abc"}}` | 尾随覆盖同名 |
| 返回对象 | `return {url, header};` | 对象 header 覆盖同名（推荐） |
| 直接 `@html:` | `@html:<html>…</html>` | 只保证 Cookie |
| `@html:`+尾随 | `@html:<html>…</html>,{"header":{…}}` | Cookie 可写；非 Cookie 头不用于子资源 |
| JS 返回 HTML | `return '@html:…';` 或 `return {html, baseURL};` | 只保证 Cookie |

- 异步必须 `await`；等待上限 30s；失败/空值/无效 URL → “地址无效”（不回退 `infoUrl`/`chapterUrl`）。
- `toolsUrl` 使用详情上下文且无 `chapterUrl`；`commentUrl` 为整章评论页（不代替各段 `<comment ident />`）。需要完整 Auth/Referer/UA/Token 时优先返回 URL，不用 HTML。

## 3. 前置请求字段表与请求安全分层

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | String | 必填 | 支持 `${}` `@{}` `@get{}` `<js>` 正则 |
| `method` | String | GET | GET/POST |
| `mode` | String | http | 需要 WebView 时 `webview` |
| `header` / `params` | Object | 空 | `header` 须为 `{String:String}` 字典；value 可用规则语法 |
| `request` | String | 空 | `@js:` 改请求配置 |
| `response` | Object | 空 | `engine`(xpath/jsonpath/css) + `put`(key→规则，value 可用 `<js>`) + `respones`(响应 JS 处理，String，支持 `@js:` 前缀，参数 `html`；**历史拼写必须保留**) |
| `preRequestType` | Number | 0 | 0 常规 / 1 浏览器过盾 / 2 图片验证码 |
| `forbidCookie` / `forbidSSL` / `forbidRedirect` | Boolean | false | **`forbidRedirect` 仅持久化于 `preRequests[]`** |
| `requestEncode` / `responseEncode` | String | utf-8 | 仅 `utf-8` / `gbk`（忽略大小写）；废弃 `encoding` |
| `filterErrorCodes` | Array\<Int\> | 空 | 整数数组（不可写字符串），仅放行已收到的 HTTP 状态码进入解析 |
| `domains` | String/Array | 空 | 额外 Cookie 收集域名（登录/过盾） |

- **请求安全与错误分层**（按失败层级选择，不可混用）：
  1. `requestEncode` / `responseEncode`（仅 `utf-8`/`gbk`；`encoding` 非 V2 正式字段）处理请求参数与响应体编码。
  2. `filterErrorCodes`（`int[]`）仅放行已抵达的 HTTP 状态码（如 `503` WAF / `400` 业务错误 JSON）继续进入解析，对 DNS/TLS/超时/取消无效。
  3. `forbidCookie` 仅关闭登录态与 HTTP Cookie 缓存的自动注入，不删除显式写在请求 `header.Cookie` 的值；WAF/登录态不可盲目开启。
  4. `forbidSSL` **仅用于** App 明确报告 TLS 证书校验失败时作为最小范围兼容，禁止用于 HTTP 降级或掩盖 4xx/5xx；开启后必须保留安全风险提示并实测回溯。
  5. `forbidRedirect` **仅持久化在 `preRequests[]` JSON 中**（读取 `Location`/保留 3xx）；`ruleSearch`/`ruleBookInfo`/`ruleChapter`/`ruleContent`/`ruleFinder` JSON 中**不要写** `forbidRedirect`（仅存在运行时 `config.forbidRedirect`）。
- 自动保存：`preUrlN` / `preResHeaderN` / `preRepHeaderN`（N≥1，Header 键为 camelCase）；过盾 `verifyHeader`+`verifyCookies`；验证码 `config.verifyCode`。
- App 生成模板附加字段：`ruleSearch.requestType`(默认 0) 与 `ruleSearch.mark`(备注) 保留即可；`ruleFinder` / `openParams` 为数组，`cookies` 为 `{String:String}` 对象。

## 4. Native 方法表与运行差异

| 方法 | 说明 |
|---|---|
| `doc(html, clean)` | v2.6.0+ Document；`select("css")` 返回数组，`first()/last()/text()/attr()` |
| `log/toast/showDialog/handleError` | 调试与交互；**已知 App bug：`app.showDialog` 无论确认或取消均向回调传入 `0`**，勿依赖其区分用户选择 |
| `post/get({url, params, header, timeout})` | Promise，**仅可在 `toolsUrl`/`commentUrl` `@js:` 中 `await`**；底层 `OS.get/post` 回调 code `0`=成功/`401`=缺参/`402`=网络/`408`=超时；响应含 `responseBody/requestHeader/responseHeader/cookie` |
| `socket(url, protocols, headers)` | `open/text/binary/close/push/finished` |
| `uuid()` | UUID |
| `strToBytes/bytesToStr(bytes, code)` | code utf-8/gbk |
| `string.toGBK/toUTF8` | 编码转换 |
| `sp.put/get/delete(key, value)` | 按 `siteIdent` 隔离持久化（支持 String/Number/Object/Array/Date/Data，禁 null/undefined/Function）；V2 无裸 `getValue` |
| `base64.encode/decode/decodeToBytes` | Base64 |
| `md5/sha1/sha224/sha256/sha384/sha512(data)` | 小写十六进制（签名哈希优先用 `app.md5`/`app.sha256`，勿依赖 `@tools{md5/sha256}`） |
| `aes.encrypt/decrypt(data, key, iv)` | UTF-8 key/iv、AES-CBC PKCS7、Base64 输出（本地 Node mock 不验证真实密码学，须 App 实测） |
| `rsa.encrypt(data, pub)/rsa.decrypt(data, pri)` | 非对称（Base64） |
| `bcrypt.genSalt(rounds)/hash(pwd, salt)` | Bcrypt |
| `nlp.cht/chs` | 简繁 |
| `time(unix, 'yyyy-MM-dd HH:mm:ss')` | 时间戳；毫秒先 `>1e12 ? v/1000 : v` |
| `setTimeout/clearTimeout` | 定时器（仅限同步周期内，不跨请求等待） |

## 5. 富文本标签属性表与证据分级

| 标签 | 属性 | 约束 |
|---|---|---|
| `<img>` | `src`(必) `width` `height` `ident`(点击 URL) `alt` `style` | 自闭合；网络图/SVG 必须显式宽高；`src`/`ident` 可尾随 `,{"header":{...}}`；`identHeader` 非空时整组替换顶层 Header |
| `<comment>` | `ident` `count` | 自闭合；`count` 须 >0 整数；**Swift 当前实现要求 `ident` 为绝对 HTTP(S) URL 才可点击**（裸业务 ID 或相对路径不会回退 `commentUrl`，也不会自动补 `host`） |
| `<note>` | `type`(manual/remote 默认) `text`(必) `ident`(remote 必) `id`(manual 必) `label` `autoHeight` | 自闭合；整行独占；受 `enableNote` 开关控制 |

- 富文本格式：`---CATALOG---` 标题 + `---CONTENT---` 正文（CSS 写一次到开头，字号用 `em` 不用 `px`；内置字体 `SourceHanSB`/`FZGWKTGBK`）。
- **可选能力 5 级证据**（`optionalCapabilities`）：`absent`（未声明）→ `declared`（仅配置字段）→ `static_validated`（静态语法/结构通过）→ `runtime_emitted`（正文实测产出合法标签/入口）→ `app_interaction_verified`（真实 App 打开/加载/点击验收通过）。静态检查与主链正文通过都不能自动升级为 `app_interaction_verified`。

## 6. openParams 与 loginUrl `@html:`

- 定义字段：`name` / `key`（书源内非空且唯一） / `value` / `defaultValue` / `type`（`input`/`single`/`multiple`，未知回退 `input`） / `options`。
- 运行时：`config.openParams` = `[String:String]`（多选英文逗号分隔，JS 内自行 `split`）。
- 写回：JS `window.ParsingBook.setOpenParamValue(key, v)` / `setOpenParamValues({...})`；HTML 事件 `@setOpenParams('k','v')`（`window.ParsingBook` bridge **仅注入本地 `@html:`**，远程 `loginUrl` 无该 bridge）。
- `loginUrl`：仅支持**绝对 HTTP(S) URL**（App 不会对相对路径补全 `host`，也不会展开 `${host}`）或本地 `@html:`；尾随 `,{"domains":[...]}` 收集额外域名 Cookie。

## 7. `type` 合同、听书源、分页与发现（V2 运行细节）

- **`type` 合同**：V2 网络书源仅允许 **`1`**（文本阅读）与 **`4`**（网络听书）。`0` 仅作 App 兼容回退告警（新建、转换或归一化书源必须显式设为 `1` 或 `4`）；**`2` 不再是合法的 V2 听书类型**；`3` 仅限本地文件，不可作为网络源导入。
- **听书源（`type: 4`）**：`ruleContent.playUrl` 提取音频地址（jsonpath `$..` 可用；相对地址按 `host` 补全；`contents` 可给文本/歌词）；`playUrl` 为空时用正文 URL 与正文 Header；音频需专用请求头时写 `ruleContent.header`。搜索/详情/目录结构与文本源一致。
- **规则执行与 `@tools{}`**：基础规则/`@all` 后，变量替换 `@get{} → ${} → @{} → @tools{}` 与 `{{}}` 处理完成；**字段级 `<js>` 与 `##` 正则按规则文本中从左到右的原始位置顺序执行**（如 `//a/@href<js>...</js>##https?://` 先 JS 后正则）；**`##@@##` 在 App 中不串联**；`@tools{}` 当前仅可靠支持 `timestamp()`（`sortAsc`/`sortDesc` 返回空；哈希/编码优先用 `<js>return app.md5/sha256(...);</js>`）。
- **分页与 `pageMax`**：
  - `ruleChapter` / `ruleContent`：**`page` 非空时严格屏蔽 `next`**（含 `page="1"` / `"0"` 等非空值）。`page` 并发后续页从原始配置重建并**重跑 `request` JS，不再执行首页 URL/params 模板预处理**，动态页码与签名须在 `request @js:` 中按 `config.pageIndex` 显式构造。
  - `pageMax` 为空时的行为差异：**`ruleSearch`** 若 URL/params/`request` 能证明存在 `pageIndex` 分页，则按 `pageIndex + 1` 继续探测；**`ruleFinder[]`** 若 `pageMax` 为空则默认返回 `1`，仅当 `structure`/`params`/`request`/已选筛选 `value` 证明支持 `pageIndex` 分页时才按 `pageIndex + 1` 探测。
- **发现 `ruleFinder[]`**：每项含 `uuid`（确定性且唯一，推荐 `finder-<hash>`）、`name`、`structure`、筛选组数组 `list`（每组 `{name, type, list}`，**内层 `list` 必须是 `[{name, value}]` 的 JSON 序列化字符串**）、公共请求字段、`pageMax`、书籍字段与 `ruleExtra`。运行时读写当前选中优先遍历 **`config.selectList`**（`[{name,type,value}]`），优于 `config.filters` 与旧 `config._<type>`。
- **JSONPath 与编码**：`jsonpath-plus` 支持 `$..x`、`.*`、`[0:3]`、`[?(...)]`；**负索引 `[-1]` 报错**，取末项用 `[(@.length-1)]`。`CryptoJS` 与 `common.js`（加载顺序 `prototype.js → crypto.min.js → common.js → publicJavascript`）由 App 内置。

## 8. Web API 摘要（自动化调试）

入口：`http://localhost:8080/api/`（仅限回环/RFC1918 私网 IPv4 Origin，无认证），**全部 `POST` + `Content-Type: application/x-www-form-urlencoded;charset=utf-8`**（`encodeURIComponent` 空格编码为 `%20`，非 JSON 请求体）。只收发**明文 UTF-8 JSON**（无离线 `.mrs` 加解密互转）。直接发送 canonical V2 字段（`ruleSearch`/`ruleBookInfo`/`ruleChapter`/`ruleContent`/`ruleFinder`）。调试响应 `ResponsesModel{resultData, list, jsLog, gets}` 需先检查 `resultData`，并将 `list` 中含 `httpStatus`/`errorMag`/`jsParsing`/`responseBody`/`responseNewBody`/`originalUrl`/`newUrl` 的轨迹项过滤掉；遇到 `responseType === 1` 等传输失败不可误判为空匹配；超时/中止时调用 `/api/site/cancelRequest`（`type`: `"0"`..`"3"`）。完整接口见 `references/web-api.md`。
