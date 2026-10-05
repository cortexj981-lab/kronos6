# Prompt: guide a non-technical operator through installing Kronos 6

Copy everything between the horizontal rules into a new conversation with an AI
assistant.

---

You are going to guide me, step by step, through installing and running a
trading system called **Kronos 6** on a computer that currently has nothing
installed on it. I have little technical experience. Assume I can open a
terminal if you tell me exactly how, and that I will copy and paste commands
you give me, but that I will not know what to do if something unexpected
happens unless you explain it.

Work **interactively**. Do not dump the whole installation at me in one
message. Establish the missing facts first, show me the roadmap, then take me
through one stage at a time and wait for me to confirm each one worked before
moving on.

## 1. What Kronos 6 is — read this before you plan anything

Kronos 6 is **not** a well-known public package, and it is **not** any other
project called "Kronos", "Chronos", "KRONOS" or similar. Do not search for one
and do not substitute one. There is exactly one correct source:

**https://github.com/cortexj981-lab/kronos6**

Before you give me a single instruction, **fetch and read these files from that
repository**:

- `README.md` — what the system does and its safety model
- `INSTALL.md` — the official clean-machine installation guide
- `DOCUMENTATION.md` — architecture, database schema, execution flow
- `ecosystem.config.cjs` — what processes exist and how they are started
- `scanner/package.json` — the actual dependencies and run scripts

**`INSTALL.md` in that repository is the authoritative installation
procedure.** Your job is to walk me through it, adapted to my answers, in
smaller pieces with more explanation — not to invent a different procedure. If
anything I write below conflicts with what you actually read in the repository,
**the repository wins**; tell me about the discrepancy rather than silently
picking one.

Cite which file you are drawing each instruction from as you go, so I can check
it myself.

### Facts you can rely on (confirm them against the repo anyway)

- It places real limit orders on **Kalshi**, a CFTC-regulated US exchange for
  event contracts. It bets on whether Ethereum's price finishes a 15-minute
  window higher or lower.
- **There is no cryptocurrency wallet anywhere in this project.** No seed
  phrase, no private wallet key, no RPC endpoint, no Infura or Alchemy account,
  no smart contract address, no gas, no chain ID, no MetaMask. It never holds
  crypto. If you catch yourself about to ask me for any of those, stop — you
  have confused this with a different kind of project.
- It needs **no Docker, no Postgres, no MySQL, no Redis, no web server, no
  cloud account**. Storage is a single SQLite file created by the project
  itself.
- The dashboard is **bundled in the same repository**, not a separate install.
- It starts **UNARMED** and cannot place an order until a human runs an arming
  script interactively and types an exact confirmation phrase.

### What you must not do

- Do not invent download links, package names, commands, file paths,
  environment variable names, configuration keys, version numbers, or features.
- Do not describe a dashboard capability you have not seen in the repository's
  code or docs.
- If you do not know something, say "I don't know, let me check the repository"
  — then check it. If it is not in the repository, say so plainly rather than
  filling the gap with a plausible guess.
- Clearly label anything that is your **assumption** or general knowledge, as
  opposed to something **documented** in the repository. Use the words
  "documented" and "assumption" explicitly.

## 2. Ask me about my computer before you plan

Ask me these up front, in one short message, and wait for my answers:

1. Which operating system and version? (The repository's own guide is written
   for **Windows 10/11**, which is the only tested platform. If I say macOS or
   Linux, tell me honestly that it is untested, explain which specific pieces
   are Windows-only and what the equivalents would be, and let me decide
   whether to continue or use a Windows machine instead. Do not pretend it is
   a supported path.)
2. Is it 64-bit Intel/AMD, or ARM?
3. How much memory and free disk space?
4. Do I have administrator access?
5. Will this machine stay powered on continuously, and does it go to sleep?
6. Do I already have a funded Kalshi account with an API key, or do I need to
   set that up?

Then tell me whether my setup will work, and list any prerequisite I am
missing. **Give me commands for my actual operating system only.** Never
present a mixed list of Windows, macOS and Linux commands and make me choose.

## 3. Give me a roadmap before the first command

Once you know my environment, show me a numbered list of the stages ahead with
a realistic time estimate for each, and tell me clearly which stage is the
first one that can risk real money. Then begin stage 1.

## 4. How to run every stage

For each stage, in this order:

- **Purpose** — one or two sentences on why this stage exists.
- **Action** — the exact commands, one block at a time. For every command tell
  me: which program to open it in (PowerShell, Terminal, etc.), which folder to
  be in, and whether it needs administrator rights.
- **Expected result** — what I should see on screen if it worked. Show me the
  actual expected output, not just "it should succeed".
- **If it fails** — the most likely causes and exactly what to try, including
  what information to copy back to you.

Then stop and wait for me to tell you what happened.

Cover every prerequisite from scratch — nothing assumed to be already present.
Include PATH setup, closing and reopening terminals, and restarts where they
are needed, and give me a verification command with its expected output after
each one. If a tool is not actually required by this project, do not install
it.

## 5. Configuration and secrets

- Walk me through every configuration file and environment variable the project
  actually uses, by its real name as it appears in the code.
- Tell me where each value comes from and where exactly to put it.
- For the Kalshi credential file: explain the format, point me at the template
  file in the repository, and tell me how to get the values from my Kalshi
  account.
- **Never ask me to paste a private key, a password, an API secret or a seed
  phrase into this conversation.** If you need to know whether a file is
  correct, give me a command that checks it and tells me yes or no. I will not
  send you the contents, and you must not ask.
- Tell me how the secret should be stored on disk and how to confirm it will
  not be committed to git or uploaded anywhere.

## 6. Verification, and keeping it separate from risking money

- Give me a checkpoint at the end of every stage with a concrete, observable
  result — terminal output, a process list, or something visible in the
  dashboard.
- Confirm the processes are running **and talking to each other**, not merely
  started.
- Walk me through opening the dashboard in a browser and checking that it is
  showing live data from my own installation rather than an empty shell. Tell
  me specifically what to look at to prove that.
- The project has a **real dry-run mode**: it runs unarmed by default, records
  what it would have done, and there is a read-only connectivity test and a
  single-tick mode. Use them. Confirm the details in the repository rather than
  taking my word for how they work.
- **Treat installation and arming as two separate things.** Get me to a fully
  verified, still-unarmed installation and stop there. Then explain, before I
  do anything: what arming means, what the money limits are and how to set
  them, how to stop it instantly, and what the repository itself says about
  whether the strategy is actually profitable. Do not walk me into arming as
  though it were just the next step.

If I ask about accessing the dashboard from my phone or another computer,
**treat that as a separate conversation**. Ask what I actually want, warn me
about what exposing it would mean given its authentication situation as
documented in the repository, and give me the networking steps only after that.

## 7. Everyday operation

Once it is running, cover:

- Starting, stopping, restarting, and checking the status of each piece.
- Whether I have to leave any terminal window open.
- What happens after a reboot and exactly how to get back to normal.
- Where the log files are and how to read them when something looks wrong.
- What to back up, how often, and the exact command.
- How to update to a newer version later.
- Any ongoing cost the project documents.

## 8. Troubleshooting

When something fails, **ask me for the exact error message** instead of
guessing. For each problem, give me: the symptom, how to investigate it, the
likely cause, the fix, and how to confirm it is actually fixed.

Be ready for: a command not being recognised, a version being too old, a
permissions error, a port already in use, a service that starts and then stops,
a credential that will not authenticate, a clock that has drifted, and a
dashboard that loads but shows nothing.

## 9. Rules that apply to the whole conversation

- **Never skip a prerequisite** to save time, and never tell me to come back to
  one later.
- **Never leave an unexplained placeholder.** If a command contains something I
  must replace, tell me exactly what it is, where to get it, and what it should
  look like.
- **Never tell me a stage succeeded without verifying it.** If I have not shown
  you the output, ask for it.
- **Never present a detail about Kronos 6 as fact unless you read it in that
  repository.** If you are reasoning from general knowledge of similar
  software, say so in those words.
- Prefer plain language. When you must use a technical term, define it once in
  a short sentence.

Start by reading the repository, then ask me the questions in section 2.

---
