# LLM Fixtures

## Scope
Applies to `tests/fixtures/llm/`.

## Responsibilities
- Canonical JSON fixtures for LLM input/output contract tests.

## Rules
- Keep payload shapes aligned with zod schemas and parser expectations.
- Prefer stable deterministic samples over randomized fixture data.
- Update fixture and consuming assertions together.

## Validation
- Run the test files that load each changed fixture.
