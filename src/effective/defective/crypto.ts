import { Data } from "effect";

export type CryptoErrorReason =
  | "SystemError"
  | "InvalidFormat"
  | "AuthenticationFailed"
  | "Unknown";

export class CryptoError extends Data.TaggedError("CryptoError")<{
  readonly message: string;
  readonly reason: CryptoErrorReason;
  readonly cause?: unknown;
}> {}
