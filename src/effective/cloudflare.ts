import { Context, Effect, Layer } from "effect";

export class CloudflareEnv extends Context.Tag("CloudflareEnv")<
  CloudflareEnv,
  {
    readonly bindings: CloudflareBindings;
    readonly get: <K extends keyof CloudflareBindings>(
      key: K,
    ) => Effect.Effect<CloudflareBindings[K]>;
  }
>() {}

export const makeCloudflareEnvLayer = (bindings: CloudflareBindings) =>
  Layer.succeed(
    CloudflareEnv,
    CloudflareEnv.of({
      bindings,
      get: <K extends keyof CloudflareBindings>(key: K) =>
        Effect.succeed(bindings[key]),
    }),
  );
