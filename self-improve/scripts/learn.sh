#!/bin/sh
# self-improve：学习日志初始化 + 记录 + 搜索 + 提升（POSIX sh，不依赖任何宿主目录）
#
# 作用域：
#   --project [目录]  项目级（默认）：<目录>/.learnings；目录缺省为当前 git 根目录，否则为当前目录
#   --global          全局级：${SELF_IMPROVE_HOME}，缺省 ${XDG_DATA_HOME:-$HOME/.local/share}/self-improve
#   --base 目录       自定义日志目录
set -e

git_root() {
  git -C "${1:-.}" rev-parse --show-toplevel 2>/dev/null || (cd "${1:-.}" && pwd)
}

GLOBAL_BASE="${SELF_IMPROVE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/self-improve}"
PROJECT_ROOT="$(git_root .)"
BASE="$PROJECT_ROOT/.learnings"
MODE="project"

while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      if [ -n "$2" ] && [ -d "$2" ]; then
        PROJECT_ROOT="$(git_root "$2")"
        shift
      fi
      BASE="$PROJECT_ROOT/.learnings"
      MODE="project"
      shift
      ;;
    --global)
      BASE="$GLOBAL_BASE"
      MODE="global"
      PROJECT_ROOT=""
      shift
      ;;
    --base)
      [ -n "$2" ] || { echo "缺少 --base 参数值" >&2; exit 1; }
      BASE="$2"
      MODE="custom"
      PROJECT_ROOT=""
      shift 2
      ;;
    *)
      break
      ;;
  esac
done

LEARN="$BASE/LEARNINGS.md"
ERRS="$BASE/ERRORS.md"
FEAT="$BASE/FEATURE_REQUESTS.md"

# 字符串比较按字节进行：macOS awk 在 UTF-8 locale 下会把不同的中文行判为相等
LC_ALL=C
export LC_ALL

init_dir() {
  mkdir -p "$1"
  [ -f "$1/LEARNINGS.md" ] || printf '# Learnings\n' > "$1/LEARNINGS.md"
  [ -f "$1/ERRORS.md" ] || printf '# Errors\n' > "$1/ERRORS.md"
  [ -f "$1/FEATURE_REQUESTS.md" ] || printf '# Feature Requests\n' > "$1/FEATURE_REQUESTS.md"
}

init() {
  init_dir "$BASE"
}

project_meta_line() {
  if [ -n "$PROJECT_ROOT" ]; then
    printf '%s\n' "- 项目路径: $PROJECT_ROOT"
  fi
}

meta_block() {
  printf '%s\n' "- 来源: conversation"
  printf '%s\n' "- 作用域: $MODE"
  project_meta_line
  printf '%s\n' "- 关联文件: (可选)"
  printf '%s\n' "- 标签: (可选)"
}

new_id() {
  TYPE="$1"
  DATE=$(date -u +%Y%m%d)
  RAND=$(tr -dc A-Z0-9 </dev/urandom | head -c 3)
  echo "${TYPE}-${DATE}-${RAND}"
}

log_learning() {
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ID=$(new_id LRN)
  SUMMARY="$1"
  DETAILS="${2:-（可选）}"
  {
    printf '\n## [%s] category\n\n' "$ID"
    printf '**记录时间**: %s\n' "$TS"
    printf '**优先级**: medium\n'
    printf '**状态**: pending\n'
    printf '**领域**: docs\n\n'
    printf '### 摘要\n%s\n\n' "$SUMMARY"
    printf '### 详情\n%s\n\n' "$DETAILS"
    printf '### 建议动作\n（待补充）\n\n'
    printf '### 元数据\n'
    meta_block
    printf '\n---\n'
  } >> "$LEARN"
  echo "已记录：$ID → $LEARN"
}

log_error() {
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ID=$(new_id ERR)
  SUMMARY="$1"
  DETAILS="${2:-（粘贴错误信息）}"
  {
    printf '\n## [%s] command\n\n' "$ID"
    printf '**记录时间**: %s\n' "$TS"
    printf '**优先级**: high\n'
    printf '**状态**: pending\n'
    printf '**领域**: infra\n\n'
    printf '### 摘要\n%s\n\n' "$SUMMARY"
    printf '### Error\n```\n%s\n```\n\n' "$DETAILS"
    printf '### Context\n- 尝试的命令/操作：\n- 输入或参数：\n- 环境细节：\n\n'
    printf '### 建议修复\n（待补充）\n\n'
    printf '### 元数据\n'
    printf '%s\n' '- 可复现: unknown'
    printf '%s\n' "- 作用域: $MODE"
    project_meta_line
    printf '%s\n\n' '- 关联文件: (可选)'
    printf '%s\n' '---'
  } >> "$ERRS"
  echo "已记录：$ID → $ERRS"
}

log_feature() {
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ID=$(new_id FEAT)
  SUMMARY="$1"
  DETAILS="${2:-（可选）}"
  {
    printf '\n## [%s] capability\n\n' "$ID"
    printf '**记录时间**: %s\n' "$TS"
    printf '**优先级**: medium\n'
    printf '**状态**: pending\n'
    printf '**领域**: docs\n\n'
    printf '### 需求能力\n%s\n\n' "$SUMMARY"
    printf '### 用户背景\n%s\n\n' "$DETAILS"
    printf '### 复杂度评估\nmedium\n\n'
    printf '### 建议实现\n（待补充）\n\n'
    printf '### 元数据\n'
    printf '%s\n' '- 频次: first_time'
    printf '%s\n' "- 作用域: $MODE"
    project_meta_line
    printf '%s\n\n' '- 关联功能: (可选)'
    printf '%s\n' '---'
  } >> "$FEAT"
  echo "已记录：$ID → $FEAT"
}

status() {
  init
  echo "模式: $MODE"
  echo "基础路径: $BASE"
  [ -n "$PROJECT_ROOT" ] && echo "项目路径: $PROJECT_ROOT"
  echo "全局区: $GLOBAL_BASE"
  echo "LEARNINGS: $LEARN"
  echo "ERRORS: $ERRS"
  echo "FEATURES: $FEAT"
  printf 'pending: '
  cat "$LEARN" "$ERRS" "$FEAT" | grep -c '^\*\*状态\*\*: pending' || true
}

# 当前作用域 + 全局区（去重）
search_dirs() {
  printf '%s\n' "$BASE"
  [ "$BASE" = "$GLOBAL_BASE" ] || printf '%s\n' "$GLOBAL_BASE"
}

search_all() {
  KEYWORD="$1"
  [ -n "$KEYWORD" ] || { echo "缺少搜索关键词" >&2; exit 1; }
  search_dirs | while IFS= read -r d; do
    [ -d "$d" ] && grep -n -i -- "$KEYWORD" "$d"/*.md 2>/dev/null
  done || true
}

promote_to_global() {
  ENTRY_ID="$1"
  [ -n "$ENTRY_ID" ] || { echo "缺少条目 ID" >&2; exit 1; }
  if [ "$BASE" = "$GLOBAL_BASE" ]; then
    echo "当前作用域已是全局区，无需提升" >&2
    exit 1
  fi
  SRC=$(grep -l "^## \[$ENTRY_ID\]" "$BASE"/*.md 2>/dev/null | head -n 1)
  [ -n "$SRC" ] || { echo "未在 $BASE 找到条目：$ENTRY_ID" >&2; exit 1; }
  TARGET="$GLOBAL_BASE/$(basename "$SRC")"
  init_dir "$GLOBAL_BASE"
  if grep -q "^## \[$ENTRY_ID\]" "$TARGET" 2>/dev/null; then
    echo "条目已存在于全局区：$TARGET"
    exit 0
  fi
  echo "" >> "$TARGET"
  awk -v id="$ENTRY_ID" '
    BEGIN {capture=0}
    $0 ~ "^## \\[" id "\\]" {capture=1}
    capture {print}
    capture && $0 == "---" {exit}
  ' "$SRC" >> "$TARGET"

  TMP=$(mktemp)
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  awk -v id="$ENTRY_ID" -v target="$TARGET" -v ts="$TS" '
    BEGIN {in_block=0; promoted_done=0; resolution_seen=0}
    {
      if ($0 ~ "^## \\[" id "\\]") in_block=1
      if (in_block && $0 == "**状态**: pending") { print "**状态**: promoted"; next }
      if (in_block && $0 ~ /^\*\*已提升到\*\*:/) promoted_done=1
      if (in_block && $0 == "### 解决记录") resolution_seen=1
      if (in_block && $0 == "---") {
        if (!promoted_done) print "**已提升到**: " target
        if (!resolution_seen) {
          print ""
          print "### 解决记录"
          print "- **解决时间**: " ts
          print "- **说明**: 已提升到全局区"
        }
        print
        in_block=0; promoted_done=0; resolution_seen=0
        next
      }
      print
    }
  ' "$SRC" > "$TMP"
  mv "$TMP" "$SRC"

  echo "已提升：$ENTRY_ID → $TARGET"
  echo "已回写源条目状态为 promoted"
}

usage() {
  echo "用法：$0 [--project [目录] | --global | --base 目录] init | status | learning <摘要> [详情] | error <摘要> [错误] | feature <摘要> [背景] | search <关键词> | promote <条目ID>" >&2
  exit 1
}

case "$1" in
  init)
    init
    echo "已初始化：$BASE"
    ;;
  status)
    status
    ;;
  learning)
    [ -n "$2" ] || usage
    init
    log_learning "$2" "$3"
    ;;
  error)
    [ -n "$2" ] || usage
    init
    log_error "$2" "$3"
    ;;
  feature)
    [ -n "$2" ] || usage
    init
    log_feature "$2" "$3"
    ;;
  search)
    search_all "$2"
    ;;
  promote)
    promote_to_global "$2"
    ;;
  *)
    usage
    ;;
esac
