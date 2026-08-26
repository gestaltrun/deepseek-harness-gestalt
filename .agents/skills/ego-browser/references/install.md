# Install ego lite

Read this file only when ego lite isn't installed yet, or when the user asks to install ego lite. For day-to-day browser work, return to [the main skill](../SKILL.md).

The ego-browser skill depends on the ego lite browser: the `ego-browser` command is provided by the ego lite app. Once ego lite is installed and you've gone through onboarding once, the environment is ready and there are no further environment issues.

ego lite website: https://lite.ego.app/

## Install

Installation changes the user's applications and browser account state. Proceed only after the user explicitly asks to install ego lite.

Open [lite.ego.app](https://lite.ego.app/) and ask the user to download and install the current macOS release through the normal Finder and Gatekeeper flow. Do not download an unpinned installer from a script, remove quarantine metadata, replace an existing application, run an installer as root, or bypass macOS signature and notarization checks.

After installation, the user opens ego lite and completes first-run onboarding:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH (usually under `~/.local/bin`).

Wait for the user to confirm that installation and onboarding are complete before continuing.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Once the command exists, verify the runtime with a minimal heredoc:

```bash
ego-browser nodejs <<'EOF'
cliLog('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready.

## After that, return to the original task

Once the environment is ready, return to the user's original task. Define the DSH helpers from [Quick start](../SKILL.md#quick-start) and begin with `useDshTaskSpace(name)`.

## Troubleshooting

- **Not macOS**: follow the platform support and installation instructions at [lite.ego.app](https://lite.ego.app/).
- **Download failed**: have the user check their network and retry the official download.
- **Gatekeeper blocks it**: stop and let the user review the macOS warning. Do not remove quarantine metadata or bypass the trust check.
- **Command still unavailable after onboarding**: confirm `~/.local/bin` is on the PATH (see above); or have the user reopen ego lite, finish onboarding, and retry.
