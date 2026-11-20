# Bootleg

**Find out where your photos are used online.** Every night Bootleg looks up photos from your own library with Google Lens, checks every find against your original, and gives you a quiet screen to go through what it found, one find at a time.

Named after what it finds: the bootlegs of your photos, wherever they turn up online. Formerly called Photowatch.

Part of [All Access](https://www.wouter.photo/tools), free tools for photographers by Wouter Vellekoop.

- **Searches your own library**, newest shoots first. Young photos are searched again more often (weekly in the first month, once a year after two years), because publications often appear weeks or months after a shoot.
- **Verifies every find.** Lens also returns pages that merely show the same subject. Bootleg compares the image Google shows with your original at several scales and positions, so crops still match (a 4:5 crop for Instagram, a strip from a panorama on a news site), while another photographer's photo of the same stage does not.
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
git clone https://github.com/woutervellekooppixel/bootleg.git && cd bootleg && npm install && npm start
```

Open <http://localhost:4410>, go to **Settings** and add the folder with your exported photos. Bootleg reads the folder right away; subfolders show up as a list where you can click any of them to skip it. Add your own website under **Your websites**, so your portfolio does not show up as a find.

To see it work before the first night, click **Search 10 photos now** on the Status tab. A browser window opens off-screen and searches the newest photos, with a pause of 15 to 35 seconds between searches.

## Running every night

Bootleg runs the night scan itself (01:15 to 07:00 by default, see Settings), as long as the app is running and the computer is awake.

**macOS.** To start Bootleg at login and keep it running, use a launch agent. [`examples/macos-launchd.plist`](examples/macos-launchd.plist) is a starting point: fill in the paths, then

```bash
cp examples/macos-launchd.plist ~/Library/LaunchAgents/com.example.bootleg.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.bootleg.plist
```

Make sure the Mac does not sleep at night (System Settings → Energy).

If your photos are on a network or external drive, macOS may block a background process from reading them. Give the `node` binary (`which node`) access under System Settings → Privacy & Security → Full Disk Access. That permission belongs to that exact binary, so check it again after you upgrade Node. Bootleg tells you on the Settings screen when it cannot read a folder, and it never treats an unreachable drive as "photos gone".

**Linux** (not tested). Run `npm start` as a systemd user service in your desktop session. The browser needs a display; on a machine without one, start it under `xvfb-run`.

**Cron instead.** Turn the night scan off in Settings and run `npm run nightly` from cron at the start of your night window. The app and the command line never search at the same time. A cron job runs outside your desktop session, so the browser window may not be able to open: on macOS a launch agent is the safer choice, on Linux run the command under `xvfb-run`.

## On your phone

The app has no login, so it only answers on this computer (127.0.0.1). To use it from your phone, put it behind a private network such as `tailscale serve 4410`, and allow that host name:

```bash
BOOTLEG_ALLOWED_HOSTS=my-mac.tail1234.ts.net npm start
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

## Configuration

Everything you change under **Settings** is saved in one file, `data/settings.json`. You can also write that file yourself, for example to set up a machine over SSH. Start from [`examples/settings.example.json`](examples/settings.example.json):

```bash
mkdir -p data
cp examples/settings.example.json data/settings.json
```

| Key | Default | |
| --- | --- | --- |
| `folders` | none | photo folders: `path` (a full path, or one starting with `~/`) and `exclude`, the subfolders to skip, like `2019/private` |
| `ignoredHosts` | none | your own websites: finds on these sites and their subdomains are never shown |
| `schedule` | `{ "enabled": true, "start": "01:15", "end": "07:00" }` | when the night scan runs, in local time; the end may be after midnight |
| `maxPerNight` | `500` | the most searches in one night (10 to 1000); the actual pace adapts below it |
| `minSimilarity` | `75` | finds below this similarity with your original (50 to 99) are not shown |
| `browser` | `"chrome"` | `"chrome"`, `"chrome-beta"` or `"msedge"` |
| `notifications` | `true` | a system notification after new finds, or when Google asks for a captcha |
| `owner` | empty | your `name` and `contact`, for the claim letter |
| `claimTemplate` | a standard letter | the claim letter, with `{date}`, `{url}`, `{file}`, `{name}` and `{contact}` filled in |

Keys you leave out keep their default. When the file has a mistake, Bootleg names it and does not start. After you change `folders` by hand, click **Read folders now** on the Status tab (or wait for the night scan).

Three environment variables set where Bootleg keeps its data and where it listens:

| Variable | Default | |
| --- | --- | --- |
| `BOOTLEG_DATA_DIR` | `./data` | database, settings, browser profile, image cache |
| `BOOTLEG_PORT` | `4410` | port of the app |
| `BOOTLEG_ALLOWED_HOSTS` | | extra host names the app answers on, comma-separated |

Coming from Photowatch? The old names `PHOTOWATCH_DATA_DIR`, `PHOTOWATCH_PORT` and `PHOTOWATCH_ALLOWED_HOSTS` still work (when both are set, the `BOOTLEG_` name wins), and Bootleg keeps using the `photowatch.db` in your data folder, so your finds and progress stay as they are.

The data folder holds your settings, your finds and the cookies of the Bootleg browser window, so keep it to yourself (it is in `.gitignore`). The tuning that was measured once, like the starting pace of 200 a night, the pause between searches and how often a photo is searched again, is in [`src/config.ts`](src/config.ts), with a note on every value.

## How it works

1. **Index.** Bootleg walks your folders for JPG files and computes a perceptual hash (pHash) and reads the EXIF date of each. Within a shoot (the folder two levels below the photo folder, like `2025/2025-04-22 Concert`), photos whose hashes differ by 8 bits or less form a series; only the first is searched.
2. **Plan.** The shoot date comes from the folder or file name (`2025-04-22`, `20250422`), else the EXIF date, else the file date. Tonight's queue is everything that is due, newest first. While there are photos that were never searched, rescans get at most half the night.
3. **Search.** A real browser window (Google answers headless browsers with a captcha) opens Google Lens, drops in a 1000-pixel copy of the photo and reads the *Exact matches* tab, including the thumbnails Google shows.
4. **Verify.** Each thumbnail is searched for inside your photo: normalised cross-correlation on greyscale pixels, at eight scales and every position. On real finds, copies and crops score 77-96, while an unrelated photo that contains the same logo scores 64 or less. Finds from 75 up are shown; you can change that in Settings.
5. **Review.** You decide per find. "Always fine" puts a whole site on your own list.

The code is small: [`src/lens.ts`](src/lens.ts) (Google Lens), [`src/similarity.ts`](src/similarity.ts) (verification), [`src/schedule.ts`](src/schedule.ts) (what to search when), [`src/indexer.ts`](src/indexer.ts), [`src/jobs.ts`](src/jobs.ts) (night run and lock), [`src/server.ts`](src/server.ts) and [`ui/index.html`](ui/index.html).

## Good to know

- Lens only finds what Google has indexed. Closed groups, apps and print stay out of sight.
- A large library takes a while: at most a few hundred photos a night, newest first.
- Bootleg does not visit the pages it finds. It asks Google for the address behind each result; a page only opens when you click its link.
- Bootleg reads Google's pages in English (it asks for `hl=en`), with Dutch as a fallback. If Google still answers you in another language, add those labels to `LABEL` in [`src/lens.ts`](src/lens.ts).

## Responsible use

- **Only for your own photos**, or photos whose rights you look after. Every photo Bootleg searches is uploaded to Google.
- **Google Lens has no official API.** Bootleg uses it the way a person would, through a browser window. Automated use may not sit well with Google's terms of service: read them and decide for yourself. When Google changes its pages, searching stops until the code is updated.
- **Keep the pace modest.** Google may slow you down or ask for a captcha at any time. Bootleg then stops, pauses for a day and halves its pace. A higher limit in Settings does not make Google more patient.
- **Do not sign in to Google** in the window Bootleg opens. It has its own browser profile and needs no account.
- **Check before you act.** A high score means the images match, not that the use is unauthorised: you may have licensed the photo, or the use may be allowed where you live. The claim letter is a template, not legal advice. Edit it in Settings to fit your country and your terms.

## Development

```bash
npm test
npm run typecheck
```

## All Access

Part of [All Access](https://www.wouter.photo/tools), free tools for photographers by Wouter Vellekoop:

- [Pitpick](https://github.com/woutervellekooppixel/pitpick): fast culling, IPTC metadata and renaming for macOS
- [Bootleg](https://github.com/woutervellekooppixel/bootleg): finds where your photos turn up online
- [Stage Fix](https://github.com/woutervellekooppixel/stage-fix): Lightroom presets for stage light
- [Crop & Roll Export](https://github.com/woutervellekooppixel/lightroom-plugins): Lightroom Classic exports sorted by aspect ratio
- [Remix](https://github.com/woutervellekooppixel/remix): every photo in every format, in Photoshop
- [Setlist](https://github.com/woutervellekooppixel/setlist): one wide image as a series of slides, in Photoshop

## License

[MIT](LICENSE). Bootleg is made by Wouter Vellekoop.
