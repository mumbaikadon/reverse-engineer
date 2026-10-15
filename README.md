# applio

A self-hosted job application agent. It does the four things auto-apply products like tsenta.com do behind their landing pages, on your own machine, with you approving each send:

| Stage | What applio does | Where |
|---|---|---|
| **Find** | Polls the public job-board APIs behind company career pages (Greenhouse, Lever, Ashby, Workday), stores every posting, and notices new ones within one scan interval. | `src/sources/`, `applio scan`, `applio watch` |
| **Match** | Scores each posting 0–100 against your target titles, skills, locations and seniority, with the reasons spelled out. Flags "no sponsorship" postings if you need a visa. | `src/match.js`, `applio jobs` |
| **Prep** | Uses Claude to rewrite your résumé bullets and write a cover letter for one posting. A fact check rejects any edit that quotes a bullet you don't have or adds a number that isn't in your résumé. Renders ATS-friendly PDFs. | `src/tailor.js`, `src/render.js`, `applio tailor` |
| **Apply** | Opens the real application form in headless Chromium, reads every field and label, answers from your profile (Claude writes the open-ended answers), uploads the PDFs, and saves a screenshot + receipt. It only clicks submit with `--submit` on a job you approved. | `src/apply/filler.js`, `src/answers.js`, `applio apply` |
| **Track** | SQLite pipeline with status history (`matched → tailored → approved → submitted → interview …`). | `src/db.js`, `applio board` |

## Run it on your computer

You need **Node.js 22.13 or newer** (`node -v` to check; install from [nodejs.org](https://nodejs.org) if needed) and **git**.

```bash
# 1. Get the code
git clone https://github.com/mumbaikadon/reverse-engineer.git
cd reverse-engineer
git checkout claude/great-thompson-xywco1

# 2. Install dependencies and the browser used for filling forms (~150 MB, once)
npm install
npx playwright install chromium

# 3. Check everything works: 20 tests, including a real fill-and-submit on a local test form
npm test

# 4. Create your own config files (git-ignored, so your details never get committed)
node src/cli.js init

# 5. Start the dashboard
npm run dashboard
```

Open **http://localhost:4317** and press **Scan boards**. The first scan pulls about 5,000 postings from the example companies in roughly 15 seconds.

### Trying it out safely

Nothing reaches an employer until you approve a job **and** press Submit (or run `apply --submit`), so this is a safe way to explore:

1. **Scan** with the example profile and résumé still in place, and look through the matches. Click a row to see why it matched.
2. Click **Dry run** on any job. A headless browser opens the real application form, fills it in, takes a screenshot and stops without submitting. Afterwards the panel shows every field, the value used and where it came from, with a link to the screenshot.
3. Put in your real details: `resume/resume.md`, `config/profile.json` (contact info, work authorization, `preferences`) and `config/companies.json` (the companies you want). Scan again and the scores update to match you.
4. To turn on résumé tailoring and AI-written answers, stop the server (Ctrl-C), set your key and restart:
   - macOS / Linux: `export ANTHROPIC_API_KEY=sk-ant-...`
   - Windows PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."`

   The header pill changes to **Claude: on**. Click **Tailor** on a job, review the bullet changes and cover letter in the panel, then **Approve**, then **Dry run** again to see the tailored PDFs uploaded.
5. Press **Submit** only on a job you want to apply to. It asks for confirmation first.

To see the browser while it fills a form, use the CLI: `node src/cli.js apply <job> --headed`.

To start over, delete the `data/` folder (the database) and `out/` (generated PDFs and screenshots).

## Dashboard

`npm run dashboard` (same as `node src/cli.js serve [--port 4317]`) serves a local web UI over the same database the CLI uses:

- **Header:** last scan summary, Claude on/off, **Scan boards**, **Tailor top 5**, light/dark toggle.
- **Totals:** open roles, matched, tailored, approved, submitted and needs-you counts. Click one to filter the table.
- **Pipeline bar:** how many jobs sit at each stage (hover for counts, click to filter). Stages run light to dark blue; "needs you" (⚠) and "failed" (✕) use warning colors.
- **Jobs table:** filter by status, search, company and minimum score; sort by match, newest, recently updated or company.
- **Job panel:** match reasons, actions (Tailor, Approve, Dry run, Submit, set status), the tailored bullet diff with anything the fact check rejected, cover letter, the field-by-field record of the last form fill with its screenshot, links to the PDFs, the full description and the job's history.
- Long operations run in a background queue, one browser at a time, with progress cards in the bottom-right corner.

The server listens on `127.0.0.1` only. It can submit applications in your name, so don't expose it with `--host 0.0.0.0` on a network you don't trust. Every state-changing request must carry an `X-Applio` header, which stops other websites open in your browser from triggering actions on it.

## Setup details

After `node src/cli.js init`, edit:

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

These cover the four source normalizers, scoring, the tailoring fact check, profile answer mapping, the database, the dashboard API (including its CSRF and file-path guards), and an end-to-end fill-and-submit against a local fixture form (`test/fixtures/form.html`).

## Limits

- Workday applications need a per-company account, so they are marked `needs_input` with the link.
- Custom widgets outside the patterns above may be missed. Run with `--headed` to see what happened and finish by hand.
- Check each site's terms before automating submissions to it, and keep volume reasonable. One well-targeted application beats ten generic ones.
