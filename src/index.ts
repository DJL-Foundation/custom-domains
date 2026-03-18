import { Effect, Option, Schema } from "effect";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { CloudflareEnv, makeCloudflareEnvLayer } from "#effective/cloudflare";
import {
  annotateThis,
  logCurrentSpanAsJson,
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

const ROOT_PROXY_HOSTS = new Set([
  "custom-domains.bildung.workers.dev",
  "proxy.djl.foundation",
]);

const ROOT_PROXY_BRANCH_SUFFIX = "-custom-domains.bildung.workers.dev";

const isRootProxyHost = (host: string): boolean =>
  ROOT_PROXY_HOSTS.has(host) ||
  (host.endsWith(ROOT_PROXY_BRANCH_SUFFIX) &&
    host.length > ROOT_PROXY_BRANCH_SUFFIX.length);

const rootProxyLandingPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>DJL Foundation Proxy</title>
    <style>
      :root {
        color-scheme: light;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        background: radial-gradient(circle at top, #f4f8ff, #e7eef8 40%, #dce7f6);
        color: #16253b;
      }

      main {
        width: min(720px, 92vw);
        padding: 2rem;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid rgba(22, 37, 59, 0.15);
        box-shadow: 0 20px 50px rgba(17, 35, 58, 0.12);
      }

      h1 {
        margin: 0 0 1rem;
        font-size: clamp(1.5rem, 2.2vw, 2rem);
      }

      p {
        margin: 0;
        line-height: 1.55;
        font-size: 1rem;
      }

      .redirect {
        margin-top: 1.2rem;
        font-weight: 600;
      }

      a {
        color: #0e4cb5;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>DJL Foundation SaaS Proxy</h1>
      <p>
        This is the proxy for SaaS apps by the DJL Foundation. To use Custom
        Domains, access your organization's settings in supported apps.
      </p>
      <p class="redirect">
        Redirecting to
        <a href="https://djl.foundation">djl.foundation</a> in
        <span id="countdown">5</span> seconds.
      </p>
    </main>
    <script>
      const countdownEl = document.getElementById("countdown");
      let remaining = 5;

      const tick = () => {
        remaining -= 1;
        if (countdownEl) countdownEl.textContent = String(remaining);
        if (remaining <= 0) {
          window.location.replace("https://djl.foundation");
          return;
        }
        setTimeout(tick, 1000);
      };

      setTimeout(tick, 1000);
    </script>
  </body>
</html>`;

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
  const auth = bearerAuth({ token: c.env.ACCESS_TOKEN ?? "" });
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
    logCurrentSpanAsJson,
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
      logCurrentSpanAsJson,
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
    logCurrentSpanAsJson,
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
      logCurrentSpanAsJson,
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
  yield* Effect.log(
    `Received request for host: ${Option.getOrUndefined(host)}`,
  );

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
  yield* Effect.log(
    `Lookup for host ${host.value} returned: ${Option.getOrUndefined(targetAppUrl)}`,
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
    logCurrentSpanAsJson,
    Effect.match({
      onFailure: () => new Response("Bad Gateway", { status: 502 }),
      onSuccess: (res) => res,
    }),
  );
});

app.all("*", async (c) => {
  const requestHost = c.req.header("Host")?.split(":")[0]?.toLowerCase();
  const requestPathname = new URL(c.req.url).pathname;

  if (
    c.req.method === "GET" &&
    requestHost &&
    requestPathname === "/" &&
    isRootProxyHost(requestHost)
  ) {
    return new Response(rootProxyLandingPage, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const response = await Effect.runPromise(
    proxyRequest(c.req.raw, c.req.url).pipe(
      withServerSpan("proxy-request", c.req.raw.headers, {
        "http.method": c.req.method,
        "http.url": c.req.url,
        "http.host": c.req.header("Host") ?? "unknown",
      }),
      logCurrentSpanAsJson,
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
