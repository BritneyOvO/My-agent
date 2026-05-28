# TypeScript Refactor

The active backend runtime has been rewritten under `backend/src` and runs directly on Node.js.

## Entry points

- Root workspace: `package.json`
- Backend package: `backend/package.json`
- Server bootstrap: `backend/src/index.ts`
- HTTP server and route wiring: `backend/src/server.ts`

## Commands

Run from repo root:

```bash
npm run dev
```

Production run:

```bash
npm run start
```

## Scope of the rewrite

- FastAPI routes were ported to TypeScript route modules on Node's built-in HTTP server.
- Pydantic validation was replaced with local request parsers.
- File-backed task, report, hub-message, audit, policy, scope, and tool-dispatch behavior was preserved.
- The backend uses Node 22's built-in TypeScript stripping and has no third-party npm packages.
- Runtime config defaults to the root `config/` folder.
- Runtime data and logs default to `backend/.runtime-data/` and `backend/.runtime-logs/` for reliable local Node execution.

## Transitional note

Legacy Python files under `backend/app` still exist on disk for reference, but the new container/runtime path now points at the TypeScript implementation.
