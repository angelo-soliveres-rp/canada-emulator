import { describe, it, expect } from 'vitest';
import { drainScanBuffer, parseScanToken } from './scanProtocol';

describe('parseScanToken', () => {
  it('parses the default UPC-A template output: A + 11 digits + literal c', () => {
    // omni BarcodeScanner default upcaFormat "\r\nAdddddddddddc\r\n" replaces
    // only the d's, leaving the c placeholder literal on the wire.
    expect(parseScanToken('A04900000044c')).toBe('049000000443');
  });

  it('parses a bare A-prefixed 12-digit UPC-A', () => {
    expect(parseScanToken('A049000000443')).toBe('049000000443');
  });

  it('parses plain digits (loyalty codes pass through unconverted)', () => {
    expect(parseScanToken('8018782603800034999992')).toBe('8018782603800034999992');
  });

  it('parses EAN-13 (F prefix) and short PLU codes', () => {
    expect(parseScanToken('F0049000000443')).toBe('0049000000443');
    expect(parseScanToken('A00123')).toBe('00123');
  });

  it('rejects garbage, empty and non-barcode tokens', () => {
    expect(parseScanToken('')).toBeNull();
    expect(parseScanToken('hello')).toBeNull();
    expect(parseScanToken('EventId=2001,Barcode=1')).toBeNull();
  });
});

describe('drainScanBuffer', () => {
  it('splits CR/LF-framed scans and keeps the trailing partial', () => {
    const { barcodes, rest } = drainScanBuffer('\r\nA04900000044c\r\n\r\nA01200000129');
    expect(barcodes).toEqual(['049000000443']);
    expect(rest).toBe('A01200000129');
  });

  it('drains multiple complete scans', () => {
    const { barcodes, rest } = drainScanBuffer('A049000000443\nA012000001291\n');
    expect(barcodes).toEqual(['049000000443', '012000001291']);
    expect(rest).toBe('');
  });

  it('ignores blank segments between separators', () => {
    const { barcodes } = drainScanBuffer('\r\n\r\nA049000000443\r\n');
    expect(barcodes).toEqual(['049000000443']);
  });
});
