# First npm publication bootstrap

The regular `.github/workflows/release-tools.yml` workflow intentionally cannot
create `pi-leetcode-tools` in npm. A registry `404` is a hard
`bootstrap_required` failure. Bootstrap authority must never be added to or
reused by the regular OIDC publish job.

The one-time bootstrap is an external release gate. If it is approved, use a
separately reviewed, temporary protected GitHub Actions workflow with all of
the following controls:

1. A dedicated protected environment and an exact `workflow_dispatch`
   confirmation for the committed tag, CandidateRecord digest, and tgz
   SHA-256. Grant `id-token: write` only to its minimal publish job so npm can
   emit provenance; build and validation jobs must not hold that permission.
2. A newly created, short-lived granular `NPM_TOKEN` with only the minimum
   package-creation/publish authority needed for this package. Do not use a
   maintainer's long-lived or classic token.
3. An isolated empty npm user/global config. The exact approved tgz is the only
   publish input; the bootstrap must not rebuild or generate a CandidateRecord.
4. `npm publish <exact-tgz> --tag next --provenance --access public
   --ignore-scripts`. Bootstrap must not create or move `latest`.
5. Exact registry metadata, tarball, integrity, provenance, clean-install, Pi
   activation, and `latest`-unchanged verification before bootstrap is accepted.
6. Immediate revocation of the granular token and removal/disablement of the
   temporary bootstrap workflow.
7. Configure the npm trusted publisher for
   `.github/workflows/release-tools.yml` and environment `npm-tools-next`, then
   commit the reviewed npm owner, `configured: true`, and an auditable evidence
   reference to `release/tools-release-policy.json`.

Until every step is complete, the regular OIDC workflow remains fail-closed.
