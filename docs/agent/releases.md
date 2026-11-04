# Versions and releases

**Versions belong to releases, never to commits.** A commit never changes
the version in `package.json` and never creates a tag. It adds its lines
under **Unreleased** at the top of the change log in `docs/ARCHITECTURE.md`.
Only when the user asks for a release: pick the number (minor for features
or migrations, patch for fixes only, major only for manual-update changes),
turn Unreleased into one `vX.Y.Z` entry, bump, tag, build and publish as in
`docs/RUNBOOK.md` → Publishing a release. Never reference an unreleased
version number in code comments or docs; say "Unreleased" or name the next
release only once it is cut.
