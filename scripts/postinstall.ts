#!/usr/bin/env bun

import { BunContext, BunRuntime } from "@effect/platform-bun";
// import { runRouteMatcherGeneration } from "./route-matchers";
import { Effect } from "effect";
import { syncVersion } from "./version";

// runRouteMatcherGeneration();
BunRuntime.runMain(
  Effect.all([syncVersion]).pipe(Effect.provide(BunContext.layer)),
);
