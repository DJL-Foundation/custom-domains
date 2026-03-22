# DJL Foundation Custom Domains Proxy

Fallback origin worker for DJL Foundation multi-tenant SaaS products that use Cloudflare Custom Domains.

It receives requests for customer domains, resolves the target app URL from KV, and proxies traffic to the correct tenant app.

## What this service does

- Manages domain mappings through authenticated API endpoints
- Stores `custom-domain -> target-app-url` in Cloudflare KV
- Proxies incoming requests to the mapped upstream app
- Provides a branded landing page on the root proxy domain
- Emits OpenTelemetry traces to Axiom

## How the request flow works

1. Cloudflare routes custom-domain traffic to this worker (fallback origin).
2. Worker reads `Host` header.
3. Worker looks up host in `hostnames-kv`.
4. If found, worker forwards request to mapped target URL (same path/query).
5. If not found, worker returns a not-configured response.

## API

All `/api/*` routes require bearer auth via `ACCESS_TOKEN`.

### POST `/api/domains`

Registers or updates a domain mapping.

Request body:

```json
{
  "customDomain": "customer.example.com",
  "targetAppUrl": "https://tenant-123.my-saas.app"
}
```

Success:

```json
{
  "code": 200,
  "tag": "OK",
  "message": "Domain added successfully"
}
```

### DELETE `/api/domains`

Removes a domain mapping.

Request body:

```json
{
  "customDomain": "customer.example.com"
}
```

Success:

```json
{
  "code": 200,
  "tag": "OK",
  "message": "Domain deleted successfully"
}
```

## Runtime behavior

- `GET /` on proxy root hosts (`proxy.djl.foundation`, workers.dev preview hosts) serves a landing page and redirects to `https://djl.foundation`.
- All other routes are proxied.
- Common responses:
  - `400` when Host header is missing
  - `404` when domain is not configured
  - `502` when upstream cannot be reached

## KV schema

- Namespace binding: `hostnames-kv`
- Key: custom domain hostname (e.g. `customer.example.com`)
- Value: target app base URL (e.g. `https://tenant.myapp.com`)

## Environment and secrets

Copy the template and fill values:

```bash
cp .env.example .env
```

Required:

- `ACCESS_TOKEN`: bearer token for domain-management API
- `ENCRYPTION_KEY`: symmetric key material used by crypto helpers
- `AXIOM_TOKEN`: token for OTLP trace export

Configured in Wrangler vars:

- `ENVIRONMENT`: `dev` | `staging` | `production`
- `AXIOM_DATASET`: Axiom dataset name
- `AXIOM_API_URL`: Axiom OTLP endpoint

## Development

```bash
npm install
npm run dev
```

Type generation:

```bash
npm run typegen
```

## Deploy

```bash
npm run deploy:staging
npm run deploy:prod
```

Default deploy command targets staging:

```bash
npm run deploy
```
