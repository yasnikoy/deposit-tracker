# graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- The graph is local only: `graphify-out/` is git-ignored and never published. It stays fresh by itself: git hooks rebuild it after every commit, checkout, merge and rebase, and a Claude Code Stop hook (`.claude/settings.local.json` → `.claude/hooks/graphify-refresh.sh`) runs `graphify update .` in the background after a turn, only when git's view of the code changed since its last run. Run `graphify update .` yourself before a query when code changed earlier in the same turn.
- Keep graphify current: `uv tool upgrade graphifyy`, then `graphify install --platform claude` and `graphify hook install`. Its machine-specific files (`.claude/settings*.json`, `.claude/hooks/`, `.gitattributes`) are listed in `.git/info/exclude`; never commit them.
