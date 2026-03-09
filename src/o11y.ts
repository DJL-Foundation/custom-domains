import { Tracer } from "@effect/opentelemetry";
import {
  context,
  propagation,
  trace,
  type SpanContext,
} from "@opentelemetry/api";
import { Effect, Option } from "effect";

// ---------------------------------------------------------------------------
// W3C context extraction
// ---------------------------------------------------------------------------

const extractSpanContext = (headers: Headers) => {
  const carrier: Record<string, string> = {};
  headers.forEach((value, key) => {
    carrier[key] = value;
  });

  const otelContext = propagation.extract(context.active(), carrier, {
    get: (c, key) => c[key],
    keys: (c) => Object.keys(c),
  });

  const spanContext = trace.getSpanContext(otelContext);

  if (!spanContext?.traceId || !spanContext?.spanId) {
    return Option.none<SpanContext>();
  }

  return Option.some(spanContext as SpanContext);
};

// ---------------------------------------------------------------------------
// withServerSpan
// ---------------------------------------------------------------------------

/**
 * Wraps an Effect in a named server span.
 *
 * - If the incoming request headers carry a valid W3C traceparent, the span
 *   is attached to that trace as a child via Tracer.withSpanContext.
 * - If no parent context is present, a new root span is created.
 *
 * Replaces the old useServerTrace() / startTrace() / Tracer.withSpanContext()
 * pattern. Use this at the Hono handler boundary before Effect.runPromise.
 *
 * @example
 * ```ts
 * app.post("/api/domains", async (c) => {
 *   const body = await c.req.json()
 *   const response = await Effect.runPromise(
 *     postDomain(body).pipe(
 *       withServerSpan("post-domain", c.req.raw.headers, {
 *         "http.method": c.req.method,
 *         "http.url": c.req.url,
 *       }),
 *       Effect.provide(otelLive),
 *       Effect.provide(OTelConfigLive),
 *       Effect.provide(makeCloudflareEnvLayer(c.env)),
 *     ),
 *   )
 *   return c.json(response)
 * })
 * ```
 */
export const withServerSpan =
  (name: string, headers: Headers, attributes?: Record<string, string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const parent = extractSpanContext(headers);

    const spanned = effect.pipe(
      Effect.withSpan(name, {
        attributes: {
          "span.kind": "server",
          ...attributes,
        },
      }),
    );

    if (Option.isNone(parent)) {
      return spanned;
    }

    return spanned.pipe(Tracer.withSpanContext(parent.value));
  };
