# Sidecar Services

## Scope
Applies to `services/`.

## Responsibilities
- Auxiliary services used by local/runtime orchestration (for example IP oracle sidecar).
- Service-level docs and dependency manifests.

## Rules
- Keep service startup/health contracts explicit and reproducible.
- Pin dependencies in service manifests where possible.
- Do not include secrets or credential material in tracked files.

## Validation
- Verify sidecar health endpoint behavior before documenting startup guarantees.
