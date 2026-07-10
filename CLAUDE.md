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

## Stats passthrough — broadcast-only filters/groupBys must be STRIPPED for postmark, never forwarded

The `/stats` route is a passthrough, but "passthrough" does NOT mean "forward every filter to both providers." A filter/groupBy dimension that one provider genuinely has NO concept of must be stripped before that provider, or the response is incoherent. Postmark (transactional) has no `timezone`/day-calendar grouping, no per-`audienceId` attribution — so those are **broadcast-only** and handled by `withoutBroadcastOnlyFilters` (strips `timezone` + `audienceId` before postmark) and `isBroadcastOnlyGroupBy` (`day`/`audienceId` → `handleBroadcastOnlyGrouped`, transactional returns empty groups). This is NOT "working around missing backend data" — postmark truly has no such dimension, so returning nothing for its side is correct; forwarding the filter instead makes postmark drop the unknown param and return UNFILTERED transactional stats presented alongside audience/day-scoped broadcast stats (a self-contradictory secondary surface = a bug). **When adding a new stats dimension, first ask "does postmark have this dimension?" If no, add it to the broadcast-only strip/route set — do NOT pure-forward it.** Cost 2026-07-06 (audienceId, #170→#171): shipped a pure-passthrough forwarding `audienceId` to both providers to main/prod; incoherent transactional output; #171 reverted onto the broadcast-only pattern (twin's #168, already on staging). When postmark-service#160 ships per-audience transactional stats, remove `audienceId` from the broadcast-only strip.

## Shared contract

Cross-provider canonical shapes (`StatusScope`, `RecipientStats`, `EmailStats`, `StepStats`, `RepliesDetail`, `ChannelStats`, `ProviderStatus`, `GlobalStatus`, `ReplyClassification`) live in [`@shamanic-technologies/email-domain-contract`](https://github.com/shamanic-technologies/email-domain-contract). Do NOT redeclare these schemas locally — re-export from the package via `src/schemas.ts`. As of 2026-06-05 (DIS-229), instantly-service (v0.40.0) and postmark-service both migrated onto this package too — all three services now source the shared shapes from `^1.1.0`, so a contract change propagates to every provider on a version bump.

Two provider-specific fields are **optional in v1** of the contract: `cancelled` and `notSending`. They live on instantly responses today and are expected on postmark after a follow-up that pads them with neutral defaults (`false` / `0`). Contract v2 will tighten them to required after that padding ships.

`StatusScope` carries 8 **per-event first-occurrence timestamps** (contract `^1.1.0`, DIS-229): `firstContactedAt`, `firstSentAt`, `firstDeliveredAt`, `firstOpenedAt`, `firstClickedAt`, `firstRepliedAt`, `firstBouncedAt`, `firstUnsubscribedAt` — each optional + nullable ISO-8601, `MIN` (first occurrence) of that event type in scope; brand-scope = MIN across the brand's campaigns. They mirror `lastDeliveredAt` (MAX): **a MIN-twin of an existing `lastX` field takes a `firstX` prefix** for symmetry (convention: `firstX`=MIN, `lastX`=MAX). `firstRepliedAt` is always null for postmark (no reply tracking). email-gateway forwards them through the `/orgs/status` passthrough — no route logic; the providers populate them from their event stores.

`StatusScope` also carries **`sentCount`** (contract `^1.2.0`): the per-scope COUNT of emails actually sent to the recipient (a send-event count, NOT a boolean — `sent` only says "≥1 sent"). A consumer derives the outreach sequence position from it: `1` = initial email, `2` = first follow-up, `3` = second follow-up, … (lead-service forwards it onto each `/orgs/leads` row; the dashboard renders the sequence label). Optional `int` ≥ 0, **absent-safe** — a provider that predates the field simply omits it and the consumer reads `?? 0` (do NOT fabricate/default it in the passthrough). Scope aggregation: per-campaign (`byCampaign[id]`, `campaign`) = count of that (recipient, campaign)'s sends; **brand-scope = SUM across the brand's campaigns** (total emails sent to the recipient across the brand — contrast the booleans' BOOL_OR and the timestamps' MIN/MAX). Populated per-provider from each event store (broadcast via instantly-service, transactional via postmark-service); email-gateway forwards it through the `/orgs/status` passthrough untouched, keeping the broadcast/transactional blocks separate — a recipient reached by one provider reads that provider's `sentCount`.

## Zod 4 caveat — contract schemas + `.openapi()`

`@asteasolutions/zod-to-openapi` attaches `.openapi()` to Zod schema instances at the time `extendZodWithOpenApi(z)` runs in the consumer. The contract package's schemas were instantiated before that point in the consumer's module graph, so they do NOT gain `.openapi()` retroactively. Re-export them without `.openapi(name)` and let the generator inline them (no `$ref` name). Local schemas defined in `src/schemas.ts` (after `import "./zod-setup"`) keep their `.openapi(name)` tagging.
