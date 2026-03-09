import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";

import { Effect, Option, Schema } from "effect";
import { CloudflareEnv, makeCloudflareEnvLayer } from "#effective/cloudflare";
import {
  annotateThis,
  OTelConfigLive,
  otelLive,
} from "#effective/defective/o11y";
import {
  extractTracingContext,
  injectTracingHeaders,
} from "#effective/defective/telemetry";
import { withServerSpan } from "./o11y";

// ---------------------------------------------------------------------------
// Hono app type
// ---------------------------------------------------------------------------

type Env = {
  Bindings: CloudflareBindings;
};

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Per-request layer factory
// ---------------------------------------------------------------------------

/**
 * Builds a per-request Effect Layer stack:
 *   CloudflareEnvLive → OTelConfigLive → otelLive
 *
 * OTLP credentials are read from Cloudflare Bindings at runtime,
 * not at module load time.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PostDomainsBody = Schema.Struct({
  customDomain: Schema.NonEmptyString.pipe(
    Schema.filter((s) => s.includes(".")),
  ),
  targetAppUrl: Schema.String.pipe(
    Schema.filter((s) => {
      try {
        new URL(s);
        return true;
      } catch {
        return false;
      }
    }),
  ),
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

app.use("/api/*", async (c, next) => {
  const auth = bearerAuth({ token: c.env.ACCESS_TOKEN });
  return auth(c, next);
});

// ---------------------------------------------------------------------------
// POST /api/domains
// ---------------------------------------------------------------------------

const postDomain = Effect.fn("post-domain")(function* (json: unknown) {
  const parsed = yield* Schema.decodeUnknown(PostDomainsBody)(json);
  const cloudflare = yield* CloudflareEnv;
  const kv = yield* cloudflare.get("hostnames-kv");
  return yield* Effect.tryPromise(() =>
    kv.put(parsed.customDomain, parsed.targetAppUrl),
  ).pipe(
    Effect.withSpan("kv.put", {
      attributes: { "kv.key": parsed.customDomain },
    }),
    annotateThis,
    Effect.match({
      onFailure: () => ({
        code: 500,
        tag: "KVPUTEXCEPTION",
        message: "Unknown exception occurred while adding the domain",
      }),
      onSuccess: () => ({
        code: 200,
        tag: "OK",
        message: "Domain added successfully",
      }),
    }),
  );
});

app.post("/api/domains", async (c) => {
  const body = await c.req.json();

  const response = await Effect.runPromise(
    postDomain(body).pipe(
      withServerSpan("post-domain", c.req.raw.headers, {
        "http.method": c.req.method,
        "http.url": c.req.url,
      }),
      Effect.provide(otelLive),
      Effect.provide(OTelConfigLive),
      Effect.provide(makeCloudflareEnvLayer(c.env)),
    ),
  );

  return c.json(response);
});

// ---------------------------------------------------------------------------
// DELETE /api/domains
// ---------------------------------------------------------------------------

const DeleteDomainBody = Schema.Struct({
  customDomain: Schema.NonEmptyString.pipe(
    Schema.filter((s) => s.includes(".")),
  ),
});

const deleteDomain = Effect.fn("delete-domain")(function* (json: unknown) {
  const parsed = yield* Schema.decodeUnknown(DeleteDomainBody)(json);
  const cloudflare = yield* CloudflareEnv;
  const kv = yield* cloudflare.get("hostnames-kv");
  return yield* Effect.tryPromise(() => kv.delete(parsed.customDomain)).pipe(
    Effect.withSpan("kv.delete", {
      attributes: { "kv.key": parsed.customDomain },
    }),
    annotateThis,
    Effect.match({
      onFailure: () => ({
        code: 500,
        tag: "KVDELETEEXCEPTION",
        message: "Unknown exception occurred while deleting the domain",
      }),
      onSuccess: () => ({
        code: 200,
        tag: "OK",
        message: "Domain deleted successfully",
      }),
    }),
  );
});

app.delete("/api/domains", async (c) => {
  const body = await c.req.json();

  const response = await Effect.runPromise(
    deleteDomain(body).pipe(
      withServerSpan("delete-domain", c.req.raw.headers, {
        "http.method": c.req.method,
        "http.url": c.req.url,
      }),
      Effect.provide(otelLive),
      Effect.provide(OTelConfigLive),
      Effect.provide(makeCloudflareEnvLayer(c.env)),
    ),
  );

  return c.json(response);
});

// ---------------------------------------------------------------------------
// Proxy — all other routes
// ---------------------------------------------------------------------------

const proxyRequest = Effect.fn("proxy-request")(function* (
  req: Request,
  requestUrl: string,
) {
  const tracing = yield* extractTracingContext(req.headers);
  const cloudflare = yield* CloudflareEnv;
  const kv = yield* cloudflare.get("hostnames-kv");

  const host = Option.fromNullable(req.headers.get("Host"));

  if (Option.isNone(host)) {
    return {
      code: 400 as const,
      tag: "MISSINGHOST",
      message: "Host header is required",
    };
  }

  const targetAppUrl = yield* Effect.tryPromise(() => kv.get(host.value)).pipe(
    Effect.map(Option.fromNullable),
  );

  if (Option.isNone(targetAppUrl)) {
    return {
      code: 404 as const,
      tag: "DOMAINNOTFOUND",
      message: "Domain not configured correctly or not found",
    };
  }

  const url = new URL(requestUrl);
  const proxyUrl = new URL(url.pathname + url.search, targetAppUrl.value);

  const proxyReq = new Request(proxyUrl.toString(), req);
  proxyReq.headers.set("x-forwarded-host", host.value);
  yield* injectTracingHeaders(proxyReq.headers, tracing);

  return yield* Effect.tryPromise(() => fetch(proxyReq)).pipe(
    Effect.withSpan("fetch.upstream", {
      attributes: {
        "http.url": proxyUrl.toString(),
        "http.host": host.value,
      },
    }),
    annotateThis,
    Effect.match({
      onFailure: () => new Response("Bad Gateway", { status: 502 }),
      onSuccess: (res) => res,
    }),
  );
});

app.all("*", async (c) => {
  const response = await Effect.runPromise(
    proxyRequest(c.req.raw, c.req.url).pipe(
      withServerSpan("proxy-request", c.req.raw.headers, {
        "http.method": c.req.method,
        "http.url": c.req.url,
        "http.host": c.req.header("Host") ?? "unknown",
      }),
      Effect.provide(otelLive),
      Effect.provide(OTelConfigLive),
      Effect.provide(makeCloudflareEnvLayer(c.env)),
    ),
  );

  if (response instanceof Response) {
    return response;
  }

  return c.json({ error: response.message }, response.code);
});

export default app;
