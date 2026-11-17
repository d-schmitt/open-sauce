# Open Sauce

A personal, local-only family cookbook. Recipes are shown as "Cooking for Engineers" style preparation tables, every change and every cooking attempt is kept as a git-like history, and the whole cookbook is a folder of human-readable JSON files that you can back up or sync to a private git repository.

The same web UI runs in two places that share one backend implementation and one data folder:

- **Standalone**: `npm start` opens a loopback server in your browser.
- **Copilot canvas**: the extension in `.github/extensions/open-sauce/` registers the canvas `open-sauce`, so Copilot can open the cookbook in a side panel, read recipes and propose drafts.

New recipes are not typed into a blank form. You give the recipe to an AI assistant (Copilot in the canvas, or another assistant with local tool access), it places a draft in the review area, and you check and correct every field before you press Save. See [Adding recipes with AI](#adding-recipes-with-ai).

The app name lives in one constant, `APP_NAME` in `.github/extensions/open-sauce/model.mjs`, plus this README and `package.json`. Data file format markers (`open-sauce-recipe`, etc.), the env vars and the config folder use the slug `open-sauce`; rename them together if you rename the app.

## Requirements

- Node.js 22 or newer (developed on Node 24). There are no runtime npm dependencies.
- git, only if you want to use Sync. The GitHub CLI `gh`, only if your sync remote is on GitHub (used to confirm the repository is private).

## Run standalone

```sh
cd open-sauce
npm start                                     # prints a http://127.0.0.1:<port>/<token>/ URL; open it in your browser
OPEN_SAUCE_DATA=~/Cookbook npm start          # use a specific cookbook folder
PORT=4791 OPEN_SAUCE_DATA=~/Cookbook npm start
```

The server binds to `127.0.0.1` only, on a random port unless `PORT` is set. The URL contains a random access token; every request without it gets `401`. Keep the URL to yourself. Stop the server with Ctrl+C.

`npm install` is only needed for the optional screenshot script (it installs the dev dependency `playwright-core`). The app and the tests do not need it.

## Open the canvas in Copilot

Use either option. Nothing is installed automatically.

1. Open this folder as a project in the Copilot app or CLI. Project extensions under `.github/extensions/` are discovered from there.
2. Or copy or symlink the extension folder into your user extensions folder, for example:

   ```sh
   ln -s "$(pwd)/.github/extensions/open-sauce" ~/.copilot/extensions/open-sauce
   ```

Then ask Copilot to open the `open-sauce` canvas. `extension.mjs` imports `createCanvas` and `joinSession` from the `@github/copilot-sdk/extension` module that the Copilot runtime provides; do not `npm install` the SDK. The standalone launcher (`standalone.mjs`) never imports the SDK.

### Canvas actions for Copilot

| Action | What it does |
| --- | --- |
| `list_recipes` | Lists recipes (id, title, categories, current snapshot id, short description). |
| `get_recipe` | Returns the current snapshot of one recipe, including ingredients, steps and the diagram validation result. Photo ids are not shared; `photoCount` says how many photos the recipe has. |
| `submit_draft` | Puts a proposed new recipe, or a proposed revision of an existing one, into the "Drafts waiting for review" area. It never saves, never changes Current and never syncs. You open the draft, check and correct it and save it yourself. |

`submit_draft` uses the same published draft schema and validation as the local agent interface below. Draft diagram problems and category names that do not exist in the cookbook are reported back to Copilot and shown in the review.

## Adding recipes with AI

There is no "New recipe" form. To add a recipe, give it to an AI assistant in any form (pasted text, a transcription of a handwritten card, a description). The assistant converts it into a draft and places it in the review area of the running app. Then:

1. On the Recipes page, the draft appears under "Drafts waiting for review", with who submitted it.
2. "Review and save" opens it in the editor. Every field is shown and editable: title, description, family or source attribution, source URL, yield, categories (suggested names are pre-selected; unknown names are listed but never created), each ingredient's name, amount, unit and note, every step with its text, time, temperature, oven mode and inputs (including editable portion amounts of split ingredients), the live preparation table, notes and photos.
3. A summary above the button repeats title, counts, categories and whether the table is complete.
4. Only "Save reviewed recipe" writes anything. Cancel keeps the draft in the review area; Dismiss discards it. Until you save, nothing is written to the cookbook folder, nothing becomes Current and nothing is synced.

Existing recipes are still edited directly (new revision, cooking attempt), and assistants can also propose a revision of an existing recipe, which you review the same way.

### With Copilot

Open the `open-sauce` canvas and say for example "Add this recipe to my cookbook:" followed by the recipe. Copilot calls `submit_draft`.

### With another AI assistant on this computer (local agent interface)

While Open Sauce runs (standalone or canvas), it also starts a small local interface for other assistants. It is meant for assistants that can **run tools on this computer**, for example a coding agent that can read a file and call `curl`. Hosted chatbots in a browser tab, or any service on the internet, cannot reach it, and nothing here connects them automatically. No AI model or provider is built into Open Sauce, and no secret is stored in the code.

- **Address and token**: every running Open Sauce window (each standalone server and each Copilot canvas session) writes its own endpoint file `~/.config/open-sauce/agents/<instanceId>.json`, for example `agents/standalone-5adb003f51ad.json` or `agents/canvas-0c4f1e2a9b7d.json`. The folder follows the config file (`OPEN_SAUCE_CONFIG` moves both; `OPEN_SAUCE_AGENT_DIR` sets the folder directly). Each file holds `app`, `instanceId`, `surface` (`standalone` or `canvas`), `cookbook` (the absolute cookbook folder), `url`, `token`, `pid` and `startedAt`. It is created with permissions `0600` in a `0700` folder, gets a new random port, token and id on every start, and is removed when that instance stops. One instance never writes or removes another instance's file. The app prints only the instance id and the file path, never the token.
- **Choosing the right instance**: the "Add a recipe" page of each window shows "This window is Open Sauce instance ..." with its surface, cookbook folder and the exact path of its own endpoint file, and lists the other running instances with theirs. Give the assistant that exact file path, or tell it to pick the file whose `cookbook` matches. For extra safety the assistant can send `X-Open-Sauce-Instance: <instanceId>`; a request that reaches a different instance is refused with `409`. Every accepted draft returns `instance: {id, cookbook}` so the assistant can report where it went.
- **After a crash**: if an instance is killed without cleaning up (for example `kill -9`), its file stays behind with a dead port and token. The next Open Sauce start removes files whose process no longer exists; files of running instances, unreadable files and unrelated files are left alone.
- **Keep the token private**: do not paste it into chats, issues, screenshots or websites, and do not echo it in shared terminals or logs. Let the assistant read the file itself. Any program running as your user can read the file; that is the same trust level as your recipe files.
- **Turn it off** with `OPEN_SAUCE_AGENT=off`.

Operations (all require `Authorization: Bearer <token>`; base URL from the file, for example `http://127.0.0.1:<port>/agent/v1/`):

| Request | Result |
| --- | --- |
| `GET schema` | The exact JSON Schema of a draft (`schemas.draft`) and this list of operations. |
| `GET recipes` | Read-only list: id, title, category names, current snapshot id. |
| `GET recipes/<id>` | Read-only current version of one recipe, in the same shape as `draft.recipe`. |
| `GET categories` | Read-only list of category names. |
| `POST drafts` | Puts a draft into the review area. `202` with `{draftId, status: "in_review", diagramErrors, unmatchedCategories}`. Nothing is saved. |

Errors: `400` invalid draft (the message names the field, for example `draft.recipe.ingredients[0].unit must be one of ...`), `401` missing or wrong token, `403` browser or foreign-host request, `404` unknown recipe or route, `412` no cookbook set up, `413` larger than 2 MB, `415` not JSON, `429` review area full (20 drafts; existing drafts are kept, never evicted).

The draft schema in short (the `GET schema` response is authoritative and is the very object the server validates against, in `drafts.mjs`):

```json
{
  "submittedBy": "My assistant",
  "message": "Transcribed from Grandma's card",
  "categories": ["Sweet", "Baking"],
  "recipe": {
    "title": "Plum crumble", "description": "", "attribution": "Aunt Example",
    "sourceUrl": "https://example.com/plum-crumble", "yield": "1 dish", "notes": "",
    "ingredients": [
      { "id": "plums", "name": "Plums", "quantity": 600, "unit": "g", "note": "halved" },
      { "id": "sugar", "name": "Sugar", "quantity": 120, "unit": "g" },
      { "id": "flour", "name": "Flour", "quantity": 150, "unit": "g" },
      { "id": "butter", "name": "Butter", "quantity": 100, "unit": "g" }
    ],
    "actions": [
      { "id": "fruit", "text": "Toss plums with sugar", "inputs": [{ "ingredient": "plums" }, { "ingredient": "sugar", "quantity": 40 }] },
      { "id": "crumbs", "text": "Rub into crumbs", "inputs": [{ "ingredient": "flour" }, { "ingredient": "butter" }, { "ingredient": "sugar", "quantity": 80 }] },
      { "id": "bake", "text": "Scatter crumbs over the fruit and bake", "inputs": [{ "action": "fruit" }, { "action": "crumbs" }],
        "durationMinutes": 35, "temperatureC": 180, "ovenMode": "fan" }
    ]
  }
}
```

Rules: unknown fields are refused; units are metric (`g kg ml cl l tsp tbsp pinch piece clove bunch can` or empty); quantities are positive or `null` ("to taste"); an input `{ingredient, quantity}` is a portion of a split ingredient and portions must add up to the listed amount; every ingredient and every step result is used exactly once and the last step produces the dish; `photos` must be empty (you add photos while reviewing; a proposed revision automatically keeps the photos of the snapshot it is based on, shown as "Kept from the base entry", and only you can remove them); `categories` only for new recipes; `recipeId` (plus optional `baseSnapshotId`) makes it a proposed revision. Drafts whose table has problems are still accepted and shown to you with the problems listed.

An instruction you can give a local assistant (it reads the token itself; nothing is printed):

```text
Read <the endpoint file path shown on the Add a recipe page>. Use its "url", send its
"token" as "Authorization: Bearer <token>" without printing the token, and send its
"instanceId" as "X-Open-Sauce-Instance". GET schema, convert the recipe below into a
draft that matches schemas.draft, and POST it to drafts. Report the draftId, instance,
diagramErrors and unmatchedCategories. Do not try to save anything.
```

The same from a shell, without showing the token:

```sh
ls ~/.config/open-sauce/agents/                            # one file per running instance
F=~/.config/open-sauce/agents/standalone-5adb003f51ad.json  # the path shown in the app
URL=$(node -p 'require(process.argv[1]).url' "$F")
ID=$(node -p 'require(process.argv[1]).instanceId' "$F")
node -p '"Authorization: Bearer " + require(process.argv[1]).token' "$F" \
  | curl -sS -H @- -H "X-Open-Sauce-Instance: $ID" -H 'Content-Type: application/json' \
    --data @draft.json "${URL}drafts"
```

## Where your data lives

Real data never defaults to the app folder. The cookbook folder is resolved in this order:

1. `OPEN_SAUCE_DATA=/absolute/or/relative/path` (environment variable).
2. `~/.config/open-sauce/config.json` containing `{ "dataDir": "/absolute/path" }`. The setup screen writes this file for you. `OPEN_SAUCE_CONFIG` overrides the config file path.
3. Otherwise the app shows a **setup screen**:
   - "Use this folder": creates or opens a cookbook folder and stores the path in the config file. Folders inside the app or project folder are refused.
   - "Try the demo cookbook": copies the bundled synthetic demo into a fresh temporary folder (under `OPEN_SAUCE_DEMO_DIR` or the system temp folder). The demo copy is never written to the config file and is clearly labelled in the UI.

The standalone app and every canvas panel can use the same folder at the same time; see "Invariants" for how conflicting writes are prevented.

Changing the folder while one is in use (from the setup screen of a running app) is refused while drafts for the current cookbook are waiting for review; save or dismiss them first. Choosing the same folder again changes nothing. After a change, other windows of the same app must be reloaded: every write carries the identity of the cookbook the window was opened for (`X-Open-Sauce-Cookbook`), and a write meant for the previous cookbook is refused with `409` (`cookbook_changed`) and keeps your edits on screen, so it can never land in the new cookbook. Drafts and photos staged during review belong to the cookbook they were created for and are not shown or saved in another one.

## Sync with a private git repository (optional)

Sync is a button, never automatic. It works only if you have made the cookbook folder a git repository yourself. The app never creates repositories.

1. Create a **private** repository on github.com yourself, for example `open-sauce-files`. Sync only works with a private github.com repository whose privacy the app can confirm through `gh` (run `gh auth login` once). Any other destination is refused (see below); there is no setting to override this.
2. In your cookbook folder:

   ```sh
   cd ~/Cookbook
   git init -b main
   git remote add origin git@github.com:<you>/open-sauce-files.git
   git add cookbook.json categories.json recipes assets
   git commit -m "Initial cookbook"
   git push -u origin main
   ```

3. Press **Sync** in the app. It will:
   - refuse if HEAD is detached, if a merge, rebase or cherry-pick is in progress, or if files outside the cookbook's own paths are already staged;
   - verify the destination before staging anything (details below) and check again that the remote URLs are unchanged before fetching and before pushing;
   - stage only app-managed paths explicitly (`cookbook.json`, `categories.json`, `recipes/*.json`, `assets/<id>.<ext>`), never `git add -A`;
   - commit, `git fetch`, fast-forward if the remote moved ahead, then `git push`;
   - if your branch and the remote have both changed (diverged), stop and explain. It never force-pushes, resets or merges for you. Resolve it in a terminal, then sync again.

### How the destination is verified (fails closed)

- The app reads every fetch and push URL of the remote with `git remote get-url --all` and `--push --all`, so `url.<base>.insteadOf` and `pushInsteadOf` rewrites are already applied. Every URL must point to the **same** github.com repository.
- Accepted: `https://github.com/<owner>/<repo>` and SSH addresses (`git@host:owner/repo`, `ssh://...`) whose host resolves, through `ssh -G` (the same lookup ssh does, including `Host` aliases in `~/.ssh/config`), to `github.com` or `ssh.github.com`.
- Refused: any other host (GitLab, GitHub Enterprise hosts, self-hosted servers), local paths and `file://` remotes, `git://`, `http://`, `ext::`, SSH addresses whose host cannot be resolved, and SSH remotes when `core.sshCommand`, `GIT_SSH` or `GIT_SSH_COMMAND` is set (those can send the connection elsewhere).
- Then `gh repo view github.com/<owner>/<repo> --json nameWithOwner,visibility,isPrivate` (with `GH_HOST=github.com`) must report exactly that repository as `PRIVATE`. Public, internal, renamed or moved repositories, and any case where `gh` is missing, logged out or cannot answer, are refused.
- If the destination cannot be verified, nothing is staged, committed, fetched or pushed. The status bar shows why sync is off.

All git and gh calls use argument arrays (`child_process.spawn` without a shell). The status bar shows local saving and sync status separately: "All changes are saved locally" is independent of "Sync: 2 files not synced".

## Using the app

- **Recipes**: searchable cards with photo, title and category tags. Selecting several categories always shows recipes that have **all** of them.
- **Recipe view**: ingredient list, preparation table, notes, photos, a multiplier (0.5x, 1x, 2x or custom).
- **Add a recipe**: explains how to add recipes through Copilot or a local assistant (there is no blank form). Drafts are reviewed and saved in the editor.
- **Editor**: guided forms, no Markdown, used to review drafts, write revisions and log cooking attempts. Add ingredients (name, amount, metric unit, note), then add steps and choose each step's inputs from unused ingredients, portions of an ingredient (for example 20 g of the sugar) and results of earlier steps. The table preview updates live and shows actionable errors instead of a wrong table.
- **History**: every saved entry with its parent, a graph of branches, the diff to its parent (ingredients added, removed or changed; oven temperature, time and mode changes), "Set as current" and "Start new entry from here" (new revision or new cooking attempt).

## Data schema

A cookbook folder looks like this:

```
cookbook.json            {"format":"open-sauce-cookbook","schemaVersion":1,"createdAt":...}
categories.json          {"format":"open-sauce-categories","version":N,"categories":[{"id":"sweet","name":"Sweet"},...],
                          "deleted":[{"id":"...","name":"...","deletedAt":"..."}]}   (tombstones)
recipes/<recipe-id>.json one document per recipe (see below)
assets/<32 hex>.png|jpg|webp   photos, referenced by id from recipes
.open-sauce.lock         present only while a write or sync is running (see "Locking")
.open-sauce.lock.recover present only during recovery of a dead owner's lock
```

A recipe document:

```jsonc
{
  "format": "open-sauce-recipe",
  "schemaVersion": 1,
  "id": "banana-bread",
  "version": 7,                 // increases on every write; used for stale-write protection
  "categoryIds": ["sweet", "baking"],
  "current": "s_d0000000004d",  // the one "Current" pointer
  "createdAt": "...", "updatedAt": "...",
  "snapshots": [                // append-only, never edited or removed
    {
      "id": "s_d0000000003d",
      "parent": "s_d0000000001d",   // null for the first snapshot
      "kind": "attempt",            // "revision" or "attempt"
      "createdAt": "...",
      "message": "Double batch for the school fair",
      "attempt": {                  // null for revisions
        "date": "2026-04-12",
        "multiplier": 2,            // provenance only; amounts below are already the actual ones
        "outcome": "...", "rating": 3, "photos": ["<asset id>"]
      },
      "content": {
        "title": "...", "description": "...", "attribution": "...", "sourceUrl": "...", "yield": "...",
        "ingredients": [{ "id": "i1", "name": "Bananas", "quantity": 6, "unit": "piece", "note": "" }],
        "actions": [{
          "id": "a1", "text": "Mash the bananas",
          "inputs": [{ "ingredient": "i1" }, { "ingredient": "i2", "quantity": 20 }, { "action": "a0" }],
          "durationMinutes": null, "temperatureC": null, "ovenMode": ""
        }],
        "notes": "...", "photos": ["<asset id>"]
      }
    }
  ]
}
```

Units: `g kg ml cl l tsp tbsp pinch piece clove bunch can` (or none). Oven modes: `top-bottom fan grill fan-grill bottom top` (or none).

### Invariants

- **Snapshots are immutable.** Saving appends a snapshot whose `parent` can be any existing snapshot, which allows branches. Nothing is ever deleted from history.
- **Current moves only on request.** A save changes `current` only if "Make this the current recipe" is ticked. "Set as current" can move it to any snapshot, including older ones; later snapshots stay.
- **Promotion is confirmed against the Current the user saw.** A save with "Make this the current recipe" sends `expectedCurrent`, the Current shown when the editor opened. If another window moved Current in the meantime, the save is refused with `409` (`currentChanged`). The editor then reloads the history, keeps your edits and the entry you started from (so it still becomes a branch of that snapshot), unticks the box and says which entry is now current. Tick the box again only if your branch should replace it. Branching from an old snapshot and promoting it on purpose is always possible; the editor notes when an entry does not start from the current recipe.
- **Attempts store actual amounts.** The multiplier is kept as provenance. Amounts in an attempt are never multiplied again when it is displayed or used as a parent.
- **Scaling is display-only and multiplier-only.** Quantities in the list and the table scale together; time and temperature never change; piece counts are not rounded (1.5 eggs). Multipliers must be finite, greater than 0 and at most 100.
- **Diagram validity.** Each action input is either an ingredient (whole, or a `quantity` portion) or an earlier action. A recipe with steps can only be saved if: there are no cycles; every input exists; no ingredient is over- or under-allocated across portions; portions need a quantity; every ingredient and action is used; no action's result is consumed twice; exactly one final action produces the dish and every action reaches it. Errors are shown instead of a table; no ingredient or action is ever dropped silently.
- **Table layout is deterministic.** Starting from the final action, the tree is walked in input order; leaves (ingredient portions) become rows; each action spans the rows of everything it consumes; columns are depth, right-aligned so the final action is the last column.
- **Stale-write protection.** Every mutation carries the version the client last saw (`expectedVersion`). A mismatch returns HTTP `409` with the current version, so two panels or windows cannot silently overwrite each other. The editor keeps your unsaved edits when this happens.
- **Atomic, durable writes.** JSON is written to a temporary file in the same folder, fsynced, then renamed over the target. Photos are written and fsynced under a generated id before any recipe refers to them.
- **Photos are staged in memory until Save.** Adding a photo in the editor keeps it only in the running app's memory (at most 30 photos or 120 MB, for 24 hours) and shows it as "Not saved yet". Nothing is written to the cookbook folder. Cancel, leaving the editor or removing the photo discards it. On Save, under the cookbook lock, the app first writes the referenced photos to `assets/` (atomic and fsynced), then the recipe; if the recipe write fails or is refused (for example `409`), the photos it just wrote are removed again. Staged photos are lost when the app stops; saving a recipe that refers to one then fails with a clear message instead of saving a broken reference. Sync stages only assets referenced by some recipe snapshot, so a photo left behind by a crash between the two writes is never committed. Photos must be PNG, JPEG or WebP (checked by file signature, not file name) and at most 8 MB.
- **One lock per cookbook.** Mutations and sync hold `.open-sauce.lock`; every write checks that the lock is still ours. A live owner is never displaced, however old its lock is. See "Locking" below.
- **Categories are flat tags with stable ids, deleted by tombstone.** Sweet and Savory are preloaded. Renaming keeps the id. Deleting a category first moves it to `deleted` in `categories.json` (one atomic write; the id is never reused), then removes the tag from each recipe file. Every reader ignores tombstoned ids, so an interrupted delete can only leave a stale id in a recipe file that already behaves as removed; deleting again (or the next category delete) finishes the cleanup. Recipes are never deleted that way. A tombstoned id cannot be assigned again.

### Locking

The lock file records `{token, pid, procStart, host, machineId, createdAt}`. It is created by writing a private temporary file and hard-linking it to `.open-sauce.lock` (atomic; the link fails if the lock exists). If hard links are not supported, exclusive create is used instead.

- **Live owner**: never displaced, regardless of age. After 5 seconds the request fails with HTTP `423`, naming the lock file.
- **Dead owner** (same machine, and the pid no longer exists or now belongs to a different process, detected by comparing the process start time): the lock is recovered. Recovery takes a second marker, `.open-sauce.lock.recover`, by exclusive create, re-reads the lock, and removes it only if it is still the same dead owner's lock. Competing recoverers therefore cannot remove a lock that someone else acquired in the meantime.
- **Unknown owner** (another machine, or an unreadable lock file): never recovered automatically. The `423` message says when it is safe to delete the file by hand.
- **Release** removes the lock only if it still carries our token. Writes stop with `423` if the lock was removed or replaced while we held it.
- **Tradeoffs and rejected alternatives**: age-based expiry (would break a slow but live writer), steal-by-rename (racy between recoverers), `flock` (not available in Node, unreliable on network drives). The price is that some situations need a person: a recovery marker left by a crash during the few microseconds of recovery, or a lock from another machine, must be removed by hand after checking that nothing is running.

### HTTP API safety

The API is only for the app's own UI. Requests must include the token as the first path segment and a matching `Host`. Mutations must be JSON and carry the cookbook identity the window was opened for (a mismatch gives `409 cookbook_changed`), and requests with a foreign `Origin` or a cross-site `Sec-Fetch-Site` are rejected with `403`. Responses use a strict Content Security Policy without inline scripts or styles.

The local agent interface is a separate server on its own random loopback port with its own token (an `Authorization` header, never part of a URL). Its token cannot call the UI API and the UI token cannot call it. It can only read recipes and submit drafts: no save, Current change, photo upload, category change or sync. It rejects any request with an `Origin` header, a cross-site `Sec-Fetch-Site` or a foreign `Host`, sends no CORS headers, and requires JSON.

## Demo cookbook

`.github/extensions/open-sauce/examples/demo-cookbook/` contains synthetic recipes only:

- **Apfelkuchen** (German, sweet): dough and filling as parallel branches, sugar split 20 g to the dough and 30 g to the filling, two oven stages (180 °C then 160 °C).
- **Shepherd's Pie** (English, savory): mash and filling branches.
- **Kartoffelsalat** (German, savory).
- **Weekday Banana Bread** (English, sweet): a branching history. #2 is a revision of #1, #3 is a cooking attempt from #1 at 2x that was not made current, #4 is a cooking attempt from #2 that was made current.

Rebuild it with `npm run demo:build` (it validates every recipe diagram).

## Tests

```sh
npm test
```

Uses `node:test` only. Covers table layout (branch merge, split portions, deep chain, validation errors), scaling, history invariants (including promotion against a changed Current), category match-all filtering, delete safety and interrupted tombstone deletes, stale-write `409`, photo validation, locking (old live owners kept, dead owners and reused pids recovered, other machines and unreadable locks refused, a multi-process race, stale recovery markers, release safety), sync against a temporary local bare git remote (clean push, fast-forward, divergence blocked, unrelated staged file refused, detached HEAD refused), sync destination checks (local, rewritten, non-GitHub, public, internal, renamed and unverifiable remotes refused before anything is staged; SSH aliases resolved), API authentication and origin checks, canvas actions, and the local agent interface (one private endpoint file per running instance, two simultaneous instances on different cookbooks reaching only their own drafts and surviving each other's shutdown, crashed instances' files pruned while live and unrelated files are kept, photos staged in memory and published only on Save (stale save publishes nothing, failed recipe write removes the photo, unreferenced assets are never synced, expiry checked on every read), revision drafts keeping the photos of their exact base snapshot (Copilot and agent sources, a branch from an older snapshot with different photos, promotion, removal only by the user), writes bound to the cookbook they were opened for when the folder is switched, token separation, browser and foreign-host refusal, the published schema equals the enforced one, identical normalization for Copilot and agent drafts, field-path errors, a byte-for-byte unchanged cookbook folder after submissions, the 20-draft limit without eviction, drafts not surviving a restart, no blank add-recipe form in the UI). The local bare remote is allowed only through a test-only injection; the app itself has no such option. Temporary folders are created under `tests/.tmp/` and removed afterwards.

Optional screenshots (needs `npm install` and Google Chrome, or `CHROME_PATH`):

```sh
OPEN_SAUCE_URL=http://127.0.0.1:<port>/<token>/ SCREENSHOT_DIR=./screenshots npm run screenshots
```

Point it at a server running on a **copy** of the demo cookbook: the script also saves a revision through the UI.

Browser end-to-end check of the two-panel conflict and promotion flow (same requirements; use a fresh copy of the demo, it saves entries to the banana bread recipe):

```sh
OPEN_SAUCE_URL=http://127.0.0.1:<port>/<token>/ npm run e2e:conflict
```

Browser end-to-end check of adding a recipe through local assistants. It is self-contained: it copies the demo cookbook twice under `tests/.tmp/`, starts two real app processes on the two copies with one shared config folder, and removes everything afterwards. It checks that each window shows its own endpoint file and lists the other without any token, that an assistant using one file reaches only that instance, that there is no blank add form, that every field, amount, portion, step connection, category and the table are shown and editable, that adding a photo during review and pressing Cancel leaves the cookbook folder byte-for-byte unchanged, that "Save reviewed recipe" adds exactly the recipe file and its photo, that a revision proposed by an assistant shows the saved recipe's photo as kept, names the target cookbook and still has the photo after promotion, and that stopping one instance leaves the other and its file working:

```sh
npm run e2e:agent
```

## Design decisions

- **JSON files in a folder, not a database.** Human-readable, diffable, easy to back up and to sync with git. Rejected: SQLite (opaque to git diffs and merges, binary conflicts).
- **One document per recipe with all its snapshots.** A recipe's history changes atomically with its Current pointer in a single rename. Rejected: one file per snapshot (needs multi-file transactions for "save and make current").
- **Guided editor, not Markdown.** The diagram needs explicit input references and portions, which free text cannot express reliably. Rejected: Markdown or a custom text syntax.
- **Explicit input references for the diagram.** Rejected: inferring the table from step order, which cannot express parallel branches or split ingredients.
- **Optimistic versions plus a lock file.** Simple, works across processes (standalone and canvas). Rejected: CRDTs or automatic merging, which are heavy and can silently combine edits.
- **Sync refuses any destination it cannot prove private.** Rejected: warning-only checks for unknown hosts and a user override, which would let private family recipes leak through a typo or a rewritten URL. The cost is that GitLab, GitHub Enterprise and self-hosted remotes are not supported in v1.
- **Category tombstones instead of a multi-file transaction.** Rejected: untagging recipes first (an interruption leaves a half-deleted category that still shows up) and a journal file (more machinery than one ignore rule on read).
- **Sync only on request, fast-forward only.** Rejected: automatic sync (surprising network and history effects), `git add -A` (could commit unrelated files), and force or reset strategies (can destroy data).
- **Multiplier-only scaling.** Rejected: target-serving scaling and unit conversion, which need yield parsing and density data.
- **Zero runtime dependencies.** Fewer moving parts for a long-lived personal tool.
- **Recipes enter through AI drafts plus a human review, not a blank form.** The editor stays for review, revisions and attempts. One schema (`drafts.mjs`) is published and enforced for both Copilot and other assistants.
- **A separate, least-privilege agent interface with its own token in a private file.** Rejected: reusing the UI token (it can save and sync, which would bypass review), a token in the URL (ends up in logs and history), printing the token at startup, a fixed port or token, persisting drafts to disk (unreviewed data in the cookbook folder and in sync), auto-creating suggested categories, evicting old drafts when the review area is full, and an embedded AI provider (a secret in the app and data leaving the machine).

## Known limitations

- Drafts (from Copilot or local assistants) are kept in memory (at most 20) in the process that received them, and are lost when that process stops. The canvas and the standalone server are separate processes, so a Copilot draft appears only in that Copilot session's panels.
- Assistants need local tool access (read a file, make a loopback HTTP request). Hosted chatbots cannot use the interface, and there is no AI inside the standalone app.
- Drafts cannot carry new photos; add them while reviewing. Revision drafts keep the base snapshot's photos.
- Cancel in the review keeps the draft in the review area but discards photos added there.
- After the cookbook folder is changed, other open windows must be reloaded (their writes are refused, not misdirected). Staged photos from the previous cookbook stay in memory, unused, until they expire (24 hours) or the app stops.
- If an instance is killed without a chance to clean up (for example `kill -9` or a crash), its endpoint file stays until the next Open Sauce start prunes it; meanwhile an assistant using it gets "connection refused". If the operating system has already reused that process id, the stale file survives until a later start (harmless: its port and token are dead). Any program running as your user can read the endpoint files.
- Staged photos, like drafts, live only in memory and are lost when the app stops. A crash between writing a photo and writing the recipe on Save leaves an unreferenced file in `assets/`; Sync ignores it, but it stays on disk until you delete it.
- The UI URL printed by `npm start` still contains the UI token, as before. The agent token is never printed.
- Panels do not push live updates to each other. A stale panel is detected on its next write (`409`) and asks you to reload.
- Sync does not resolve divergence; you resolve it in a terminal.
- Photos cannot be removed from the assets folder through the UI (removing one from a recipe only drops the reference, so history stays intact).
- Sync works only with private repositories on github.com, verified through `gh`. Other hosts are refused.
- The lock ownership check before each write narrows but does not fully close a check-then-write window: if someone deletes a live lock by hand at exactly the wrong moment, one write could still happen.
- Locks from another machine, unreadable lock files and a leftover `.open-sauce.lock.recover` need manual removal. Without a machine id (`/etc/machine-id` or the macOS platform UUID), a hostname change makes the app's own old lock look foreign. On systems without `ps` (Windows), pid reuse cannot be detected, so such a lock is treated as live.
- Cloud-synced or network folders (iCloud, Dropbox, SMB) are not supported for use from several computers at the same time; use Sync instead.

## Deferred (not in v1)

Hosting or multi-user access, hierarchical categories, linked sub-recipes, nutrition data, shopping lists, translation, and an AI model built into the app (AI help comes from Copilot in the canvas or from your own local assistant through the agent interface).

## Handoff (status and next steps)

Status at handoff. Everything below was built and checked on this machine with
synthetic data. The app repository `d-schmitt/open-sauce` is public; the
separate `d-schmitt/open-sauce-files` repository is private.

**Done and verified** (`npm test`: 62 of 62 pass; `npm run e2e:agent` and `npm run e2e:conflict` pass in headless Chrome; screenshots of browse, Apfelkuchen table, history, attempt editor, add-recipe help and draft review were taken and looked at):

- Cookbook storage (JSON per recipe, categories with tombstones, photos in `assets/`), versioned writes with `409`, the lock protocol, git-like history with Current, revisions, cooking attempts and branching, scaling, the preparation table with validation.
- Guided editor used for reviewing AI drafts, revisions and attempts; no blank "add recipe" form.
- Copilot canvas actions `list_recipes`, `get_recipe`, `submit_draft`; local agent interface with one private endpoint file per running instance.
- Photos added during review stay in memory until Save; revision drafts keep their base snapshot's photos; writes are bound to the cookbook a window was opened for.
- Sync logic (fast-forward only, refuses public or unverifiable destinations), tested against a local bare remote injected only in tests.

**Not done or not verified:**

- The private data repository `d-schmitt/open-sauce-files` exists and is empty. Sync has never been run against a real GitHub repository, and no cookbook is connected to it. Create or choose a cookbook folder, connect it to that private repository as described in "Sync with a private git repository", verify `gh auth status`, and press Sync yourself.
- The latest build was reloaded into this Copilot session's canvas and checked with synthetic data: `list_recipes` returned the demo cookbook, `submit_draft` placed a draft in review, and the recipe count stayed unchanged until the draft was dismissed. The canvas is session-scoped and has not been installed user-wide. No real recipe has been entered.
- No real family recipes have been entered. The limitations listed under "Known limitations" still apply.

**Next steps:**

1. Choose a cookbook folder outside the code folder and connect it to the private `open-sauce-files` repository. Then enter and review a first real recipe, save it, and try Sync.
2. Consider user-wide canvas installation later. Hosting and the other items in "Deferred" remain out of scope.
