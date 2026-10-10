---
name: skill-creator
version: 2.1.0
description: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends the agent's capabilities with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

This skill provides guidance for creating effective skills.

## About Skills

Skills are modular, self-contained packages that extend the agent's capabilities by providing
specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific
domains or tasks—they transform the agent from a general-purpose agent into a specialized agent
equipped with procedural knowledge that no model can fully possess.

### What Skills Provide

1. Specialized workflows - Multi-step procedures for specific domains
2. Tool integrations - Instructions for working with specific file formats or APIs
3. Domain expertise - Company-specific knowledge, schemas, business logic
4. Bundled resources - Scripts, references, and assets for complex and repetitive tasks

## Core Principles

### Concise is Key

The context window is a public good. Skills share the context window with everything else the agent needs: system prompt, conversation history, other Skills' metadata, and the actual user request.

**Default assumption: the agent is already very smart.** Only add context the agent doesn't already have. Challenge each piece of information: "Does the agent really need this explanation?" and "Does this paragraph justify its token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

Match the level of specificity to the task's fragility and variability:

- **High freedom (text-based instructions)**: Use when multiple approaches are valid.
- **Medium freedom (pseudocode or scripts with parameters)**: Use when a preferred pattern exists.
- **Low freedom (specific scripts, few parameters)**: Use when operations are fragile, consistency is critical, or a specific sequence must be followed.

### Anatomy of a Skill

Every skill consists of a required SKILL.md file and optional bundled resources:

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name + description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/       - Executable code
    ├── references/    - Documentation loaded as needed
    └── assets/        - Files used in output (templates, icons, etc.)
```

#### SKILL.md Frontmatter

- `name` (required): The skill name
- `description` (required): What the skill does and when to trigger it. Be comprehensive—this is the primary triggering mechanism.

#### SKILL.md Body

Instructions and guidance, loaded after the skill triggers. Keep under 500 lines; split into reference files when approaching this limit.

### Progressive Disclosure

Skills use three loading levels:
1. **Metadata** - Always in context (~100 words)
2. **SKILL.md body** - When skill triggers (<5k words)
3. **Bundled resources** - As needed (unlimited)

## Skill Creation Process

1. **Understand** the skill with concrete examples from the user
2. **Plan** reusable contents (scripts, references, assets)
3. **Create** the SKILL.md with proper frontmatter and instructions
4. **Test** by using the skill on real tasks
5. **Iterate** based on actual usage

### Writing the SKILL.md

- Use imperative/infinitive form
- `description` field should include all "when to use" triggers (body is loaded after triggering)
- Only add context the agent doesn't already have
- Prefer concise examples over verbose explanations
- Keep essential workflow in SKILL.md; move detailed reference material to separate files

### Portability (cross-agent)

Skills in this format (agentskills.io) load in Minis, pi, Codex, Claude Code, Antigravity and other agents. Target them in that priority order and keep them portable:

- Frontmatter: only `name` + `description` are required everywhere; `name` must match the directory name (lowercase kebab-case). Extra keys (`metadata`, `compatibility`) are optional and may be ignored.
- Never hardcode host-specific absolute paths (app sandboxes, a particular agent's home dir, `/tmp`). Reference bundled files relative to the skill directory (`scripts/foo.py`), and let the agent decide where inputs/outputs live — usually the user's working directory.
- Don't write runtime data into the skill directory; it may be read-only, symlinked, or shared by several agents. Use the project directory or a user-level data dir, configurable by flag/env var.
- Don't depend on one agent's private tools (e.g. a specific memory or file-read tool). Describe the intent ("record this in the agent's long-term memory") and let the host pick the mechanism.
- Invoke scripts through an interpreter (`python3 scripts/x.py`, `sh scripts/x.sh`, `node scripts/x.js`) so they work without execute permission; list runtime dependencies.

Install locations, by priority: Minis skills dir (scans one level of `<name>/SKILL.md`, no nesting); `~/.agents/skills/` (pi, Codex); `~/.claude/skills/` (Claude Code); `~/.gemini/config/skills/` (Antigravity). Project scope: `.agents/skills/` or `.claude/skills/`.

### What NOT to Include

Do not create extraneous files: README.md, INSTALLATION_GUIDE.md, CHANGELOG.md, etc. The skill should only contain what an AI agent needs to do the job.