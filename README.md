# Unlimited Accounts

Multi-account session manager for X (Twitter). Save any number of accounts and switch between them with one click — no login/logout cycles.

All data (session cookies, groups, settings) is stored **locally in your browser**. No external servers, no analytics, no tracking.

## Features

- **Unlimited accounts** — save as many sessions as you want; switch instantly from the popup, the context menu (toolbar icon), keyboard shortcuts (`Ctrl+Shift+1-4`), or the in-page switcher rail on x.com
- **In-page switcher** — floating avatar rail on x.com (draggable, collapsible, `Alt+Shift+←/→` to cycle accounts)
- **Dashboard** — followers / following / post counts and account health (suspended / expired detection) for every saved account, opened in a separate tab
- **Unread badges** — per-account unread notification counts
- **Groups** — organize accounts into color-coded groups
- **Encrypted backup** — export / import all accounts with AES-GCM password encryption (`.tua` files), merge or replace
- **Cookie import** — add an account by pasting an `auth_token`
- **Custom accent color** — RGB / picker based theme accent, applied across popup, dashboard and badge

## Install (unpacked)

1. Download and unzip this repository (or `git clone`)
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the folder containing `manifest.json`
5. Open X, log in with one of your accounts, click the extension icon → **Save Current**

## Privacy

- Session cookies are stored in your browser's local extension storage only
- API requests (account stats, unread counts) are sent directly to `x.com` using your own session — nothing is sent anywhere else
- Export files are encrypted with PBKDF2 + AES-GCM using your password

## Disclaimer

- This extension automates account switching using your own session cookies. Automating or circumventing platform limits may violate the X Terms of Service — **use at your own risk**. The authors are not responsible for any account restrictions.
- Anyone with access to your browser profile can extract saved session cookies. Do not save accounts you do not own on shared machines.

## Development

- `background.js` — session CRUD, cookie swapping, internal API calls, alarms
- `content.js` — in-page switcher + user info extraction on x.com
- `popup.*` — account list / groups / settings entry
- `dashboard.*` — stats + notifications dashboard (full page)
- `settings.*` — backup, cookie import, appearance, history

License: MIT
