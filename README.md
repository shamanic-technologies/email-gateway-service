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
  "endpoint_url": "https://consumer.example/webhooks/inbound-email",
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

## Reading one send operation back (`/stats/by-operation`)

`GET /orgs/stats/by-operation` and `GET /public/stats/by-operation` answer how one
logical send operation landed — a mailing-list release, a batch notification — in a
single request.

**The handle is the operation's RUN.**

```
GET /public/stats/by-operation?operationRunId=<the x-run-id the sends were made under>
```

Pass the `x-run-id` the caller set on every send of the operation. postmark-service
persists it as each message's parent run, so one indexed lookup answers whatever the
operation's size. Do **not** pass `/stats?runIds=<that run>`: the run stored on a
message is the CHILD run the provider mints per send, so that query matches nothing
and answers a well-formed zero.

**Contract change (v0.27.0).** The parameter used to be `operationId`, carrying the
send's `tag`. postmark-service withdrew the tag-keyed read before it reached prod: a
tag is per-TEMPLATE, so eleven mailing-list releases shared one value and a single
release's question answered for all eleven. A caller still sending `operationId` now
gets a `400`, not a wrong number. Rename it to `operationRunId` and pass the run.

**An unmatched operation is not a zero.**

```json
{ "operationRunId": "...", "matched": false, "messagesMatched": 0 }
```

No `transactional` block at all. A consumer polling an operation in flight reads
`matched: false` as "my question found nothing", never as "the outcomes are fine".
A `200` with `matched: true` always has real messages behind its figures, including
when those figures are genuinely zero. A provider failure — including a bare `404`
from a route that no longer exists — is a `502`, never an empty match.

**Transactional only.** Broadcast sequences are already named by their campaign and
audience, and the broadcast provider has no equivalent per-send handle, so this read
does not answer for broadcast rather than answering with a silent zero.
