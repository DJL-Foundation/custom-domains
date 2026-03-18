import { Resource, Tracer } from "@effect/opentelemetry";
import {
  type Attributes,
  type Context as OtelContext,
  type SpanKind,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { Context, Effect, Layer } from "effect";
import { CloudflareEnv } from "#effective/cloudflare";
// Note: OtelContext = @opentelemetry/api Context, Context = effect Context
import { APP_VERSION, CURRENT_BRANCH, LATEST_COMMIT_HASH } from "#version";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OTelConfig {
  readonly axiomOtlpUrl: string;
  readonly axiomApiToken: string;
  readonly axiomDataset: string;
}

// ---------------------------------------------------------------------------
// OTelConfig Service — resolved at runtime from CloudflareEnv bindings
// ---------------------------------------------------------------------------

export class OTelConfigService extends Context.Tag("OTelConfigService")<
  OTelConfigService,
  OTelConfig
>() {}

export const OTelConfigLive = Layer.effect(
  OTelConfigService,
  Effect.gen(function* () {
    const cf = yield* CloudflareEnv;
    const axiomOtlpUrl = yield* cf.get("AXIOM_API_URL");
    const axiomApiToken = yield* cf.get("AXIOM_TOKEN");
    const axiomDataset = yield* cf.get("AXIOM_DATASET");

    return OTelConfigService.of({
      axiomOtlpUrl: axiomOtlpUrl ?? "",
      axiomApiToken: axiomApiToken,
      axiomDataset: axiomDataset ?? "",
    });
  }),
);

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

class SmartHybridSampler implements Sampler {
  private ratioSampler: Sampler;

  constructor(private readonly successRatio: number = 1.0) {
    this.ratioSampler = new TraceIdRatioBasedSampler(successRatio);
  }

  shouldSample(
    context: OtelContext,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
  ): SamplingResult {
    // Explicit drop via attribute set at span start
    if (
      attributes["_internal.dropSpan"] === true ||
      attributes["_internal.dropSpan"] === "true"
    ) {
      return { decision: SamplingDecision.NOT_RECORD };
    }

    // Propagate parent sampling decision to keep traces coherent
    const parentSpanContext = trace.getSpanContext(context);
    if (parentSpanContext?.traceId) {
      const isSampled = !!(parentSpanContext.traceFlags & 1);
      return {
        decision: isSampled
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD,
      };
    }

    // Root span: apply ratio
    return this.ratioSampler.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      [],
    );
  }

  toString(): string {
    return `SmartHybridSampler(ratio=${this.successRatio})`;
  }
}

export const customSampler = new SmartHybridSampler(1.0);

// ---------------------------------------------------------------------------
// OTEL Layer — built at runtime from OTelConfigService
// ---------------------------------------------------------------------------

/**
 * Builds a live OTEL tracer layer.
 * Must be provided with OTelConfigLive (which needs CloudflareEnvLive).
 *
 * Usage:
 *   const AppLayer = otelLive.pipe(
 *     Layer.provide(OTelConfigLive),
 *     Layer.provide(makeCloudflareEnvLayer(bindings)),
 *   )
 */
export const otelLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const config = yield* OTelConfigService;

    const exporter = new OTLPTraceExporter({
      url: config.axiomOtlpUrl,
      headers: {
        Authorization: `Bearer ${config.axiomApiToken}`,
        "X-Axiom-Dataset": config.axiomDataset,
      },
    });

    const processor = new SimpleSpanProcessor(exporter);

    const resource = Resource.layer({
      serviceName: "custom-domain-proxy",
      serviceVersion: APP_VERSION,
      attributes: {
        "git.commit": LATEST_COMMIT_HASH,
        "git.branch": CURRENT_BRANCH,
      },
    });

    return Tracer.layerGlobal.pipe(
      Layer.provide(resource),
      // Attach the processor to the provider via a scoped effect so it flushes
      // on scope close (end of request)
      Layer.provideMerge(
        Layer.scopedDiscard(
          Effect.acquireRelease(
            Effect.sync(() => processor),
            (p) => Effect.promise(() => p.shutdown()),
          ),
        ),
      ),
    );
  }),
);

/**
 * A no-op tracer layer that drops all spans via the sampler attribute.
 * Useful for routes or tests where you want tracing silenced.
 */
export const otelNOT = Tracer.layerGlobal.pipe(
  Layer.provide(
    Resource.layer({
      serviceName: "custom-domain-proxy",
      serviceVersion: APP_VERSION,
      attributes: {
        "git.commit": LATEST_COMMIT_HASH,
        "git.branch": CURRENT_BRANCH,
        "_internal.dropSpan": "true",
      },
    }),
  ),
);

// ---------------------------------------------------------------------------
// Span annotation helpers
// ---------------------------------------------------------------------------

/**
 * Annotates the current span with all enumerable properties of the error.
 * Prefixes each key with "error.".
 *
 * Usage:
 *   myEffect.pipe(annotateThis)
 */
export const annotateThis = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.tapError(effect, (error) => {
    if (typeof error === "object" && error !== null) {
      const attributes: Record<string, string | number | boolean> = {};

      for (const [key, value] of Object.entries(error)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          attributes[`error.${key}`] = value;
        } else if (value === null) {
          attributes[`error.${key}`] = "null";
        } else {
          try {
            attributes[`error.${key}`] = JSON.stringify(value);
          } catch {
            attributes[`error.${key}`] = String(value);
          }
        }
      }

      return Effect.annotateCurrentSpan(attributes);
    }

    return Effect.annotateCurrentSpan("error.message", String(error));
  });

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const toJsonValue = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, seen));
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);

    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = toJsonValue(item, seen);
    }
    return output;
  }

  if (typeof value === "undefined") {
    return "[undefined]";
  }

  return String(value);
};

const serializeCurrentSpan = Effect.map(Effect.currentSpan, (span) => ({
  name: span.name,
  traceId: span.traceId,
  spanId: span.spanId,
  sampled: span.sampled,
  kind: span.kind,
  status: span.status,
  parent:
    span.parent._tag === "Some"
      ? {
          _tag: span.parent.value._tag,
          traceId: span.parent.value.traceId,
          spanId: span.parent.value.spanId,
          sampled: span.parent.value.sampled,
        }
      : null,
  attributes: Object.fromEntries(
    Array.from(span.attributes.entries(), ([key, value]) => [
      key,
      toJsonValue(value),
    ]),
  ),
  links: span.links.map((link) => ({
    span: {
      _tag: link.span._tag,
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      sampled: link.span.sampled,
    },
    attributes: Object.fromEntries(
      Object.entries(link.attributes).map(([key, value]) => [
        key,
        toJsonValue(value),
      ]),
    ),
  })),
}));

const logSpanSnapshot = (state: "success" | "failure") =>
  Effect.matchEffect(serializeCurrentSpan, {
    onFailure: () =>
      Effect.sync(() => {
        console.log(
          JSON.stringify({
            type: "effect.span.snapshot",
            state,
            hasSpan: false,
            timestamp: new Date().toISOString(),
          }),
        );
      }),
    onSuccess: (span) =>
      Effect.sync(() => {
        console.log(
          JSON.stringify({
            type: "effect.span.snapshot",
            state,
            hasSpan: true,
            timestamp: new Date().toISOString(),
            span: toJsonValue(span),
          }),
        );
      }),
  });

/**
 * Logs the current Effect span as JSON with console.log.
 *
 * Usage:
 *   myEffect.pipe(logCurrentSpanAsJson)
 */
export const logCurrentSpanAsJson = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.tapBoth(effect, {
    onFailure: () => logSpanSnapshot("failure"),
    onSuccess: () => logSpanSnapshot("success"),
  });
