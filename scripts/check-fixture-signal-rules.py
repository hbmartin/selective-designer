"""Exercise the real Semgrep engine on inert syntax examples, never process calls."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
cases = json.loads((root / "tests/architecture/fixture-signaling-cases.json").read_text())
rule_ids = {"fixture-signaling-requires-verified-helper", "fixture-kill-spy-requires-persistent-replacement"}
with tempfile.TemporaryDirectory(prefix="fixture-signal-rules-") as temporary:
    (Path(temporary) / ".semgrepignore").write_text((root / ".semgrepignore").read_text())
    configuration = Path(temporary) / ".semgrep.yml"
    configuration.write_text((root / ".semgrep.yml").read_text())
    directory = Path(temporary) / "tests/security"
    directory.mkdir(parents=True)
    for index, case in enumerate(cases):
        (directory / f"case-{index}.js").write_text(case["source"] + "\n")
    targets = [str(path.relative_to(temporary)) for path in sorted(directory.glob("*.js"))]
    result = subprocess.run(
        ["semgrep", "scan", "--config", str(configuration), "--json", "--quiet",
         "--metrics=off", "--no-git-ignore", *targets],
        cwd=temporary, capture_output=True, text=True, check=False,
    )
    if result.returncode:
        sys.exit(result.stderr or "Semgrep fixture regression scan failed")
    report = json.loads(result.stdout)
    if report.get("errors"):
        sys.exit("Semgrep could not parse all fixture regression examples")
    failed = []
    for index, case in enumerate(cases):
        actual = {finding["check_id"].split(".")[-1] for finding in report["results"] if Path(finding["path"]).name == f"case-{index}.js"} & rule_ids
        if actual != set(case["rules"]):
            failed.append({"case": index, "expected": case["rules"], "actual": sorted(actual)})
    if failed:
        sys.exit(json.dumps(failed, indent=2))
print(f"Semgrep fixture syntax regressions passed ({len(cases)} examples)")
