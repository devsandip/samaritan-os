# How three models reached one plan

Interactive companion to the three research rounds and the signed [consensus proposal v2](../../consensus/PROPOSAL.md).

**For a browser, open [index.html](index.html).** It contains the complete styles, embedded data and preview runtime. The template source is an input to the build, not a browser entry point.

The walkthrough has four views:

- **Rounds:** compare each model's recorded recommendation, distinctive positions, agreements and remaining questions in rounds 1–3.
- **Issues:** follow 15 decisions through initial positions, challenge, evidence checks, revision and final outcome.
- **Audit:** inspect 36 concerns against the final proposal. These are planning classifications: 16 designed, 8 partial, 6 deferred, 2 constrained, 4 missing. They are not implementation results or an agreement score.
- **Sources:** inspect the embedded report excerpts and complete saved sources with line references and SHA-256 fingerprints.

## Files

- `deliberation-map.html`: inline interactive source used in the conversation.
- `index.html`: complete standalone browser preview. `deliberation-map-preview.html` and the older `deliberation-map.template.html` entry point show the same preview.
- [coverage-audit.md](coverage-audit.md): readable audit, including the unresolved workflows and mechanisms.
- `evidence.json`: source snapshots and structured interpretation.
- `deliberation-map.fragment.html.in` and `build_data.py`: editable presentation source and reproducible data builder. The source template has a data placeholder and is not a standalone page.
- `qa/verification.json`: interaction and reference checks; `qa/*.png` records the visual review.

All sources and narrative data are embedded. The authored explainer makes no application API requests. The standalone preview runtime may load its standard icon/tooltip libraries from the allowed CDN; research content is not sent to those services.

## What the visual does and does not establish

All three models chose Samaritan as the core in round 1. Most disagreement concerned implementation, authority and evidence. Round 1 reports were independently written before reading peer reports, while factual observations were already being shared. They were not a blind experiment. Early estimated times were later corrected; the visual uses rounds and the verified final signature times rather than claiming research-duration comparisons.

The account summarizes written recommendations and stated reasons. It does not reconstruct hidden internal reasoning or assign model personalities. Evidence references identify the recorded basis for a summary; an initial claim shown as a later correction is not endorsed as a current product fact.

The final architecture was signed by all three. The post-consensus coverage interpretation is Codex's audit, informed by Claude's later gap check, rather than another joint sign-off. It identifies four workflows missing an explicit end-to-end route in v2: office arrival/commute events, calendar rearrangement from messages/screenshots, after-workout planning triggers, and upcoming interviews. Other concerns still require specification or validation. Agreement on a plan does not mean those capabilities have shipped.

## Rebuild

Run `python3 build_data.py` from this directory or by absolute path. It validates each cited marker against the current saved source, then writes the data snapshot, inline source and Markdown audit here. It never changes the signed proposal or project implementation. If the reports change, source hashes and line references will change on rebuild.

The preview was rendered with the installed Visualize skill's `scripts/render.py`. After changing the inline source, rerender `deliberation-map-preview.html`, then copy it to `index.html` and the compatibility entry `deliberation-map.template.html`. This keeps browser entry points complete rather than exposing an unbuilt template. The existing QA harness uses the bundled Playwright dependency and an isolated browser profile under `qa/`; its temporary profile and downloads are removed after verification. All authored and generated files remain inside `docs/deliberations/`.
