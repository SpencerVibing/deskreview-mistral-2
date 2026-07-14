# DeskReview Mistral 2 Agent Rules

## Studio parity baseline
- This project exists to replicate the fast Mistral Studio OCR4 reader first: PDF pane plus OCR4 HTML pane with source-grounded jump links.
- Do not import code from `deskreview`, `deskreview claude`, or `deskreview-mistral`.
- Do not add DeskReview-specific checks until Studio parity is verified on the same manuscript.
- Use one OCR4 request as the primary source of truth. Do not add separate chat-completions reconstruction passes for ToC, references, tables, figures, or anchors in the baseline.
- App code may render OCR4 pages, blocks, tables, images, and bounding boxes. It may validate whether returned OCR coordinates are usable. It must not infer manuscript structure that OCR4 did not return.
- Preserve a clear run summary so Studio-vs-local latency can be compared.
- BIG WARNING: If a proposed or implemented feature slows core OCR-to-reader performance, or degrades the availability, accuracy, or quality of jump-links, assume the implementation is likely inefficient or architecturally wrong. Stop and surface a clear warning before proceeding; preserve Studio-parity speed and source-grounded jump-link quality as the baseline contract.
- Treat the current medRxiv baseline as a performance benchmark: one OCR4 request, OCR-to-reader ready in roughly 3-5 seconds locally, 24 HTML pages, OCR block links available, PDF regions available, tables and figures rendered. Any feature that materially worsens this benchmark must trigger the BIG WARNING above.
- A Table of Contents may only be a UI projection of OCR4-returned/rendered headings and existing block anchors. It must not add model calls, reparsing, heading inference, or a second anchor-resolution path.
- Right-side count tiles in the Studio-parity baseline may only summarize already-returned OCR4 data such as pages, words from OCR blocks, headings, blocks, tables, and figures. Do not label deterministic local counts as journal-rule article/abstract/reference counts.
- Semantic DeskReview tiles such as abstract word count, article word count, reference count with citation usage, and table/figure citation details require OCR4 document annotation or equivalent model-authored structure. They must not run automatically in the Studio-parity baseline unless live benchmarking proves they preserve the 3-5 second OCR-to-reader target and jump-link quality. If they are added before that, they must be optional/background and clearly labeled as an enhancement pass.

## UI
- Keep the UI close to Mistral Studio's two-pane reader: PDF controls on the left, OCR HTML blocks on the right.
- Bootstrap is the default UI implementation path. Before adding or keeping custom CSS, check whether Bootstrap components or utilities can provide the same layout, spacing, typography, color, borders, shadows, buttons, cards, lists, tables, modals, accordions, progress states, or responsive behavior.
- Use custom CSS only when Bootstrap cannot reasonably provide the behavior, such as split-pane grid sizing, draggable resizers, PDF canvas overlays, OCR block hover/highlight states, article typography, tile reveal animations, and the sliding details panel.
- When touching UI, remove custom CSS that merely duplicates Bootstrap utilities/components.
