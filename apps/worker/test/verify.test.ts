// ffmpeg/verify.sh's judgement of gpg's status lines (gpg's doc/DETAILS): only a good signature by the pinned key, and
// never one by that key once it is expired or revoked (PR #21 review).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const KEY = 'FCF986EA15E6E293A5644F10B4322F04D67658D8';
const LONG = KEY.slice(24);
const judge = (...lines: string[]) =>
  spawnSync('sh', [join(__dirname, '../ffmpeg/verify.sh'), '--judge'], { input: lines.map((l) => `[GNUPG:] ${l}\n`).join(''), encoding: 'utf8' }).status;

const good = `GOODSIG ${LONG} FFmpeg release signing key <ffmpeg-devel@ffmpeg.org>`;
const valid = (fpr = KEY) => `VALIDSIG ${fpr} 2026-03-01 1772323200 0 4 0 1 10 00 ${fpr}`;

describe('verify.sh --judge', () => {
  it('passes a good signature by the pinned key', () => {
    expect(judge('NEWSIG', 'KEY_CONSIDERED ' + KEY + ' 0', 'SIG_ID x 2026-03-01 1772323200', good, valid(), 'TRUST_UNDEFINED 0 pgp')).toBe(0);
  });

  it('refuses one by an expired or revoked key, though gpg calls it VALIDSIG', () => {
    expect(judge(`EXPKEYSIG ${LONG} FFmpeg release signing key`, valid())).toBe(1);
    expect(judge(`REVKEYSIG ${LONG} FFmpeg release signing key`, valid())).toBe(1);
    // and a GOODSIG next to one of them (two signatures, say) does not outweigh it
    expect(judge(good, valid(), `REVKEYSIG ${LONG} FFmpeg release signing key`)).toBe(1);
    expect(judge(good, valid(), `EXPKEYSIG ${LONG} FFmpeg release signing key`)).toBe(1);
    expect(judge(good, valid(), `EXPSIG ${LONG} FFmpeg release signing key`)).toBe(1);
  });

  it('refuses VALIDSIG without GOODSIG, GOODSIG without VALIDSIG, another key, a bad or unchecked signature', () => {
    expect(judge(valid())).toBe(1);
    expect(judge(good)).toBe(1);
    expect(judge(`GOODSIG 0123456789ABCDEF Someone else`, valid())).toBe(1);
    expect(judge(good, valid('0123456789ABCDEF0123456789ABCDEF01234567'))).toBe(1);
    expect(judge(good, valid(), `BADSIG ${LONG} FFmpeg release signing key`)).toBe(1);
    expect(judge(good, valid(), `ERRSIG ${LONG} 1 10 00 1772323200 9 -`)).toBe(1);
    expect(judge()).toBe(1);
  });
});
