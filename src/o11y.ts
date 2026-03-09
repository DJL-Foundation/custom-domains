import { Tracer } from "@effect/opentelemetry";
import { type SpanContext, TraceFlags } from "@opentelemetry/api";
import { Effect, Option } from "effect";

// ---------------------------------------------------------------------------
// W3C traceparent parsing — fully stateless, no async_hooks / context manager
// ---------------------------------------------------------------------------

const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";

// Matches: 00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>
const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

const extractSpanContext = (headers: Headers): Option.Option<SpanContext> => {
  const raw = headers.get(TRACEPARENT_HEADER);
  if (!raw) return Option.none();

  const match = raw.trim().match(TRACEPARENT_RE);
  if (!match) return Option.none();

  const [, , traceId, spanId, flagsHex] = match;
  const traceFlags = parseInt(flagsHex, 16) as TraceFlags;

  // version ff is invalid per W3C spec
  if (match[1] === "ff") return Option.none();
  // all-zero traceId or spanId are invalid
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return Option.none();

  const traceStateRaw = headers.get(TRACESTATE_HEADER);

  return Option.some({
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags,
    isRemote: true,
    ...(traceStateRaw
      ? {
          traceState: {
            serialize: () => traceStateRaw,
          } as SpanContext["traceState"],
        }
      : {}),
  });
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
