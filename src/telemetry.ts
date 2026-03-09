/**
 * Telemetry Proxy API Route
 *
 * Proxies frontend telemetry data to Axiom while:
 * - Protecting the backend API token
 * - Adding server-side validation
 * - Implementing rate limiting
 * - Enriching with server context
 *
 * POST /api/telemetry - Accept OTLP trace data from frontend
 */

import { CryptoAuthLive } from "'/betterauth.ts";
import { annotateThis, otelNOT } from "'defective/o11y.ts";
import { TelemetryError, TelemetryPayload } from "'defective/telemetry.ts";
import { Crypto } from "'services/betterauth.ts";
import process from "node:process";
import { Tracer } from "@effect/opentelemetry";
import { createFileRoute } from "@tanstack/react-router";
import type { UserWithRole } from "better-auth/plugins";
import { Effect, Logger, LogLevel, Schedule } from "effect";
import env from "#env";
import { authenticateRequest, UserLive } from "~/lib/api-auth.ts";
import { useServerTrace } from "~/lib/telemery/defective.ts";
import {
  APP_VERSION,
  CURRENT_BRANCH,
  LATEST_COMMIT_HASH,
} from "~/lib/version.ts";
import { posthog } from "~/server";

/*
# Test curl
curl -X POST 'http://localhost:3000/api/telemetry' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: telemetry-test/1.0' \
  -H 'X-Forwarded-For: 203.0.113.5' \
  -d '{
    "resourceSpans":[
      {
        "resource": {"attributes": []},
        "scopeSpans":[
          {
            "spans":[
              {
                "traceId":"0123456789abcdef0123456789abcdef",
                "spanId":"0123456789abcdef",
                "name":"test-span",
                "startTimeUnixNano":"1672531200000000000",
                "endTimeUnixNano":"1672531201000000000",
                "attributes":[{"key":"test.key","value":{"stringValue":"test-value"}}]
              }
            ]
          }
        ]
      }
    ]
  }'
*/

const getSafeIp = Effect.fn("api.telemery.getSafeIp")(function* (
  request: Request,
) {
  const crypto = yield* Crypto;
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return yield* crypto
      .hash(forwardedFor.split(",")[0].trim())
      .pipe(annotateThis);
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return yield* crypto.hash(realIp).pipe(annotateThis);
  }

  // Fallback (Vercel/Netlify)
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp) {
    return yield* crypto.hash(cfConnectingIp).pipe(annotateThis);
  }

  return "unknown";
});

const isValidTelemetryPayload = (payload: unknown) =>
  Effect.gen(function* () {
    // 1. Erstmal sicherstellen, dass es ein Record/Objekt ist
    if (typeof payload !== "object" || payload === null) {
      return yield* Effect.fail(
        new TelemetryError({ message: "Payload is not an object", code: 400 }),
      );
    }

    // 2. Type-Cast auf Record<string, unknown>
    const raw = payload as Record<string, unknown>;

    if (!Array.isArray(raw.resourceSpans)) {
      return yield* Effect.fail(
        new TelemetryError({
          message: "Payload missing resourceSpans array",
          code: 400,
        }),
      );
    }

    // 3. Validierung durch explizite Typ-Prüfung in der Schleife
    const hasSpans = raw.resourceSpans.some((rs) => {
      if (typeof rs === "object" && rs !== null && "scopeSpans" in rs) {
        const scopeSpans = (rs as Record<string, unknown>).scopeSpans;
        return (
          Array.isArray(scopeSpans) &&
          scopeSpans.some((ss) => {
            if (typeof ss === "object" && ss !== null && "spans" in ss) {
              const spans = (ss as Record<string, unknown>).spans;
              return Array.isArray(spans) && spans.length > 0;
            }
            return false;
          })
        );
      }
      return false;
    });

    if (!hasSpans) {
      return yield* Effect.fail(
        new TelemetryError({ message: "Payload contains no spans", code: 400 }),
      );
    }

    return new TelemetryPayload(
      raw as unknown as ConstructorParameters<typeof TelemetryPayload>[0],
    );
  }).pipe(annotateThis, Effect.withSpan("api.telemetry.validatePayload"));

/**
 * Reichert das Telemetry-Payload mit Server-Kontext an.
 * Nutzt Effect, da für das Hashing der User-ID der Crypto-Service benötigt wird.
 */
export const enrichPayloadWithServerContext = (
  payload: TelemetryPayload,
  clientIpHash: string,
  userAgent: string | null,
  user: UserWithRole | null,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto;

    // 1. User ID anonymisieren (Hashing), falls vorhanden
    const userIdHash = user ? yield* crypto.hash(user.id) : null;

    // 2. Runtime Umgebung bestimmen
    const runtime = process.env.VERCEL
      ? "vercel"
      : process.env.RAILWAY_ENVIRONMENT
        ? "railway"
        : "bun";

    // 3. Basis-Attribute definieren (Wide Events Philosophie)
    const serverAttributes = [
      {
        key: "server.received_at",
        value: { stringValue: new Date().toISOString() },
      },
      {
        key: "server.client_ip_hash",
        value: { stringValue: clientIpHash },
      },
      {
        key: "server.runtime",
        value: { stringValue: runtime },
      },
      {
        key: "app.environment",
        value: { stringValue: env.NODE_ENV },
      },
      {
        key: "app.version",
        value: { stringValue: APP_VERSION },
      },
      {
        key: "app.commit_hash",
        value: { stringValue: LATEST_COMMIT_HASH },
      },
      {
        key: "app.branch",
        value: { stringValue: CURRENT_BRANCH },
      },
      {
        key: "telemetry.sdk.name",
        value: { stringValue: "ewf-id-proxy" },
      },
    ];

    // 4. Optionale Attribute hinzufügen
    if (userAgent) {
      serverAttributes.push({
        key: "http.user_agent",
        value: { stringValue: userAgent },
      });
    }

    if (userIdHash) {
      serverAttributes.push(
        {
          key: "user.id_hash",
          value: { stringValue: userIdHash },
        },
        {
          key: "user.role",
          value: { stringValue: user?.role ?? "user" },
        },
      );
    }

    // 5. Payload mutieren (Alle ResourceSpans anreichern)
    for (const resourceSpan of payload.resourceSpans) {
      resourceSpan.resource ??= { attributes: [] };
      resourceSpan.resource.attributes ??= [];

      // Wir pushen die Server-Attribute in die Resource-Attributes
      resourceSpan.resource.attributes.push(...serverAttributes);
    }

    return payload;
  }).pipe(Effect.withSpan("api.telemetry.enrichPayload"));

export const Route = createFileRoute("/api/telemetry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { startTrace } = useServerTrace();

        const program = Effect.gen(function* () {
          if (!env.AXIOM_TOKEN) {
            return yield* Effect.fail(
              new TelemetryError({
                message: "Axiom not configured",
                code: 501,
              }),
            );
          }

          const userAgent = request.headers.get("user-agent");

          const getUserEffect = authenticateRequest(request).pipe(
            Effect.map((payload) => {
              return payload.user ?? null;
            }),
            Effect.catchTag("AuthenticationError", (error) => {
              if (error.reason === "InvalidCredentials") {
                return Effect.succeed(null);
              }
              return Effect.fail(
                new TelemetryError({
                  message: error.message,
                  code: error.code,
                }),
              );
            }),
            Effect.withSpan("getUser"),
          );

          const clientIpHashEffect = getSafeIp(request).pipe(
            annotateThis,
            Effect.mapError((_err) => {
              return new TelemetryError({
                message: "Failed to get client IP",
                code: 500,
              });
            }),
            Effect.withSpan("getSafeIp"),
          );

          // 3. Payload parsen
          const jsonEffect = Effect.tryPromise({
            try: () => request.json(),
            catch: () =>
              new TelemetryError({ message: "Invalid JSON", code: 400 }),
          }).pipe(
            Effect.tap((payload) => Effect.logDebug(JSON.stringify(payload))),
            Effect.withSpan("parseJson"),
            isValidTelemetryPayload,
            Effect.withSpan("validatePayload"),
          );

          const enrichedPayload = yield* Effect.all(
            [clientIpHashEffect, jsonEffect, getUserEffect],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.tap(([_clientIpHash, _payload, user]) =>
              Effect.logDebug(JSON.stringify(user)),
            ),
            Effect.flatMap(([clientIpHash, payload, user]) =>
              enrichPayloadWithServerContext(
                payload,
                clientIpHash,
                userAgent,
                user,
              ),
            ),
            Effect.withSpan("enrichPayload"),
          );

          // 6. Forward to Axiom
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              fetch(`${env.AXIOM_API_URL}/v1/traces`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${env.AXIOM_TOKEN}`,
                  "X-Axiom-Dataset": env.AXIOM_DATASET,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(enrichedPayload),
                signal, // Übergibt den Abbruch-Signal vom Timeout an fetch
              }),
            catch: (error) =>
              new TelemetryError({
                message: `Fetch failed: ${String(error)}`,
                code: 500,
              }),
          }).pipe(
            Effect.timeout("20 seconds"),
            Effect.withSpan("api.telemetry.axiom_fetch_attempt"),
            Effect.retry(
              Schedule.recurs(3).pipe(Schedule.addDelay(() => "500 millis")),
            ),
            Effect.withSpan("api.telemetry.forward_to_axiom"),
          );

          if (!response.ok) {
            return yield* Effect.fail(
              new TelemetryError({ message: "Axiom API error", code: 500 }),
            );
          }

          return new Response("OK", { status: 202 });
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              posthog?.capture({
                distinctId: "server",
                event: "telemetry.error",
                properties: {
                  traceId: trace.getTraceId(),
                  error: String(error),
                },
              });
            }),
          ),
          // Fehler-Mapping auf Response Objekte
          Effect.catchTag("TelemetryError", (error) =>
            Effect.succeed(new Response(error.message, { status: error.code })),
          ),
          Effect.withSpan("handleAxiosResponse"),
        );

        // Trace starten und Kontext an Effect übergeben
        const trace = startTrace("api.telemetry.proxy");
        trace.extractFromHeaders(request.headers);
        trace.setAttributes({
          "http.method": "POST",
          "http.url": request.url,
        });

        const ctx = trace.getSpanContext();

        const response = await Effect.runPromise(
          program.pipe(
            Effect.provide(CryptoAuthLive),
            Effect.provide(UserLive),
            Effect.provide(otelNOT),
            Effect.provide(Logger.minimumLogLevel(LogLevel.Debug)),
            Tracer.withSpanContext(ctx),
          ),
        );
        trace.end();
        return response;
      },

      // Health check for the proxy
      GET: async () => {
        const isConfigured = !!env.AXIOM_TOKEN;

        return new Response(
          JSON.stringify({
            status: isConfigured ? "ready" : "not_configured",
            message: isConfigured
              ? "Telemetry proxy is ready"
              : "AXIOM_TOKEN not configured",
          }),
          {
            status: isConfigured ? 200 : 503,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      },
    },
  },
});
