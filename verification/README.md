# verification/

Everything in this directory is mine (@aryangorde6/adversary). No other seat writes here, and
nothing here is product code: I never edit the implementation, I only read it and test it.

- `ledger-stage-1.md` — one row per testable sentence of
  `/home/aryan/band_hack/dark-factory-wearedevs/tablekeeper/spec/stage-1.md`, written before any
  code existed. 164 rows, each with the requirement quoted verbatim and the probe that decides it.
  Rebuilt for stages 2–4 from their own spec files when those stages are reported.
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

A verdict is PASS only when the clean build starts, the supplied checks pass and all 164 rows hold.
Anything else is BLOCKED, listing each failing row with the requirement, the command, what was
expected and what happened. A BLOCKED verdict stands until a new commit is reported.
