"""Tests for scripts/check_sqlalchemy_models.py.

The checks against real SQLAlchemy are skipped when it is not installed; the
end-to-end run over test/fixtures also needs node and a built dist/cli.js.
"""

from __future__ import annotations

import importlib.util
import io
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_sqlalchemy_models as csm  # noqa: E402

HAS_SQLALCHEMY = importlib.util.find_spec("sqlalchemy") is not None and csm.sqlalchemy_version() is not None
NEEDS_SQLALCHEMY = unittest.skipUnless(HAS_SQLALCHEMY, "SQLAlchemy 2.x is not installed")

HEADER = """from __future__ import annotations
from typing import Optional
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass
"""

VALID = HEADER + """

class Parent(Base):
    __tablename__ = "parent"
    id: Mapped[int] = mapped_column(sa.Integer(), primary_key=True)
    children: Mapped[list[Child]] = relationship(back_populates="parent")


class Child(Base):
    __tablename__ = "child"
    id: Mapped[int] = mapped_column(sa.Integer(), primary_key=True)
    parent_id: Mapped[Optional[int]] = mapped_column(sa.ForeignKey("parent.id", name="child_parent_id_fkey"))
    parent: Mapped[Optional[Parent]] = relationship(back_populates="children")
"""

# Two relationships write the same foreign key without back_populates: SQLAlchemy only warns.
OVERLAPPING = VALID.replace(
    '    parent: Mapped[Optional[Parent]] = relationship(back_populates="children")',
    "    parent: Mapped[Optional[Parent]] = relationship()",
).replace('relationship(back_populates="parent")', "relationship()")

BROKEN = VALID.replace("list[Child]", "list[Missing]")

POSTGRES_ONLY = HEADER + """

class Sample(Base):
    __tablename__ = "sample"
    id: Mapped[int] = mapped_column(sa.Integer(), primary_key=True)
    tags: Mapped[list[str]] = mapped_column(postgresql.ARRAY(sa.Text()))
"""


class FakeRun:
    """Stands in for the prismax CLI: writes `models` as models.py."""

    def __init__(self, models: str = VALID, code: int = 0) -> None:
        self.models = models
        self.code = code
        self.calls: list[list[str]] = []

    def __call__(self, command, **kwargs) -> subprocess.CompletedProcess:
        self.calls.append(list(command))
        out = Path(command[command.index("--out") + 1])
        (out / "models.py").write_text(self.models)
        return subprocess.CompletedProcess(command, self.code, "", "boom" if self.code else "")


def which_all(name: str) -> str:
    return f"/usr/bin/{name}"


class HelpersTest(unittest.TestCase):
    def test_module_name(self) -> None:
        self.assertEqual(csm.module_name(Path("test/fixtures/Many-To-Many.prisma")), "prismax_check_many_to_many")

    def test_generate_runs_the_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run = FakeRun()
            path = csm.generate(Path("a.prisma"), Path(tmp), run, "node")
            self.assertEqual(path, Path(tmp) / "models.py")
            self.assertEqual(run.calls[0][2:], ["generate", "--adapter", "sqlalchemy", "--schema", "a.prisma", "--out", tmp])

    def test_generate_raises_when_the_cli_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, "prismax failed \\(exit 1\\):\nboom"):
                csm.generate(Path("a.prisma"), Path(tmp), FakeRun(code=1), "node")


@NEEDS_SQLALCHEMY
class CheckModuleTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def check(self, source: str, provider: str):
        path = self.dir / "models.py"
        path.write_text(source)
        return csm.check_module(path, "prismax_check_test", provider)

    def test_valid_models_create_and_query_on_sqlite(self) -> None:
        self.assertEqual(self.check(VALID, "sqlite"), ["create_all and 4 queries run on SQLite"])

    def test_compiles_with_the_fixture_dialect(self) -> None:
        notes = self.check(VALID, "mysql")
        self.assertEqual(notes[1], "2 DDL statements and 4 queries compile for mysql")

    def test_falls_back_to_the_fixture_dialect_when_sqlite_cannot_create(self) -> None:
        notes = self.check(POSTGRES_ONLY, "postgresql")
        self.assertRegex(notes[0], "^create_all on SQLite failed: CompileError: .*ARRAY")
        self.assertNotIn(" at 0x", notes[0])
        self.assertEqual(notes[1], "1 DDL statements and 1 queries compile for postgresql")

    def test_sqlite_fixtures_must_create_on_sqlite(self) -> None:
        import sqlalchemy as sa

        with self.assertRaises(sa.exc.CompileError):
            self.check(POSTGRES_ONLY, "sqlite")

    def test_reports_unresolvable_relationships(self) -> None:
        import sqlalchemy as sa

        with self.assertRaises(sa.exc.InvalidRequestError):
            self.check(BROKEN, "sqlite")

    def test_treats_sqlalchemy_warnings_as_errors(self) -> None:
        import sqlalchemy as sa

        with self.assertRaises(sa.exc.SAWarning):
            self.check(OVERLAPPING, "sqlite")

    def test_clears_mappers_between_modules(self) -> None:
        with self.assertRaises(Exception):
            self.check(BROKEN, "sqlite")
        self.assertEqual(self.check(VALID, "sqlite"), ["create_all and 4 queries run on SQLite"])
        self.assertNotIn("prismax_check_test", sys.modules)


class MainTest(unittest.TestCase):
    def main(self, argv, which=which_all, run=None) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = csm.main(argv, which=which, run=run or FakeRun())
        return code, stdout.getvalue(), stderr.getvalue()

    def fixture(self, root: Path, provider: str = "sqlite") -> Path:
        path = root / "a.prisma"
        path.write_text(f'datasource db {{\n  provider = "{provider}"\n}}\n')
        return path

    def test_skips_without_sqlalchemy(self) -> None:
        original = csm.sqlalchemy_version
        csm.sqlalchemy_version = lambda: None
        try:
            run = FakeRun()
            code, stdout, _ = self.main([], run=run)
        finally:
            csm.sqlalchemy_version = original
        self.assertEqual(code, 0)
        self.assertIn("SQLAlchemy 2.x not installed; skipping", stdout)
        self.assertEqual(run.calls, [])

    @NEEDS_SQLALCHEMY
    def test_fails_without_node(self) -> None:
        code, _, stderr = self.main([], which=lambda name: None)
        self.assertEqual(code, 1)
        self.assertIn("node not found", stderr)

    @NEEDS_SQLALCHEMY
    def test_reports_each_fixture(self) -> None:
        if not csm.CLI.exists():
            self.skipTest("dist/cli.js is not built")
        with tempfile.TemporaryDirectory() as tmp:
            fixture = self.fixture(Path(tmp))
            code, stdout, _ = self.main([str(fixture), "--workdir", str(Path(tmp) / "work")])
            self.assertEqual(code, 0, stdout)
            self.assertIn("ok   a.prisma\n     create_all and 4 queries run on SQLite", stdout)
            self.assertTrue((Path(tmp) / "work/prismax_check_a/models.py").exists())

    @NEEDS_SQLALCHEMY
    def test_reports_failures(self) -> None:
        if not csm.CLI.exists():
            self.skipTest("dist/cli.js is not built")
        with tempfile.TemporaryDirectory() as tmp:
            code, _, stderr = self.main([str(self.fixture(Path(tmp)))], run=FakeRun(BROKEN))
            self.assertEqual(code, 1)
            self.assertIn("FAIL a.prisma", stderr)
            self.assertIn("FAILED: a.prisma", stderr)

    @NEEDS_SQLALCHEMY
    def test_skips_mongodb(self) -> None:
        if not csm.CLI.exists():
            self.skipTest("dist/cli.js is not built")
        with tempfile.TemporaryDirectory() as tmp:
            run = FakeRun()
            code, stdout, _ = self.main([str(self.fixture(Path(tmp), "mongodb"))], run=run)
            self.assertEqual(code, 0)
            self.assertIn("skip a.prisma: provider 'mongodb'", stdout)
            self.assertEqual(run.calls, [])


@NEEDS_SQLALCHEMY
@unittest.skipUnless(csm.CLI.exists() and shutil.which("node"), "needs node and a built dist/cli.js (pnpm build)")
class FixturesTest(unittest.TestCase):
    def test_generated_models_for_every_fixture_pass(self) -> None:
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = csm.main([])
        self.assertEqual(code, 0, stderr.getvalue())
        for fixture in sorted(csm.FIXTURES.glob("*.prisma")):
            self.assertIn(f"ok   {fixture.name}", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
