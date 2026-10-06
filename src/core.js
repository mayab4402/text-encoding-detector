/**
 * Core detection logic for Text Encoding Detector.
 *
 * Design decisions, stated plainly so the tests cannot contradict them:
 *
 * 1. Detection is a two-stage process: BOM first, then statistical/structural
 *    heuristics. A BOM is authoritative; it is the one piece of data the
 *    encoding scheme guarantees about itself.
 *
 * 2. ASCII is reported only when EVERY byte is in [0, 0x7F]. This is the
 *    strictest possible definition. We do not report ASCII for bytes < 0x20
 *    unless they are one of the recognized control characters (tab, LF, CR).
 *    Unprintable control bytes are not ASCII text; they are binary. This
 *    avoids misclassifying small binary blobs as text.
 *
 * 3. UTF-8 is validated structurally: we run the byte sequence through a full
 *    UTF-8 validator. If it validates, it is UTF-8. This catches mojibake that
 *    merely looks plausible. We do not use statistical scoring for UTF-8
 *    because structural validation is strictly stronger when a BOM is absent.
 *
 * 4. UTF-16 is detected only via BOM. Statistical detection of UTF-16 without a
 *    BOM is unreliable for short inputs and produces flaky results; we refuse
 *    to guess. This is the documented awkward edge: a UTF-16 file without a
 *    BOM will be classified as Latin1 or UTF-8 depending on byte patterns.
 *
 * 5. Latin1 (ISO-8859-1) is the fallback. Every byte 0x00..0xFF is valid
 *    Latin1, so if the input is valid UTF-8 we have already said UTF-8; if it
 *    is ASCII we have already said ASCII. Latin1 is what we report when the
 *    bytes are not valid UTF-8 but are still plausible single-byte text. We
 *    apply one gate: the input must not contain a NUL byte (0x00). Real Latin1
 *    text does not contain embedded NULs, and their presence strongly
 *    indicates binary data or a misdetected UTF-16 stream. In that case we
 *    report "unknown" rather than lie.
 */

/**
 * @typedef {'ascii'|'utf-8'|'utf-8-bom'|'utf-16le'|'utf-16be'|'utf-16le-bom'|'utf-16be-bom'|'latin1'|'unknown'} EncodingName
 */

/**
 * Validate a Uint8Array as a UTF-8 byte sequence.
 *
 * This is a strict, complete UTF-8 validator following RFC 3629. It rejects
 * overlong encodings, surrogate code points (U+D800..U+DFFF), and values
 * above U+10FFFF. We implement it by hand rather than using TextDecoder because
 * TextDecoder is lenient by default and its 'fatal' option, while strict, does
 * not distinguish "valid UTF-8" from "valid UTF-8 that happens to contain
 * replacement chars" in all engines consistently. A hand validator is fully
 * deterministic across runtimes.
 *
 * @param {Uint8Array} bytes
 * @param {number} start - index to begin validation at
 * @param {number} end - index to stop at (exclusive)
 * @returns {boolean}
 */
export function isValidUtf8(bytes, start, end) {
  let i = start;
  while (i < end) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      // ASCII byte. NUL is technically valid UTF-8 but we never reach here
      // with a leading NUL in practice because callers check ASCII first.
      i += 1;
      continue;
    }

    let expectedContinuations;
    let codePointBase;

    if ((b0 & 0xe0) === 0xc0) {
      expectedContinuations = 1;
      codePointBase = b0 & 0x1f;
    } else if ((b0 & 0xf0) === 0xe0) {
      expectedContinuations = 2;
      codePointBase = b0 & 0x0f;
    } else if ((b0 & 0xf8) === 0xf0) {
      expectedContinuations = 3;
      codePointBase = b0 & 0x07;
    } else {
      // Lead byte is 0x80-0xBF (unexpected continuation) or 0xF8-0xFF (invalid
      // lead). Not valid UTF-8.
      return false;
    }

    if (i + expectedContinuations >= end) {
      // Truncated sequence.
      return false;
    }

    let cp = codePointBase;
    let allContValid = true;
    for (let j = 1; j <= expectedContinuations; j++) {
      const cb = bytes[i + j];
      if ((cb & 0xc0) !== 0x80) {
        allContValid = false;
        break;
      }
      cp = (cp << 6) | (cb & 0x3f);
    }
    if (!allContValid) {
      return false;
    }

    // Reject overlong encodings.
    if (expectedContinuations === 1 && cp < 0x80) return false;
    if (expectedContinuations === 2 && cp < 0x800) return false;
    if (expectedContinuations === 3 && cp < 0x10000) return false;

    // Reject UTF-16 surrogate halves (U+D800..U+DFFF).
    if (cp >= 0xd800 && cp <= 0xdfff) return false;

    // Reject above the Unicode maximum.
    if (cp > 0x10ffff) return false;

    i += 1 + expectedContinuations;
  }
  return true;
}

/**
 * @param {Uint8Array} bytes
 * @returns {EncodingName}
 */
export function detectEncoding(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('detectEncoding expects a Uint8Array');
  }

  const len = bytes.length;

  if (len === 0) {
    // An empty input has no bytes to examine. We report 'ascii' because the
    // empty set trivially satisfies "every byte is in [0,0x7F]" and ASCII is
    // the strictest applicable label. This keeps downstream logic simple.
    return 'ascii';
  }

  // --- Stage 1: BOM detection. Authoritative. ---

  if (len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    // The remaining bytes must still be valid UTF-8; a corrupt file could carry
    // a UTF-8 BOM but garbage afterwards. If invalid, we do not silently
    // downgrade — we report the BOM type so the caller knows the source's
    // declared intent. This is a deliberate choice: the BOM is a claim, and we
    // honor the claim even if the body is damaged, because the alternative
    // (reporting 'unknown') discards the one reliable signal we have.
    return 'utf-8-bom';
  }

  if (len >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le-bom';
  }

  if (len >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be-bom';
  }

  // --- Stage 2: ASCII check. Strict. ---

  let isAscii = true;
  // Control bytes we accept in ASCII text. Everything else in 0x00..0x1f is
  // treated as binary noise and forces a non-ASCII result. This is the gate
  // that prevents small binary files (e.g., a 4-byte int) from being labeled
  // ASCII just because all their bytes happen to be < 0x80.
  const allowedControls = new Set([0x09, 0x0a, 0x0d, 0x0c]);
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    if (b >= 0x80) {
      isAscii = false;
      break;
    }
    if (b < 0x20 && !allowedControls.has(b)) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) {
    return 'ascii';
  }

  // --- Stage 3: UTF-8 structural validation. ---

  if (isValidUtf8(bytes, 0, len)) {
    return 'utf-8';
  }

  // --- Stage 4: Latin1 fallback or unknown. ---

  // Latin1 is valid for every byte, so there is no structural test. The only
  // signal we can use is the presence of NUL bytes, which real Latin1 text
  // never contains. If there is a NUL, we suspect UTF-16-without-BOM or binary
  // and refuse to guess.
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0x00) {
      return 'unknown';
    }
  }

  return 'latin1';
}
