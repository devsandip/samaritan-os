# Architecture Research

Research snapshots gathered while re-evaluating Samaritan's architecture — specifically the *buy-vs-build* question for its two core systems:

1. **The agent runtime** — schedules and durably runs agents (cron + events), keeps them alive, manages secrets.
2. **The HITL Action Center** — the typed, policy-driven, audited inbox where agents post proposals and the user reviews, edits, approves, or rejects.

The working hypothesis under evaluation: adopt an off-the-shelf runtime, and reserve the build effort for the differentiated Action Center (policy engine, money-never-auto lock, per-item render schemas, autonomy gradient, append-only audit, earn-autonomy).

## Documents

### Buy-vs-build — runtime + Action Center tooling
- [`lightweight-oss-runtime-and-hitl-evaluation.md`](./lightweight-oss-runtime-and-hitl-evaluation.md) — Inventory of OSS agent runtimes and HITL/approval surfaces, filtered for light / cheap / open-source / local-first use. Comparison tables, shortlists, and a gap analysis.
- [`buy-vs-build-runtime-and-action-center.md`](./buy-vs-build-runtime-and-action-center.md) — The buy-vs-build verdict per component: adopt the runtime, build the Action Center. Gap analysis against the six Action Center differentiators.

### Claude ecosystem vs. self-hosted frameworks (OpenClaw / Hermes)
- [`claude-ecosystem-feasibility.md`](./claude-ecosystem-feasibility.md) — Whether a local-first, always-on personal agentic OS can live inside the Claude ecosystem. Inventory of Claude primitives, a Claude vs. OpenClaw vs. Hermes comparison, and a hybrid recommendation.
- [`claude-openclaw-hermes-architecture.md`](./claude-openclaw-hermes-architecture.md) — A full integration architecture across the three ecosystems: component gaps, the interrupt/resume HITL pattern, and a mapping of the 26-agent topology.

### Prior art / community builds
- [`personal-agentic-os-youtube-showcases.md`](./personal-agentic-os-youtube-showcases.md) — Analysis of documented and community personal agentic-OS builds: the layered architecture model, frameworks (OpenClaw, Letta, Mastra, LangGraph), and HITL governance patterns.

## Notes
- These are **research snapshots of the 2026 landscape**. Tool names, licenses, GitHub star counts, and beta/preview features move fast — re-verify any specific claim before relying on it.
- Two documents were authored directly in Markdown; three were converted from Word (`.docx`) with `pandoc` and no content changes.
