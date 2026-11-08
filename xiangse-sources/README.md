# Xiangse book sources (JSON/XBS)

- `SKILL.md` — skill definition (Codex/pi/Claude compatible frontmatter)
- `scripts/xs.js` — zero-dependency lint / fmt / probe / try / sniff for Xiangse sources
- `scripts/xbs.js` — zero-dependency XBS <-> JSON codec (XXTEA)
- `references/` — worked example and source-writing patterns

```bash
node scripts/xbs.js selftest
node scripts/xs.js probe sources.xbs --jobs 8 --report report.json
```
