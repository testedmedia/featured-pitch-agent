# featured-pitch-agent

An agent that answers journalist questions on [Featured](https://featured.com) (now Connectively) for you.
It reads every open question, picks the ones that fit your expertise, drafts a quote in your voice, has a
separate model call grade the draft, and only lets through pitches that pass. You review them on a
local page and approve what goes out.

It runs on [Claude Code](https://claude.com/claude-code). Open Claude Code in this folder and say
"set up Featured" the first time, then "run Featured" each day. Everything also works from the command line.

## How it flows

```
 1. SCAN        every open question on /experts/questions, all pages
 2. CLASSIFY    an LLM maps each question to your expert profiles: strong fit, stretch fit, or skip
 3. FILTER      your DA range, then a live page check drops questions you already answered or that closed
 4. RANK        one profile per question, ordered by expected link yield
 5. DETAILS     the full question text for every pick
 6. DRAFT       one LLM call writes the pitch from your approved facts only
 7. PREFLIGHT   mechanical gate: length, dashes, your own name, filler words, AI sentence shapes,
                invented-story phrases, your brand's banned claims
 8. GRADE       a SEPARATE LLM call scores the draft on 8 axes (see below)
                fail -> redraft with the grader's notes, up to 3 drafts total
                still failing -> held for you, never submitted
 9. REVIEW      data/runs/<run>/review.html: every pitch, its scores, and why anything was held
10. SUBMIT      only what you approve (or, if you opted in, what passed), then a live check that each
                answer is actually stored on the question page
```

### Bylined articles (Featured News)

Bylines are the highest-value placement on Featured: a full article under your name, published on Featured
News and syndicated to partner sites, with your homepage linked in the bio.

```
 1. SOURCES     fetch your source pages; their numbers are the only numbers the article may use
 2. DRAFT       one LLM call writes a 700 to 1,300 word article from your approved facts and sources
 3. GATES       word counts, headline and bio length, brand named once, no calls to action,
                links only to sources, no lead-capture pages, no dashes, no invented stories
 4. GRADE       a separate LLM call scores accuracy, sourcing, usefulness, guideline fit, lie risk,
                fabrication risk and AI likelihood; misses go back to the drafter, up to 3 drafts
 5. REVIEW      data/bylines/<date>/review.html shows every article as it will read
 6. STAGE       fills Featured's article form and runs Featured's own "Check for AI", then stops
 7. SUBMIT      only on your yes, and only if Featured's check unlocked the Submit button
```

```bash
npm run byline -- draft                          # every profile with bylines turned on
npm run byline-stage -- data/bylines/<date>/<profile>.json            # fill the form, run the check, stop
npm run byline-stage -- data/bylines/<date>/<profile>.json --submit   # after you've read it
```

Turn bylines on per profile during onboarding, or later with `npm run onboard -- --add`. Featured's
article guidelines ask that articles be written by the named author, and submitting attests to that.
Read them and decide for your own account.


### The grader

The grader is a fresh model call that never saw the drafter's instructions. It gets the question and the
pitch and returns a score from 1 to 10 on each axis:

| Axis | What it checks | Default floor |
|---|---|---|
| overall | would a journalist use this | 8 |
| lie_risk | no credential you don't hold (10 = none) | 9 |
| fabrication_risk | no invented story, client or result (10 = safe) | 8 |
| ai_likelihood | reads like a person, not a model (10 = human) | 7 |
| thesis_match | backs the answer the journalist already wrote | recorded, not enforced |
| fit, authenticity, specificity | recorded on the review page | none |

A pitch passes only if it clears every floor AND the mechanical preflight. If it misses, the drafter
gets the grader's scores and notes and rewrites, up to 3 drafts. Floors live in `config/seats.json`
under `gate` and you can raise them. Drafter and grader both default to Sonnet; set `models.grader` to
`opus` if you want the grade to come from a different model than the one that wrote the draft.

## Safety defaults

- **Nothing is submitted without you.** A normal run stops at the review page. Submitting needs
  `--live` plus typing `SUBMIT`, or `--yes` after you have read the page.
- **Auto-submit is opt-in per profile.** It only happens with `autoSubmit: true` on that profile AND the
  `--auto-submit` flag on the run.
- **Wrong-profile guard.** The submitter refuses to type anything unless the expert name you configured
  is visible on the answer page.
- **No double answers.** Already-answered questions are skipped, and every submission goes into a
  local ledger that blocks a repeat.
- **No made-up stories.** Drafts may only state facts from your approved-facts file. Everything else
  has to be framed as opinion. A regex gate and the grader both enforce this.
- **The model has no tools.** Journalist questions are untrusted text. Every LLM call runs with tools
  disabled, so a question that tries to give the model instructions has nothing it can run.
- **One run at a time.** A lock file stops two runs from drafting the same questions.
- **No stealth.** It uses your own logged-in session and does not hide that it is a browser.

## Requirements

- Node.js 18 or newer
- Claude Code installed and logged in. All model calls go through it. If `claude` is not on your PATH,
  set `CLAUDE_BIN=/full/path/to/claude` in `.env`.
- A Featured expert account with at least one expert profile
- macOS or Linux

## Setup

```bash
git clone <this repo> featured-pitch-agent
cd featured-pitch-agent
npm install
npx playwright install chromium
```

**1. Onboard.** Either open Claude Code here and say "set up Featured", or run:

```bash
npm run onboard
```

It asks about your niche, the topics you cover and the ones you don't, credentials you do NOT have,
facts you can prove, your Featured profile ID, your minimum and maximum DA, and whether you want
auto-submit (default no). It writes `config/seats.json` and `config/claims/<brand>.md`. Both stay on
your machine and are ignored by git.

To find your profile ID: open any question on Featured, switch the answering profile, and copy the
number after `profileId=` in the address bar.

**2. Log in once.**

```bash
cp .env.example .env      # put your Featured email and password in .env
npm run login             # or: npm run login -- --manual  (log in yourself in a browser window)
```

The session is saved to `data/browser-state.json` with owner-only permissions.

**3. Check the config.**

```bash
npm run check
```

## Daily use

```bash
npm start                         # scan, classify, draft, grade, write the review page
open data/runs/<run>/review.html  # read every pitch
npm run submit -- --run data/runs/<run> --ids <id1,id2> --live
```

Useful flags for `npm start`:

| Flag | Effect |
|---|---|
| `--max 5` | draft at most 5 pitches this run (good for a first run) |
| `--seat <key>` | only one profile |
| `--wide` | also draft "stretch" fits |
| `--from-scan <feed.json>` | reuse a saved scan |
| `--auto-submit` | submit passed pitches for profiles with `autoSubmit: true` |

Run it early in the day. Journalists often choose from the first answers that come in, not the ones
sent on deadline day.

## What it learned in production

These rules come from more than 1,500 real pitches on one account.

- **Back the journalist's angle.** Most articles are already written when the question goes up. The quote
  that confirms the thesis, and names the exact items the question names, beats a clever contrarian take.
- **Never invent a story.** An invented anecdote once got published under an expert's name, and a
  national newspaper reporter then asked to interview them about an event that never happened. If a
  question asks "tell us about a time", the drafter answers with the pattern you see in your work, in the
  present tense, and never with a made-up dated incident.
- **Don't chase DA.** On one account, answers placed on sites under DA 20 carried a dofollow link about
  90% of the time, against roughly a quarter of the time on DA 40 and up. That is why the minimum DA
  defaults to 0 and picks are ordered by expected link yield.
- **Prompt rules are suggestions; gates are rules.** Every writing rule that mattered ended up as a
  regex in `src/preflight.js`, because the model broke the prompt-only versions.
- **A grade is only as good as its ruler.** If you swap the grader model, re-check the floors against
  pitches you know were good before trusting a run that passes nothing.

## Deliberately not included

- **Scheduling.** Run it yourself or add your own cron job. Nothing here installs a background service.

## Files

```
config/seats.json        your profiles (created by onboarding, git-ignored)
config/claims/*.md       approved facts per profile (git-ignored, except the example)
data/                    session, ledgers, run folders and bylines (git-ignored)
src/                     the pipeline (see the header comment in each file)
tests/                   npm test
.claude/skills/featured-pitch-agent/SKILL.md   the Claude Code skill
```

## Responsibility

Every pitch goes out under your name. Read what you approve, keep your approved-facts file true, and
follow Featured's terms of service.

MIT licensed.
