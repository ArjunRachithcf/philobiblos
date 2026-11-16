// What a file is, from its first bytes: never from its name, its MIME type or what the sender said.
import { videoContainer } from '@philobiblos/contracts/media';

export type Sniffed = 'jpeg' | 'png' | 'webp' | 'gif' | 'pdf' | 'mp4' | 'webm' | 'unknown';

export function sniff(b: Uint8Array): Sniffed {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'gif';
  if (b.length >= 5 && at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf';
  return videoContainer(b) ?? 'unknown';
}
