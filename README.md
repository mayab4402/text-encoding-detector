# Text Encoding Detector

Detects the encoding of a byte buffer as one of: `ascii`, `utf-8`, `utf-8-bom`,
`utf-16le-bom`, `utf-16be-bom`, `latin1`, or `unknown`. Pure ESM, zero
dependencies, runs under `node --test`.

## Usage

```js
import { detectEncoding } from './src/index.js';

const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
console.log(detectEncoding(bytes)); // 'utf-8-bom'
```

The input must be a `Uint8Array`; any other type throws `TypeError`.

## Why this exists

The problem is reading a file off disk and not knowing whether it is UTF-8,
UTF-16, Latin1, or plain ASCII before you try to decode it. Guessing wrong
produces mojibake; decoding defensively (e.g., as Latin1) silently corrupts
multibyte text.

The trade-off here is strictness over cleverness. Detection is a two-stage
process: a BOM is authoritative when present, otherwise ASCII is reported only
when every byte is in `[0, 0x7F]` and no unexpected control bytes appear, and
UTF-8 is decided by a full structural validator (RFC 3629 — overlong encodings,
UTF-16 surrogate halves, and code points above U+10FFFF are all rejected). When
none of those apply, the input falls back to Latin1 — unless it contains a NUL
byte, in which case it is reported as `unknown`.

## The awkward edge

**UTF-16 without a BOM is not detected.** Statistical detection of UTF-16 from
byte patterns alone is unreliable for short inputs, so this library refuses to
guess. A UTF-16 file that has had its BOM stripped will be misclassified as
`latin1`, `utf-8`, or `unknown` depending on its byte values. If you need to
handle that case, require a BOM upstream.

A second edge: a file that carries a UTF-8 BOM but has a damaged body is still
reported as `utf-8-bom`. The BOM is treated as the source's declared intent; we
do not silently downgrade it.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

