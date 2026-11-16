// The jobs themselves, run only inside the child process (child.ts): sharp and pdfjs-dist are loaded here and nowhere
// else in Shelf (ADR 0009). Each takes bytes and gives back plain data; errors are a fixed vocabulary.
import { MEDIA_LIMITS, type MediaError } from '@shelf/contracts/media';
import { sniff } from './sniff';

export class JobError extends Error {
  constructor(readonly code: MediaError) { super(code); }
}

/** Decodes an image (within the pixel limit), drops every metadata block, and writes a fresh JPEG. */
export async function reencodeImage(input: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  if (input.length > MEDIA_LIMITS.maxInput['image.reencode']) throw new JobError('too_large');
  const type = sniff(input);
  if (!['jpeg', 'png', 'webp', 'gif'].includes(type)) throw new JobError('not_this_type');
  const { default: sharp } = await import('sharp');
  sharp.cache(false);
  sharp.concurrency(1);
  const img = sharp(input, { limitInputPixels: MEDIA_LIMITS.maxPixels, failOn: 'error', sequentialRead: true, pages: 1, animated: false });
  let meta;
  try { meta = await img.metadata(); } catch (e) { throw new JobError(/pixel limit/i.test(String((e as Error).message)) ? 'too_many_pixels' : 'unreadable'); }
  if (!meta.width || !meta.height) throw new JobError('unreadable');
  if (meta.width * meta.height > MEDIA_LIMITS.maxPixels) throw new JobError('too_many_pixels');
  try {
    // rotate(): apply the EXIF orientation, then the EXIF is gone with the rest of the metadata (sharp keeps none by default).
    const { data, info } = await img.rotate().resize({ width: MEDIA_LIMITS.maxSide, height: MEDIA_LIMITS.maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (e) {
    if (/pixel limit/i.test(String((e as Error).message))) throw new JobError('too_many_pixels');
    throw new JobError('unreadable');
  }
}

/** The text of a PDF, as rows of cells (items on one line, split where the gap is wide), within the limits. */
export async function pdfText(input: Uint8Array): Promise<{ pages: number; rows: string[][]; truncated: boolean }> {
  if (input.length > MEDIA_LIMITS.maxInput['pdf.text']) throw new JobError('too_large');
  if (sniff(input) !== 'pdf') throw new JobError('not_this_type');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(input),
    // Nothing in a PDF runs or loads: pdfjs 6 has no eval path at all; no fonts, no XFA forms, no WebAssembly image
    // decoders, no streaming or fetching (and the container has no network besides).
    disableFontFace: true, useSystemFonts: false, enableXfa: false, useWasm: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    disableAutoFetch: true, disableStream: true, disableRange: true, stopAtErrors: true, verbosity: 0,
  });
  let doc;
  try { doc = await task.promise; } catch { await task.destroy(); throw new JobError('unreadable'); }
  const pages = Math.min(doc.numPages, MEDIA_LIMITS.pdfMaxPages);
  const rows: string[][] = [];
  let chars = 0;
  let truncated = false;
  try {
    for (let n = 1; n <= pages && !truncated; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines = new Map<number, { x: number; w: number; s: string }[]>();
      for (const it of content.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        const y = Math.round(it.transform[5]);
        lines.set(y, [...(lines.get(y) ?? []), { x: it.transform[4], w: it.width, s: it.str }]);
      }
      for (const y of [...lines.keys()].sort((a, b) => b - a)) {
        const cells: string[] = [];
        let end = -Infinity;
        for (const p of lines.get(y)!.sort((a, b) => a.x - b.x)) {
          if (cells.length && p.x - end < 6) cells[cells.length - 1] += (p.x - end > 1 ? ' ' : '') + p.s.trim();
          else cells.push(p.s.trim());
          end = p.x + p.w;
        }
        chars += cells.reduce((k, c) => k + c.length, 0);
        if (chars > MEDIA_LIMITS.pdfMaxText) { truncated = true; break; }
        rows.push(cells);
      }
      page.cleanup();
    }
  } catch { throw new JobError('unreadable'); } finally { await task.destroy(); }
  return { pages, rows, truncated: truncated || doc.numPages > pages };
}
