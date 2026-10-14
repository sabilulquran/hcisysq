# Permanent staging retirement — 2 October 2026

**Status: OWNER DECISION — PRODUCTION ONLY.**

HCIS/SQ Hub staging on the production VPS was permanently retired by owner decision on 2 October 2026. Production-only is the intended topology. Do not recreate, deploy, enable, or infer a requirement for staging from historical files, backups, Docker resources, workflows, or documentation. Reintroduction requires a new explicit owner decision and a new deployment plan.

## Operational boundary

- No staging runtime, realm, Docker network, datastore, alias, route, or working directory is an intended production-VPS dependency.
- Do not recreate staging to diagnose production or to validate backups. Restore verification uses disposable databases with no production network, application connection, published ports, Caddy, or DNS.
- Historical configuration lives under `docs/archive/staging-retired/` or root-protected VPS backup archives. It does not authorize recreation.
- Former staging deployment wrappers fail before environment access, Docker operations, pulls, or SSH. The old staging Compose entry points contain no services.
- Production deployment workflows and immutable-image publishing remain production delivery paths. Legacy publisher filenames are compatibility identifiers, not staging deployments.
- Dedicated CI fixtures run only on disposable GitHub-hosted runners with localhost endpoints. They never authorize deploying CI fixtures to the production VPS.
- Production credential rotation, authentication observability, build cache and generic storage cleanup are separate workstreams.

## Safety gate

Owner causal-regression gate supersedes global smoke thresholds. STOP and roll back the relevant last mutation only when evidence links that mutation to loss of a production dependency, an unhealthy service, reproducible route failure, unintended production identity changes, or production data-loss risk. Timing correlation alone is insufficient. Previously observed machine-auth 401/500 and RuangHadir transient 502 are separate production reliability follow-ups when no causal staging dependency exists. Record bounded before/after checks without repairing those issues during decommission.

## Historical evidence

The VPS canonical decommission archive is recorded by `/var/backups/sq-hub/staging-permanent-decommission-current`. It contains checksums, restore evidence, resource inventory, configuration references and the final report. Archives are historical, not deployable environments.
