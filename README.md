# Practice Coach

An AI piano teacher that listens through your piano's Bluetooth MIDI connection.

You connect a digital piano to the app in your browser. The app sees every key you press, shows you
right and wrong notes the instant you play them, and Claude acts as the teacher: it reads a short
report of each try, tells you the one thing to fix, and picks what you practice next.

Early prototype, built in public.

## What it does

- **Connects to your piano** over Bluetooth MIDI (BLE MIDI) straight from the browser. USB MIDI works too.
  No piano nearby? Click the on-screen keys or use your computer keyboard.
- **Sees every keystroke**: note, timing and how hard you played, with a live readout and chord names.
- **Two practice modes.** *Learn the notes*: the app waits until you play the right note, so there is
  no time pressure. *With metronome*: play along with a click and get your timing measured in milliseconds.
- **Instant feedback, no AI lag**: keys light up green or red and the notation tracks where you are.
  All of that is computed in the browser.
- **A coach that adapts**: after each try Claude gets the numbers (accuracy, wrong notes by step,
  hesitations, tempo, evenness, loudness) and replies in a sentence or two. It can slow you down, loop a
  trouble spot, switch hands, or move you on. It can read its replies aloud so you can keep your hands on the keys.
- **Free play**: play anything and see the chord, key and tempo it hears. The coach can comment on that too.
- **Real exercises with real fingering**: scales, arpeggios, five-finger patterns, chord progressions and
  short public-domain tunes, shown as notation with finger numbers. For scales, arpeggios and chords the
  fingering comes from a standard table in the code, not from the AI.

## Quick start

You need [Node.js](https://nodejs.org) 20.12 or newer and Chrome or Edge.

```bash
git clone https://github.com/alexsokell/practice-coach.git
cd practice-coach
npm install
cp .env.example .env      # then put your Claude API key in .env
npm start
```

Open **http://localhost:5173** in Chrome or Edge, click **Connect piano**, and play.

No API key yet? Leave it empty. The app then runs a simple built-in offline coach so you can try
everything else for free.

### Getting an API key, and what it costs

Create a key at [platform.claude.com](https://platform.claude.com) and paste it into `.env` as
`ANTHROPIC_API_KEY`. The API is billed per use, separately from a Claude subscription.

Rough estimate with the default model (`claude-opus-5-5`, $4 per million input tokens and $20 per million
output tokens): about 1 to 2 cents per coach reply, a few cents for the first reply of a session. A 30-minute
session with 40 replies comes to roughly 50 to 80 cents. These numbers are calculated from token prices, not
measured on a bill yet. Set `COACH_MODEL=claude-haiku-5-5` in `.env` to make it about 40 times cheaper, with
simpler feedback.

Two guards against surprises: Settings shows a running cost estimate for the session, and the server refuses
more than 20 coach requests a minute.

## Connecting your piano

### Which browser

| Setup | Bluetooth MIDI | USB MIDI |
| --- | --- | --- |
| Chrome or Edge on Windows 10/11, macOS, ChromeOS | Yes | Yes |
| Chrome on Android 6 or newer | Yes | Yes |
| Chrome on Linux | Only after enabling `chrome://flags/#enable-experimental-web-platform-features` | Yes |
| Firefox (desktop, 108 or newer) | No | Yes, plug the piano in before you click Connect |
| Safari, and every browser on iPhone and iPad | No | No |

The page must be opened at `http://localhost` (or over https). Browsers refuse Bluetooth on plain
`http://192.168...` addresses, which is why the simplest setup is a laptop next to the piano.

### Steps

1. Switch the piano on and turn on its **Bluetooth MIDI** function. On many pianos this is separate from Bluetooth audio.
2. Make sure the piano is not already connected to a phone or tablet app.
3. Turn Bluetooth on at the computer.
4. In the app, click **Connect piano**, choose **Bluetooth piano**, and pick the piano in the browser's own list.
5. Not in the list? Choose **My piano is not in the list**. The normal list only shows devices that announce the MIDI service.
6. USB instead: plug the cable in, choose **USB cable or already paired**, and allow the browser's MIDI prompt.

### If it does not work

- **Piano not listed:** check that Bluetooth MIDI is on, disconnect the piano from other devices, move closer,
  switch its Bluetooth off and on, then try "My piano is not in the list".
- **"Does not offer Bluetooth MIDI":** the entry you picked is not the MIDI one (often the piano's audio entry).
- **Connects but no notes, or connecting keeps failing:** remove the piano from the system Bluetooth settings,
  restart its Bluetooth and connect again. On Windows, a piano that insists on pairing may need to be paired in
  Windows settings first.
- **Connection drops:** the app releases all keys and retries by itself six times with growing waits, then asks you to connect again.
- **"Bluetooth is not available":** no adapter, Bluetooth is off, the browser lacks Bluetooth permission in the
  system settings, or (Linux) the flag above is off.
- **MIDI blocked:** allow "MIDI devices" for the site in the browser's site settings.
- **Still stuck:** pair the piano in the system (macOS: Audio MIDI Setup, Bluetooth; Windows 11: Bluetooth settings)
  and use the **USB cable or already paired** button. Chrome's `about://bluetooth-internals` page shows what the adapter sees.

Settings has a **MIDI monitor** that lists the raw messages arriving from the piano.

## How it works

```
 piano --BLE MIDI--> browser (Chrome)                          Node server            Claude API
                     - decodes BLE MIDI packets                - keeps the API key
                     - tracks the exercise note by note        - system prompt
                     - draws notation and keyboard             - validates exercises
                     - builds a short text report  --POST-->   - streams the reply  <------>
                     - shows/speaks the reply     <--SSE---
```

- `shared/` runs in both the browser and Node: the BLE MIDI parser, music theory (scales, chords,
  fingerings), the exercise builder, the attempt tracker, and the text reports the coach reads.
- `web/` is the browser app: plain ES modules, no build step.
- `server/` is a small dependency-light Node server. It serves the app and exposes `POST /api/coach`,
  which streams the coach's reply. The only npm dependency is the official `@anthropic-ai/sdk`.

What Claude sees is text like this, never audio:

```
[event: attempt]
Exercise: "C major scale, right hand" (right hand, 15 steps)
Try 2 | wait mode, no metronome, suggested tempo 60 bpm
Result: completed | 14 of 15 steps clean (93%) | wrong notes 1
Timing (estimated from the gaps between notes): about 71 bpm | evenness 71% (100% = equal gaps) | 1 hesitation | took 12.9 s
Loudness (MIDI velocity 1-127): mean 70 | spread (sd) 8 | softest 58 | loudest 82
Trouble spots (worst first):
- step 4, F4 (finger 1): wrong notes, pressed F#4 before the right key; 1.9 s gap before it (2.2x the usual)
Change from the previous try: clean 80% -> 93% | wrong notes 3 -> 1 | pace 67 -> 71 bpm | evenness 66% -> 71% | hesitations 2 -> 1
```

Claude answers with one JSON object: what to say, one action (keep going, change tempo or mode, drill
a few steps, go back to the full exercise, or load a new exercise), and optional long-term notes about
you. Generated exercises (scales, arpeggios, chords) are built by code from a short description, so
their notes and fingerings are always right. The server validates everything the model sends and asks
it once to correct an exercise it cannot build.

## Privacy

- Your profile, progress and chat history stay in your browser's local storage. **Settings > Erase all my data** removes them.
- The text reports of your playing and your chat messages go to the Claude API through your own server and key.
- Nothing else leaves your machine. No analytics, no accounts.
- The server listens on `127.0.0.1` only. Anyone who can reach its port can spend your API key, so do
  not expose it to a network without adding your own protection.

## Settings (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | empty | Your Claude API key. Empty means the offline coach. |
| `COACH_MODEL` | `claude-opus-5-5` | Model that coaches you. |
| `COACH_EFFORT` | `low` | How long the model thinks before replying: `low`, `medium`, `high`. Higher is slower. |
| `HOST` / `PORT` | `127.0.0.1` / `5173` | Where the app listens. |
| `COACH_MOCK` | empty | `1` forces the offline coach, `0` forces the API even with no key in `.env`. |
| `COACH_MAX_PER_MIN` | `20` | Spending guard: maximum coach requests per minute. |
| `ALLOWED_HOSTS` | empty | Extra host names the server answers to, comma separated. |

## Development

```bash
npm test        # unit tests (node:test, no network)
npm run e2e     # end-to-end run in headless Chromium with a simulated Bluetooth piano (needs Playwright)
npm run dev     # server with auto-restart
```

The end-to-end test feeds real BLE MIDI packets through a fake Web Bluetooth device, so the whole path
from packet to coach reply is exercised without hardware.

## Honest limits

- **Not yet played on a real piano.** Everything was built and tested against simulated Bluetooth MIDI packets
  and a fake browser Bluetooth device. The first session on real hardware may surface quirks.
- **The live Claude connection was built from the API reference but not exercised with a real key in the
  build environment.** The server falls back step by step if the API rejects an optional feature, and the
  offline coach always works. Expect to report a bug or two on the first live run.
- **Browser limits.** Chrome or Edge on a computer or Android. No iPhone, no iPad, no Safari. Linux needs a flag for Bluetooth.
- **Runs on the computer next to the piano.** Using a phone as the screen needs HTTPS hosting, which is not set up.
- **The coach reads numbers, not sound.** It cannot hear tone or pedalling and cannot see your hands, posture or
  which finger you used. It is told to say so instead of pretending.
- **Timing over Bluetooth is good, not perfect.** The app uses the piano's own timestamps to remove most Bluetooth
  jitter, but a constant delay of some tens of milliseconds cannot be told apart from playing late. Trust the
  spread and the drift more than the average. Settings has a timing offset if it always reads late.
- **Fingerings cover the standard cases only:** major and minor scales, the chromatic scale, major and minor triad
  arpeggios, five-finger patterns and block chords. Anything else is shown without finger numbers rather than
  guessed. The tables were checked against several piano-teaching sites through search results, not against a
  printed scale manual, so a teacher's eye on them is welcome.
- **Notation is simplified.** No key signatures (accidentals are written on the notes), no beams or ties, one
  voice per hand. A two-octave scale in the left hand runs into a lot of ledger lines.
- **Tunes written by the AI can contain wrong notes or odd fingerings.** When the coach writes a tune note by
  note, its notes and finger numbers are the model's own. Generated scales, arpeggios and chords cannot be
  wrong that way, because code builds them.
- **A layered piano voice counts as one key press.** If your piano sends each key twice (piano plus strings),
  the copy is ignored. Split keyboards and auto-accompaniment are not handled: turn them off while practicing.
- **It costs money per coach reply** when you use a real API key. See the numbers above.
- **One learner, one browser.** No accounts, no sync between devices.

## License

MIT
