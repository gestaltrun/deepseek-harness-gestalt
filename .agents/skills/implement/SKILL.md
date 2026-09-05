---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Use the repository's changed-behavior policy to select the narrowest red/green test and pre-push evidence. Do not default to a full suite or repeat a passing check solely because commit or push follows.

Once done, review the complete committed and dirty scope through the repository's review workflow.

Commit your work to the current branch.
