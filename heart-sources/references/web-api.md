# Web 写源开放接口速查（对齐 mrs-skills 1.0.6）

入口：App 内进入书源列表 →「电脑写源」→「开始连接」（或 设置 → 开发者选项 → 启用 Web API）。

- **基址限制**：仅允许 HTTP(S) 本地回环（`localhost` / `127.0.0.1` / `::1`）或 RFC1918 私网 IPv4（`10/8`、`172.16/12`、`192.168/16`）纯 Origin（无 userinfo/path/query/hash）；默认 `http://localhost:8080/api/`。
- **请求编码**：全部 **`POST`**，**`Content-Type: application/x-www-form-urlencoded;charset=utf-8`**，无认证（**禁止发送 JSON 请求体**）。表单叶子值统一字符串化（字符串直接编码、对象/数组先 `JSON.stringify`、数字/布尔转字符串），`encodeURIComponent` 后空格必须为 **`%20`**（不可用 `+`）。
- **明文 JSON 边界**：Web API 与本地工具均只处理明文 UTF-8 JSON（`*.mrs.json`：flat / `ruleData`-wrapper / `legacy-site-wrapper`）。**不存在 `.mrs` 二进制/加密文件与 `.json` 的离线互转算法**；仅 App 端 `/api/site/export` 返回 AES 加密导出串。
- **Canonical 字段**：新版 App 直接接收 V2 规范字段（`siteName` / `ruleSearch` / `ruleBookInfo` / `ruleChapter` / `ruleContent` / `ruleFinder`），新调用勿再适配为旧占位名（`name/search/detail/catalog/content`）。

## 管理接口

| 接口 | 参数 | 说明 |
|---|---|---|
| `POST /api/site/list` | `keyword`/`groupId`/`order`(0-7) | 源列表；order 0 默认、1-2 名称、3-4 更新时间、5-6 创建时间、7 网址 |
| `POST /api/site/group` | — | 源分组列表（可作探活 ping） |
| `POST /api/site/info` | `id`/`password` | 源详情（加密源需密码）；返回 `siteJson` |
| `POST /api/site/save` | `siteJson`(完整 V2)/`id`/`index`/`groupId`/`status`/`finderStatus`/`remarks` | 创建/更新；实测通过后持久化 |
| `POST /api/site/delete` | `id` | 删除 |
| `POST /api/site/export` | `id` | App 侧导出（返回 AES 加密串，无离线加解密算法） |

## 调试接口

| 接口 | 参数 | 说明 |
|---|---|---|
| `POST /api/site/search` | `keyword`/`siteJson` | 搜索调试；业务项含 `name`/`author`/`bookUrl` |
| `POST /api/site/bookinfo` | `bookJson`/`siteJson` | 详情调试；`resultData` 为详情对象 |
| `POST /api/site/chapter` | `bookJson`/`siteJson` | 章节列表调试；业务项含 `name`/`url` |
| `POST /api/site/content` | `catalogJson`/`siteJson`（可选带 `bookJson`） | 正文调试；`resultData` 为正文文本 |
| `POST /api/site/finder` | `siteJson`/`categoryUUID`/`selectList`/`pageIndex` | 发现调试；`selectList` 为当前选择 JSON 串 |
| `POST /api/site/cancelRequest` | `type`(`"0"`..`"3"`) | 取消请求：`0` 搜索与详情 / `1` 目录 / `2` 正文 / `3` 发现（超时/中止时清理） |
| `POST /api/debug/clear` | `type`(1搜索 2章节 3正文 5发现)/`siteIdent` | 清调试日志 |

## 响应结构与轨迹过滤（ResponsesModel）

```json
{ "code": "200", "message": "成功", "data": { "resultData": null, "list": [], "jsLog": "", "gets": {} } }
```

- 外层 `code` 为字符串 `"200"`/`"600"`。**外层 `"200"` 仅表示接口本身返回，不代表目标请求或业务解析成功**。
- **业务提取优先级**：先解析 `data.resultData`（可为对象、正文字符串，或含 `list`/`items`/`books`/`chapters`/`chapterList` 的 JSON）；`data.list` 中可能混入请求轨迹对象，**必须过滤掉含轨迹键的项**后再作业务列表判空：
  - 轨迹键集合：`httpStatus`、`errorMag`、`jsParsing`、`responseBody`、`responseNewBody`、`originalUrl`、`newUrl`。
- **传输失败 vs 空匹配区分**：若 `data.list` 含 `responseType === 1` 或 `httpStatus <= 0` / 非 2xx 且带 `errorMag` 的轨迹项，判定为**网络/超时/传输失败**，不可误判为「规则匹配为空」。
- **超时/中止清理**：调试请求超时或被客户端中止时，应 best-effort 调用 `POST /api/site/cancelRequest`（传入对应 `type` 字符串 `"0"`..`"3"`）释放 App 侧阻塞请求。

## 调试链路示例

1. `site/group` 探活 → `site/search` → 优先解析 `resultData` 或过滤轨迹后的 `data.list[0].bookUrl` → 组 `bookJson`。
2. `site/bookinfo`（若启用）→ 校验 `resultData`。
3. `site/chapter` → 过滤轨迹后的 `data.list[0].url` → 组 `catalogJson`。
4. `site/content` → 校验 `data.resultData` 为非空正文（去空白后有效）。

## 安全与工具

- 默认 CORS `*`；仅限本地回环或内网局域网调试，禁用跨网重定向（`redirect: error`），勿向不可信公网地址发送含凭据的 `siteJson`。
- 工具参考：[books-web-source](https://gitee.com/jon/books-web-source)、[jelly](https://freenovel123.github.io/jelly/)、[jijianconvert](https://jijianconvert.netlify.app/)
