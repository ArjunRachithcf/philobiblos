// Bundles the server and the workspace packages into dist/main.js. The server's own dependencies (native
// better-sqlite3, Fastify, Drizzle) stay external and are installed in the image by `pnpm deploy`.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@shelf/'));

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/main.js',
  external: external.flatMap((d) => [d, `${d}/*`]),
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
