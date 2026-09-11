# Agent instructions

Read `CLAUDE.md` first; it is the architecture reference and the working conventions for this repo.

Non-negotiables for any agent working here:

1. **Commit frequently.** After every coherent unit of work (a compiling file group, a green test
   suite, a working script, a finished doc section), make a local conventional commit with a short
   "why" body. Never accumulate more than ~15 minutes of uncommitted work. Push once the remote is
   authorised.
2. **Test before you claim.** `forge test --root contracts`, `pnpm --filter agents test`,
   `pnpm --filter agents e2e` must be green before reporting a change as done.
3. **Never commit secrets.** `agents/.env`, `agents/state/`, `dashboard/config.local.js` are gitignored;
   keep it that way. Enter keys with `./scripts/set-keys.sh`, never by pasting into chat.
4. **Keep Solidity and TypeScript in lockstep.** After any contract change: `forge build`, then
   `pnpm --filter agents gen-abi && pnpm --filter agents gen-fixtures`, then run everything.
