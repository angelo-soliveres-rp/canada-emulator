/**
 * US scanner reverse channel — the player→register barcode inject path.
 *
 * When a cashier accepts an upsell ("completer") on CK Player 2.0 in US mode,
 * the player writes the barcode to the SCANNER socket (`scanner.ioParams=
 * TCP:10000`) via BarcodeScanner.writeToHost, formatted through the scan
 * templates (default UPC-A: `\r\nAdddddddddddc\r\n` — the 11 `d`s are replaced
 * with digits, the `c` check-digit placeholder is left literal on the wire).
 * Loyalty codes pass through unconverted. The register (this emulator) rings
 * the item up and echoes the normal EventId 1011 back on the VJ — which is
 * also what releases the player's Zynstra age-verification scan queue.
 *
 * Pure / browser-safe (no Node or Electron imports).
 */

/**
 * `[ADEF]?` format prefix + digits + optional literal `c` check-digit
 * placeholder. Upper bound 24 covers the longest real codes (22-digit Circle K
 * loyalty numbers) while still rejecting arbitrary digit streams.
 */
const SCAN_TOKEN = /^([ADEF])?(\d{4,24})(c)?$/;

/** UPC-A check digit for an 11-digit code (mirrors omni Upc.java:330 port). */
function upcACheckDigit(upc11: string): number {
  const d = (i: number): number => upc11.charCodeAt(i) - 48;
  let sum = (d(0) + d(2) + d(4) + d(6) + d(8) + d(10)) * 3 + (d(1) + d(3) + d(5) + d(7) + d(9));
  sum = sum % 10;
  return sum > 0 ? 10 - sum : 0;
}

/**
 * Parse one CR/LF-framed scanner token into a barcode, or null if it isn't a
 * scan. A literal trailing `c` after 11 digits is the unfilled check-digit
 * placeholder from the player's UPC-A template — complete it so the barcode
 * matches the 12-digit pricebook form.
 */
export function parseScanToken(token: string): string | null {
  const m = SCAN_TOKEN.exec(token.trim());
  if (!m) return null;
  const digits = m[2];
  if (m[3] === 'c' && digits.length === 11) {
    return digits + upcACheckDigit(digits);
  }
  return digits;
}

export interface ScanDrainResult {
  /** Barcodes decoded from complete (separator-terminated) segments. */
  barcodes: string[];
  /** Trailing partial segment to carry into the next chunk. */
  rest: string;
}

/**
 * Split buffered scanner bytes on CR/LF, decode each complete segment, and
 * return the unterminated tail for re-buffering.
 */
export function drainScanBuffer(buffer: string): ScanDrainResult {
  const segments = buffer.split(/[\r\n]+/);
  const rest = segments.pop() ?? '';
  const barcodes: string[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    const barcode = parseScanToken(segment);
    if (barcode) barcodes.push(barcode);
  }
  return { barcodes, rest };
}
