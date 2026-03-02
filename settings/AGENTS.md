# Runtime Settings

## Scope
Applies to `settings/`.

## Responsibilities
- Persisted runtime risk-profile JSON snapshots.

## Rules
- Keep JSON valid and schema-compatible with runtime policy/risk loaders.
- Preserve profile intent (near_zero/moderate/high/extra_high) when editing values.
- Avoid ad-hoc keys that are not represented in config schema.

## Validation
- Validate profile updates through runtime config endpoints or startup validation.
