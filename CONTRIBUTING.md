# Contributing to Aegis

Thank you for your interest in contributing to Aegis! This document provides guidelines and information for contributors.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/Aegis.git`
3. Create a branch for your changes
4. Make your changes and ensure tests pass
5. Submit a pull request

## Branching Strategy

- `main` — production-ready code, always deployable
- Feature branches: `feat/<area>/<short-desc>` (e.g., `feat/dashboard/camera-widget`)
- Bug fixes: `fix/<area>/<short-desc>`
- Chores: `chore/<short-desc>` (dependencies, tooling, etc.)

## Development Workflow

### Before Committing

Ensure code quality and test coverage:

```bash
make lint
make test
```

All linters and tests must pass before pushing. If a test is flaky, mark it appropriately and file an issue — do not commit with known flakes.

### Pull Requests

- One PR per logical change. Keep commits focused.
- Title format: `<area>: <short description>`
- Description should include:
  - What changed
  - Why the change was needed
  - How it was tested
- At least one team member review required
- CI must pass with no errors

### Commit Messages

Follow conventional commit format:

```
feat(dashboard): add real-time camera streaming
fix(api): handle null values in response parser
docs: update installation instructions
```

## Code Quality

### Python
- Formatter: [ruff](https://github.com/astral-sh/ruff) (configured in `pyproject.toml`)
- Type checking: strict mypy

### TypeScript / JavaScript
- Linting: ESLint + Prettier
- TypeScript strict mode enabled

### Dart
- `dart analyze`
- `dart format`

### SQL
- [sqlfluff](https://github.com/sqlfluff/sqlfluff) for linting and formatting

Auto-format on save is configured in `.vscode/settings.json` for supported editors.

## Architectural Decisions

Significant architectural or design decisions are documented using [ADR](https://adr.github.io/) (Architectural Decision Records). New ADRs live in `docs/decisions/` following the established format.

## Security

**Never commit**:
- `.secrets/` directory
- `.env` files containing secrets
- Service account credentials (`service-account-*.json`)
- API keys, tokens, or passwords

If you accidentally commit sensitive data, notify the team immediately and rotate the credential.

## Testing

- Write tests for new features and bug fixes
- Run `scripts/smoke.sh` to verify end-to-end functionality
- Do not break the smoke test — if your PR breaks it, fix it in the same PR or document why it's skipped with a linked issue

## Questions?

Open an issue for any questions about contributing to this project.
