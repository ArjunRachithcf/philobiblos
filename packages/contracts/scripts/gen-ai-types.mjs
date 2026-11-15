// Generates src/ai.gen.ts from contracts/ai/*.schema.json (run by `pnpm gen:api`).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { compile } from 'json-schema-to-typescript';

const dir = new URL('../../../contracts/ai/', import.meta.url);
const names = {
  'extract_titles.schema.json': 'ExtractTitlesOut',
  'tag_book.schema.json': 'TagBookOut',
  'propose_links.schema.json': 'ProposeLinksOut',
  'suggest_next.schema.json': 'SuggestNextOut',
};
const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json')).sort();
for (const f of files) if (!names[f]) throw new Error(`no type name for contracts/ai/${f}: add it to ${import.meta.url}`);

let out = '// Generated from contracts/ai/*.schema.json by scripts/gen-ai-types.mjs. Do not edit.\n/* eslint-disable */\n';
for (const f of files) {
  const schema = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  delete schema.$id;
  schema.title = names[f];
  out += '\n' + (await compile(schema, names[f], { bannerComment: '', additionalProperties: false, strictIndexSignatures: true, maxItems: -1 }));
}
writeFileSync(new URL('../src/ai.gen.ts', import.meta.url), out);
