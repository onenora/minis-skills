"""Legado 书源批量清洗：去重、分组、风格标准化。

用法:
    python3 analyze_and_clean.py <书源.json> [-o 输出目录] [--group-prefix 前缀] [--comment 说明]

输出目录缺省为输入文件同级的 book_source_cleanup/，内含
cleaned_sources.json / summary.json / report.txt。
"""
import argparse, json, re, urllib.parse, collections, hashlib
from pathlib import Path

ap = argparse.ArgumentParser(description='Legado 书源批量去重、分组、风格标准化')
ap.add_argument('src', type=Path, help='书源 JSON 数组文件')
ap.add_argument('-o', '--outdir', type=Path, help='输出目录（缺省：输入文件同级 book_source_cleanup/）')
ap.add_argument('--group-prefix', default='', help='分组前缀，如 "我的"，生成 "我的::小说::CSS"')
ap.add_argument('--comment', default='已完成去重、分组、风格标准化', help='写入 bookSourceComment 的说明')
args = ap.parse_args()

SRC = args.src
OUTDIR = args.outdir or SRC.parent / 'book_source_cleanup'
OUTDIR.mkdir(parents=True, exist_ok=True)

data = json.loads(SRC.read_text(encoding='utf-8'))

TYPE_MAP = {
    0: '小说',
    1: '漫画',
    2: '听书',
    3: '图片',
    4: '文本',
}

def norm_url(u:str)->str:
    if not u:
        return ''
    u = u.strip()
    base = u.split('#')[0].split('?')[0]
    if '://' in base:
        pr = urllib.parse.urlsplit(base)
        host = (pr.netloc or '').lower()
        if host.startswith('www.'):
            host = host[4:]
        path = pr.path.rstrip('/') or '/'
        return host + path
    return base

DECOR_RE = re.compile(r'^[\+♛♕♔♚★☆♤♧◇◆※✦✧•·◉◎]+')
TAIL_TAG_RE = re.compile(r'\s*[#＃].*$')
SPACE_RE = re.compile(r'\s+')

def clean_name(name:str)->str:
    s = (name or '').strip()
    s = DECOR_RE.sub('', s)
    s = TAIL_TAG_RE.sub('', s)
    s = SPACE_RE.sub(' ', s).strip()
    return s

RULE_KEYS = ['ruleSearch','ruleBookInfo','ruleToc','ruleContent','ruleExplore']

def compact_json(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def source_signature(item):
    parts = [norm_url(item.get('bookSourceUrl','')), item.get('searchUrl','') or '']
    for k in RULE_KEYS:
        parts.append(compact_json(item.get(k) or {}))
    return hashlib.sha1('\n'.join(parts).encode('utf-8')).hexdigest()

def classify_style(item):
    blob = ' '.join([
        item.get('searchUrl','') or '',
        compact_json(item.get('ruleSearch') or {}),
        compact_json(item.get('ruleBookInfo') or {}),
        compact_json(item.get('ruleToc') or {}),
        compact_json(item.get('ruleContent') or {}),
    ]).lower()
    if '@js:' in blob or '<js>' in blob or 'eval(' in blob:
        return 'JS'
    if '$.' in blob or blob.strip().startswith('{'):
        return 'JSON'
    if '@css:' in blob or '@class.' in blob or '@tag.' in blob:
        return 'CSS'
    return 'XPath/默认'

def quality_score(item):
    score = 0
    if item.get('enabled'): score += 3
    if item.get('searchUrl'): score += 2
    for k in ['ruleSearch','ruleBookInfo','ruleToc','ruleContent']:
        if item.get(k): score += 2
    if item.get('enabledCookieJar'): score += 1
    if item.get('bookUrlPattern'): score += 1
    score += int(item.get('weight') or 0)
    score += int(item.get('respondTime') == 0)
    return score

for i, item in enumerate(data):
    item['_index'] = i
    item['_norm_url'] = norm_url(item.get('bookSourceUrl',''))
    item['_clean_name'] = clean_name(item.get('bookSourceName',''))
    item['_type_name'] = TYPE_MAP.get(item.get('bookSourceType'), f"类型{item.get('bookSourceType')}")
    item['_style'] = classify_style(item)
    item['_sig'] = source_signature(item)
    item['_score'] = quality_score(item)

seen_sig = {}
unique = []
duplicates = []
for item in sorted(data, key=lambda x: (-x['_score'], x['_index'])):
    if item['_sig'] in seen_sig:
        duplicates.append({'reason':'same_signature', 'keep':seen_sig[item['_sig']]['_index'], 'drop':item['_index']})
    else:
        seen_sig[item['_sig']] = item
        unique.append(item)

best_by_url_type = {}
final = []
for item in sorted(unique, key=lambda x: (-x['_score'], x['_index'])):
    key = (item['_norm_url'], item.get('bookSourceType'))
    if item['_norm_url'] and key in best_by_url_type:
        duplicates.append({'reason':'same_site_type', 'keep':best_by_url_type[key]['_index'], 'drop':item['_index']})
    else:
        best_by_url_type[key] = item
        final.append(item)

for item in final:
    item['bookSourceName'] = item['_clean_name'] or item.get('bookSourceName') or '未命名书源'
    group = f"{item['_type_name']}::{item['_style']}"
    item['bookSourceGroup'] = f"{args.group_prefix}::{group}" if args.group_prefix else group
    item['bookSourceComment'] = args.comment
    item['enabledExplore'] = bool(item.get('enabledExplore', False))
    item['enabledCookieJar'] = bool(item.get('enabledCookieJar', False))
    item['customOrder'] = int(item.get('customOrder') or 0)
    item['weight'] = int(item.get('weight') or 0)
    item['lastUpdateTime'] = int(item.get('lastUpdateTime') or 0)
    item['respondTime'] = int(item.get('respondTime') or 0)
    item['enabled'] = bool(item.get('enabled', True))
    for k in ['exploreUrl', 'ruleExplore', 'bookUrlPattern', 'storageKind']:
        if item.get(k) in ('', None, {}, []):
            item.pop(k, None)
    for k in list(item.keys()):
        if k.startswith('_'):
            item.pop(k, None)

final.sort(key=lambda x: (x.get('bookSourceType', 999), x.get('bookSourceGroup',''), x.get('bookSourceName',''), x.get('bookSourceUrl','')))
summary = {
    'original_count': len(data),
    'final_count': len(final),
    'removed_count': len(data) - len(final),
    'type_counter': dict(collections.Counter(TYPE_MAP.get(x.get('bookSourceType'), str(x.get('bookSourceType'))) for x in final)),
    'group_counter': dict(collections.Counter(x.get('bookSourceGroup','') for x in final)),
    'duplicates': duplicates,
}
(OUTDIR / 'cleaned_sources.json').write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding='utf-8')
(OUTDIR / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
(OUTDIR / 'report.txt').write_text('\n'.join([
    f"original_count: {summary['original_count']}",
    f"final_count: {summary['final_count']}",
    f"removed_count: {summary['removed_count']}",
    '',
    'type_counter:',
    *[f"- {k}: {v}" for k,v in summary['type_counter'].items()],
    '',
    'group_counter:',
    *[f"- {k}: {v}" for k,v in sorted(summary['group_counter'].items())],
    '',
    'duplicates:',
    *[f"- {row['reason']}: keep #{row['keep']} drop #{row['drop']}" for row in duplicates[:100]],
]), encoding='utf-8')
print(f'done: {len(data)} → {len(final)} → {OUTDIR}')
