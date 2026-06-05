# Project: email-gateway

Email gateway - routes emails to Postmark (transactional) or Instantly (broadcast) based on type.

## Commands

- `npm test` — run tests (vitest)
- `npm run test:watch` — watch mode
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server with hot reload
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/routes/` — Express route handlers
- `src/middleware/` — Express middleware
- `src/lib/` — Shared utilities
- `src/config.ts` — Environment configuration
- `src/zod-setup.ts` — Side-effect module that extends Zod with `.openapi()`. Import it BEFORE any module that creates `z.object(...).openapi("Name")` schemas.
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually

## Shared contract

Cross-provider canonical shapes (`StatusScope`, `RecipientStats`, `EmailStats`, `StepStats`, `RepliesDetail`, `ChannelStats`, `ProviderStatus`, `GlobalStatus`, `ReplyClassification`) live in [`@shamanic-technologies/email-domain-contract`](https://github.com/shamanic-technologies/email-domain-contract). Do NOT redeclare these schemas locally — re-export from the package via `src/schemas.ts`. As of 2026-06-05 (DIS-229), instantly-service (v0.40.0) and postmark-service both migrated onto this package too — all three services now source the shared shapes from `^1.1.0`, so a contract change propagates to every provider on a version bump.

Two provider-specific fields are **optional in v1** of the contract: `cancelled` and `notSending`. They live on instantly responses today and are expected on postmark after a follow-up that pads them with neutral defaults (`false` / `0`). Contract v2 will tighten them to required after that padding ships.

`StatusScope` carries 8 **per-event first-occurrence timestamps** (contract `^1.1.0`, DIS-229): `firstContactedAt`, `firstSentAt`, `firstDeliveredAt`, `firstOpenedAt`, `firstClickedAt`, `firstRepliedAt`, `firstBouncedAt`, `firstUnsubscribedAt` — each optional + nullable ISO-8601, `MIN` (first occurrence) of that event type in scope; brand-scope = MIN across the brand's campaigns. They mirror `lastDeliveredAt` (MAX): **a MIN-twin of an existing `lastX` field takes a `firstX` prefix** for symmetry (convention: `firstX`=MIN, `lastX`=MAX). `firstRepliedAt` is always null for postmark (no reply tracking). email-gateway forwards them through the `/orgs/status` passthrough — no route logic; the providers populate them from their event stores.

## Zod 4 caveat — contract schemas + `.openapi()`

`@asteasolutions/zod-to-openapi` attaches `.openapi()` to Zod schema instances at the time `extendZodWithOpenApi(z)` runs in the consumer. The contract package's schemas were instantiated before that point in the consumer's module graph, so they do NOT gain `.openapi()` retroactively. Re-export them without `.openapi(name)` and let the generator inline them (no `$ref` name). Local schemas defined in `src/schemas.ts` (after `import "./zod-setup"`) keep their `.openapi(name)` tagging.
