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

## Reading ONE logical send operation back — `runIds` cannot do it, and the failure is silent

`GET /stats?runIds=<run>` filters on the run the PROVIDER recorded against each
message, which is a CHILD run minted per send. It is not the run of the service
that asked for the sends. So a caller that performed thousands of sends as one
operation, and asks with its own run, matches nothing and gets a clean
well-formed response saying nothing was sent — byte-identical to a real all-zero
result. Measured in prod 2026-09-18: release run `79982eb6…` → `sent: 0`; its
child run `e095307e…` → `sent: 1`.

`GET /orgs/stats/by-operation` + `GET /public/stats/by-operation` take an
`operationId` instead — the value the caller set as the send's `tag` on every
message of that operation — and pass it to postmark-service's own per-operation
read (`/stats/by-tag`, v0.32.6+), which is one indexed query whatever the
operation's size.

**The half that matters is `matched`, not the figures.** An operation nothing
belongs to comes back `matched: false` with NO `transactional` block at all.
Never "improve" this into a zeroed `ChannelStats`: a consumer polling an
operation in flight must be able to tell "my question found nothing" from "the
outcomes are zero", and the only way to give it that is to refuse to emit
numbers with no messages behind them. Same reason the handler 502s when the
provider claims a match and serves no figures.

**Transactional only, on purpose.** Broadcast sequences are already named by
their campaign and audience, and the broadcast provider has no equivalent
per-send handle — so this read does not answer for broadcast rather than
answering with a silent zero. This is NOT the broadcast-only strip pattern
below; it is its mirror, and it is a separate read rather than a filter on
`/stats` precisely because `/stats`'s response shape cannot express
"I matched nothing".

Consumer: transactional-email-service's mailing-list release self-halt, which
stops a release when Postmark's bounce or unsubscribe outcomes go bad. It read
the run-keyed query and was therefore inert for its whole life.

## Shared contract

Cross-provider canonical shapes (`StatusScope`, `RecipientStats`, `EmailStats`, `StepStats`, `RepliesDetail`, `ChannelStats`, `ProviderStatus`, `GlobalStatus`, `ReplyClassification`) live in [`@shamanic-technologies/email-domain-contract`](https://github.com/shamanic-technologies/email-domain-contract). Do NOT redeclare these schemas locally — re-export from the package via `src/schemas.ts`. As of 2026-06-05 (DIS-229), instantly-service (v0.40.0) and postmark-service both migrated onto this package too — all three services now source the shared shapes from `^1.1.0`, so a contract change propagates to every provider on a version bump.

Two provider-specific fields are **optional in v1** of the contract: `cancelled` and `notSending`. They live on instantly responses today and are expected on postmark after a follow-up that pads them with neutral defaults (`false` / `0`). Contract v2 will tighten them to required after that padding ships.

`StatusScope` carries 8 **per-event first-occurrence timestamps** (contract `^1.1.0`, DIS-229): `firstContactedAt`, `firstSentAt`, `firstDeliveredAt`, `firstOpenedAt`, `firstClickedAt`, `firstRepliedAt`, `firstBouncedAt`, `firstUnsubscribedAt` — each optional + nullable ISO-8601, `MIN` (first occurrence) of that event type in scope; brand-scope = MIN across the brand's campaigns. They mirror `lastDeliveredAt` (MAX): **a MIN-twin of an existing `lastX` field takes a `firstX` prefix** for symmetry (convention: `firstX`=MIN, `lastX`=MAX). `firstRepliedAt` is always null for postmark (no reply tracking). email-gateway forwards them through the `/orgs/status` passthrough — no route logic; the providers populate them from their event stores.

`StatusScope` also carries **`sentCount`** (contract `^1.2.0`): the per-scope COUNT of emails actually sent to the recipient (a send-event count, NOT a boolean — `sent` only says "≥1 sent"). A consumer derives the outreach sequence position from it: `1` = initial email, `2` = first follow-up, `3` = second follow-up, … (lead-service forwards it onto each `/orgs/leads` row; the dashboard renders the sequence label). Optional `int` ≥ 0, **absent-safe** — a provider that predates the field simply omits it and the consumer reads `?? 0` (do NOT fabricate/default it in the passthrough). Scope aggregation: per-campaign (`byCampaign[id]`, `campaign`) = count of that (recipient, campaign)'s sends; **brand-scope = SUM across the brand's campaigns** (total emails sent to the recipient across the brand — contrast the booleans' BOOL_OR and the timestamps' MIN/MAX). Populated per-provider from each event store (broadcast via instantly-service, transactional via postmark-service); email-gateway forwards it through the `/orgs/status` passthrough untouched, keeping the broadcast/transactional blocks separate — a recipient reached by one provider reads that provider's `sentCount`.

## A provider-additive field on a contract shape is an `.extend()` here, not a contract fork

`StatusScope` lives in the shared contract, but a provider may serve fields the contract has not absorbed yet (`replyKind` / `disqualified`, instantly-service v0.75.0). Those are declared in `src/schemas.ts` as `RawStatusScope.extend({...})` (`ScopedStatusSchema`, wrapped by `GatewayProviderStatusSchema`) — the contract stays the single source of truth for the shared fields, and widening it is a separate cross-repo change. instantly-service made the same call on its own side.

Two constraints on such an extension. It is **optional** on both fields: the transactional provider (postmark) has no reply tracking and simply omits them, and a provider that predates the field must not start failing. And the value is typed `z.string()`, never a copy of the owner's enum — the same call the manual-qualification `status` field made in v0.25.3, after a stale local copy refused three kinds instantly-service accepted; `replyKind` is instantly-service's list and a stale copy here would refuse a kind the owner accepts. `disqualified` is derived by the provider from `replyKind`; this hop forwards the pair and decides nothing about who is disqualified. `replyClassification` keeps its exact meaning — a consumer reading only the coarse value sees no change.

The extended schemas carry no `.openapi("Name")` for the reason in the next section; the generator inlines them.

## Zod 4 caveat — contract schemas + `.openapi()`

`@asteasolutions/zod-to-openapi` attaches `.openapi()` to Zod schema instances at the time `extendZodWithOpenApi(z)` runs in the consumer. The contract package's schemas were instantiated before that point in the consumer's module graph, so they do NOT gain `.openapi()` retroactively. Re-export them without `.openapi(name)` and let the generator inline them (no `$ref` name). Local schemas defined in `src/schemas.ts` (after `import "./zod-setup"`) keep their `.openapi(name)` tagging.
