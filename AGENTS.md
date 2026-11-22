# Instructions for contributors and coding agents

## Write for the next human reader

Human readability is a requirement for every change in this repository. Assume
that a developer learning the project will read and modify your code. Do not
compress code to save lines or tokens.

- Use consistent indentation, normal spacing, and blank lines between logical
  steps. Keep one statement per line and use braces for control-flow bodies.
- Use descriptive names for variables, parameters, functions, and types. Avoid
  cryptic abbreviations when a name can explain its role.
- Split long workflows into focused, named functions when doing so makes their
  purpose and execution order easier to follow.
- Add a module overview explaining the file's responsibility and where it fits
  in the workflow.
- Add JSDoc to functions, methods, classes, and shared domain types. Describe
  their purpose, inputs, returned results, meaningful errors, and side effects
  where applicable. Document private helpers as well as exported APIs.
- Use comments throughout nontrivial workflows to explain what each logical
  step accomplishes and why it is necessary. Explain scoring rules, SQL
  relationships, data normalization, verification gates, retention behavior,
  and external API requirements close to the relevant code.
- Comments must help a human understand the implementation. Do not replace
  explanations with vague labels or merely repeat obvious syntax. Never claim
  that a guard or guarantee exists unless the code actually enforces it.
- Keep comments and JSDoc accurate whenever implementation changes.
- Apply the same readability standard to tests and demonstration scripts.
  Explain fixture setup and any non-obvious expected result.

## Formatting and validation

- Run `npm run format` after editing TypeScript or project configuration.
- Before publishing, run `npm run format:check`, `npm run check`, and `npm test`.
- Run `npm run demo` when changing the example workflow.
- Inspect the diff yourself: a formatter cannot supply meaningful names,
  explanations, or clear separation of responsibilities.
- A readability-only change should preserve behavior. Keep any necessary
  behavior changes explicit and verify them with relevant tests.

## Product boundaries

Keep searches tied to a specific open object case. Preserve provenance and the
human verification gate. Do not add seller profiling, person search, biometrics,
marketplace scraping, or automatic seller contact. Sandbox and staged records
must remain excluded from real-case metrics and owner notifications.
