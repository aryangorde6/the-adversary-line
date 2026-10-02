# verification/

Everything in this directory is mine (@aryangorde6/adversary). No other seat writes here, and
nothing here is product code: I never edit the implementation, I only read it and test it.

- `ledger-stage-1.md` — one row per testable sentence of
  `/home/aryan/band_hack/dark-factory-wearedevs/tablekeeper/spec/stage-1.md`, written before any
  code existed. 164 rows, each with the requirement quoted verbatim and the probe that decides it.
  Rebuilt for stages 2–4 from their own spec files when those stages are reported.
- `ledger-stage-2.md` — the same construction from `spec/stage-2.md`: 132 rows, written from the
  specification text after the stage-2 tree already existed. Its header records that difference
  and what it costs; the stage-1 ledger is not widened for stage-2 semantics.
- `sabotage-triage-*.md` — my triage of mutants my probes missed, written **here in
  `verification/`** and never inside `sabotage/`, which belongs to @aryangorde6/saboteur.
- `probes/` — the probe scripts. Each one is named by the group it serves, prints
  `PASS <row-id>` or `FAIL <row-id>: expected … got …`, and exits non-zero if anything failed.
  They are built from the specification text and use only `docker`, `curl`, `node` and `jq`.
- `results/` — one file per reported commit, listing the command, the row ids decided and the
  verdict.
- `sabotage/` — owned by @aryangorde6/saboteur. I read the reports; I do not write there.

## Standing rules for a verification run

1. Clone the reported commit into `/tmp/check-<commit>` and check it out there. Never check out
   anything in the result repository: five seats share that one folder.
2. Build and start the service exactly as `RUN.md` says. If that fails, the verdict is BLOCKED
   before any row is looked at.
3. Run the supplied checks first, through the command I was given, reading only their output.
4. Then run every probe. Every ledger row must be decided by a probe that was actually run.
5. Read the code afterwards for special cases that satisfy a check rather than the requirement.
6. Stop every container and process I started, before the turn ends.

## Supplied checks

I never open, read or copy the harness check files. They are run only through the command the room
owner gave, with a fresh output directory number every time:

```sh
cd /home/aryan/band_hack/dark-factory-wearedevs && .venv/bin/python -m harness run \
  --track tablekeeper --repo /home/aryan/band_hack/band-work/tablekeeper \
  --stage 1 --out /home/aryan/band_hack/band-work/checks/tablekeeper/s1-<new number>
```

Acceptance runs the same command with `--mode isolated`. For stage 1 a failing suite 2 is expected
and correct. Only the command's own output and failure messages are read; the probes are written
from the specification text, never from a check's internals.

For stage 2 the same command with `--stage 2` and a fresh `s2-<new number>` directory decides the
supplied half of `ledger-stage-2.md`; the second suite is expected to cover the browser, and a
stage-2 failure there is a result to read, not noise to skip.

A stage-1 verdict is PASS only when the clean build starts, the supplied checks pass and all 164
stage-1 rows hold. A stage-2 verdict is PASS only when the same holds for its 132 rows. Anything
else is BLOCKED, listing each failing row with the requirement, the command, what was expected and
what happened. A BLOCKED verdict stands until a new commit is reported.
