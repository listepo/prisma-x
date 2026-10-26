"""Tests for scripts/copy_prisma_tests.py. No network: fetch is replaced by an in-memory tarball."""

from __future__ import annotations

import io
import json
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import copy_prisma_tests as cpt  # noqa: E402

REF = "0123456789abcdef0123456789abcdef01234567"
PREFIX = f"prisma-engines-{REF}"


def make_tarball(files: dict[str, bytes], links: dict[str, str] | None = None) -> bytes:
    """Builds a .tar.gz shaped like a GitHub source tarball."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        directory = tarfile.TarInfo(PREFIX)
        directory.type = tarfile.DIRTYPE
        tar.addfile(directory)
        for name, data in files.items():
            info = tarfile.TarInfo(name if name.startswith(("/", "..")) else f"{PREFIX}/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for name, target in (links or {}).items():
            info = tarfile.TarInfo(f"{PREFIX}/{name}")
            info.type = tarfile.SYMTYPE
            info.linkname = target
            tar.addfile(info)
    return buffer.getvalue()


ARCHIVE = make_tarball(
    {
        "psl/psl/tests/validation/models/a.prisma": b"model A {\n  id Int @id\n}\n",
        "psl/psl/tests/validation/enums/b.prisma": b"enum B {\n  X\n}\n",
        "psl/psl/tests/reformatter/c.prisma": b"model C {}\n",
        "psl/psl/src/lib.rs": b"// not a suite\n",
        "psl/psl/tests/validation/../../escape.prisma": b"nope\n",
        "../outside.prisma": b"nope\n",
        "/absolute.prisma": b"nope\n",
    },
    links={"psl/psl/tests/validation/link.prisma": "/etc/passwd"},
)


class FakeFetch:
    def __init__(self, archive: bytes = ARCHIVE) -> None:
        self.archive = archive
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        return self.archive


class CopyTestsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "tests-reference"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def copy(self, suites=("psl/psl/tests/validation",), fetch=None, ref=REF) -> dict:
        return cpt.copy_tests(ref, suites, self.out, fetch=fetch or FakeFetch(), log=lambda _: None)

    def test_extracts_only_the_selected_suites(self) -> None:
        fetch = FakeFetch()
        manifest = self.copy(fetch=fetch)
        self.assertEqual(fetch.urls, [f"https://codeload.github.com/prisma/prisma-engines/tar.gz/{REF}"])
        files = sorted(p.relative_to(self.out).as_posix() for p in self.out.rglob("*") if p.is_file())
        self.assertEqual(
            files,
            [
                "MANIFEST.json",
                "psl/psl/tests/validation/enums/b.prisma",
                "psl/psl/tests/validation/models/a.prisma",
            ],
        )
        self.assertEqual(
            (self.out / "psl/psl/tests/validation/models/a.prisma").read_text(), "model A {\n  id Int @id\n}\n"
        )
        self.assertEqual(manifest["fileCount"], 2)

    def test_skips_links_and_paths_that_escape(self) -> None:
        self.copy()
        self.assertFalse((self.out / "psl/psl/tests/validation/link.prisma").exists())
        self.assertFalse((self.tmp / "outside.prisma").exists())
        self.assertFalse((self.tmp / "escape.prisma").exists())
        self.assertFalse(any(p.name in ("escape.prisma", "absolute.prisma") for p in self.out.rglob("*")))

    def test_writes_a_manifest(self) -> None:
        self.copy(suites=("psl/psl/tests/validation", "/psl/psl/tests/reformatter/"))
        manifest = json.loads((self.out / "MANIFEST.json").read_text())
        self.assertEqual(
            manifest,
            {
                "repository": "https://github.com/prisma/prisma-engines",
                "ref": REF,
                "suites": ["psl/psl/tests/validation", "psl/psl/tests/reformatter"],
                "fileCount": 3,
                "files": [
                    "psl/psl/tests/reformatter/c.prisma",
                    "psl/psl/tests/validation/enums/b.prisma",
                    "psl/psl/tests/validation/models/a.prisma",
                ],
            },
        )

    def test_replaces_previous_output(self) -> None:
        self.out.mkdir()
        (self.out / "stale.prisma").write_text("old")
        self.copy()
        self.assertFalse((self.out / "stale.prisma").exists())
        self.assertFalse(self.out.with_name("tests-reference.partial").exists())

    def test_missing_suite_raises_and_keeps_previous_output(self) -> None:
        self.out.mkdir()
        (self.out / "keep.prisma").write_text("old")
        with self.assertRaisesRegex(RuntimeError, "suites not found .*psl/psl/tests/nope"):
            self.copy(suites=("psl/psl/tests/validation", "psl/psl/tests/nope"))
        self.assertEqual((self.out / "keep.prisma").read_text(), "old")
        self.assertFalse(self.out.with_name("tests-reference.partial").exists())

    def test_rejects_invalid_refs_and_suites_before_fetching(self) -> None:
        fetch = FakeFetch()
        for ref in ("", "../main", "main?x=1", "-rf", "a b"):
            with self.subTest(ref=ref), self.assertRaises(ValueError):
                self.copy(ref=ref, fetch=fetch)
        for suite in ("../psl", "psl/../..", "/"):
            with self.subTest(suite=suite), self.assertRaises(ValueError):
                self.copy(suites=(suite,), fetch=fetch)
        self.assertEqual(fetch.urls, [])

    def test_accepts_branch_and_tag_refs(self) -> None:
        self.assertEqual(self.copy(ref="release/6.0.x")["ref"], "release/6.0.x")


class SelectMembersTest(unittest.TestCase):
    def test_strips_the_archive_prefix(self) -> None:
        member = tarfile.TarInfo(f"{PREFIX}/psl/psl/tests/validation/x.prisma")
        selected = list(cpt.select_members([member], [PurePosixPath("psl/psl/tests/validation")]))
        self.assertEqual(selected, [(member, PurePosixPath("psl/psl/tests/validation/x.prisma"))])

    def test_matches_whole_path_components(self) -> None:
        member = tarfile.TarInfo(f"{PREFIX}/psl/psl/tests/validation_extra/x.prisma")
        self.assertEqual(list(cpt.select_members([member], [PurePosixPath("psl/psl/tests/validation")])), [])


class DefaultRefTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.package = Path(self._tmp.name) / "package.json"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_reads_the_engine_commit_from_the_wasm_version(self) -> None:
        self.package.write_text(json.dumps({"dependencies": {cpt.WASM_PACKAGE: f"8.1.0-2.{REF}"}}))
        self.assertEqual(cpt.default_ref(self.package), REF)

    def test_falls_back_when_the_version_has_no_commit(self) -> None:
        self.package.write_text(json.dumps({"dependencies": {cpt.WASM_PACKAGE: "^8.0.0"}}))
        self.assertEqual(cpt.default_ref(self.package), cpt.FALLBACK_REF)

    def test_falls_back_when_package_json_is_missing_or_invalid(self) -> None:
        self.assertEqual(cpt.default_ref(self.package), cpt.FALLBACK_REF)
        self.package.write_text("{")
        self.assertEqual(cpt.default_ref(self.package), cpt.FALLBACK_REF)

    def test_matches_the_repository_package_json(self) -> None:
        self.assertRegex(cpt.default_ref(), r"^[0-9a-f]{40}$")


class MainTest(unittest.TestCase):
    def test_returns_0_on_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, redirect_stdout(io.StringIO()):
            out = Path(tmp) / "out"
            code = cpt.main(["--ref", REF, "--out", str(out)], fetch=FakeFetch())
            self.assertEqual(code, 0)
            self.assertTrue((out / "psl/psl/tests/reformatter/c.prisma").exists())

    def test_returns_1_and_reports_errors(self) -> None:
        def failing_fetch(url: str) -> bytes:
            raise OSError("network is unreachable")

        with tempfile.TemporaryDirectory() as tmp:
            stderr = io.StringIO()
            with redirect_stderr(stderr), redirect_stdout(io.StringIO()):
                code = cpt.main(["--ref", REF, "--out", str(Path(tmp) / "out")], fetch=failing_fetch)
            self.assertEqual(code, 1)
            self.assertIn("error: network is unreachable", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
