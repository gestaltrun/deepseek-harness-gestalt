---
name: setup-pre-commit
description: Set up or extend pre-commit hooks without replacing a repository's existing hook, formatter, package-manager, or check policy. Use when the user asks for Husky, lint-staged, staged formatting, or commit-time checks.
---

# Setup Pre-Commit Hooks

## 1. Inspect the repository

Detect the package manager, existing hook framework and hook files, formatter and staged-file configuration, package scripts, contributor instructions, and CI/pre-push check policy. Follow symlinks before editing `CLAUDE.md` or another instruction alias. Present the smallest compatible change when the repository already has hooks.

Complete this step when every existing hook and formatter owner that the change could affect is identified.

## 2. Choose the integration

Prefer extending the installed framework. Add Husky, lint-staged, or Prettier only when the repository does not already provide an equivalent and the user requested that behavior. Use the owning workspace and detected package manager for dependencies and commands.

Keep commit-time work fast and proportional. Staged formatting or linting is a suitable default; full typecheck or test suites belong in pre-commit only when the repository explicitly adopts them. Do not overwrite hook files, package scripts, formatter config, or user commands.

Complete this step when the intended hook order, preserved commands, new dependencies, and changed files are explicit.

## 3. Implement the smallest change

Merge the new command into the existing hook, or initialize the requested framework when none exists. Scope lint-staged patterns to files the configured formatter or linter owns. Create a formatter config only when the selected tool requires one and no project config exists; derive settings from repository conventions instead of installing generic defaults.

Complete this step when the hook invokes the requested staged behavior and all pre-existing behavior remains represented.

## 4. Prove the hook

Run the staged command directly against a representative staged file, verify the file is changed or rejected as intended, restore any temporary probe, and run the repository-selected checks for the configuration diff. Confirm the hook is executable where the framework requires it.

Complete the skill when the representative valid case passes, an invalid case is rejected or repaired by the intended command, temporary probes are removed, and the final diff contains only the agreed hook integration.
