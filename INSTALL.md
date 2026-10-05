# Installing Kronos 6 on a clean machine

This guide takes a computer with nothing installed to a **running, verified,
UNARMED** Kronos 6. Unarmed means it does everything except place orders: it
scans the market every 15 seconds, applies the full strategy, and records what
it *would* have done. No money moves.

Arming live trading is a separate, deliberate step at the very end
([Stage 9](#stage-9--arming-live-trading-real-money)). You can stop before it
and still have a complete, working installation.

**Nothing in this guide asks you to paste a private key, a password, or any
secret into a chat window.** If something tells you to, it is wrong.

---

## Before you start — what you need

| | |
|---|---|
| **A Windows PC** | Windows 10 or 11. This is the only tested platform. See [Other operating systems](#other-operating-systems). |
| **Administrator access** | Needed to install Node.js and the global PM2 package. |
| **A machine that stays on** | The strategy evaluates every 15 seconds. A sleeping laptop trades nothing. |
| **Disk space** | Under 1 GB. The ledger database is a few megabytes; `node_modules` is most of it. |
| **A Kalshi account** | Real, funded, identity-verified, with an API key you generate yourself. Confirm Kalshi is available to you where you live and that you accept its terms — that is yours to check, not this guide's. |

**You do NOT need:** a crypto wallet, a seed phrase, an RPC provider, an
Infura/Alchemy key, a smart contract address, Docker, Postgres, or a web
server. If any instruction mentions those, it is not describing this project.

---

## Stage 1 — Install Node.js

**Why:** the scanner, the dashboard and every operator script are Node
programs. The project stores its data using Node's built-in `node:sqlite`
module, which only exists in recent versions.

**Do this:**

1. Go to <https://nodejs.org/en/download>.
2. Download the **Windows Installer (.msi), 64-bit**, for the current **LTS**
   release (or newer).
3. Run it. Accept the defaults — in particular leave **"Add to PATH"** ticked.
4. **Close every open terminal window.** PATH changes only reach new windows.

**Verify** — open a *new* PowerShell window and run:

```powershell
node --version
npm --version
```

**Expected:** a version of `v22.5.0` or higher for node, and any version for
npm. This project is verified on `v25.9.0`.

**If it fails:** `node` not recognised almost always means the terminal was
open before the install. Close it and open a new one. If it still fails,
restart the computer and try again.

---

## Stage 2 — Install Git

**Why:** to download this repository, and to pull updates later.

**Do this:** download and run the installer from <https://git-scm.com/download/win>.
Accept every default.

**Verify** (new terminal):

```powershell
git --version
```

**Expected:** `git version 2.x.x` or similar.

---

## Stage 3 — Install PM2

**Why:** PM2 is the supervisor. It keeps the scanner and dashboard running and
restarts them if they crash. Without it you would have to leave terminal
windows open forever.

**Do this** — in PowerShell:

```powershell
npm install -g pm2
```

**Verify:**

```powershell
pm2 --version
```

**Expected:** a version number, e.g. `6.0.13`.

> **Remember how you opened this terminal.** PM2 starts a background daemon
> owned by whoever launched it. If you first run PM2 from an **Administrator**
> terminal, every later `pm2` command from a normal terminal fails with an
> `EPERM` permission error — and each failure leaves an orphaned daemon behind.
> Pick one and stay consistent. A normal (non-admin) terminal is the simpler
> choice; use it for every PM2 command from here on.

---

## Stage 4 — Download Kronos 6

**Why:** get the source onto the machine.

**Do this** — choose a folder with no spaces in its path:

```powershell
cd C:\
git clone https://github.com/cortexj981-lab/kronos6.git Kronos6
cd C:\Kronos6
```

**Verify:**

```powershell
dir
```

**Expected:** you can see `README.md`, `INSTALL.md`, `ecosystem.config.cjs`,
and the folders `scanner`, `dashboard`, `scripts`, `db`.

> The repository works from any folder. Paths resolve at runtime, so there is
> nothing to edit in `ecosystem.config.cjs` before starting it. Every command
> below assumes you cloned to `C:\Kronos6` — substitute your own path if you
> chose differently.

---

## Stage 5 — Install the project's dependencies

**Why:** the scanner is written in TypeScript and runs through `tsx`, which
executes TypeScript directly with no build step.

**Do this:**

```powershell
cd C:\Kronos6\scanner
npm install
```

**Verify:**

```powershell
npm run typecheck
```

**Expected:** no output and the prompt returns. Silence means the TypeScript
compiler found no errors.

**If it fails:** read the first error, not the last. `Cannot find module`
usually means `npm install` did not finish — run it again and watch for
network errors.

> The dashboard and the operator scripts have **no dependencies of their own**.
> There is nothing to install in `dashboard/` or `scripts/`.

---

## Stage 6 — Add your Kalshi credentials

**Why:** every request to Kalshi is cryptographically signed with your private
key. Without it the scanner starts, fails its validation checks, and refuses
to trade — by design.

**Get the credentials:** in your Kalshi account settings, create an API key.
Kalshi gives you two things: an **API Key ID** (it looks like a UUID) and a
**private key file**. Kalshi shows the private key **once** and cannot show it
again. If you lose it, delete that key and create another.

**Do this:**

1. Copy `KalshiAPIKeyFullAccess.example.txt` to `KalshiAPIKeyFullAccess.txt`
   in the repository root — the same folder as `README.md`:

   ```powershell
   cd C:\Kronos6
   copy KalshiAPIKeyFullAccess.example.txt KalshiAPIKeyFullAccess.txt
   ```

2. Open `KalshiAPIKeyFullAccess.txt` in Notepad.
3. Follow the instructions inside it: first line is the API Key ID, then the
   PEM private key block exactly as Kalshi supplied it, line breaks intact.
4. Save and close.

**Verify:**

```powershell
cd C:\Kronos6
git status --short
```

**Expected:** `KalshiAPIKeyFullAccess.txt` does **not** appear in the list. It
is git-ignored. If you see it listed, stop and fix `.gitignore` before you
commit anything.

> **Security.** This key can place and cancel orders on a funded account.
> Never paste its contents into a chat, an issue, or a screenshot. Nobody
> needs to see it to help you. If it leaks, revoke the key in Kalshi
> immediately — revocation is instant and free.

---

## Stage 7 — Create the database

**Why:** Kronos 6 keeps every trade, every decision and every setting in a
single SQLite file at `db/kronos6.db`.

**Do this:**

```powershell
cd C:\Kronos6\scanner
npm run init-db
```

**Verify:**

```powershell
npm run test-fees
```

**Expected:** the fee tests pass. This checks the exchange's fee formula, which
is what decides whether a bet is worth taking.

---

## Stage 8 — Dry run (no money at risk)

This is the real proof the installation works. **Live trading is still
unarmed**, so nothing here can place an order.

### 8a. Connectivity check — read-only

```powershell
cd C:\Kronos6\scanner
node --experimental-sqlite --import tsx/esm ..\scripts\connectivity_test.mjs
```

**What it does:** signs real requests to Kalshi and confirms the safety gate
blocks everything except the one order endpoint. It never places an order.

**Expected:** a list of checks, all passing, including that your balance can be
read and that deposits, withdrawals and `api_keys` paths are refused by
construction.

**If it fails:** an authentication error means the credential file is wrong —
most often the PEM block was pasted onto one line, or the API Key ID line is
missing. A clock error means your Windows clock has drifted: right-click the
clock → *Adjust date and time* → **Sync now**.

### 8b. One scan, unarmed

```powershell
npm run scan-once
```

**What it does:** runs exactly one evaluation tick and exits.

**Expected:** log lines showing the strategy evaluating the current 15-minute
window and recording a decision. Because the system is unarmed, any decision to
bet is recorded as `DRY_RUN` and no order is sent. **A decision of "no trade" is
a normal, healthy result** — the strategy is selective and most windows do not
qualify.

### 8c. Start the services

```powershell
cd C:\Kronos6
pm2 start ecosystem.config.cjs
pm2 save
pm2 list
```

**Expected:** three processes `online` — `kronos6-scanner`,
`kronos6-metrics`, `kronos6-dashboard`.

**If a process shows `errored`:** read its log before restarting it:

```powershell
pm2 logs kronos6-scanner --lines 50
```

### 8d. Open the dashboard

Open a browser on this computer and go to:

**<http://localhost:3006>**

**Expected:** the Kronos 6 dashboard with a **LIVE MONEY** banner, showing the
armed/disarmed state, recent decisions with the reason each was declined, and
a price chart. It should say the system is **disarmed**.

**Confirm it is showing real data**, not a placeholder: the "last heartbeat"
time should be within the last minute or so, and the decisions table should
gain a new row roughly every 15 seconds. Refresh after a minute and check the
timestamp moved.

**If the page does not load:** see [Troubleshooting](#troubleshooting).

> **The dashboard has no password.** It is served on port 3006 with no
> authentication of any kind. On a home network behind a router that is
> normally fine. Do not forward port 3006 through your router, and do not run
> this on a public or shared network, without putting authentication in front
> of it first. It reads the database read-only and cannot place a trade, but it
> does display your account balance.

---

## Stage 9 — Arming live trading (REAL MONEY)

> **Everything above this line risks nothing. This step does.**
>
> Do not continue until the dry run is clean, you have watched the dashboard
> record decisions for a while, and you accept that you may lose the money in
> the account. The authors do not claim this strategy is profitable; a search
> over 21 alternative rule sets found none that survived statistical
> correction.

**Set your limits first.** These are stored in the database, and the running
scanner re-reads them within seconds — no restart needed:

```powershell
cd C:\Kronos6\scanner
node --experimental-sqlite ..\scripts\set-stake.mjs 5          # dollars per trade, $25 hard cap
node --experimental-sqlite ..\scripts\set-stop-loss.mjs 90     # halt if balance falls to this
node --experimental-sqlite ..\scripts\set-take-profit.mjs 150  # halt if balance reaches this
```

**Then arm it.** This must be typed by a human at a real keyboard; the script
refuses to run unattended:

```powershell
node --experimental-sqlite ..\scripts\arm-live-trading.mjs
```

It will ask you to type the exact phrase **`ARM LIVE TRADING`**. Anything else
aborts and leaves the system unarmed.

**Verify:** refresh <http://localhost:3006>. The banner now shows **ARMED**.
The running scanner picks the change up within one 15-second poll.

**To stop at any time** — always safe, takes effect within seconds:

```powershell
node --experimental-sqlite ..\scripts\disarm-live-trading.mjs
```

---

## Everyday operation

| Task | Command |
|---|---|
| See what is running | `pm2 list` |
| Watch the scanner live | `pm2 logs kronos6-scanner` |
| Stop everything | `pm2 stop all` |
| Start everything | `pm2 start all` |
| Restart one process | `pm2 restart kronos6-dashboard` |
| Disarm (stop trading) | `node --experimental-sqlite ..\scripts\disarm-live-trading.mjs` from `scanner\` |

**You do not need to keep a terminal open.** PM2 runs the processes in the
background. Closing the window you started them from does not stop them.

**After a reboot**, PM2 does **not** come back on its own — it is not installed
as a Windows service. Open a terminal and run:

```powershell
pm2 resurrect
```

Then check `pm2 list` and the dashboard. **If the system was armed before the
reboot it is still armed** — the setting lives in the database, not in the
process. Check the dashboard banner.

**Logs** are written next to the code: `scanner\scanner.log` and `.err`,
`dashboard\dashboard.log` and `.err`, `scripts\metrics.log` and `.err`.

**Backups.** The only irreplaceable file is `db\kronos6.db`. SQLite keeps
recent writes in side files, so copy **all three** or you will get a silently
out-of-date snapshot:

```powershell
copy C:\Kronos6\db\kronos6.db*  D:\backups\
```

**Updates:**

```powershell
cd C:\Kronos6
git pull
cd scanner
npm install
cd ..
pm2 restart all
```

**Recurring costs:** none for the software. Kalshi charges a trading fee per
contract, taken at the moment an order fills; the fee formula is implemented in
`scanner/fees.ts` and is the dominant cost at this stake size.

---

## Troubleshooting

**`node` / `npm` / `git` / `pm2` is not recognised**
PATH was not picked up. Close the terminal, open a new one. If it persists,
restart the computer. Verify with `node --version`.

**Every `pm2` command fails with `EPERM`**
The PM2 daemon was started from a terminal with different privileges than the
one you are using now. Re-run the command from the same kind of terminal
(Administrator vs normal) you first used. Do not kill the daemon while trading
is armed.

**`pm2 list` shows a process `errored` or constantly restarting**
Read its log first: `pm2 logs <name> --lines 50`. Restarting without reading
just repeats the crash.

**The dashboard will not open**
Check it is running (`pm2 list`), then check whether something else already
holds port 3006:

```powershell
netstat -ano | findstr :3006
```

If another program has it, run the dashboard on a different port:

```powershell
pm2 stop kronos6-dashboard
$env:K6_DASH_PORT=3010
pm2 start ecosystem.config.cjs --only kronos6-dashboard
```

Then use <http://localhost:3010>.

**The dashboard loads but shows no recent activity**
The dashboard only reads the database — it does not talk to Kalshi. A stale
heartbeat means the **scanner** is the problem, not the dashboard. Check
`pm2 logs kronos6-scanner`.

**Authentication / signature errors from Kalshi**
The credential file is malformed in nine cases out of ten. Confirm line 1 is
the API Key ID alone, and that the PEM block kept its original line breaks. If
in doubt, create a fresh API key in Kalshi and rebuild the file. Do not paste
the file's contents anywhere to ask for help.

**Clock skew errors**
Kalshi rejects requests whose timestamp has drifted. Sync the Windows clock:
right-click the clock → *Adjust date and time* → **Sync now**.

**It has not traded in days**
Usually correct behaviour, not a fault. The strategy is selective and many
windows do not qualify. The dashboard's decisions table shows which gate
declined each evaluation. Confirm the heartbeat is fresh and the banner does
not say halted.

**The system halted itself**
A halt means the ledger audit found the account balance disagreeing with the
recorded trades by more than 50 cents, or a stop was hit. That is a safety
feature. Investigate the cause in the dashboard and the scanner log before
clearing it with `scripts/clear-halt.mjs`.

---

## Other operating systems

The scanner, dashboard and scripts are plain Node and have no Windows-specific
code. The surrounding operational pieces **are** Windows-specific:

- `ecosystem.config.cjs` sets `windowsHide`, which other platforms ignore
  harmlessly.
- `scripts/take-profit-watch.vbs` is a Windows Script Host launcher and has no
  equivalent elsewhere; on macOS or Linux you would run
  `take-profit-watch.mjs` under `cron` or a `systemd` timer instead.
- Every path in this guide is a Windows path.

Running on macOS or Linux is therefore plausible but **untested**. Nothing in
this repository verifies it. Treat it as a port, not an install.
