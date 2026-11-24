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
  short public-domain tunes, shown as notation with finger numbers. Fingerings come from a verified table,
  never from the AI's guess.

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

Rough numbers with the default model (`claude-opus-5-5` at $4 per million input tokens and $20 per
million output tokens): one coach reply is about 2 cents at the start of a session and less once the
prompt cache is warm. A 30-minute session with 40 replies lands somewhere around 30 to 60 cents.
Set `COACH_MODEL=claude-haiku-5-5` in `.env` to make it roughly 40 times cheaper with simpler feedback.
The Settings panel shows a running estimate for the session, and the server refuses more than 20 coach
requests a minute as a guard against runaway spending.

## Connecting your piano

CONNECTING_PLACEHOLDER

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
REPORT_PLACEHOLDER
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

LIMITS_PLACEHOLDER

## License

MIT
