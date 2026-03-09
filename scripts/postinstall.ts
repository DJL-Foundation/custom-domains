#!/usr/bin/env bun

// import { runRouteMatcherGeneration } from "./route-matchers";
import { Effect } from "effect";
import { BunRuntime, BunContext } from "@effect/platform-bun";
import { syncVersion } from "./version";

// runRouteMatcherGeneration();
BunRuntime.runMain(
  Effect.all([syncVersion]).pipe(Effect.provide(BunContext.layer)),
);
