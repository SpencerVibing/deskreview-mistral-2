# Cached Jump-Link Test Loop

Use this loop when iterating on counts, result details, OCR HTML rendering, and jump links for real PDFs.

## Observation

Repeated live OCR, document annotation, and resolver calls are expensive. We need to cache OCR/API outputs and run most tests against stored payloads, then do one final live pass.

## Loop

1. Start the local server.

   ```bash
   PORT=8891 npm start
   ```

2. Record one live run after confirming the Mistral key and billing state are healthy.

   ```bash
   JUMP_LINK_TIMEOUT_MS=420000 npm run verify:jump-links:record -- \
     "/path/to/manuscript-1.pdf" \
     "/path/to/manuscript-2.pdf"
   ```

   This writes successful local API responses to `.cache/mistral-api/`. The cache can contain manuscript text and OCR image payloads, so it stays local and is ignored by git.

3. Iterate with cached replay.

   ```bash
   JUMP_LINK_TIMEOUT_MS=420000 npm run verify:jump-links:cached -- \
     "/path/to/manuscript-1.pdf" \
     "/path/to/manuscript-2.pdf"
   ```

   Cached replay intercepts `/api/*` calls in Playwright and serves the stored responses. It still exercises the real browser UI, count tiles, details panels, HTML block activation, and PDF highlight checks, but it does not spend Mistral tokens.

4. Run normal local checks.

   ```bash
   npm run check
   ```

5. Run one final live pass before treating the change as verified.

   ```bash
   JUMP_LINK_TIMEOUT_MS=420000 npm run verify:jump-links:live -- \
     "/path/to/manuscript-1.pdf" \
     "/path/to/manuscript-2.pdf"
   ```

## Modes

- `API_CACHE_MODE=record`: call the real local server/API and store successful `/api/*` responses.
- `API_CACHE_MODE=replay`: serve `/api/*` responses from `.cache/mistral-api/`; fail fast on cache misses.
- `API_CACHE_MODE=off`: call the live local server/API without reading or writing the cache.

By default, failed API responses are not cached. Set `API_CACHE_RECORD_FAILURES=1` only when debugging failure handling.
