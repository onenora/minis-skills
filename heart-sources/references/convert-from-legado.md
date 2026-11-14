# 阅读（Legado）书源 → 用心读书（RWH）转换

输入：Legado 书源 JSON（`bookSourceUrl/bookSourceName/searchUrl/ruleSearch/ruleBookInfo/ruleToc/ruleContent/ruleExplore/jsLib`）。输出：RWH V2 明文 JSON 对象（`*.mrs.json`；**无 `.mrs` 二进制加解密转换**）。

## 顶层映射

| Legado | RWH V2 | 说明 |
|---|---|---|
| `bookSourceName` | `siteName` | 必填 |
| `bookSourceUrl`（域名根） | `host` | 必填，保留协议并归一化 |
| `bookSourceType` | `type` | `0` 文本→`1`；`1` 音频→`4`（**V2 不允许 `2`**）；`2` 漫画等非小说类需人工评估/拒绝 |
| `header` | `header` | `{String:String}` 字典，保留常量头 |
| `loginUrl` | `loginUrl` | **远程相对路径（如 `/login.php`）或 `${host}/...` 必须在转换期用归一化 `host` 拼接为绝对 HTTP(S) URL**（App 不自动补全） |
| `enabledCookieJar` | `forbidCookie` | **非一一反向映射**：仅显式关闭时评估 `forbidCookie`，不可盲目取反 |
| `cookies` | `cookies` | `{String:String}` 字典，勿写私人值 |
| `jsLib` | `publicJavascript` | 仅保留纯函数声明（`publicJavascript` 在 wrapper `JSON.parse(config)` 前执行，需从业务体传入 `config`） |
| `bookSourceGroup`/`bookSourceComment`/`bookUrlPattern` | `remarks` | 说明性备注，不参与解析 |

## 规则段映射与 CSS-first 策略

**CSS-first 原则**：搜索、详情、章节、正文、发现分别按段判断引擎。只要整段规则为纯 CSS 且能由 RWH `css` 引擎无损执行，**保持 `engine: "css"`**；仅当同段出现以下情况时**整段回退为 `engine: "xpath"`**（或标人工迁移）：
- 混合规则（同一规则段内混用 XPath / JSONPath / Default / CSS）
- 列表切片、负索引或排除索引（如 `[0:3]`、`[!0]`、`-1`、首字符 `-` 反序）
- RWH CSS 不支持的 Legado 访问器或连接符：`@ownText`、`@textNodes`、`@attr(...)`、`&&`、`||`、`%%`（轮询交错非普通并集）、`:allInOne`

| Legado | RWH |
|---|---|
| `searchUrl`：`{{key}}`→`@{keyword}`、`{{page}}`→`${pageIndex}`、POST `body`/`headers`/`charset` | `ruleSearch.url` + `params` + `header` + `requestEncode`/`responseEncode` |
| `ruleSearch.bookList/name/author/bookUrl` + 封面/简介/分类/字数/最新章 | `ruleSearch.bookList/bookName/bookAuthor/bookUrl` + `ruleExtra.*` |
| `ruleBookInfo.tocUrl` | `ruleBookInfo.chapterListUrl`（为空回退详情地址） |
| `ruleBookInfo` 其余元数据（含 `updateTime`） | `ruleBookInfo` 同名 + `ruleExtra.lastUpdateTime` |
| `ruleToc.chapterList/chapterName/chapterUrl` | `ruleChapter` 同名（优先 `chapterUrl`，勿用旧名 `list`/`name`/`url`） |
| `ruleToc.nextTocUrl` | `ruleChapter.next` |
| `chapterList` 首位 `-` 反序 | RWH 无反序标记 → 在 `response @js:` 内 `reverse` |
| `ruleContent.content` | `ruleContent.contents` |
| `ruleContent.nextContentUrl` | `ruleContent.next` |
| `ruleExplore` / `exploreUrl` | `ruleFinder[]`（每项含 `uuid`/`name`/`structure`/`list` JSON 串/`bookList`…；`{{page}}`→`${pageIndex}`） |

## 选择器、正则与 `@put/@get` 转换

- 简写转换：`class.item` → `.item`（CSS）或 `//*[contains(@class,'item')]`（XPath）；`id.x` → `#x` / `//*[@id='x']`；`tag.a@href` → `a@href`（CSS）或 `//a/@href`（XPath）。去掉 `@css:`/`@xpath:`/`@json:` 前缀并统一写入该段的 `engine`。
- **正则差异（禁止等价误换）**：
  - Legado `##pattern##rep###`（末尾 `###` 为 OnlyOne 单次替换）→ RWH `##pattern#rep`（`#` 为单次替换）。
  - Legado `##pattern##rep`（循环/全局）→ RWH `##pattern##rep`，**不可写为 `##@@##`**（App 不串联 `##@@##`）。
  - `ruleContent.replaceRegex` **不能 1:1 直接照搬为 `ruleContent.cleaner`**（需核对输入、顺序与多规则语义）；`ruleContent.sourceRegex` 是后台 WebView 资源嗅探，**不是 `cleaner`**。
- **`@put` / `@get` 语义**：Legado `@put:{k:rule}` 会**先对当前输入求值 `rule` 再写入**（如 XPath 结果而非 XPath 字面量），不可把 `rule` 字符串原样存入 `putData`；简单键值读写改用 `preRequests[].response.put` 或 `app.sp.put/get`。

## JS 改写与必须人工迁移项

- **可改写项**：`java.t2s` → `App.nlp.chs`；`java.md5` → `app.md5`；`java.base64` → `app.base64`；`java.put/get` → `app.sp.put/get`；`book.*`/`chapter.*` → `config.bookUrl/bookName/chapterName/chapterUrl`；`charset: "gbk"` → `requestEncode`/`responseEncode: "gbk"`。
- **必须标明「人工迁移（manual_required）」的项**（不可静默丢弃或猜测）：
  - **异步脚本**：`async/await`、`Promise.*`、`java.ajax`（RWH 普通字段/`request`/`response`/`preRequests` **不等待 Promise**，仅 `toolsUrl`/`commentUrl` 支持异步 `@js:`）
  - **Java 桥与宿主扩展**：`Packages.*`、未知 `java.*`、`eventListener`、`customButton`、`concurrentRate`、`loginUi`、`loginCheckJs`
  - **非文本/复杂模型**：`bookSourceType = 2`（漫画等）、`isVip` / `isVolume`、`ruleBookInfo.init` / `bookInfoInit`、`ruleBookInfo.downloadUrls`、`ruleContent.subContent` / `imageDecode` / `callBackJs` / `webJs`、`ruleReview.reviewUrl`、`HEAD` 请求方法
  - **`AnalyzeUrl.UrlOption` 扩展项**：`retry`、`type`、`webJs`、`js`、`bodyJs`、`dnsIp`、`serverID`、`webViewDelayTime`

## 转换后必检

1. `python3 scripts/source-check.py <书源.mrs.json> --strict` PASS：确认 `type` 明确为 `1`（阅读）或 `4`（听书，必填 `ruleContent.playUrl`）；无 `baseUrl`/`encode`/`lines`/`list`/`name`/`imageUrl` 等旧字段；`forbidRedirect` 未写入正式规则段；`header`/`cookies` 为字符串字典。
2. 占位符已迁移：`{{key}}` → `@{keyword}`、`{{page}}` → `${pageIndex}`；远程 `loginUrl` 已为绝对 HTTP(S) URL；`publicJavascript` 无顶层读取 `config`。
3. 在真实 App（或 Web API）实测四链路（搜索 → 详情 → 目录 → 正文），人工迁移项实测前不得报 `pass`。
