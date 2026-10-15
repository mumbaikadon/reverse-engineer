# applio

A self-hosted job application agent. It does the four things auto-apply products like tsenta.com do behind their landing pages, on your own machine, with you approving each send:

| Stage | What applio does | Where |
|---|---|---|
| **Find** | Polls the public job-board APIs behind company career pages (Greenhouse, Lever, Ashby, Workday), stores every posting, and notices new ones within one scan interval. | `src/sources/`, `applio scan`, `applio watch` |
| **Match** | Scores each posting 0–100 against your target titles, skills, locations and seniority, with the reasons spelled out. Flags "no sponsorship" postings if you need a visa. | `src/match.js`, `applio jobs` |
| **Prep** | Uses Claude to rewrite your résumé bullets and write a cover letter for one posting. A fact check rejects any edit that quotes a bullet you don't have or adds a number that isn't in your résumé. Renders ATS-friendly PDFs. | `src/tailor.js`, `src/render.js`, `applio tailor` |
| **Apply** | Opens the real application form in headless Chromium, reads every field and label, answers from your profile (Claude writes the open-ended answers), uploads the PDFs, and saves a screenshot + receipt. It only clicks submit with `--submit` on a job you approved. | `src/apply/filler.js`, `src/answers.js`, `applio apply` |
| **Track** | SQLite pipeline with status history (`matched → tailored → approved → submitted → interview …`). | `src/db.js`, `applio board` |

## Setup

Requires Node 22.5+ (uses the built-in `node:sqlite`).

```bash
npm install
npx playwright install chromium     # skip if you already have a Chromium (see APPLIO_CHROMIUM below)
node src/cli.js init                # creates config/profile.json, config/companies.json, resume/resume.md
```

Then edit:

- **`resume/resume.md`** — your résumé in Markdown. Use `## Summary`, `## Experience` (bullets starting with `- `) and `## Skills` (comma-separated) so tailoring can edit those sections.
- **`config/profile.json`** — contact details, work authorization, and `preferences` (titles, skills, locations, seniority, `minScore`). The `answers` list holds your own standing answers to recurring questions (`{"match": "<regex>", "answer": "No"}`). Demographic questions are answered "decline" unless you fill in `eeo`.
- **`config/companies.json`** — the boards to watch. Find a company's board in its careers-page URL:
  - Greenhouse: `boards.greenhouse.io/<slug>` or `job-boards.greenhouse.io/<slug>` → `{"ats": "greenhouse", "slug": "<slug>"}`
  - Lever: `jobs.lever.co/<slug>` → `{"ats": "lever", "slug": "<slug>"}`
  - Ashby: `jobs.ashbyhq.com/<slug>` → `{"ats": "ashby", "slug": "<slug>"}`
  - Workday: `<host>/<site>` such as `nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite` → `{"ats": "workday", "host": "nvidia.wd5.myworkdayjobs.com", "tenant": "nvidia", "site": "NVIDIAExternalCareerSite"}`

Set `ANTHROPIC_API_KEY` to enable tailoring and AI-written answers. Without it, scanning, matching and profile-based form filling still work; open-ended questions are left for you.

## Daily use

```bash
node src/cli.js scan                       # or: node src/cli.js watch --every 30
node src/cli.js jobs --min 75              # best matches first
node src/cli.js show 7263592               # any unique fragment of the job id
node src/cli.js tailor 7263592             # or: tailor --top 10
#   review out/<job>/changes.md, resume.pdf, cover_letter.txt
node src/cli.js approve 7263592
node src/cli.js apply 7263592              # dry run: fills the form, screenshots it, does not submit
node src/cli.js apply 7263592 --submit     # sends it
node src/cli.js apply 7263592 --headed     # watch it; finish anything it couldn't (CAPTCHA, odd widgets) yourself
node src/cli.js board
```

Every `apply` writes `out/<job>/apply/receipt.json` (each field, the value used, and where it came from: `profile`, `claude`, `file` or `missing`), `filled.png`, and after submitting, `after-submit.png`.

## How it works

**Discovery.** The career pages for most tech companies are hosted by one of a few applicant-tracking systems, and each publishes the postings as JSON:

- Greenhouse: `GET boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` (plus `?questions=true` per job for the application questions)
- Lever: `GET api.lever.co/v0/postings/{slug}?mode=json`
- Ashby: `GET api.ashbyhq.com/posting-api/job-board/{slug}`
- Workday: `POST {host}/wday/cxs/{tenant}/{site}/jobs`, then `GET …{externalPath}` per job for the description

A scan of the 19 boards in the example list (about 5,400 open roles) takes around 15 seconds. Postings that disappear are marked closed.

**Form filling.** Rather than hard-coding each portal's form, the filler reads the live DOM: every input, textarea, select, radio/checkbox group (grouped by `<fieldset>` or name), react-select combobox (options read from its own `aria-controls` listbox), and Yes/No toggle buttons. Labels come from `aria-labelledby`, `<label for>`, wrapping labels or nearby label elements. This handles Greenhouse's new job-boards UI, Lever and Ashby forms as they are today.

**Safety rails.**
- Nothing is submitted without `approve` plus `--submit`.
- If a required field has no answer, a CAPTCHA appears, or the portal wants an account login (Workday usually does), the job goes to `needs_input` and you finish it. CAPTCHAs are never bypassed.
- Claude is told to use only facts from your résumé and profile, and to mark questions it can't answer truthfully. Tailored bullets that add figures your résumé doesn't contain are rejected and listed in `changes.md`.

## Configuration

| Env var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables tailoring and AI answers |
| `APPLIO_MODEL` | Claude model id (default `claude-opus-5-5`) |
| `APPLIO_DB` | SQLite path (default `data/applio.db`) |
| `APPLIO_CHROMIUM` | Path to a Chromium binary to use instead of Playwright's download |

Behind an HTTP proxy (`HTTPS_PROXY` set), the CLI re-runs itself with `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses the proxy, and launches Chromium through it too.

## Tests

```bash
npm test
```

These cover the four source normalizers, scoring, the tailoring fact check, profile answer mapping, the database, and an end-to-end fill-and-submit against a local fixture form (`test/fixtures/form.html`).

## Limits

- Workday applications need a per-company account, so they are marked `needs_input` with the link.
- Custom widgets outside the patterns above may be missed. Run with `--headed` to see what happened and finish by hand.
- Check each site's terms before automating submissions to it, and keep volume reasonable. One well-targeted application beats ten generic ones.
