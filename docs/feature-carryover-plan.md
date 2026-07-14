# DeskReview Mistral 2 Feature Carryover Plan

This project should carry forward the useful DeskReview feature set by reimplementing behavior against the `deskreview-mistral-2` OCR4-first reader. Older projects are references for behavior and product intent only. Do not import code from `deskreview`, `deskreview claude`, or `deskreview-mistral`.

## Baseline Contract

- Preserve the Studio-parity reader first: PDF pane, OCR HTML pane, source-grounded jump links, tables, figures, and runtime summary.
- Keep the core OCR-to-reader path fast. The medRxiv baseline should remain roughly 3-5 seconds locally for OCR-to-reader readiness.
- Use one OCR4 request as the primary source of truth for the baseline. Heavier document annotation, guideline checks, plugin checks, and reporting should run after the reader is usable.
- Do not infer manuscript structure from deterministic PDF parsing. App code may validate, render, cache, retry, and surface failure states.
- Keep UI Bootstrap-first. Use custom CSS only for split panes, draggable tracks, PDF overlays, OCR highlights, details sliders, and similarly specific interactions.

## Milestones

1. **Checkpoint Current State**
   - Save this plan in the repo.
   - Commit the current UI fixes and baseline documentation.
   - Add a local smoke test that protects the current server/static/API validation contract.
   - Confirm the existing local server still responds.

2. **Create Architecture Boundaries**
   - Split the current monolithic browser code into `/app`, `/core`, `/services`, and `/data` modules.
   - Preserve current behavior exactly while extracting modules.
   - Add unit tests for pure result shaping before moving behavior.

3. **Counts Tile Mini Progress Bars**
   - Reimplement the mini progress/result bars for count tiles using current Mistral-resolved counts.
   - Cover pending, running, ready, unavailable, within-limit, and over-limit states.
   - Add tests for bar segment calculation and tile labels.

4. **Document Annotation Layer**
   - Define a structured Mistral annotation response for title/front matter, counted text, references, citations, tables, figures, and quote anchors.
   - Run this after OCR reader readiness.
   - Store annotation output with browser reviews and maintain a clear runtime summary.

5. **EASE Essential Guidelines**
   - Add static EASE Essential guideline data under `/data`.
   - Build a guideline runner that evaluates guide items from Mistral annotation output and returns structured status, evidence quotes, and anchors.
   - Render Essential guide cards in the side pane.

6. **Details Slider**
   - Generalize the current details panel into a guideline result slider.
   - Add filters, status grouping, quotes, copy affordances, OCR jump links, and PDF region jumps.
   - Test filter behavior and quote navigation.

7. **Plugin and Customization System**
   - Add a compact plugin manifest and registry model.
   - Support enabled/disabled state, pinned guides, custom guides, and browser persistence.
   - Keep scheduling explicit so plugins do not block OCR-to-reader readiness.

8. **Reporting and Matched Guidelines**
   - Add a guideline catalog and a Mistral matching pass.
   - Run matched guideline checks in the background.
   - Feed results into the same detail slider and feedback report model.

9. **Landing/Homepage and Examples**
   - Expand the home page with stored reviews, upload, example manuscripts, and benchmark/runtime context.
   - Adapt example data to the new result contracts instead of copying old app state.

10. **Feedback Report**
    - Generate the report from the normalized result store.
    - Include counts, guideline results, missing items, quotes, and source anchors.
    - Add browser verification before treating export/print as complete.

## Verification Policy

- Every milestone ends with a commit and push so it is a rollback point.
- Run `npm run check` before committing.
- Add targeted tests with each new behavior.
- Browser smoke tests should cover upload, reader readiness, ToC, count tiles, details slider filters, quote jumps, PDF highlights, and stored review reloads as those features land.
- If a feature slows reader readiness or weakens source-grounded jumps, stop and rework the design before continuing.

## Milestone Log

- Milestone 1 complete in `299c5eb`: baseline checkpoint, plan, and local smoke test.
- Milestone 2 complete: browser app moved behind `/app/reader.js`, ToC projection extracted to `/core/toc.js`, browser storage and Mistral API calls extracted to `/services`, and ToC projection unit coverage added.
- Milestone 3 complete: count-tile benchmark progress bars added through `/core/count-progress.js`, rendered in released count tiles, and covered by unit/baseline tests.
