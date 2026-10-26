# Reference tests

The parser is checked against Prisma's own, language-independent schema test suites, so the
behavior asserted here is the engine's, not our guess.

## How it works

1. `scripts/copy_prisma_tests.py` downloads the `prisma/prisma-engines` source tarball at a pinned
   ref and extracts selected suites into `tests-reference/`. The default suites are
   `psl/psl/tests/validation` and `psl/psl/tests/reformatter`: `.prisma` inputs with the expected
   diagnostics in trailing comments. It writes a `MANIFEST.json` listing the repository, ref,
   suites and files.
   - The default ref is the commit that the pinned `@prisma/prisma-schema-wasm` build was
     compiled from: the 40-hex suffix of its version in `package.json`
     (`8.1.0-2.59be4fda12412a79eeb9c2ae727b6aa723593323`). The fixtures therefore match the engine
     under test.
   - It needs only the Python 3.9+ standard library.
   - Only regular files under the requested suites are extracted. Links, absolute paths and
     `..` are skipped.
   - Output is staged in `tests-reference.partial/` and swapped in only on success, so a failed
     download keeps the previous copy.
2. `tests-reference/` is reference material, not a test suite. It is gitignored, excluded from
   `tsconfig.json`/`tsconfig.build.json`, and excluded from vitest (`vitest.config.ts`).
3. Selected cases are ported by hand to `test/reference/*.test.ts` as behavioral tests with the
   schema inlined. They need neither the network nor `tests-reference/`. Each case cites its
   upstream path, and failures print the upstream URL at the pinned ref. A test checks that the
   pinned ref still matches the wasm version in `package.json`.

Ported so far (`test/reference/validation.test.ts`):

- `relations/set_null_is_not_valid_on_required_fields.prisma`
- `relations/set_null_still_valid_on_optional_fields.prisma`
- `attributes/map/map_must_error_for_relation_fields.prisma`
- `attributes/map/duplicate_models_with_map_on_both_sides.prisma`
- `models/field_with_same_map_should_not_error.prisma`
- `models/field_with_non_ascii_ident_should_not_error.prisma`
- `enums/value_with_non_ascii_ident_should_not_error.prisma`
- `attributes/uuid/require_string_column.prisma`
- `attributes/cuid/reject_random_int.prisma`
- `attributes/index/unknown_field.prisma`
- `mysql/set_default_warning.prisma`

Each case asserts validity, then every diagnostic's severity, 1-based line and message, in
engine order.

## Enabling and disabling

- **Refresh the reference copy** (network needed):
  ```sh
  python3 scripts/copy_prisma_tests.py                      # default ref and suites
  python3 scripts/copy_prisma_tests.py --ref <sha|tag> --suite psl/psl/tests/validation --out tests-reference
  ```
- **Port a case:**
  1. Copy the schema and the expected messages into `test/reference/`.
  2. Keep the upstream path.
  3. Run the test against the engine.
- **Disable:** the ported tests are part of `pnpm test`. To skip them, run
  `pnpm vitest run --exclude 'test/reference/**'`. Nothing reads `tests-reference/` during tests,
  so it can be deleted at any time.
- **When bumping the wasm package:**
  1. Refetch the suites; the new default ref follows `package.json`.
  2. Update `REF` in `test/reference/validation.test.ts`.
  3. Re-check the ported cases against the new upstream files.

## Testing

```sh
pnpm vitest run test/reference                 # ported behavioral tests (no network)
pnpm test:py                                   # pytest for scripts/ (no network)
python3 -m unittest discover -s scripts/tests  # the same tests without pytest
```

`scripts/tests/` covers both Python scripts with fakes (no network, no cargo or node needed):

- `copy_prisma_tests.py`, using an in-memory tarball as the fake fetch:
  - suite selection
  - links and path traversal skipped
  - manifest contents
  - replacing previous output, and keeping it when a suite is missing
  - ref and suite validation
  - reading the default ref
  - `main` exit codes
- `compile_check_diesel.py`:
  - provider detection and fixture grouping
  - `Cargo.toml` and `lib.rs`
  - the cargo environment (`CARGO_TARGET_DIR`, MySQL placeholder)
  - project creation
  - skipping without cargo, and failure reporting

## Limitations

- Ports are manual. The upstream expectation format (rendered diagnostics in comments) is not
  parsed automatically, so most upstream cases are not run.
- Only cases that make sense for a single-file schema and the parser's public API are ported.
  Reformatter suites are fetched for reference, but formatting is not part of the API.
- `test:py` needs `pytest`; the tests are `unittest`-based, so the standard library runner works
  too.
