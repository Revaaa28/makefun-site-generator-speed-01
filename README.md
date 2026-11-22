# makefun-site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Revaaa28/makefun-site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Revaaa28/makefun-site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: `solve.js` is a single dependency-free ES module whose `run(input)` returns, for every input, exactly the output tree makefun-site 1.0.0's build returns — the same front matter, Markdown, template dialect, slug rule, link resolution and build report, byte for byte — reimplemented for low CPU time (char-code dispatch instead of per-line regexes, single-pass scanners, plain-run batching in the inline renderer, cached slug and date computations, per-source link-resolution caching). `main.ts` is the house driver: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`. Verified byte-for-byte identical to the reference on the kit's practice set and on over a hundred fresh cases drawn with the kit's own generator, and measured at roughly 3x the reference's speed on the build itself.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=25wtkm1p&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
