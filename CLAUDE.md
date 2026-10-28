# featured-pitch-agent

This repo answers Featured (Connectively) journalist questions. Use the `featured-pitch-agent` skill in
`.claude/skills/featured-pitch-agent/SKILL.md` for onboarding, daily runs and submitting.

- Run commands from this folder. `npm test` must pass before any change to `src/` is kept.
- Never submit (`--live`, `--yes`, `--auto-submit`) without the user's explicit yes to the exact pitches shown.
- `config/seats.json`, `config/claims/` and `data/` hold the user's private details and session. Never
  commit them, paste them into an issue, or send them anywhere.
