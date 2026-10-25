# CI and npm publishing

## How CI works

`.github/workflows/pipeline.yml` is a thin caller of pyrlyn/ci's config-driven
`ci.yml` (`uses: pyrlyn/ci/.github/workflows/ci.yml@main`). Following the pyrlyn convention the
reference is `@main`, not a SHA: pyrlyn/ci's `no-pinned-ci` check rejects pinned callers.

What runs is configured in `.github/infra.yml`:

- Shared checks: lint (actionlint), CodeQL (actions, JavaScript/TypeScript, Python) and Semgrep
  on public repositories, and the `gate` job that aggregates everything.
- Turned off: `rust` (prismax is not a Rust crate; generated Rust is checked below) and `dotnet`.
  No macOS or Swift jobs exist for this repository.
- Custom jobs (pyrlyn/ci runs them as one matrix job, tools come from `mise.toml`):
  - `typescript`: `pnpm typecheck`, `pnpm build`, `pnpm test`, `npm pack --dry-run`.
  - `python-scripts`: the real SQLAlchemy import check and the pytest suite for `scripts/`.
  - `diesel-compile-check`: `cargo check` of the generated Diesel code (Postgres, MySQL, SQLite).

Enable or disable a job: set `enabled: false` on it in `.github/infra.yml`, or remove it.
Disable CI entirely: disable the `pipeline` workflow in the repository's Actions tab.

## How publishing works

`.github/workflows/publish.yml` publishes the package `prisma-x` to the public npm registry:

- Trigger: a GitHub release is published, or manual `workflow_dispatch` with an existing tag.
- The tag must equal `v<version>` from `package.json`, otherwise the job fails.
- It runs typecheck, tests and build, then `npm publish --provenance --access public`.
- Provenance comes from GitHub OIDC (`id-token: write`), so the npm page links the package to
  the exact commit and workflow run in `pyrlyn/prismax`.
- Authentication uses the repository secret `NPM_TOKEN` (an npm automation or granular token
  with publish rights for `prisma-x`).

pyrlyn/ci's `release.yml` targets binary releases, so npm publishing is a local workflow.

### Release steps

1. Bump `version` in `package.json` in a pull request and merge it.
2. Create a GitHub release with tag `v<version>` on main. The `publish` workflow runs.

### Enable or disable

- Enable: add the `NPM_TOKEN` secret (`gh secret set NPM_TOKEN -R pyrlyn/prismax`).
- Disable: disable the `publish` workflow in the Actions tab (or delete the file). Without
  `NPM_TOKEN` the publish step fails and nothing is uploaded.

### Test

- `npm pack --dry-run` lists the exact files that would be published (only `dist/`,
  `README.md` and `package.json`). CI runs it on every pull request.
- A dry run of the whole workflow is not possible without publishing; check `npm pack` output and
  the version/tag rule instead.

## Limitations

- The npm name `prismax` is already taken by another package, so the package is `prisma-x`; the
  CLI command is still `prismax`.
- No `license` field yet: the repository has no LICENSE file. Choose one before the first
  release, otherwise npm shows the package as unlicensed.
- Actions billing problems in the organization block both CI and publishing.
- npm provenance requires a public repository and GitHub-hosted runners.
