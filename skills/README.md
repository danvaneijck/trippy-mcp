# Agent skills

Skills published from this repo, in the layout
[InjectiveLabs/agent-skills](https://github.com/InjectiveLabs/agent-skills)
expects (one directory per skill, each with `SKILL.md`, `LICENSE` and
`TERMS_OF_USE`).

| Skill | What it teaches |
|---|---|
| [`injective-memecoin-trading`](./injective-memecoin-trading/SKILL.md) | Launching and trading memecoins on Injective with `trippy-mcp`: bonding curves, aggregator swaps, the spend policy, and how the surface splits against the Injective MCP server |

## Using it now

Skills can be installed straight from this repo, no upstream merge needed:

```bash
npx skills add danvaneijck/trippy-mcp --skill injective-memecoin-trading
```

## Submitting upstream

`ainj install` pulls skills from `InjectiveLabs/agent-skills`, pinned by
`skillsRef` in that package's `ainj.config.json` — so a merged skill reaches
every `ainj` user, and the pin means a merge is not live until they bump it.

To open the PR:

```bash
git clone https://github.com/InjectiveLabs/agent-skills
cp -r skills/injective-memecoin-trading agent-skills/skills/
# add the entry to agent-skills/README.md, then branch, commit, PR
```

Keep this copy as the source of truth and re-sync on change, so the skill's
gotchas stay in step with the server that produces them.
