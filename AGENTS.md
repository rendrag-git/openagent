# Agent Instructions — openagent

## What This Is
A TypeScript SDK for orchestrating Claude Code sessions as PDCA workers (plan, execute, check, act). Built on @anthropic-ai/claude-agent-sdk.

## Setup
Run `./scripts/bootstrap` to install dependencies and typecheck.

## After Changes
Run `./scripts/test` to verify nothing is broken.

## Before Finishing
Run `./scripts/lint` to run the typecheck (no separate linter is configured).

## Rules
- Never read `.env`, secret files, or credential files
- Never commit secrets or API keys
- Use `./scripts/*` instead of guessing package manager commands
- Keep changes focused — one concern per commit
- Tests use Node's built-in `node:test` runner — no external test framework
- All source uses `.ts` extension imports (e.g., `import { foo } from "./bar.ts"`)
- Requires Node >= 22 for `--experimental-strip-types`
