#!/usr/bin/env python3
"""Check the SQLAlchemy models generated for the test fixtures with real SQLAlchemy.

For every fixture (default: test/fixtures/*.prisma), this generates models.py
through the prismax CLI (dist/cli.js, so run `pnpm build` first) into a
temporary directory, imports it, and runs:

1. `sqlalchemy.orm.configure_mappers()`, which resolves every annotation,
   relationship, foreign key and join condition (SQLAlchemy warnings are
   treated as errors);
2. `Base.metadata.create_all()` on an in-memory SQLite database, then a
   SELECT per mapped class and a SELECT ... JOIN per relationship;
3. for fixtures whose provider is not SQLite, `CREATE TABLE` / `CREATE INDEX`
   and the same queries compiled with the provider's own dialect (PostgreSQL,
   MySQL, SQL Server). create_all on SQLite may fail for those fixtures on
   dialect-specific types or schemas; that is reported as a note, not a
   failure, when everything compiles with the fixture's dialect.

Each fixture's mappers are cleared before the next one is imported. Exits 0
with a message when SQLAlchemy 2.x is not installed. Python 3.9+.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from types import ModuleType
from typing import Callable, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compile_check_diesel import detect_provider  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "dist" / "cli.js"
FIXTURES = ROOT / "test" / "fixtures"

# SQLAlchemy dialect module per Prisma provider; other providers compile with SQLite only.
DIALECTS = {"postgresql": "postgresql", "cockroachdb": "postgresql", "mysql": "mysql", "sqlserver": "mssql"}

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


def sqlalchemy_version() -> Optional[str]:
    """The installed SQLAlchemy 2.x version, or None."""
    try:
        import sqlalchemy
    except ImportError:
        return None
    version = sqlalchemy.__version__
    return version if version.split(".")[0] == "2" else None


def module_name(fixture: Path) -> str:
    """A unique Python module name for a fixture file."""
    return "prismax_check_" + "".join(c if c.isalnum() else "_" for c in fixture.stem).lower()


def generate(fixture: Path, out: Path, run: Runner, node: str) -> Path:
    """Runs the CLI for one fixture and returns the path of models.py."""
    command = [node, str(CLI), "generate", "--adapter", "sqlalchemy", "--schema", str(fixture), "--out", str(out)]
    result = run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"prismax failed (exit {result.returncode}):\n{result.stderr}")
    return out / "models.py"


def load_module(path: Path, name: str) -> ModuleType:
    """Imports a file as module `name`. It stays in sys.modules: SQLAlchemy resolves annotations there."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def compile_ddl(metadata, dialect_name: str) -> list[str]:
    """CREATE TABLE and CREATE INDEX statements for `metadata`, compiled with a dialect module."""
    import importlib

    from sqlalchemy.schema import CreateIndex, CreateTable

    dialect = importlib.import_module(f"sqlalchemy.dialects.{dialect_name}").dialect()
    statements = []
    for table in metadata.sorted_tables:
        statements.append(str(CreateTable(table).compile(dialect=dialect)))
        statements.extend(str(CreateIndex(index).compile(dialect=dialect)) for index in table.indexes)
    return statements


def relationship_queries(base) -> list:
    """A SELECT per mapped class and a SELECT ... JOIN per relationship."""
    import sqlalchemy as sa
    from sqlalchemy import orm

    queries = []
    for mapper in sorted(base.registry.mappers, key=lambda m: m.class_.__name__):
        cls = mapper.class_
        queries.append(sa.select(cls))
        for rel in mapper.relationships:
            # Aliased, so self-relations join a second copy of the table.
            queries.append(sa.select(cls).join(getattr(cls, rel.key).of_type(orm.aliased(rel.mapper))))
    return queries


def check_module(path: Path, name: str, provider: Optional[str]) -> list[str]:
    """Imports generated models and checks them. Returns notes; raises on failure."""
    import importlib
    import warnings

    import sqlalchemy as sa
    from sqlalchemy import orm

    notes = []
    with warnings.catch_warnings():
        # Overlapping relationships, unresolvable defaults and similar mapping problems are only warnings.
        warnings.simplefilter("error", sa.exc.SAWarning)
        module = load_module(path, name)
        try:
            base = getattr(module, "Base", None)
            if base is None:
                raise AssertionError("models.py defines no Base")
            orm.configure_mappers()
            queries = relationship_queries(base)
            engine = sa.create_engine("sqlite://")
            try:
                try:
                    base.metadata.create_all(engine)
                except sa.exc.SQLAlchemyError as error:
                    if provider == "sqlite" or provider not in DIALECTS:
                        raise
                    reason = re.sub(r" object at 0x[0-9a-f]+", "", str(error).splitlines()[0])
                    notes.append(f"create_all on SQLite failed: {type(error).__name__}: {reason}")
                else:
                    with orm.Session(engine) as session:
                        for query in queries:
                            session.execute(query).all()
                    notes.append(f"create_all and {len(queries)} queries run on SQLite")
            finally:
                engine.dispose()
            if provider in DIALECTS:
                dialect = importlib.import_module(f"sqlalchemy.dialects.{DIALECTS[provider]}").dialect()
                statements = compile_ddl(base.metadata, DIALECTS[provider])
                for query in queries:
                    query.compile(dialect=dialect)
                notes.append(f"{len(statements)} DDL statements and {len(queries)} queries compile for {DIALECTS[provider]}")
            return notes
        finally:
            orm.clear_mappers()
            sys.modules.pop(name, None)


def main(
    argv: Optional[Sequence[str]] = None,
    which: Callable[[str], Optional[str]] = shutil.which,
    run: Runner = subprocess.run,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("fixtures", nargs="*", type=Path, help="schemas to check (default: test/fixtures/*.prisma)")
    parser.add_argument("--workdir", type=Path, help="keep the generated models in this directory")
    args = parser.parse_args(argv)

    version = sqlalchemy_version()
    if version is None:
        print("SQLAlchemy 2.x not installed; skipping the SQLAlchemy check")
        return 0
    node = which("node")
    if node is None:
        print("error: node not found", file=sys.stderr)
        return 1
    if not CLI.exists():
        print(f"error: {CLI.relative_to(ROOT)} is missing; run `pnpm build` first", file=sys.stderr)
        return 1

    fixtures = sorted(args.fixtures or FIXTURES.glob("*.prisma"))
    workdir = args.workdir or Path(tempfile.mkdtemp(prefix="prismax-sqlalchemy-"))
    print(f"SQLAlchemy {version}; work directory: {workdir}")
    failures = []
    try:
        for fixture in fixtures:
            provider = detect_provider(fixture.read_text(encoding="utf-8"))
            if provider == "mongodb":
                print(f"skip {fixture.name}: provider 'mongodb' has no SQLAlchemy output")
                continue
            name = module_name(fixture)
            out = workdir / name
            out.mkdir(parents=True, exist_ok=True)
            try:
                notes = check_module(generate(fixture, out, run, node), name, provider)
            except Exception:  # noqa: BLE001 - report every fixture
                print(f"FAIL {fixture.name}\n{traceback.format_exc(limit=-3)}", file=sys.stderr)
                failures.append(fixture.name)
                continue
            print(f"ok   {fixture.name}" + "".join(f"\n     {note}" for note in notes))
    finally:
        if args.workdir is None:
            shutil.rmtree(workdir, ignore_errors=True)

    if failures:
        print(f"FAILED: {', '.join(failures)}", file=sys.stderr)
        return 1
    print("OK: generated SQLAlchemy models configure and create")
    return 0


if __name__ == "__main__":
    sys.exit(main())
