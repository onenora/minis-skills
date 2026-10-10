# MinisSkills

A personal but shareable collection of agent skills. Originally built for Minis and organized to stay close to the official OpenMinis [`MinisSkills`](https://github.com/OpenMinis/MinisSkills) repository style; now host-agnostic so the same skills also run in other agents.

Target priority: **Minis > pi, Codex > Claude Code, Antigravity (agy)**.

## Repository layout

```text
.
├── README.md
└── <skill-name>/
    ├── SKILL.md
    ├── AGENTS.md     # optional maintenance notes for the skill
    ├── scripts/      # optional executable helpers
    ├── references/   # optional reference docs
    ├── assets/       # optional static assets
    └── evals/        # optional test cases
```

## Install

No install script: ask your agent to install the skills and let it decide how (clone, copy or symlink) based on the host it runs in. Each skill is a self-contained `<name>/` directory; install by placing it one level deep in a skills directory the agent scans.

Hosts in priority order (typical user-level locations, for reference):

| Priority | Agent | Typical skills dir |
|---|---|---|
| 1 | Minis | Minis 的技能目录（一级 `<name>/SKILL.md`，不扫描嵌套） |
| 2 | pi / Codex | `~/.agents/skills/` |
| 3 | Claude Code | `~/.claude/skills/` |
| 3 | Antigravity (agy) | `~/.gemini/config/skills/` |

Notes for the installing agent:

- One copy per skill per agent: the same `name` in two directories an agent scans (e.g. an old copy elsewhere) causes name collisions.
- Agents that share a directory need only one copy; others can symlink to it, unless the host may not follow symlinks (prefer a plain copy there).
- Do not install repository-level files (`README.md`, `.gitignore`); only the skill directories.

## Conventions

- Directory names use lowercase kebab-case, matching the `name` in frontmatter. Skills stay one level deep (`<name>/SKILL.md`) — Minis does not scan nested skills.
- Every skill includes `SKILL.md` with YAML frontmatter (`name` + `description`); other keys are optional and may be ignored by some agents.
- Scripts go in `scripts/`, docs go in `references/`, static files go in `assets/`, and test prompts go in `evals/`.
- **No host-specific paths in skill guidance**: reference bundled files relative to the skill directory (`scripts/foo.py`) and let the model decide where inputs/outputs live. Never write runtime data into the skill directory.
- Name host mechanisms in priority order (Minis → pi / Codex → Claude Code / agy) instead of depending on one agent's private tool.
- Invoke scripts through an interpreter (`sh` / `python3` / `node`) so they work without execute permission; keep shell scripts POSIX sh compatible (iSH / BusyBox / macOS / Linux) and list runtime dependencies.
- Repository content should not contain secrets, private tokens, cookies, personal credentials, or private-only links that break in public use.
- Book-source skills (`*-sources`) stay environment-agnostic: iOS / Android in them refers to the target reader app, not the agent host; verification commands are runnable anywhere (Python 3 / Node).

## Current skills

- heart-sources      # 用心读书(Read With Heart)书源开发
- legado-sources     # Legado/阅读书源生成与清洗
- self-improve       # 错误记录与自我改进闭环
- skill-creator      # 创建与维护 skill 规范
- web-search         # 网页搜索与正文提取（Jina/Defuddle，零注册）
- xiangse-sources    # 香色阅读(StandarReader)书源生成与验证

## Skill writing standard used in this repository

Common book-source skills follow this body structure (see `xiangse-sources` / `legado-sources` / `heart-sources`):

1. `# <Skill Title>` + one-line purpose (fail-closed principle)
2. `## 书源格式（JSON 骨架）`
3. `## 写源必备约束` (field types, crash/critical rules, rule syntax)
4. `## Convert and verify` (runnable CLI commands)
5. `## Delivery status` (`need_input` / `fail` / `blocked` / `pass`)

Other skills keep the generic layout: `When to use` → `Workflow` → `Scripts` → `References` → `Output` → `Notes`. Not every skill needs every section, but new edits should stay close to one of these two patterns.

## Verify

```bash
sh -n */scripts/*.sh
python3 -m py_compile */scripts/*.py
for f in */scripts/*.js; do node --check "$f"; done
```
