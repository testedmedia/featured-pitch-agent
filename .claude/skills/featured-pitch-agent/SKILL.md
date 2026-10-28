---
name: featured-pitch-agent
description: Run the Featured (Connectively) journalist-question pipeline in this repo. Onboards a new user (niche, expert profiles, approved facts, DA range, auto-submit choice), then scans open questions, drafts pitches, has an independent grader score them, and prepares a review page. Submits only what the user approves. Triggers on "set up Featured", "onboard Featured", "run Featured", "Featured pitches", "answer Featured questions", "Connectively", "journalist questions", "submit the pitches", "add a Featured profile".
---

# Featured pitch agent

This skill drives the code in this repository. Run every command from the repository root (the folder
that holds `package.json`). Never edit `src/` to get a run through; if a gate blocks something, report it.

## 0. First check

```bash
npm run check
```

- "No config yet" means onboarding has not happened. Go to step 1.
- Problems listed means the config is broken. Show the user the problems and fix them together.
- A summary of profiles means you can skip to step 2.

Also confirm `node_modules/` exists (otherwise `npm install && npx playwright install chromium`) and
that `data/browser-state.json` exists (otherwise step 1c).

## 1. Onboarding (conversation, not a form)

Interview the user in chat, a few questions at a time, in plain words. Do not invent answers. If they
skip something optional, leave it out.

**Global settings**
1. Minimum DA they want to pitch. Tell them lower-DA sites link back far more often, and that 0 keeps
   everything. Suggest 0 unless they have a reason.
2. Maximum DA (default 100).
3. Whether to include "stretch" fits (default no; more volume, more declines).
4. Max pitches per profile per run (default 10).

**Per expert profile** (repeat for each Featured profile they own)
1. Brand or company name.
2. Their name exactly as it shows on the Featured profile.
3. Featured profile ID. How to find it: open any question on Featured, switch the answering profile,
   copy the number after `profileId=` in the address bar.
4. Their niche in one or two sentences: what they do and who they serve.
5. Topics they can speak on with real experience.
6. Topics that should never be routed to them.
7. Credentials they do NOT hold (doctor, attorney, licensed contractor, CPA...). These become hard bans.
8. Words or claims that are banned for this brand (for example "free" if the product is paid).
9. Approved facts, one per line: things they can prove on a phone call. Years in business, team size,
   pricing, service area, published numbers. Push for specifics, and remind them that anything not on
   this list can only appear as opinion.
10. A statistics page URL they own, if any (optional).
11. A DA range for this profile if it differs from the global one (optional).
12. Auto-submit for this profile: default NO. Explain that NO means every pitch waits for their approval.

Then write the answers to a temporary JSON file in the same shape as `config/answers.example.json`
and run:

```bash
node src/onboard.js --from /tmp/featured-answers.json          # first time
node src/onboard.js --from /tmp/featured-answers.json --add    # adding a profile later
npm run check
```

Delete the temporary file afterwards. Show them the `npm run check` summary.

**1c. Login.** Ask them to put their Featured email and password in `.env` (copy `.env.example`), or to
use `npm run login -- --manual` and log in themselves in the browser window that opens. Never ask them to
paste a password into the chat. Then run `npm run login` and confirm it printed "Session saved."

## 2. Daily run

```bash
npm start -- --max 10
```

First run: use `--max 3` so they see the output before spending a full run. When it finishes, tell them:
- how many questions were scanned, matched, already answered, drafted, passed, held and declined
  (read `report.json` in the run folder; never estimate)
- the path to `review.html` and that they should open it
- the top reasons pitches were held, in plain words

If the run printed "Session expired", run `npm run login` and start again.

## 3. Submitting

Submitting publishes text under the user's name. The rule:

1. Show the user the COMPLETE pitch body for every pitch you intend to submit, with the publication,
   DA and expert name. Not a summary.
2. Ask one question: "Submit these N pitches live under <name>?"
3. Only after a clear yes, run:

```bash
npm run submit -- --run data/runs/<run> --ids <id1,id2> --live --yes
```

Never pass `--live` or `--yes` on your own judgment, on a "looks good" about something else, or because
a profile has auto-submit on. If they want changes to a pitch, edit nothing in the run folder; tell them
to copy the body from the review page, edit it, and paste it on Featured themselves.

After submitting, report every outcome line. Anything other than `submitted` or `submitted_inferred` is
not a success and must be said plainly.

## 4. Auto-submit (only if they asked for it during onboarding)

```bash
npm start -- --auto-submit
```

This submits passed pitches only for profiles with `autoSubmit: true`, then checks each one is stored on
the question page. Pitches for other profiles still wait on the review page.

## Writing rules (if the user asks you to draft or fix a pitch by hand)

The same rules the pipeline enforces:
- Back the answer the journalist has already decided on, and name the exact items the question names.
- Lead with the answer. 800 to 1,500 characters. Contractions. Short sentences.
- State only approved facts as fact. Everything else is opinion ("in my view", "the pattern I see").
- Never invent a client, a test, a dated incident, or a result. "Tell us about a time" gets the recurring
  pattern, in the present tense.
- Never claim a credential from the profile's "do not hold" list.
- No em or en dashes, no greetings, no bullets, no headers, no "in conclusion", no self-promotion, no
  links, no expert name in the body (the byline carries it).
- No mirrored sentence pairs ("X is easy. Y isn't."), no "not X, it's Y", no tidy closing aphorism.
- Run the result through `node -e "const {preflight}=require('./src/preflight');const {loadConfig}=require('./src/config');const c=loadConfig();console.log(preflight(require('fs').readFileSync('/tmp/pitch.txt','utf8').trim(), c.seatsByKey['<key>'], c))"`
  and fix every item it prints.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No saved Featured session` | `npm run login` |
| Every question CLASSIFY_FAILED | Claude Code is logged out or rate limited: run `claude` once and log in |
| Nothing passes the grader | read the held reasons on the review page; usually ai_likelihood. Improve the approved facts before lowering a floor |
| `reject_byline_not_visible` | the profile ID and display name in `config/seats.json` do not match the Featured profile |
| `held_plan_limit` | the Featured plan is out of answers |
| Another run is active | a previous run is still going; wait, or delete `data/pipeline.lock` if that process is gone |
