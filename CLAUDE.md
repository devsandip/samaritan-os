# Samaritan (`devsandip/samaritan-os`)

Local-first personal agentic operating system, Action Center review gate, cross-assistant MCP server, delegated worker runner, and hybrid Recall engine on macOS.

## Stack & Conventions

- **Runtime:** Node >= 24 (`node:sqlite` `DatabaseSync`, native TypeScript execution via `--experimental-strip-types`).
- **Package manager:** `pnpm` (`pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm build:ui`).
- **Server & UI:** Fastify (`127.0.0.1:4173`) serving both `/api/*` and the Vite + React SPA (`ui/`).
- **Secrets:** Stored exclusively in macOS Keychain under service `"samaritan"` (`security add-generic-password -s samaritan -a <account> -w`). Never write secrets to `~/.samaritan/config.yaml`, `.env`, or git.
- **Canonical docs:**
  - Engineering spec: `docs/COMMAND-CENTRE-SPEC.md`
  - Consensus architecture: `docs/deliberations/consensus/PROPOSAL-v1.md`
  - Foundation specs: `docs/TECH-SPEC.md`, `docs/UI-SPEC.md`, `docs/PRD.md`
  - MCP routing guide: `docs/SAMARITAN_MCP.md`
  - Live status & milestone reports: `docs/STATUS.md` and `docs/reports/`

## Milestone Completion Report Protocol (Mandatory)

Every time a GitHub Milestone is completed (or when requested by Sandip), you must:

1. Present a candid completion report in chat and file it in `docs/reports/MILESTONE-<N>-REPORT.md`, while updating `docs/STATUS.md` to reflect the latest state.
2. Follow the exact report structure:
   - **Top-line completion percentage:** State the honest percentage built against the full intended daily-driver release (with a reasonable range), explicitly separating merged/tested code scaffolds from disabled, unconfigured, or unverified runtime integrations.
   - **One-paragraph runtime summary:** State which surfaces and loops work end to end today and which cross-surface experiences remain unfinished.
   - **Area-by-area table (`Area | Built so far | What remains`):** Cover Action Center/Store, Desktop & Phone Web UI, Cross-Assistant MCP, Delegated Worker Sandbox, Recall (Hybrid Search), Anchor Filing, Meetings & Comms, Bidirectional Telegram, and Domain Capabilities. Bold concrete blockers or disabled modes in the "What remains" column.
   - **Spec & artifact alignment:** Confirm whether specs and mockups match the latest requirements.
   - **Recent progress & repo state:** Summarize what shipped in the milestone, current branch/PR state, test counts, and CI/build status.
   - **Main unresolved problems:** Bullet list of concrete, verified gaps (empty tables, missing tokens, unverified external calls, heuristic-only agents).
   - **Milestone status & next steps:** State the milestone closed/open counts (noting that ticket count is not whole-product completion percentage) and name the next milestone or issue to tackle.
