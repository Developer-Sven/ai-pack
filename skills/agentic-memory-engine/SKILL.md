---
name: agentic-memory-engine
description: Embedded, zero-external-DB hybrid memory engine for coding agents. Combines SQLite-vec/LanceDB vector search, FTS5 BM25 keyword search, Weibull temporal decay, and deterministic PreToolUse instinct extraction.
---

# Agentic Memory Engine (Local-First Hybrid Search)

This skill implements the 2026 "Log is the Agent" local-first memory architecture. Flat markdown files and append-only JSONL observation streams serve as the ground truth; embedded SQLite-vec/LanceDB indexes act as an ephemeral acceleration layer.

---

## 1. Operating Architecture

```
Session Invocations
       │
       ▼ (PreToolUse / PostToolUse Hooks)
[ observations.jsonl ] ──(async extraction)──► [ instincts/*.yaml ] (Atomic)
       │                                              │
       ▼ (SHA-256 Hash Guard)                         ▼
[ SQLite-vec + FTS5 ] ◄──(Hybrid RRF Query)───── [ Agent Working Context ]
```

---

## 2. Ingestion & Retrieval Contract

- **Storage Path**: `${XDG_DATA_HOME:-~/.local/share}/agent-memory/projects/<project-hash>/`
- **Hybrid Search via Reciprocal Rank Fusion (RRF)**:
  1. Vector ANN search using cosine similarity on `sqlite-vec` (top 50).
  2. BM25 keyword query on SQLite `FTS5` virtual table (top 50).
  3. Combine ranks using Reciprocal Rank Fusion ($k = 60$):
     $$RRF(d) = \sum_{m \in \{BM25, Vec\}} \frac{1}{60 + rank_m(d)}$$
  4. Apply temporal memory decay based on observation age:
     $$Score_{final} = RRF \times e^{-0.05 \times (\Delta days)^{0.8}}$$

---

## 3. Atomic Instinct Schema

An instinct must be atomic and conform to the standard schema:
```yaml
id: unique-kebab-slug
trigger: "when <specific technical scenario occurs>"
action: "<exact imperative rule to apply>"
confidence: 0.3 - 0.9
domain: "testing|security|architecture|style"
scope: "project|global"
evidence:
  - "Observed in session X"
  - "User corrected Y"
```

---

## 4. Execution Rules

1. **No External Vector Daemons**: Never spin up external Docker containers for agent memory. Use embedded `sqlite-vec` or LanceDB.
2. **Context Hydration**: Read compact project context from `context.json` upon session start.
3. **Promotion Path**: Promote instincts from `project` to `global` scope when observed across $\ge 2$ independent repositories with confidence $\ge 0.8$.
