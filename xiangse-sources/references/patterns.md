# 香色书源惯用写法

均为 action 片段，`actionID`/`parserID`/`host` 由 `fmt` 补齐。

## 请求

GET 模板（UTF-8 自动编码关键词）：

```json
"requestInfo": "/search.php?q=%@keyWord&page=%@pageIndex"
```

POST 表单 + GBK 站点（编码号见 SKILL.md）：

```json
"requestInfo": "@js:\nreturn {url: '/modules/article/search.php', POST: true, httpParams: {searchkey: params.keyWord, searchtype: 'articlename'}};",
"requestParamsEncode": 2147485234,
"responseEncode": 2147485234
```

由上一步书籍推导目录地址（目录在独立页）：

```json
"requestInfo": "@js:\nreturn params.queryInfo.detailUrl.replace('/book/', '/list/');"
```

分类 + 筛选（多组空行分隔，取 `params.filters.<key>`）：

```json
"requestInfo": "@js:\nreturn '/sort/' + (params.filters.sort || 1) + '_' + params.pageIndex + '/?o=' + (params.filters.order || 'new');",
"moreKeys": { "maxPage": 50, "requestFilters": "sort\n玄幻::1\n都市::3\n\norder\n最新::new\n最热::hot" }
```

## 字段

```json
"cat": "//span[@class=\"lei\"]||@js:\nreturn result.replace(/[\\[\\]]/g, '')",
"updateTime": "//span[@class=\"x2\"][1]||@replace:更新时间：",
"desc": "//meta[@property=\"og:description\"]/@content||//div[@id=\"intro\"]",
"cover": "//img[contains(@class,'cover')]/@src||//img/@data-original"
```

JSON 接口：列表 `$.data.list` 或 `$.data[*]`，子字段 `$.title`、`book/name`；拼数组 `$.data.content[*]||@js:\nreturn result.join('\\n')`。

详情页优先 `og:novel:book_name`/`author`/`category`/`status`/`latest_chapter_name`、`og:image`、`og:description`。

## 正文

去广告与站点水印：

```json
"content": "//div[@id=\"content\"]||@js:\nreturn result.replace(/一秒记住.*?无弹窗！|本章未完.*?下一页/g, '').trim();"
```

章内分页（同章守卫：仅当下一页仍属本章才翻页）：

```json
"nextPageUrl": "//a[text()='下一页']/@href||@js:\nreturn /_\\d+\\.html$/.test(result) ? result : '';",
"moreKeys": { "maxPage": 10 }
```

## JS 内解析

```js
var doc = params.nativeTool.XPathParserWithSource(result);
var a = doc.queryWithXPath('//dd/a');
var list = [];
for (var i = 0; i < a.length; i++) list.push({ title: a[i].content(), url: a[i].queryWithXPath('//@href')[0].content() });
return { list: list };
```

`JSParser`（同时适用 DOM）：`function parse(config, params, result) { … return {list: list}; }`，多页返回 `{list, nextPageUrl, autoRequestMore: true}`。

## 反例

| 写法 | 后果 | 改为 |
|---|---|---|
| `"weight": 9999` | 导入闪退 | `"9999"` |
| `bookWorld.categories: […]` | 闪退 | 分类字典 |
| `title: "./a"` | 子字段跳出当前项 | `//a` |
| `a?.b`、`x ?? y` | 旧 JavaScriptCore 语法错误 | `a && a.b`、`x || y` |
| JS 里 `'https://site' + url` 而 url 已是绝对地址 | `https://sitehttps://…` | 先 `/^http/.test(url)` |
| `nextPageUrl` 无 `maxPage` | 无限翻页 | 配 `moreKeys.maxPage` |
| `sourceName: "XX书源(公众号…)"` | 宣传语进书源 | 只写站点名 |
