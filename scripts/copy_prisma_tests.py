#!/usr/bin/env python3
"""Fetch language-independent Prisma test suites into tests-reference/.

Downloads the prisma/prisma-engines source tarball at a pinned ref and extracts
only the selected suites (Prisma schema fixtures and their expectations), e.g.
psl/psl/tests/validation. Nothing here runs in the regular test suites: the
output directory is gitignored and excluded from the TypeScript build and from
vitest. Selected cases are ported by hand to test/reference/.

The default ref is the prisma-engines commit that the pinned
@prisma/prisma-schema-wasm build was compiled from (the hash suffix of its
version in package.json), so the fixtures match the engine under test.

Python 3.9+, standard library only.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable, Optional

REPO = "prisma/prisma-engines"
WASM_PACKAGE = "@prisma/prisma-schema-wasm"
# Used only when package.json cannot be read.
FALLBACK_REF = "59be4fda12412a79eeb9c2ae727b6aa723593323"
# Suites made of .prisma inputs with expectations, independent of Rust code.
DEFAULT_SUITES = (
    "psl/psl/tests/validation",
    "psl/psl/tests/reformatter",
)
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "tests-reference"
MANIFEST = "MANIFEST.json"
USER_AGENT = "prisma-x-copy-prisma-tests"

Fetch = Callable[[str], bytes]


def default_ref(package_json: Path = ROOT / "package.json") -> str:
    """Returns the prisma-engines commit encoded in the wasm package version."""
    try:
        data = json.loads(package_json.read_text(encoding="utf-8"))
        version = data["dependencies"][WASM_PACKAGE]
    except (OSError, ValueError, KeyError, TypeError):
        return FALLBACK_REF
    match = re.search(r"([0-9a-f]{40})$", version)
    return match.group(1) if match else FALLBACK_REF


def tarball_url(ref: str) -> str:
    return f"https://codeload.github.com/{REPO}/tar.gz/{ref}"


def http_fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:  # noqa: S310 (fixed https URL)
        return response.read()


def normalize_suite(suite: str) -> PurePosixPath:
    path = PurePosixPath(suite.strip("/"))
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"invalid suite path: {suite!r}")
    return path


def select_members(
    members: Iterable[tarfile.TarInfo], suites: Iterable[PurePosixPath]
) -> Iterable[tuple[tarfile.TarInfo, PurePosixPath]]:
    """Yields regular files under one of the suites, with their repo-relative path.

    The first path component of a GitHub tarball is "<repo>-<ref>/" and is dropped.
    Links and anything that would escape the output directory are skipped.
    """
    suites = list(suites)
    for member in members:
        if not member.isfile():
            continue
        parts = PurePosixPath(member.name).parts
        if len(parts) < 2 or any(p in ("..", "") for p in parts) or member.name.startswith("/"):
            continue
        relative = PurePosixPath(*parts[1:])
        if any(relative.parts[: len(s.parts)] == s.parts for s in suites):
            yield member, relative


def extract(archive: bytes, suites: Iterable[PurePosixPath], dest: Path) -> list[str]:
    """Extracts the selected suites from a .tar.gz archive into dest. Returns file paths."""
    written: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member, relative in select_members(tar, suites):
            source = tar.extractfile(member)
            if source is None:
                continue
            target = dest.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())
            written.append(relative.as_posix())
    return sorted(written)


def copy_tests(
    ref: str,
    suites: Iterable[str],
    out: Path,
    fetch: Fetch = http_fetch,
    log: Callable[[str], None] = print,
) -> dict:
    """Downloads `ref`, replaces `out` with the selected suites and writes a manifest."""
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._/-]*", ref) or ".." in ref:
        raise ValueError(f"invalid ref: {ref!r}")
    suite_paths = [normalize_suite(s) for s in suites]
    url = tarball_url(ref)
    log(f"Downloading {url}")
    archive = fetch(url)

    staging = out.with_name(out.name + ".partial")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        files = extract(archive, suite_paths, staging)
        missing = [s.as_posix() for s in suite_paths if not any(f.startswith(s.as_posix() + "/") for f in files)]
        if missing:
            raise RuntimeError(f"suites not found at {ref}: {', '.join(missing)}")
        manifest = {
            "repository": f"https://github.com/{REPO}",
            "ref": ref,
            "suites": [s.as_posix() for s in suite_paths],
            "fileCount": len(files),
            "files": files,
        }
        (staging / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        if out.exists():
            shutil.rmtree(out)
        staging.rename(out)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    log(f"Wrote {len(files)} files to {out}")
    return manifest


def main(argv: Optional[list[str]] = None, fetch: Fetch = http_fetch) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ref", default=default_ref(), help="prisma-engines git ref (default: %(default)s)")
    parser.add_argument(
        "--suite",
        action="append",
        dest="suites",
        help=f"repo-relative directory to copy; repeatable (default: {', '.join(DEFAULT_SUITES)})",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory (default: tests-reference/)")
    args = parser.parse_args(argv)
    try:
        copy_tests(args.ref, args.suites or DEFAULT_SUITES, args.out, fetch=fetch)
    except Exception as error:  # report any failure as a message and exit code
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
