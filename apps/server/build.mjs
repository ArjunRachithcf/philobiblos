// Bundles the server (dist/main.js) and its CLI (dist/cli.js, `shelf recover`) with the workspace packages. The server's own dependencies (native
// better-sqlite3, Fastify, Drizzle) stay external and are installed in the image by `pnpm deploy`.
import { cpSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@shelf/'));

await build({
  entryPoints: ['src/main.ts', 'src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist',
  external: external.flatMap((d) => [d, `${d}/*`]),
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

// The AI's versioned prompts (packages/ai/prompts), read at run time next to the bundle (packages/ai/src/prompt.ts).
cpSync(new URL('../../packages/ai/prompts/', import.meta.url), new URL('./dist/prompts/', import.meta.url), { recursive: true, filter: (f) => !f.endsWith('README.md') });
