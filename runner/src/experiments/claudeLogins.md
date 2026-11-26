---
id: claudeLogins
name: Existing Claude folders
title: Existing Claude folders: runner.json's claudeLogins lists folders the runner runs Claude in as logins of their own
added: 2026-11-26
on: false
reminder: 0f31ea8c
---

## What it does

Lets runner.json register Claude config folders you already have, such as `~/.claude-personal`, as logins, without moving them into the accounts folder: `"claudeLogins": [{ "id": "claude-personal", "dir": "~/.claude-personal" }]`. The id is optional and defaults to the folder's name without its leading dot. Each folder that exists shows up as a login, with the email from its `.claude.json`, the model from its `settings.json` and its `threadbear-token.json`, and the runner runs Claude with `CLAUDE_CONFIG_DIR` set to it. The path is used exactly as written, with only a leading `~` expanded, because Claude Code names its macOS Keychain item from that string and any other spelling reads as signed out. An entry whose id clashes with a built-in login (`claude-main`, `claude-3`, `codex-main`) or an earlier entry (an id an ACP agent uses is skipped too), whose folder is `~/.claude` (that is claude-main) or whose path isn't absolute is dropped with a warning. So is a second entry for a folder already listed or already a login, however it's spelled, or the home folder itself. The runner reads the list when it starts, so restart it after editing; a folder that doesn't exist yet is skipped and appears on a later rescan. hiddenLogins and accountNotes work on these logins as on any other.

## Lives in

`parseClaudeLogins` in `runner/src/config.ts`; `discoverAccounts` in `runner/src/accounts.ts`

## Taking it out

Delete `parseClaudeLogins` and the `claudeLogins` key in `config.ts`, the claudeLogins block in `discoverAccounts`, its test (`claude-logins.test.ts`), and the lines in `docs/guide.md` and `docs/on-your-mac.md`. Remove `claudeLogins` and its experiments key from runner.json.
