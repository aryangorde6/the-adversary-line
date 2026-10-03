# The Adversary Line — a dark software factory

Entry for the WeAreDevelopers × BAND **Dark Factory** hackathon, **tablekeeper** track.

**Team:** Aryan Gorde (solo).

Five coding-agent seats in Band Desktop took one dispatch and built a restaurant reservation service in stages, each a complete container. One later human message relayed a verdict that our own message filter had held back from the room; [`FACTORY.md`](FACTORY.md) discloses it with the fix, and nothing else came from a person. One seat's only job is to attack the checker. The whole factory runs on free models that need no key.

## How to read this repository

| Path | What it is |
|---|---|
| [`FACTORY.md`](FACTORY.md) | The factory: seats, who talks to whom, design choices and their cost, measured time and spend, how it catches bad work, what failed, how to stand it up |
| [`mandates/`](mandates/) | One standing instruction file per seat. Nothing in them names this problem |
| [`room.json`](room.json) | The Band room the factory worked in — the full, unedited session download |
| `stage-1/`, `stage-2/` | The service at each stage the run reached (2 of 4). Each folder builds and serves on its own: see *Try a stage* below |
| `verification/` | The Adversary's requirements ledger and probes, the Finisher's screenshots, the Saboteur's defect reports |
| `bin/` | The seat launcher and the tools used to measure the run |

Every commit in the history is a seat's own: each seat commits under its name (`Builder <builder@factory.invalid>`, and so on), and its room message names the commit. The one exception is the last commit, made by hand after the run: it adds this README, the license and the factory's own files (`FACTORY.md`, `mandates/`, `bin/`, `dispatch/`) and `room.json`.

## Try a stage

```sh
cd stage-2
docker build -t tablekeeper . && docker run --rm -p 8080:8080 tablekeeper
curl -s localhost:8080/health
```

Every stage folder follows the same contract: build its `Dockerfile`, run with `-e PORT=<port>`, no network at run time. The event's harness builds each folder the same way.

**One thing the seats left wrong: a run file.** `stage-2/RUN.md` is stage 1's file, copied and never updated, so its commands `cd stage-1` and build stage 1. The checker reported it in its first stage-2 verdict and again before the stage was handed on; no seat fixed it, and we left the seats' files as they made them. From inside any stage folder, the `docker` line above builds and serves that stage.

## Results

The event's harness, `--all --mode isolated`, on a fresh clone (how the entry is graded):

| Stage | Claimed | Shipped checks passed |
|---|---|---|
| 1 | yes | 120 / 120 |
| 2 | yes | 145 / 145 (stage 1: 120 / 120, stage 2: 25 / 25) |

**Stage reached: 2 of 4.** The shipped checks are a sample; the graded suites are larger.

Who checks the checker — the Saboteur's committed tables:

| Stage | Candidate | Defects planted | Caught by the shipped checks | Caught by the Adversary's probes |
|---|---|---|---|---|
| 1 | `aa4382f` | 22 | 14 | 17 |

Not counted: `verification/sabotage/9aa1431.md` — its supplied-checks column ran the Builder's own suite, not the event's checks, and only the Adversary's API probes ran.

- **Human input:** 2 messages in the room — the dispatch at 2026-10-01 09:07 UTC, and a relay of a verdict our filter held back (06:45 UTC on 2 Oct).
- **Time:** 25.8 hours from the dispatch to the Foreman's final report (2026-10-02 10:54 UTC); the factory was down for 12.6 h of it (2.5 h while the host restarted; 10.1 h after the network dropped overnight).
- **Model spend:** 3,345 turns; 17.1 M fresh input, 251.5 M cached input, 1.00 M output tokens; **$0.00** — free models only. Per seat in `FACTORY.md`.
- **After the run:** the room log's last four entries (2026-10-02 14:39 UTC, Adversary, Builder, Finisher and Saboteur "left the conversation") are ours, not the band's: `bin/end-run` removed the seats 3 h 45 min after the final report, so that starting them again for a later run could not pull them back into this room. Nothing else was posted after 10:56 UTC.

## License

MIT — see [`LICENSE`](LICENSE).
