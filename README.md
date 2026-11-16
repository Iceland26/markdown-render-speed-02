# markdown-render-speed-02

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-7C3AED)](https://make.fun/bounty/markdown-render-speed-02)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Built for the [markdown-render-speed-02 bounty on make.fun](https://make.fun/bounty/markdown-render-speed-02) — a speed contest: render Markdown to exactly the HTML that marked 18.1.3 produces, only faster.

A fast, drop-in, marked-compatible Markdown renderer written from scratch in
dependency-free JavaScript. `parse(markdown)` returns byte-for-byte the HTML
that marked 18.1.3 renders with its default options (GFM on): CommonMark
blocks and inlines, GFM tables, task lists, strikethrough and extended
autolinks, and marked's own quirks (its escaping, entity handling, HTML block
and list behaviour) are all reproduced.

## Layout

| File | What |
| --- | --- |
| `parse.js` | The renderer: a chunk-style block parser (fences, headings, block quotes, lists, tables, HTML blocks, link reference definitions) plus a scanner + delimiter-stack inline parser. No imports, no dependencies. |
| `main.ts` | The harness driver: reads `cases.json` from `MAKEFUN_INPUT_DIR` (default `/input`), renders every case, writes `html.json` to `MAKEFUN_OUTPUT_DIR` (default `/output`). |

## Running

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

## How it is fast

- Single pass over the input with line-oriented block parsing and no
  backtracking regexes on hot paths.
- Inline scanning consumes long plain-text runs in one go and only slows
  down around actual constructs.
- Link reference definitions are collected during the block pass, so inline
  rendering never re-scans the document.
- String building with array joins and minimal intermediate allocations.
