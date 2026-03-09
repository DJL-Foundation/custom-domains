import { CryptoError } from "#defective/crypto";
import { annotateThis } from "#defective/o11y";
import { Crypto } from "#services/crypto";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  default as crypto,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { Cache, Duration, Effect, Layer } from "effect";
import { CloudflareEnv } from "./cloudflare";

const ALGORITHM = "aes-256-gcm";

const _internalHash = Effect.fn("service.crypto.hash")(function* (ip: string) {
  const cloudflare = yield* CloudflareEnv;
  const key = yield* cloudflare.get("ENCRYPTION_KEY");
  const salt = yield* Effect.try({
    try: () => createHash("sha512").update(key).digest("hex"),
    catch: (error) =>
      new CryptoError({
        message: "Failed to create first stage salt",
        reason: "SystemError",
        cause: error,
      }),
  }).pipe(
    Effect.tryMap({
      try: (res) => createHash("sha512").update(res).digest("hex"),
      catch: (error) =>
        new CryptoError({
          message: "Failed to create second stage salt",
          reason: "SystemError",
          cause: error,
        }),
    }),
    Effect.tryMap({
      try: (res) => createHash("md5").update(res).digest("hex"),
      catch: (error) =>
        new CryptoError({
          message: "Failed to create final salt",
          reason: "SystemError",
          cause: error,
        }),
    }),
    annotateThis,
  );
  return yield* Effect.try({
    try: () => scryptSync(ip, salt, 32).toString("hex"), // 32 bytes output
    catch: (error) =>
      new CryptoError({
        message: "Failed to hash IP address",
        reason: "SystemError",
        cause: error,
      }),
  }).pipe(annotateThis);
});

export const CryptoAuthLive = Layer.effect(
  Crypto,
  Effect.gen(function* () {
    const cloudflare = yield* CloudflareEnv;
    const enckey = yield* cloudflare.get("ENCRYPTION_KEY");
    const hash = yield* Cache.make({
      capacity: 1000,
      timeToLive: Duration.infinity,
      lookup: _internalHash,
    });

    const key = yield* hash.get(enckey);

    return {
      randomUUID: Effect.fn("service.crypto.randomUUID")(function* () {
        return yield* Effect.try({
          try: () => crypto.randomUUID(),
          catch: (err) =>
            new CryptoError({
              message: String(err),
              reason: "SystemError",
            }),
        }).pipe(annotateThis);
      }),
      hash: (data: string) => hash.get(data),
      encrypt: Effect.fn("service.crypto.encrypt")(function* (
        plaintext: string,
      ) {
        return yield* Effect.try({
          try: () => {
            const iv = randomBytes(16);

            const cipher = createCipheriv(ALGORITHM, key, iv);

            let encrypted = cipher.update(plaintext, "utf8", "hex");
            encrypted += cipher.final("hex");
            const authTag = cipher.getAuthTag().toString("hex");

            return `${iv.toString("hex")}:${authTag}:${encrypted}`;
          },
          catch: (err) =>
            new CryptoError({
              message: String(err),
              reason: "SystemError",
            }),
        }).pipe(annotateThis);
      }),
      decrypt: Effect.fn("service.crypto.decrypt")(function* (
        ciphertext: string,
      ) {
        return yield* Effect.try({
          try: () => {
            const parts = ciphertext.split(":");
            if (parts.length !== 3) {
              throw new CryptoError({
                message: "Invalid ciphertext format (parts missing)",
                reason: "InvalidFormat",
              });
            }

            const [ivHex, authTagHex, encryptedData] = parts;
            if (!ivHex || !authTagHex || !encryptedData) {
              throw new CryptoError({
                message: "Invalid ciphertext format (empty parts)",
                reason: "InvalidFormat",
              });
            }

            const decipher = createDecipheriv(
              ALGORITHM,
              key,
              Buffer.from(ivHex, "hex"),
            );
            decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

            let decrypted = decipher.update(encryptedData, "hex", "utf8");
            decrypted += decipher.final("utf8");

            return decrypted;
          },
          catch: (err) => {
            if (err instanceof CryptoError) return err;
            const message = String(err);
            const reason = message.includes("authenticate data")
              ? "AuthenticationFailed"
              : "Unknown";

            return new CryptoError({ message, reason });
          },
        }).pipe(annotateThis);
      }),
    };
  }),
);
