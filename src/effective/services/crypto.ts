import type crypto from "node:crypto";
import { Context, type Effect } from "effect";
import type { CryptoError } from "#defective/crypto";

class Crypto extends Context.Tag("Crypto Service")<
  Crypto,
  {
    encrypt: (plaintext: string) => Effect.Effect<string, CryptoError, never>;
    decrypt: (ciphertext: string) => Effect.Effect<string, CryptoError, never>;
    hash: (data: string) => Effect.Effect<string, CryptoError, never>;
    randomUUID: () => Effect.Effect<crypto.UUID, CryptoError, never>;
  }
>() {}

export { Crypto };
