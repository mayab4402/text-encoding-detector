import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEncoding, isValidUtf8 } from '../src/core.js';

function bytes(arr) {
  return new Uint8Array(arr);
}

// --- Empty input ---

test('empty input is reported as ascii', () => {
  assert.equal(detectEncoding(new Uint8Array(0)), 'ascii');
});

// --- BOM detection ---

test('UTF-8 BOM is detected', () => {
  // BOM + ASCII text.
  assert.equal(detectEncoding(bytes([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'utf-8-bom');
});

test('UTF-8 BOM alone is detected', () => {
  assert.equal(detectEncoding(bytes([0xef, 0xbb, 0xbf])), 'utf-8-bom');
});

test('UTF-16LE BOM is detected', () => {
  assert.equal(detectEncoding(bytes([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])), 'utf-16le-bom');
});

test('UTF-16BE BOM is detected', () => {
  assert.equal(detectEncoding(bytes([0xfe, 0xff, 0x00, 0x41, 0x00, 0x42])), 'utf-16be-bom');
});

test('UTF-8 BOM takes precedence over ASCII-looking body', () => {
  // Body is pure ASCII, but the BOM is the authoritative signal.
  assert.equal(detectEncoding(bytes([0xef, 0xbb, 0xbf, 0x41])), 'utf-8-bom');
});

// --- ASCII ---

test('plain ASCII text is detected', () => {
  assert.equal(detectEncoding(bytes(Array.from('Hello, World!').map(c => c.charCodeAt(0)))), 'ascii');
});

test('ASCII with tab, LF, CR, FF is still ASCII', () => {
  assert.equal(detectEncoding(bytes([0x41, 0x09, 0x0a, 0x0d, 0x0c, 0x42])), 'ascii');
});

test('ASCII with a NUL byte is not ASCII', () => {
  // NUL is technically valid UTF-8 (U+0000). Among otherwise-ASCII bytes the
  // sequence is valid UTF-8, so it is classified as 'utf-8'. This keeps the
  // detector's structural rule intact: a NUL alone does not make input binary.
  assert.equal(detectEncoding(bytes([0x41, 0x00, 0x42])), 'utf-8');
});

test('bytes with high bit set are not ASCII', () => {
  // 0xff is not valid UTF-8 on its own, has no NUL, so this is Latin1.
  assert.equal(detectEncoding(bytes([0x41, 0xff, 0x42])), 'latin1');
});

test('binary control byte below 0x20 forces non-ASCII', () => {
  // 0x01 is not in the allowed-controls set. Combined with a high byte, the
  // input fails UTF-8 validation too, and has no NUL, so it is Latin1.
  assert.equal(detectEncoding(bytes([0x41, 0x01, 0xff, 0x42])), 'latin1');
});

// --- UTF-8 structural validation ---

test('two-byte UTF-8 sequence is valid', () => {
  // U+00e9 (é) = C3 A9
  assert.equal(detectEncoding(bytes([0x63, 0x61, 0x66, 0xc3, 0xa9])), 'utf-8');
});

test('three-byte UTF-8 sequence is valid', () => {
  // U+20ac (€) = E2 82 AC
  assert.equal(detectEncoding(bytes([0xe2, 0x82, 0xac])), 'utf-8');
});

test('four-byte UTF-8 sequence is valid', () => {
  // U+1f600 (😀) = F0 9F 98 80
  assert.equal(detectEncoding(bytes([0xf0, 0x9f, 0x98, 0x80])), 'utf-8');
});

test('overlong two-byte encoding is rejected as not UTF-8', () => {
  // Overlong encoding of U+0041 ('A'): C1 81. Not valid UTF-8. No NUL, so
  // classified as Latin1.
  assert.equal(detectEncoding(bytes([0xc1, 0x81])), 'latin1');
});

test('lone continuation byte is rejected', () => {
  // 0x80 is a continuation byte with no lead. Not valid UTF-8. No NUL, Latin1.
  assert.equal(detectEncoding(bytes([0x80])), 'latin1');
});

test('truncated two-byte sequence is rejected', () => {
  // C3 with no continuation. Not valid UTF-8. No NUL, Latin1.
  assert.equal(detectEncoding(bytes([0x63, 0xc3])), 'latin1');
});

test('UTF-16 surrogate code point is rejected as UTF-8', () => {
  // U+D800 encoded as UTF-8: ED A0 80. Must be rejected. No NUL, Latin1.
  assert.equal(detectEncoding(bytes([0xed, 0xa0, 0x80])), 'latin1');
});

test('code point above U+10FFFF is rejected', () => {
  // U+110000 encoded: F4 90 80 80. Must be rejected. No NUL, Latin1.
  assert.equal(detectEncoding(bytes([0xf4, 0x90, 0x80, 0x80])), 'latin1');
});

// --- isValidUtf8 direct tests ---

test('isValidUtf8 returns true for valid ASCII', () => {
  assert.equal(isValidUtf8(bytes([0x41, 0x42, 0x43]), 0, 3), true);
});

test('isValidUtf8 returns false for lone 0xFF', () => {
  assert.equal(isValidUtf8(bytes([0xff]), 0, 1), false);
});

test('isValidUtf8 respects start and end bounds', () => {
  // The first byte 0xff is outside the examined range, so the slice is valid.
  assert.equal(isValidUtf8(bytes([0xff, 0x41, 0x42]), 1, 3), true);
});

// --- Latin1 fallback and the NUL gate ---

test('Latin1 text with high bytes but no NUL is latin1', () => {
  // 0xe9 is é in Latin1. In UTF-8 it would need a lead byte, so this is not
  // valid UTF-8. It has no NUL. -> Latin1.
  assert.equal(detectEncoding(bytes([0xe9, 0xe0, 0x41])), 'latin1');
});

test('input with NUL after a high byte is unknown', () => {
  // The NUL triggers the "looks like UTF-16 or binary" gate.
  assert.equal(detectEncoding(bytes([0xff, 0x00, 0x41])), 'unknown');
});

// --- Type guard ---

test('detectEncoding rejects non-Uint8Array input', () => {
  assert.throws(() => detectEncoding('hello'), TypeError);
  assert.throws(() => detectEncoding([1, 2, 3]), TypeError);
  assert.throws(() => detectEncoding(null), TypeError);
});
