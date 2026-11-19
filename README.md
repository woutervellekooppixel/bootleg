# Photowatch

**Find out where your photos are used online.** Every night Photowatch looks up photos from your own library with Google Lens, checks every find against your original, and gives you a quiet screen to go through what it found, one find at a time.

- **Searches your own library**, newest shoots first. Young photos are searched again more often (weekly in the first month, once a year after two years), because publications often appear weeks or months after a shoot.
- **Verifies every find.** Lens also returns pages that merely show the same subject. Photowatch compares the image Google shows with your original at several scales and positions, so crops still match (a 4:5 crop for Instagram, a strip from a panorama on a news site), while another photographer's photo of the same stage does not.
- **Skips near-duplicates.** Bursts and the same frame exported twice (web and print, say) are grouped per shoot and searched once.
- **Adapts its pace to Google.** It starts at 200 searches a night, adds 50 after every week without a captcha, and halves and pauses for a day after one.
- **Review with the keyboard.** Your photo and the find side by side, `1`-`4` for Allowed / Not my photo / Ignore / Action needed, all finds on one site at once, undo, an archive with search and CSV export, and a claim letter you can copy.
- **Settings in the app.** Which folders to scan (and which subfolders to skip), when the night scan runs, how fast, which sites are your own, how strict the matching is.

Everything runs on your own computer. Nothing is uploaded except the photos you search for, to Google Lens.

## Requirements

- macOS or Linux (Windows is untested)
- [Node.js](https://nodejs.org) 22.13 or newer
- Google Chrome, Google Chrome Beta or Microsoft Edge
- Your photos as JPG files (export your RAW files first)

## Start

```bash
git clone https://github.com/woutervellekooppixel/photowatch.git
cd photowatch
npm install
npm start
```

Open <http://localhost:4410>, go to **Settings** and add the folder with your exported photos. Photowatch reads the folder right away; subfolders show up as a list where you can click any of them to skip it. Add your own website under **Your websites**, so your portfolio does not show up as a find.

To see it work before the first night, click **Search 10 photos now** on the Status tab. A browser window opens off-screen and searches the newest photos, with a pause of 15 to 35 seconds between searches.

## Running every night

Photowatch runs the night scan itself (01:15 to 07:00 by default, see Settings), as long as the app is running and the computer is awake.

**macOS.** To start Photowatch at login and keep it running, use a launch agent. [`examples/macos-launchd.plist`](examples/macos-launchd.plist) is a starting point: fill in the paths, then

```bash
cp examples/macos-launchd.plist ~/Library/LaunchAgents/local.photowatch.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.photowatch.plist
```

Make sure the Mac does not sleep at night (System Settings → Energy).

If your photos are on a network or external drive, macOS may block a background process from reading them. Give the `node` binary (`which node`) access under System Settings → Privacy & Security → Full Disk Access. Photowatch tells you on the Settings screen when it cannot read a folder, and it never treats an unreachable drive as "photos gone".

**Linux** (not tested). Run `npm start` as a systemd user service in your desktop session. The browser needs a display; on a machine without one, start it under `xvfb-run`.

**Cron instead.** Turn the night scan off in Settings and run `npm run nightly` from cron at the start of your night window. The app and the command line never search at the same time.

## On your phone

The app has no login, so it only answers on this computer (127.0.0.1). To use it from your phone, put it behind a private network such as `tailscale serve 4410`, and allow that host name:

```bash
PHOTOWATCH_ALLOWED_HOSTS=my-mac.tail1234.ts.net npm start
```

Do not expose it to the internet.

## Command line

```text
npm start                                  the app with its night schedule
npm run index                              read the photo folders now
npm run scan -- --count 5 [--folder PATH]  search a few photos now
npm run nightly                            one night run now (for cron)
npm run status                             progress and the settings file
```

| Variable | Default | |
| --- | --- | --- |
| `PHOTOWATCH_DATA_DIR` | `./data` | database, settings, browser profile, image cache |
| `PHOTOWATCH_PORT` | `4410` | port of the app |
| `PHOTOWATCH_ALLOWED_HOSTS` | | extra host names the app answers on, comma-separated |

## How it works

1. **Index.** Photowatch walks your folders for JPG files and computes a perceptual hash (pHash) and reads the EXIF date of each. Within a shoot (the folder two levels below the photo folder, like `2025/2025-04-22 Concert`), photos whose hashes differ by 8 bits or less form a series; only the first is searched.
2. **Plan.** The shoot date comes from the folder or file name (`2025-04-22`, `20250422`), else the EXIF date, else the file date. Tonight's queue is everything that is due, newest first. While there are photos that were never searched, rescans get at most half the night.
3. **Search.** A real browser window (Google answers headless browsers with a captcha) opens Google Lens, drops in a 1000-pixel copy of the photo and reads the *Exact matches* tab, including the thumbnails Google shows.
4. **Verify.** Each thumbnail is searched for inside your photo: normalised cross-correlation on greyscale pixels, at eight scales and every position. On real finds, copies and crops score 77-96, while an unrelated photo that contains the same logo scores 64 or less. Finds from 75 up are shown; you can change that in Settings.
5. **Review.** You decide per find. "Always fine" puts a whole site on your own list.

The code is small: [`src/lens.ts`](src/lens.ts) (Google Lens), [`src/similarity.ts`](src/similarity.ts) (verification), [`src/schedule.ts`](src/schedule.ts) (what to search when), [`src/indexer.ts`](src/indexer.ts), [`src/jobs.ts`](src/jobs.ts) (night run and lock), [`src/server.ts`](src/server.ts) and [`ui/index.html`](ui/index.html).

## Good to know

- Photowatch uses Google Lens the way a person would, through a browser window. It is not an official API. When Google changes its pages, searching stops working until the code is updated; when Google asks for a captcha, Photowatch stops and waits a day. Use it for your own photos, at a modest pace, and check Google's terms for yourself.
- Lens only finds what Google has indexed. Closed groups, apps and print stay out of sight.
- A large library takes a while: at most a few hundred photos a night, newest first.
- The claim letter is a template, not legal advice. Edit it in Settings to fit your country and your terms.

## Development

```bash
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
