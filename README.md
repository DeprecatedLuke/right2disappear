# right2disappear

Wipe your social media history on a schedule. Discord only for now, more platforms coming.

## Why

GDPR Article 17, right to erasure. Discord won't give you a bulk delete. They rate-limit individual deletes to ~1/sec. Their "legitimate interest" argument for keeping your messages is paper-thin. So do it yourself.

## Install

Requires [Bun](https://bun.sh).

```bash
git clone git@github.com:DeprecatedLuke/right2disappear.git
cd right2disappear
bun install
bun link
```

## Setup

```bash
# grab token from running Discord/Vesktop
r2d --setup

# or manually
r2d --token YOUR_TOKEN --save
```

## Usage

```bash
# see what would be deleted
r2d -k 7d -n -v

# delete messages older than 7 days
r2d -k 7d

# skip channels by name (fuzzy match)
r2d -k 7d -s announcements,changelog,rules

# cron - daily at 3am
0 3 * * * ~/.bun/bin/r2d -k 7d -s announcements,changelog 2>&1 | logger -t r2d
```

## Options

```
-k, --keep-earlier-than <dur>  delete messages older than this (7d, 2w, 1m, 1y)
-s, --skip-channels <names>    skip channels matching these names (fuzzy, case-insensitive)
-t, --token <token>            discord user token
-n, --dry-run                  don't delete, just show
-v, --verbose                  verbose output
    --setup                    extract token from discord client
    --save                     save token to config
    --include-guilds <ids>     only process these guild IDs
    --exclude-guilds <ids>     skip these guild IDs
    --no-dms                   skip DM channels
-h, --help                     help
```

## Token extraction

Works with Discord stable/canary/PTB, Vesktop, WebCord, ArmCord, LegCord. Handles encrypted (v10/v11) leveldb on Linux, Flatpak, Snap.

## Logs & config

- Logs: `~/.r2d/discord/<date>.log` (verbose always written to file)
- Config: `~/.config/right2disappear/config.json`
- Archived threads tracked in `archived-threads.json`, skipped on future runs

## Limitations

- Can't reach messages in guilds you've left
- Archived threads need MANAGE_THREADS to unarchive
- Uses a user token (violates Discord ToS, low risk for normal use)

## Planned

Reddit, Twitter/X, Telegram, Facebook.

## License

GPL-3.0
