# email-gateway

Open Source email gateway — routes emails to Postmark (transactional) or Instantly (broadcast) based on type.

## Inbound email pub/sub

Inbound emails (Postmark `RecordType=Inbound`) flow through three hops:

```
Postmark MX  →  postmark-service  POST /webhooks/postmark
             →  email-gateway     POST /inbound/postmark   (x-api-key auth)
             →  subscribers       (each gets HMAC-signed POST)
```

`postmark-service` is the public Postmark webhook receiver. On `RecordType=Inbound` it forwards the raw payload to this gateway's `POST /inbound/postmark`. This gateway then fans the payload out to every subscription whose alias filter matches the recipient.

### Subscription configuration

Configure with `EMAIL_GATEWAY_SUBSCRIPTIONS` (JSON array). Each entry:

```json
{
  "name": "journalists-quotes-service:inbound",
  "filter": { "aliasPattern": "*@inbox.example.com" },
  "endpoint_url": "https://consumer.example/webhooks/email-gateway/inbound",
  "hmac_secret_env": "JQS_INBOUND_HMAC_SECRET"
}
```

`aliasPattern` supports `*@domain` wildcard (suffix) or exact match. `hmac_secret_env` is the name of the env var holding the shared HMAC secret; it is resolved at boot. Invalid JSON, schema errors, or a missing referenced secret cause a fatal exit at startup.

### HMAC signing scheme

Every subscriber POST carries:

- `content-type: application/json`
- `x-eg-signature: t=<unix>,v1=<hex sha256(t.body, secret)>`
- `idempotency-key: <Postmark MessageID>`

Verify by recomputing `HMAC-SHA256(secret, "${t}.${rawBody}")` and timing-safe-comparing to `v1`. Reject when `|now - t| > 300` seconds. Consumers must idempotency-dedupe on `idempotency-key`. See `src/lib/hmac.ts` for a reference verifier.

### Retry semantics

Fail loud. If any subscriber returns non-2xx or the request errors, `POST /inbound/postmark` returns 502; `postmark-service` propagates 5xx to Postmark; Postmark's own ~45-minute retry window re-delivers the event. There is no local outbox, queue, or dead-letter table.

## Threading (transactional `/orgs/send`)

`POST /orgs/send` accepts optional RFC 5322 threading fields for transactional sends:

- `inReplyTo` — Message-ID being replied to, including angle brackets, e.g. `<id@host>`
- `references` — space-separated thread chain
- `messageStream` — Postmark message stream override

Fields pass through to `postmark-service` unchanged. Omit for current default behavior.
