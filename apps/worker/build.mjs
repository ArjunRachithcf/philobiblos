// Bundles the media worker (dist/main.js, the job loop; dist/child.js, one job under limits) with the workspace
// packages. sharp and pdfjs-dist stay external: installed in the image by `pnpm deploy`, in the worker's tree only.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@shelf/'));

await build({
  entryPoints: ['src/main.ts', 'src/child.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist',
  external: external.flatMap((d) => [d, `${d}/*`]),
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
