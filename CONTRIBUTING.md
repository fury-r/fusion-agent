# Contributing to fusion-agent

Thank you for your interest in contributing! This document outlines how to get started.

## Code of Conduct

Please be respectful and constructive in all interactions. We are committed to providing a welcoming environment for everyone.

## Getting Started

1. **Fork** the repository and clone your fork.
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Build the project:**
   ```bash
   npm run build
   ```
4. **Run tests** to make sure everything passes:
   ```bash
   npm test
   ```

## Development Workflow

- Create a branch for your change: `git checkout -b feat/your-feature` or `fix/your-bug`.
- Make your changes with clear, focused commits.
- Add or update tests for any new behaviour.
- Run `npm run lint` and fix any linting issues before opening a PR.

## Pre-commit Hooks

This project uses [Husky](https://typicode.github.io/husky) and [lint-staged](https://github.com/lint-staged/lint-staged) to enforce quality checks on every commit.

After running `npm install`, the hooks are set up automatically via the `prepare` script. On each `git commit`, the following checks run against staged files:

- **ESLint** — auto-fixes lint issues in `src/` and `tests/` TypeScript files.
- **TypeScript** — runs `tsc --noEmit` to catch type errors across the project.

If any check fails the commit is aborted. Fix the reported issues and commit again. You can also run the checks manually at any time:

```bash
npm run lint        # ESLint only
npx tsc --noEmit    # Type-check only
```

## Submitting a Pull Request

1. Push your branch.
2. Open a Pull Request against the `main` branch of this repository.
3. Describe **what** changed and **why**.
4. Link any related issues (e.g., `Closes #123`).
5. A maintainer will review your PR and may request changes.

## Reporting Bugs

Open a GitHub Issue with:

- A clear title and description.
- Steps to reproduce the problem.
- Expected vs. actual behaviour.
- Your Node.js version and OS.

## Feature Requests

Open a GitHub Issue with the `enhancement` label and describe the use-case you want to support.

## Style Guide

- TypeScript with strict mode enabled.
- Follow the existing code style enforced by ESLint (`npm run lint`).
- Prefer small, focused functions and modules.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
