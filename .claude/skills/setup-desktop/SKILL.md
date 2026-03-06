---
name: setup-desktop
description: Set up NanoClaw Desktop with Lume macOS VM, Telegram bot, and Claude authentication. Use this for first-time installation on macOS with the Desktop (Lume) runtime. Triggers on "setup desktop", "setup lume", "install desktop".
---

# NanoClaw Desktop Setup

Run all commands automatically. Only pause when user action is required (Telegram bot creation, configuration choices).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Known Pitfalls — READ BEFORE STARTING

These are real issues encountered during setup. Follow this guidance to avoid them:

1. **Lume CLI syntax**: Uses positional args, NOT `--name`. Correct: `lume run my-vm`, `lume get my-vm`. Wrong: `lume run --name my-vm`. No `--display` flag exists (display is on by default, use `--no-display` to disable).

2. **VM setup is automated via `--unattended tahoe`**: `lume create` with the `--unattended tahoe` flag automatically completes the macOS Setup Assistant, creates user `lume`/`lume`, and enables SSH. Requires `sshpass` (`brew install hudochenkov/sshpass/sshpass`). After creation, SSH in to configure Automatic Login (not covered by the preset).

3. **SSH works after unattended setup**: The `tahoe` preset includes an SSH health check that verifies connectivity. If SSH fails after unattended setup, something went wrong — use `--debug` to capture screenshots and troubleshoot.

4. **VM user has no sudo/admin**: Homebrew install will fail. Use Node.js prebuilt binary (`~/local/bin`) instead of `brew install node`.

5. **SSH non-login shell misses PATH**: `~/.zshrc` is not sourced in SSH commands. The lume-runner already prepends `$HOME/local/bin` to PATH, but verify Node.js is reachable: `ssh lume@IP '$HOME/local/bin/node --version'`.

6. **`lume get` reports wrong status**: May show "stopped" and IP as null/`-` even when VM is running. Always test SSH directly rather than trusting `lume get` status. Set `LUME_VM_IP` in `.env` as a reliable fallback.

7. **`ensureLumeVmRunning` causes VNC popups**: If it tries to start a VM that's already running, it spawns a conflicting instance. The code now checks SSH first. If VNC popups appear, it means the SSH-first check is not working.

8. **launchd doesn't load `.env`**: The plist MUST include `--env-file=.env` in ProgramArguments. Without it, `LUME_VM_NAME`, `LUME_VM_IP`, `TELEGRAM_BOT_TOKEN` etc. will all be missing.

9. **agent-runner must be built**: `container/agent-runner/dist/` doesn't exist by default. Run `npm install && npx tsc` inside `container/agent-runner/` before first use.

10. **Telegram bot privacy**: Bots in groups can only see `/commands` by default. User must either disable privacy via BotFather (`/setprivacy` → Disable) or make bot a group admin. Tell them BEFORE testing.

11. **Assistant name is set via `.env`**: Set `ASSISTANT_NAME=YourName` in `.env`. The `CLAUDE.md` persona files are auto-generated from `.default` templates on startup. No need to manually edit them.

12. **Bot must be running for `/chatid`**: The bot only responds to `/chatid` when NanoClaw is running. Build and start it (`npx tsx --env-file=.env src/index.ts`) BEFORE asking the user to send `/chatid`.

13. **VM name mismatch**: Three places can disagree on VM name: `lume create` defaults to `default`, user may have an existing VM with a different name (e.g. `my-vm`), and code defaults `LUME_VM_NAME` to `nanoclaw-vm`. After identifying the actual VM name (via `lume ls`), MUST set `LUME_VM_NAME=actual-name` in `.env`. Use the actual VM name consistently in all `lume` commands throughout setup.

14. **Telegram group registration is in SQLite, not JSON**: On first run, `data/registered_groups.json` is migrated into SQLite (`store/messages.db`, table `registered_groups`). After that, the JSON file is renamed to `.migrated` and ignored. All registration changes must go through SQL inserts, not JSON file edits.

15. **`folder` column is UNIQUE**: Each registered chat must have a unique folder name. Two chats cannot share the same folder. If registering both a group and a DM, use different folders (e.g. `main` for group, `username-dm` for DM).

16. **DM (private chat) must be registered separately**: The group chat ID (negative, e.g. `tg:-1234567890`) and the DM chat ID (positive, e.g. `tg:1234567890`) are completely different. If the user wants both group and DM to work, register both with separate folders and both with `requires_trigger=0`.

17. **Telegram long-polling can go stale**: After the bot runs for a long time, the Telegram polling connection may silently drop. Messages arrive but the bot doesn't see them. The launchd `KeepAlive` auto-restarts on crash, but silent polling failures don't crash. If the user reports "no response", first try restarting the service.

18. **NEVER start `lume run` as a Claude Code subprocess**: `lume run` is a blocking foreground process — the VM lives only as long as it does. If started via Bash tool (even with `run_in_background`), it becomes a child of Claude Code and gets killed when the session ends, stopping the VM. For **existing VMs**, don't start `lume run` at all — NanoClaw's `ensureLumeVmRunning()` manages it automatically via detached spawn. For **fresh VMs**, `lume create --unattended tahoe` handles setup without needing a display window, so no separate terminal is needed.

19. **VM must have Automatic Login enabled**: The patchright anti-detection browser runs in headed mode and requires an active GUI session (WindowServer). Without auto-login, the VM boots to a lock screen and Chromium cannot render. Configure in the VM: System Settings → Users & Groups → Automatic Login → select `lume`.

20. **Enabling Forum Topics changes the chat ID**: When Forum Topics are enabled on a Telegram group, Telegram converts it to a supergroup with a **completely new chat ID** (e.g. `-5275811457` → `-1003766556846`). The old registered JID becomes stale and all messages are silently dropped. NanoClaw auto-migrates if it sees the `migrate_to_chat_id` event, but if topics were enabled while the bot was offline, you must manually update: `sqlite3 store/messages.db "UPDATE registered_groups SET jid = 'tg:NEW_ID' WHERE jid = 'tg:OLD_ID';"`. Use `/chatid` in the group to get the new ID.

---

## 1. Install Dependencies

```bash
npm install
```

## 2. Configure Claude Authentication

Ask the user:
> Choose your AI model provider:
>
> 1. **Claude Subscription** (Pro/Max) - Official Claude models
> 2. **Anthropic API Key** - Use API key to access Claude
> 3. **智谱 GLM-5.0** - Chinese GLM-5.0 model (requires GLM Coding plan)

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Either:
> 1. Paste it here and I'll add it to `.env` for you, or
> 2. Add it to `.env` yourself as `CLAUDE_CODE_OAUTH_TOKEN=<your-token>`

If they give you the token, write it to `.env` using the Write tool. **Never echo the full token in commands or output.**

### Option 2: Anthropic API Key

Ask if they have an existing key or need to create one at https://console.anthropic.com/

Write to `.env`:
```
ANTHROPIC_API_KEY=<their-key>
```

### Option 3: 智谱 GLM-5.0 (requires GLM Coding plan)

Tell the user:
> 1. Visit [智谱AI开放平台](https://open.bigmodel.cn/) to register an account
> 2. Purchase **GLM Coding plan** (supports Claude Code API compatibility)
> 3. Get API Key from the console
> 4. Paste the API Key here, or add it to `.env` yourself

If they provide the API Key, write to `.env`:

```
GLM_API_KEY=<their-key>
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.0
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.0
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.0
API_TIMEOUT_MS=3000000
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

**Note:** 智谱 GLM uses a dedicated endpoint. You must configure `ANTHROPIC_BASE_URL` to `https://open.bigmodel.cn/api/anthropic`

## 3. Install and Configure Lume VM

### 3a. Check if Lume is installed

```bash
which lume && lume --version || echo "Lume not installed"
```

If not installed, tell the user:
> NanoClaw Desktop uses [Lume](https://github.com/trycua/cua) to run agents in a macOS VM with a real desktop.
>
> Install Lume:
> ```
> brew install trycua/cua/lume
> ```
>
> Let me know when it's installed.

Wait for confirmation, then verify:
```bash
lume --version
```

### 3b. Create or locate the VM

Check if a VM already exists:
```bash
lume ls 2>/dev/null
```

**Important:** Lume CLI uses positional arguments, NOT `--name`:
- Correct: `lume run my-vm`, `lume get my-vm`
- Wrong: `lume run --name my-vm`, `lume get --name my-vm`
- Display is on by default. There is no `--display` flag, only `--no-display`.

#### Case A: Existing VM (already set up with SSH)

If a VM already exists, test if SSH works:
```bash
ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no lume@VM_IP 'echo SSH OK' 2>/dev/null
```

If SSH succeeds → the VM is set up. **Skip to step 3d.** NanoClaw's `ensureLumeVmRunning()` will manage starting/stopping the VM automatically via detached `lume run` when the service starts.

If the VM exists but SSH fails (VM stopped or SSH not configured), try starting it first:
```bash
lume run VM_NAME --shared-dir PROJECT_ROOT --no-display &
sleep 30
ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no lume@VM_IP 'echo SSH OK'
```
If SSH works now → skip to step 3d. If still failing → the VM needs manual macOS setup; follow Case B.

#### Case B: Fresh VM (automated unattended setup)

If no VM exists, first ensure `sshpass` is installed (required by the unattended health check):
```bash
which sshpass || brew install hudochenkov/sshpass/sshpass
```

Then create the VM with unattended setup:
```bash
lume create default --os macos --ipsw latest --unattended tahoe
```

This downloads a macOS restore image, boots the VM, and automatically:
- Navigates the macOS Setup Assistant (language, region, terms, etc.)
- Creates user `lume` with password `lume`
- Enables SSH (Remote Login)
- Verifies SSH connectivity via health check

The whole process takes several minutes (large download + automated UI navigation). If it fails, retry with `--debug` to capture screenshots:
```bash
lume create default --os macos --ipsw latest --unattended tahoe --debug
```
Debug screenshots are saved to `/tmp/unattended-<uuid>/`.

### 3c. Post-setup: Enable Automatic Login

After unattended setup completes, the VM has SSH access but still needs Automatic Login configured (required for the patchright anti-detection browser, which runs in headed mode and needs an active GUI session).

Start the VM headless, then configure via SSH:
```bash
lume run default --no-display &
sleep 30
```

Enable Automatic Login:
```bash
sshpass -p "lume" ssh -o StrictHostKeyChecking=no lume@$(lume get default --format json 2>/dev/null | grep -o '"ipAddress":"[^"]*"' | cut -d'"' -f4) \
  'echo "lume" | sudo -S defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser lume'
```

Stop the VM (NanoClaw will manage it from here):
```bash
lume stop default
```

### 3d. Get the VM IP and set up SSH key access

```bash
lume get VM_NAME --format json
```

Extract the IP address from the JSON output (`ipAddress` field).

**Note:** `lume get` may report status as "stopped" even when the VM is running. If `ipAddress` is null, try the table format or test SSH directly to `192.168.64.x` subnet.

Test SSH with password first:
```bash
sshpass -p "lume" ssh -o StrictHostKeyChecking=no lume@VM_IP echo "SSH OK"
```

If `sshpass` is not installed:
```bash
brew install hudochenkov/sshpass/sshpass
```

Then set up key-based SSH (so NanoClaw can connect without a password):
```bash
# Generate SSH key if none exists
ls ~/.ssh/id_*.pub 2>/dev/null || ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q

# Copy key to VM
sshpass -p "lume" ssh-copy-id -o StrictHostKeyChecking=no lume@VM_IP
```

Verify passwordless SSH:
```bash
ssh -o StrictHostKeyChecking=no lume@VM_IP echo "SSH OK"
```

### 3e. Install Node.js inside the VM

The VM user may not have admin/sudo privileges, so use a prebuilt binary instead of Homebrew:

```bash
ssh lume@VM_IP 'bash -s' << 'SETUP'
curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.xz -o /tmp/node.tar.xz
mkdir -p ~/local
tar -xJf /tmp/node.tar.xz -C ~/local --strip-components=1
echo 'export PATH="$HOME/local/bin:$PATH"' >> ~/.zshrc
export PATH="$HOME/local/bin:$PATH"
node --version && npm --version && echo "Node installed successfully"
SETUP
```

### 3f. Build the agent-runner

The agent-runner must be compiled before the VM can use it:

```bash
cd PROJECT_ROOT/container/agent-runner && npm install && npx tsc
cd PROJECT_ROOT
```

Verify:
```bash
ls container/agent-runner/dist/index.js
```

### 3g. Configure shared directory and verify

Lume VMs use VirtioFS for host-VM file sharing (passed via `--shared-dir` when starting the VM). The NanoClaw data directories must exist:

```bash
# Ensure data directories exist
mkdir -p data/ipc data/sessions
mkdir -p groups/global
```

Verify from inside the VM:
```bash
ssh lume@VM_IP ls "/Volumes/My Shared Files/"
```

The project root contents should be visible.

### 3h. Add VM config to .env

Add the VM name and IP to `.env` so NanoClaw can find it:

```
LUME_VM_NAME=VM_NAME
LUME_VM_IP=VM_IP
```

The `LUME_VM_IP` is a reliable fallback — `lume get` sometimes reports incorrect status/IP.

## 4. Set Up Telegram Bot

### 4a. Create a bot

Tell the user:
> You need a Telegram bot. If you already have one, give me the token. Otherwise:
>
> 1. Open Telegram and message [@BotFather](https://t.me/BotFather)
> 2. Send `/newbot`
> 3. Choose a name (e.g. "My Assistant")
> 4. Choose a username (must end in `bot`, e.g. `my_assistant_bot`)
> 5. Copy the token BotFather gives you and paste it here

Once you have the token, add to `.env`:
```
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_ONLY=true
```

### 4b. Disable bot privacy mode

Tell the user:
> **Important:** By default, Telegram bots in groups can only see `/commands` and direct @mentions. To let the bot see all messages:
>
> 1. Message **@BotFather** on Telegram
> 2. Send `/setprivacy`
> 3. Select your bot
> 4. Choose **Disable**
>
> Alternatively, make the bot an **admin** in the group (admins can see all messages).

### 4c. Enable Forum Topics (recommended)

Tell the user:
> For multi-project isolation, your Telegram group should have **Forum Topics** enabled:
>
> 1. Create a new Telegram group (or use an existing one)
> 2. Go to Group Settings → Topics → Enable
> 3. Add your bot to the group and make it an admin
> 4. Create topics for different projects

### 4d. Get the Chat IDs

The bot must be running to respond to `/chatid`. Build and start it first:

```bash
npm run build
```

Run briefly (set Bash tool timeout to 15000ms):
```bash
npx tsx --env-file=.env src/index.ts
```

NanoClaw Desktop uses **two Telegram channels** by default:
- **DM (direct message)** — admin channel, all messages processed, for personal/admin tasks
- **Group chat** — project channel with Forum Topics, each topic = isolated workspace

Tell the user:
> Send `/chatid` to your bot in **two places**:
>
> 1. **In a direct message to the bot** — this is your **admin channel** (positive number, e.g. `tg:1234567890`)
> 2. **In the Telegram group** (General topic if Forum Topics enabled) — this is your **project channel** (negative number, e.g. `tg:-1234567890`)

Collect both chat IDs, then stop the temporary process.

## 5. Configure Assistant Name and Register Channels

### 5a. Ask for trigger word

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> In group chats, messages starting with `@TriggerWord` will activate the agent.
> In DM, the trigger is not needed — all messages are processed.

### 5b. Register both channels

On first run, NanoClaw reads `data/registered_groups.json`, migrates it into SQLite (`store/messages.db`), and renames the JSON to `.migrated`. So:

- **Before first run**: write `data/registered_groups.json` (recommended for fresh setup)
- **After first run**: the JSON is gone — use SQL to insert into `store/messages.db`

#### Fresh setup (before first run) — write JSON

**Always register both DM and Group.** Each entry MUST have a unique `folder` value.

**Folder naming convention:** `{label}-dm` for DM, `{label}-forum` for groups. The label defaults to `ASSISTANT_NAME` lowercased (e.g. `andy`). This keeps folder names human-readable and avoids confusion with system-level "workspace" terminology.

- **DM** (`folder: "{label}-dm"`): admin channel with elevated privileges, `requiresTrigger: false`, `isAdmin: true`
- **Group** (`folder: "{label}-forum"`): working channel with per-topic isolation

Ask the user whether the group needs a trigger word:
> Does your Telegram group have other people besides you and the bot?
> - **Yes** → trigger word required (`requiresTrigger: true`) to avoid responding to every message
> - **No, just me and the bot** → no trigger needed (`requiresTrigger: false`)

Write `data/registered_groups.json` (use `ASSISTANT_NAME` lowercased as folder prefix, e.g. `andy`):

```json
{
  "DM_CHAT_JID": {
    "name": "ASSISTANT_NAME",
    "folder": "LABEL-dm",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP",
    "runtime": "lume",
    "requiresTrigger": false,
    "isAdmin": true
  },
  "GROUP_CHAT_JID": {
    "name": "ASSISTANT_NAME",
    "folder": "LABEL-forum",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP",
    "runtime": "lume",
    "requiresTrigger": false
  }
}
```

Where `LABEL` is `ASSISTANT_NAME` lowercased (e.g. `Andy` → `andy-dm`, `andy-forum`).

Create the project folder:
```bash
mkdir -p groups/LABEL-forum
```

The JSON will be auto-migrated to SQLite on first startup.

#### After first run — use SQL

If the database already exists (JSON was already migrated), use SQL instead:

```sql
-- Admin DM channel (bot_id is auto-backfilled on first startup if NULL, is_admin=1 for admin privileges)
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, runtime, bot_id, is_admin)
  VALUES ('DM_CHAT_JID', 'ASSISTANT_NAME', 'LABEL-dm', '@ASSISTANT_NAME', 'CURRENT_ISO_TIMESTAMP', NULL, 0, 'lume', NULL, 1);"

-- Project group channel (set requires_trigger=1 if group has other people, 0 if just user+bot)
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, runtime, bot_id, is_admin)
  VALUES ('GROUP_CHAT_JID', 'ASSISTANT_NAME', 'LABEL-forum', '@ASSISTANT_NAME', 'CURRENT_ISO_TIMESTAMP', NULL, 0, 'lume', NULL, 0);"
```

The `bot_id` is set to NULL here — it will be automatically backfilled with the default bot's ID on startup. To add more bots later, use `/add-telegram-bot`.

Verify:
```bash
sqlite3 store/messages.db "SELECT jid, name, folder, requires_trigger, bot_id, is_admin FROM registered_groups;"
```

**Important:**
- Set `runtime` to `'lume'` — tells NanoClaw to use the Lume VM
- DM = `requiresTrigger: false` / `requires_trigger=0` (all messages processed)
- Group = ask user: `false`/`0` if only user+bot in group, `true`/`1` if group has other people
- Each chat MUST have a unique `folder` value — two chats cannot share the same folder
- Group with Forum Topics: each topic auto-creates its own isolated workspace under the group's folder

### 5c. Set assistant name in .env

If the user chose a name other than `Andy`, add to `.env`:

```
ASSISTANT_NAME=ChosenName
```

The persona files (`groups/global/CLAUDE.md`, `groups/{admin-folder}/CLAUDE.md`) are auto-generated from `.default` templates on startup, with "Andy" replaced by `ASSISTANT_NAME`. No manual file edits needed.

To regenerate with a new name, delete the existing `CLAUDE.md` files and restart:
```bash
rm groups/global/CLAUDE.md groups/LABEL-dm/CLAUDE.md
```
(Replace `LABEL-dm` with the actual admin folder name, e.g. `andy-dm`.)

## 6. Configure launchd Service (Optional)

Ask the user:
> Do you want NanoClaw to start automatically on login?

If yes:

**Important:** Use `--env-file=.env` in ProgramArguments so the service loads environment variables from `.env`. Without this, variables like `LUME_VM_NAME` and `LUME_VM_IP` won't be available.

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.nanoclaw-desktop.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw-desktop</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>--env-file=.env</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF

npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw-desktop.plist
```

If no, tell them how to start manually:
```bash
npm run dev
```

## 7. Test

Start the service if not already running:
```bash
npm run dev
```

Check the logs for successful startup:
```bash
tail -20 logs/nanoclaw.log
```

You should see:
- `Database initialized`
- `Lume VM already reachable via SSH`
- `Telegram bot connected`
- `NanoClaw running (trigger: @AssistantName)`

Tell the user:
> Send `@ASSISTANT_NAME hello` in your Telegram group.
>
> The first response may take 30-60 seconds as the agent starts up in the VM.
>
> If you have Forum Topics enabled, each topic will automatically create its own isolated workspace.

## Troubleshooting

**Lume VM not starting:**
- Check VM status: `lume ls`
- Start manually: `lume run VM_NAME --shared-dir PROJECT_ROOT`
- Check IP: `lume get VM_NAME --format json`
- Note: `lume get` may show "stopped" even when the VM is running. Test SSH directly.

**SSH connection refused:**
- If fresh VM: unattended setup should have enabled SSH. Retry with `--debug` to check what went wrong
- The VM may need 1-2 minutes to fully boot after creation
- Try: `ssh -o StrictHostKeyChecking=no lume@VM_IP`

**SSH permission denied:**
- Key-based auth may not be set up. Use `sshpass -p "lume" ssh-copy-id lume@VM_IP`
- Verify the VM user was created with username `lume` and password `lume` (the `tahoe` preset does this automatically)

**`command not found: node` in VM:**
- Node.js was installed to `~/local/bin` which isn't in PATH for non-login SSH shells
- The lume-runner already adds `$HOME/local/bin` to PATH. If still failing, verify: `ssh lume@VM_IP '$HOME/local/bin/node --version'`

**Agent timeout (ETIMEDOUT):**
- The VM may not be running. Check `lume ls`
- NanoClaw auto-starts the VM on first use, but it takes time to boot

**No response to messages:**
- Verify bot privacy is disabled (BotFather → `/setprivacy` → Disable) OR bot is a group admin
- Verify trigger pattern: messages must start with `@AssistantName` (unless `requiresTrigger: false`)
- Check logs: `tail -50 logs/nanoclaw.log`
- Verify the bot is in the Telegram group
- Check that `TELEGRAM_ONLY=true` is in `.env`

**Bot responds with wrong name:**
- Check `ASSISTANT_NAME` in `.env` is set correctly
- Delete `groups/global/CLAUDE.md` and `groups/LABEL-dm/CLAUDE.md` (the admin folder), then restart — they'll regenerate from `.default` templates with the correct name

**Messages going to wrong topic:**
- This shouldn't happen — each topic auto-creates its own workspace
- Check that the group has Forum Topics enabled in Telegram settings
- Verify `data/ipc/` has separate directories per topic (e.g. `workspace~t16/`)

**Unload service:**
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-desktop.plist
```
