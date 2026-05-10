# email-gateway

Open Source email gateway — routes emails to Postmark (transactional) or Instantly (broadcast) based on type.

## Inbound forwarding

Postmark inbound webhooks delivered to `POST /webhooks/postmark` are forwarded to upstream `postmark-service` and additionally routed to consumer services based on the recipient alias.

Configure with `INBOUND_FORWARDING_RULES` (JSON array). Each rule:

```json
{
  "aliasPattern": "*@inbox.example.com",
  "consumerUrl": "https://consumer.example/webhooks/inbound",
  "consumerName": "consumer-name",
  "consumerApiKey": "shared-service-key"
}
```

`aliasPattern` supports `*@domain` wildcard (suffix) or exact match. Forwarding is idempotent on Postmark `MessageID`. Consumer failures are logged, never propagated. See `.env.example` for full config.

## Threading (transactional `/orgs/send`)

`POST /orgs/send` accepts optional RFC 5322 threading fields for transactional sends:

- `inReplyTo` — Message-ID being replied to, including angle brackets, e.g. `<id@host>`
- `references` — space-separated thread chain
- `messageStream` — Postmark message stream override

Fields pass through to `postmark-service` unchanged. Omit for current default behavior.
