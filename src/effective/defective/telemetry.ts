import { Data, Effect } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TelemetryError extends Data.TaggedError("TelemetryError")<{
  readonly message: string;
  readonly code: number;
}> {}

// ---------------------------------------------------------------------------
// W3C Traceparent types
// ---------------------------------------------------------------------------

export interface Traceparent {
  readonly version: string;
  readonly traceId: string;
  readonly parentId: string;
  readonly flags: string;
}

export interface TracingContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly traceparentForOutgoing: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_NAME = "custom-domain-proxy";
const TRACEPARENT_HEADER = "traceparent";
const PARENT_SPAN_ID_HEADER = "x-parent-span-id";
const OTEL_SCOPE_HEADER = "x-otel-service";
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;

export const Headers = {
  TRACEPARENT: TRACEPARENT_HEADER,
  PARENT_SPAN_ID: PARENT_SPAN_ID_HEADER,
  OTEL_SCOPE: OTEL_SCOPE_HEADER,
} as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const randomHex = (bytes: number): Effect.Effect<string> =>
  Effect.sync(() => {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  });

const makeTraceparent = (traceId: string, spanId: string): string =>
  `00-${traceId}-${spanId}-01`;

const parseTraceparent = (
  value: string | null,
): Effect.Effect<Traceparent, TelemetryError> => {
  if (!value) {
    return Effect.fail(
      new TelemetryError({ message: "Missing traceparent header", code: 0 }),
    );
  }

  const match = value
    .trim()
    .match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);

  if (!match) {
    return Effect.fail(
      new TelemetryError({
        message: `Invalid traceparent format: ${value}`,
        code: 1,
      }),
    );
  }

  return Effect.succeed({
    version: match[1].toLowerCase(),
    traceId: match[2].toLowerCase(),
    parentId: match[3].toLowerCase(),
    flags: match[4].toLowerCase(),
  });
};

const isValidSpanId = (value: string | null): value is string =>
  !!value && /^[0-9a-f]{16}$/i.test(value);

// ---------------------------------------------------------------------------
// Context extraction
// ---------------------------------------------------------------------------

/**
 * Extracts or creates a TracingContext from incoming request headers.
 *
 * Three cases:
 * 1. Valid traceparent + valid x-parent-span-id  → continue trace, use supplied span as parent
 * 2. Valid traceparent only                       → continue trace, use traceparent's parentId
 * 3. No valid traceparent                         → new root span
 */
export const extractTracingContext = (
  headers: Headers,
): Effect.Effect<TracingContext> =>
  Effect.gen(function* () {
    const rawTraceparent = headers.get(TRACEPARENT_HEADER);
    const rawParentSpanId = headers.get(PARENT_SPAN_ID_HEADER);

    const parsed = yield* Effect.option(parseTraceparent(rawTraceparent));

    if (parsed._tag === "Some") {
      const inbound = parsed.value;
      const spanId = yield* randomHex(SPAN_ID_BYTES);

      const parentSpanId = isValidSpanId(rawParentSpanId)
        ? rawParentSpanId.toLowerCase()
        : inbound.parentId;

      return {
        traceId: inbound.traceId,
        spanId,
        parentSpanId,
        traceparentForOutgoing: makeTraceparent(inbound.traceId, spanId),
      } satisfies TracingContext;
    }

    // Root span
    const traceId = yield* randomHex(TRACE_ID_BYTES);
    const spanId = yield* randomHex(SPAN_ID_BYTES);

    return {
      traceId,
      spanId,
      parentSpanId: undefined,
      traceparentForOutgoing: makeTraceparent(traceId, spanId),
    } satisfies TracingContext;
  });

// ---------------------------------------------------------------------------
// Outgoing header injection
// ---------------------------------------------------------------------------

/**
 * Mutates a Headers object with tracing propagation headers.
 * Call this on the outgoing proxy request headers.
 */
export const injectTracingHeaders = (
  headers: Headers,
  ctx: TracingContext,
): Effect.Effect<void> =>
  Effect.sync(() => {
    headers.set(TRACEPARENT_HEADER, ctx.traceparentForOutgoing);
    headers.set(PARENT_SPAN_ID_HEADER, ctx.spanId);
    headers.set(OTEL_SCOPE_HEADER, SERVICE_NAME);
  });
