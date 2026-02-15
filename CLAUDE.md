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
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated, do NOT edit manually
