// Driver for the make.fun markdown-render-speed-02 harness: reads
// cases.json (an array of { id, markdown }) from MAKEFUN_INPUT_DIR
// (default /input), renders each case with parse(), and writes a JSON array
// of the HTML strings to html.json in MAKEFUN_OUTPUT_DIR (default /output).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
