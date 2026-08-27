import { encrypt, decrypt } from '../../src/utils/encryption';

describe('encryption (AES-256-GCM)', () => {
  it('round-trips a plaintext string', () => {
    const plaintext = 'AIzaSy-super-secret-gemini-key-1234567890';
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toEqual(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const plaintext = 'same-input-both-times';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toEqual(b);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const encrypted = encrypt('some-secret');
    const [iv, authTag, ciphertext] = encrypted.split(':');
    // Flip a character in the ciphertext portion to corrupt it.
    const tamperedCiphertext =
      ciphertext.slice(0, -1) + (ciphertext.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = `${iv}:${authTag}:${tamperedCiphertext}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects a malformed encrypted string', () => {
    expect(() => decrypt('not-a-valid-format')).toThrow('Invalid encrypted text format');
  });
});
