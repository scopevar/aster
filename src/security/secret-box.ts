import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Seals secrets before persistence. Plaintext stays in the owning process. */
export interface SecretBox {
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

export function aesSecretBox(key: Buffer): SecretBox {
  if (key.byteLength !== 32) throw new Error("登录凭据密钥长度无效。");
  return {
    async seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async open(sealed) {
      const bytes = Buffer.from(sealed);
      if (bytes.byteLength < 28) throw new Error("登录凭据已损坏。");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]);
    },
  };
}
