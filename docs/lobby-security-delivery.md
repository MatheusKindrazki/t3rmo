# T3RMO lobby/security delivery receipt

Work-Control-ID: 01a0bfd1-50e0-7cbe-a513-6916b46dee3f
Base: a3e245a. Branch: codex/t3rmo-lobby-security. Production deployment: NOT PERFORMED.

## Delivered behavior

Friend-first entry, collapsed host configuration, three-round default, real one-round solo practice, invite preview/name, native dialog focus lifecycle, truthful scoring copy, score components from server, native/copy/manual sharing, session moderation and paginated participant access. Two static guides and sitemap/internal links provide useful search entry pages. The scoring formula and mode balance remain unchanged.

Room issuance is server-authorized; query flags cannot initialize a room. Config is applied before the host joins. New host and participant credentials are 256-bit random per-room capabilities, hashed server-side, transported in the first WebSocket message and never copied in invitations. Public IDs are not credentials. Origins are checked, commands parsed under size/schema/rate bounds, and IP-level connection controls apply before acceptance. Raw internal errors are not returned to clients.

## Migration and rollback

Protocol version is 2. The previous release accepted client-selected identity as reconnection authority, so securely converting an absent legacy player from their public/caller-chosen identity is not possible. This release deliberately returns 410 for legacy rooms and closes old-version sockets with a reload/version explanation. Deploy only after communicating/draining active v1 rooms. Existing v2 sessions use the same tab's sessionStorage token across reloads; private storage fallback only guarantees the current page lifetime.

A v2 match stores its seed, metadata, player board and phase receipts. The seed changes per new match and stays stable through reconnection. Host succession waits 30 seconds; a host returning after succession becomes an ordinary participant. Room expiration is 24 hours. Token revocation applies to a participant session, not all identities a human may create.

Do not blindly roll back to v1: it does not understand v2 capabilities and reintroduces the identity/issuance vulnerabilities. Prefer a forward fix. If rollback is operationally necessary, drain/retire v2 rooms, restore the old client/server together and explicitly accept the old security boundary; do not promise session continuity. No production secrets, DNS or account settings were changed.

## Limits and operating assumptions

- CREATE_LIMIT: 30 room creations per source IP/minute; ENTRY_LIMIT: 180 info requests or upgrade requests per source IP/category/minute (Cloudflare native rate limiter). Native limiters are local to their documented enforcement scope, not a universal distributed abuse ceiling.
- Per-room IP concurrency: 64, deliberately allowing small shared-NAT groups. Large school/office/creator scenarios need a measured policy, not unconditional bans or claims of support.
- Per socket: 60 incoming commands/10 seconds persisted in the attachment; 2 KiB UTF-8 payload limit before parse; per-action guess/page cooldowns preserved.
- 1500 room cap is unchanged from earlier code. This task does NOT establish new safe production capacity. Local smoke uses two players per mode, not a load benchmark.
- Lifetime identity cap: 6000; expiration: 24h. Current-match board recovery remains durable beyond the 120s in-memory cache; bounded records expire with room or reset with match.
- No accounts, ELO, 10k sharding, public matchmaking or anti-collusion guarantee introduced.
- No analytics provider or acquisition campaigns activated. SEO changes are code-level foundations, not proof of indexing/ranking/user growth.

## Verification

Security RED captured before production edits: direct `new=1` info/socket requests returned 200/426 and persisted unauthorized room state instead of 404/no writes. After correction both passed.

Independent review discovered four additional failures reproduced before fixing: socket message budget reset after hibernation/page; creator-never-joins succession; empty lobby participants; final receipt absent after reload. All four are covered by behavior regressions. Review also found repeated-training stats and rematch-seed/recovery issues; fixes use durable receipt dedup, new per-match seed and bounded/preflight connection recovery.

Commands:

```sh
pnpm test
pnpm typecheck
pnpm build
node tools/security-smoke.mjs http://127.0.0.1:8798
node tools/modes-smoke.mjs http://127.0.0.1:8798
```

`pnpm test` currently covers core scoring/dictionary, actual Room/Worker handlers under a state fixture, security lifecycle and web-stat receipt behavior. The local runtime smoke separately exercises actual workerd storage/WebSockets. Fixture success alone is not runtime proof.

Final verification: 44 automated tests passed (23 server, 2 web statistics, 19 core); typecheck and production build passed. Local workerd security smoke passed. Two real WebSocket clients passed TERMO, DUETO, TRIETO, QUARTETO and all four MISTO rounds.

Chromium checks passed at 360, 390, 768 and 1440 pixel widths with no horizontal overflow. All four board layouts fit the mobile viewport with keyboard. Two independent browser contexts verified invite, participant list, start and host removal during play. Clipboard denial exposed a selectable link. Dialog focus/Escape restoration, completed training reload without duplicate statistics, automatic and manual reconnect with retained guesses were verified. Connection recovery used exactly two sockets/two welcomes. These are emulated viewport checks, not physical-device tests.

Independent security and business-logic reviews passed. Code review prompted a short-disconnect partial-score regression: settled storage must supersede in-memory limbo before reconnect; the test also verifies next-round score continuity. Storage fixtures clone reads to match durable storage behavior. Physical mobile, multi-region Cloudflare behavior, sustained load, Search Console indexing and production deploy remain outside this local verification.
