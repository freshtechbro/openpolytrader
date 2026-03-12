# Test Fixtures

## Scope
Applies to `tests/fixtures/`.

## Responsibilities
- Shared static fixture payloads used across backend and dashboard unit suites.

## Rules
- Keep fixture payloads realistic and schema-valid.
- Prefer additive fixture updates over mutating unrelated existing payloads.
- When behavior changes, update fixture data and the consuming tests together.

## Validation
- Run targeted tests that consume changed fixtures.
