## What this changes

<!-- One paragraph. What behaviour changes, and why. -->

## Which layer does it touch?

- [ ] A domain (`lib/domains/*.js`) — new or changed action
- [ ] The registry (`lib/registry.js`) — gates, parameter building, dispatch
- [ ] The runner (`lib/runner.js`) — process handling, output caps
- [ ] Credentials (`lib/auth.js`, `lib/domains/auth.js`)
- [ ] The web half (`client.js`, `lib/client-bridge.js`, `lib/routes.js`)
- [ ] Update (`lib/update.js`, `lib/domains/update.js`)
- [ ] Docs / packaging only

## Behaviour contract

This project's rule is that a change either keeps behaviour identical or states
exactly what changed. Tick what applies:

- [ ] No behaviour change (a refactor). I ran `npm run snapshot:compare -- <before.json>` and it reported identical.
- [ ] Behaviour changed, and the change is described above.
- [ ] External interface changed (tool name, action name, parameter, result field, config key) — listed here:

## New write actions

If this adds an action that changes remote state:

- [ ] It is marked `destructive: true`, so it requires `confirm: true` and passes the approval seam
- [ ] If the action's read/write nature depends on a runtime argument, `isDestructiveCall` handles it
- [ ] It is classified in `test/r3.test.mjs` (the "every state-changing action is classified" test)

## Verification

- [ ] `npm test` passes
- [ ] `npm run verify:offline` passes
- [ ] If an argv shape changed: `npm run probe:argv` and `npm run probe:arity` pass
- [ ] If the prompt section changed: it still fits the 2400-character budget (`npm run probe:guidance`)

## Notes for the reviewer

<!-- Anything a reader would otherwise have to discover: a measured oddity, a
     deliberate omission, a line you are unsure about. -->
