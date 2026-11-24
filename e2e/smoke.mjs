// End-to-end check: boots the real server with the offline coach, opens the app in
// headless Chromium, plugs in a simulated Bluetooth MIDI piano (real BLE MIDI packets
// through the real parser) and plays through the main flows.
//
//   npm run e2e                 run the checks
//   npm run e2e -- --shots DIR  also save screenshots into DIR
//
// Needs Playwright with Chromium available (npm i -D playwright, or a global install).

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// require() instead of import so a globally installed Playwright (NODE_PATH) is found too.
const { chromium } = createRequire(import.meta.url)('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsFlag = process.argv.indexOf('--shots');
const shotsDir = shotsFlag > -1 ? path.resolve(process.argv[shotsFlag + 1]) : null;
const port = 5600 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

/** Runs inside the page before any app code: a fake Web Bluetooth stack with one BLE MIDI piano. */
function installFakePiano() {
  const SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
  const CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3';

  class FakeCharacteristic extends EventTarget {
    constructor() {
      super();
      this.uuid = CHARACTERISTIC;
      this.properties = { read: true, notify: true, write: true, writeWithoutResponse: true };
      this.value = null;
      this.written = [];
    }
    async readValue() {
      return new DataView(new ArrayBuffer(0));
    }
    async startNotifications() {
      return this;
    }
    async stopNotifications() {
      return this;
    }
    async writeValue(value) {
      this.written.push(value);
    }
    async writeValueWithResponse(value) {
      this.written.push(value);
    }
    async writeValueWithoutResponse(value) {
      this.written.push(value);
    }
  }

  class FakeDevice extends EventTarget {
    constructor(characteristic) {
      super();
      this.id = 'fake-piano';
      this.name = 'Test Piano BLE';
      const device = this;
      const service = { uuid: SERVICE, device, getCharacteristic: async () => characteristic };
      characteristic.service = service;
      this.gatt = {
        device,
        connected: false,
        async connect() {
          this.connected = true;
          return this;
        },
        disconnect() {
          if (!this.connected) return;
          this.connected = false;
          device.dispatchEvent(new Event('gattserverdisconnected'));
        },
        async getPrimaryService() {
          return service;
        },
      };
    }
  }

  const characteristic = new FakeCharacteristic();
  const device = new FakeDevice(characteristic);
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: {
      requestDevice: async () => device,
      getAvailability: async () => true,
      getDevices: async () => [],
    },
  });

  window.fakePiano = {
    /** Deliver one raw BLE MIDI packet as a GATT notification. */
    packet(bytes) {
      characteristic.value = new DataView(new Uint8Array(bytes).buffer);
      characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
    },
    message(status, data1, data2) {
      const ts = Math.floor(performance.now()) & 0x1fff;
      this.packet([0x80 | (ts >> 7), 0x80 | (ts & 0x7f), status, data1, data2]);
    },
    on(midi, velocity = 80) {
      this.message(0x90, midi, velocity);
    },
    off(midi) {
      this.message(0x80, midi, 0);
    },
    /** Schedule a note at an absolute performance.now() time. */
    at(timeMs, midi, holdMs = 150, velocity = 80) {
      setTimeout(() => this.on(midi, velocity), Math.max(0, timeMs - performance.now()));
      setTimeout(() => this.off(midi), Math.max(0, timeMs + holdMs - performance.now()));
    },
    /** Simulate the piano dropping off Bluetooth. */
    drop() {
      device.gatt.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    written: characteristic.written,
  };
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

async function playStep(page, step, { holdMs = 110, gapMs = 70 } = {}) {
  await page.evaluate((notes) => notes.forEach((n) => window.fakePiano.on(n)), step.notes);
  await page.waitForTimeout(holdMs);
  await page.evaluate((notes) => notes.forEach((n) => window.fakePiano.off(n)), step.notes);
  await page.waitForTimeout(gapMs);
}

const coachBubbles = (page) => page.locator('.msg-coach:not(.is-streaming)').count();

async function waitForCoachReply(page, countBefore) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('.msg-coach:not(.is-streaming)').length > n && window.practiceCoach.coachIdle,
    countBefore,
    { timeout: 15000 },
  );
}

async function shot(page, name) {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  env: { ...process.env, COACH_MOCK: '1', PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

let browser;
let page;
const errors = [];
try {
  const health = await waitForServer();
  console.log(`server up on ${base} (${health.mode} coach)`);
  check('server runs the offline coach for the test', health.mode === 'mock');

  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('requestfailed', (request) => errors.push(`request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
  await page.addInitScript(installFakePiano);
  await page.goto(base);

  console.log('first run');
  await page.waitForSelector('#dlg-setup[open]');
  check('first run asks for a profile', true);
  check('an exercise is on screen before any setup', (await page.locator('#staff svg').count()) === 1);
  await page.fill('#setup-name', 'Sam');
  await page.selectOption('#setup-level', 'beginner');
  await page.fill('#setup-goals', 'Play simple songs with both hands');
  await page.click('#setup-form button[type=submit]');
  await waitForCoachReply(page, 0);
  check('coach greets at session start', (await coachBubbles(page)) >= 1);
  const title = await page.textContent('#ex-title');
  check('an exercise title is shown', Boolean(title && title !== 'Loading'), title);
  await shot(page, '01-session-start');

  console.log('bluetooth');
  await page.click('#btn-connect');
  await page.click('#connect-ble');
  await page.waitForFunction(() => window.practiceCoach.connection.state === 'connected');
  check('connects to the simulated Bluetooth piano', (await page.textContent('#conn-pill')).includes('Test Piano BLE'));
  check('connect dialog closes after connecting', !(await page.locator('#dlg-connect[open]').count()));

  console.log('learn-the-notes mode');
  let exercise = await page.evaluate(() => window.practiceCoach.exercise);
  check('exercise has steps', exercise.steps.length > 0);
  const firstNote = exercise.steps[0].notes[0];
  // One wrong note first.
  const wrong = firstNote + 1;
  await page.evaluate((n) => window.fakePiano.on(n), wrong);
  await page.waitForTimeout(80);
  check('wrong note turns the key red', (await page.locator(`.kb-key[data-midi="${wrong}"].is-bad`).count()) === 1);
  check('status line names the mistake', (await page.textContent('#ex-status')).startsWith('That was'));
  await page.evaluate((n) => window.fakePiano.off(n), wrong);
  await shot(page, '02-wrong-note');
  let before = await coachBubbles(page);
  for (const step of exercise.steps) {
    if (step.notes.length) await playStep(page, step);
  }
  await page.waitForSelector('#ex-result:not([hidden])');
  const chips = await page.textContent('#ex-result');
  check('attempt result is shown', /clean/.test(chips), chips);
  check('the wrong note was counted', /1 wrong note/.test(chips), chips);
  await waitForCoachReply(page, before);
  check('coach comments on the attempt', (await coachBubbles(page)) > before);
  await shot(page, '03-after-attempt');

  console.log('looping without a pause');
  await page.waitForFunction(() => window.practiceCoach.attemptStatus === 'ready', null, { timeout: 5000 });
  exercise = await page.evaluate(() => window.practiceCoach.exercise);
  const loopSteps = exercise.steps.filter((step) => step.notes.length);
  const finishedBefore = await page.evaluate(() => window.practiceCoach.finishedCount);
  before = await coachBubbles(page);
  for (const step of loopSteps) await playStep(page, step);
  check('clean run scores 100%', /100% clean/.test(await page.textContent('#ex-result')), await page.textContent('#ex-result'));
  // Second round straight on: its first note is the last note of round one, so it starts at step 2.
  for (const step of loopSteps.slice(1)) await playStep(page, step);
  await page.waitForFunction((n) => window.practiceCoach.finishedCount >= n + 2, finishedBefore, { timeout: 8000 });
  const looped = await page.evaluate(() => window.practiceCoach.lastResult);
  check('a second round played straight on is its own clean try', looped.totals.accuracy === 1 && looped.totals.wrongNotes === 0, JSON.stringify(looped.totals));
  // Noodling after the end must not be charged to the next try.
  for (const midi of [70, 73, 75]) await playStep(page, { notes: [midi] }, { holdMs: 90, gapMs: 60 });
  check('stray notes after a finished try do not start a new one', (await page.evaluate(() => window.practiceCoach.attemptStatus)) === 'finished');
  await waitForCoachReply(page, before);
  const requestsSoFar = await page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => entry.name.endsWith('/api/coach')).length);
  check('quick repeat tries are folded into one coach request', requestsSoFar <= 3, `requests: ${requestsSoFar}`);

  console.log('starting over after a slip');
  await page.waitForFunction(() => window.practiceCoach.attemptStatus === 'ready' && window.practiceCoach.coachIdle, null, { timeout: 12000 });
  exercise = await page.evaluate(() => window.practiceCoach.exercise);
  const again = exercise.steps.filter((step) => step.notes.length);
  for (const step of again.slice(0, 3)) await playStep(page, step);
  await playStep(page, { notes: [again[3].notes[0] + 6] }); // a slip
  for (const step of again) await playStep(page, step); // then from the top
  await page.waitForFunction((n) => window.practiceCoach.lastResult && window.practiceCoach.attemptStatus === 'finished', null, { timeout: 8000 });
  const restarted = await page.evaluate(() => window.practiceCoach.lastResult);
  check('starting again from the top after a slip is a fresh clean try', restarted.totals.accuracy === 1 && restarted.totals.wrongNotes === 0, JSON.stringify(restarted.totals));

  console.log('metronome mode');
  await page.waitForFunction(() => window.practiceCoach.attemptStatus === 'ready' && window.practiceCoach.coachIdle, null, { timeout: 15000 });
  await page.click('#mode-tempo');
  await page.click('#bpm-up');
  exercise = await page.evaluate(() => window.practiceCoach.exercise);
  check('mode switches to metronome', exercise.mode === 'tempo');
  before = await coachBubbles(page);
  await page.click('#btn-start');
  await page.waitForFunction(() => window.practiceCoach.tempoStartMs !== null);
  await page.evaluate(() => {
    const { exercise: ex, tempoStartMs } = window.practiceCoach;
    const beatMs = 60000 / ex.bpm;
    let beat = 0;
    for (const step of ex.steps) {
      for (const midi of step.notes) window.fakePiano.at(tempoStartMs + beat * beatMs, midi, beatMs * step.beats * 0.6);
      beat += step.beats;
    }
  });
  await page.waitForSelector('#countin:not([hidden])', { timeout: 5000 });
  await shot(page, '04-count-in');
  await page.waitForFunction(() => window.practiceCoach.lastResult?.mode === 'tempo', null, { timeout: 60000 });
  const tempoResult = await page.evaluate(() => window.practiceCoach.lastResult);
  check('result chips stay visible after the coach replies', (await page.locator('#ex-result:not([hidden])').count()) === 1);
  check('metronome run completes', tempoResult.completed === true);
  check('all notes land inside the timing window', tempoResult.totals.accuracy === 1, JSON.stringify(tempoResult.totals));
  check(
    'measured offsets are small',
    Math.abs(tempoResult.timing.meanOffsetMs) < 40 && tempoResult.timing.offsetSdMs < 25,
    JSON.stringify(tempoResult.timing),
  );
  await waitForCoachReply(page, before);
  await shot(page, '05-metronome-result');

  console.log('reconnect');
  await page.evaluate(() => window.fakePiano.on(72));
  await page.evaluate(() => window.fakePiano.drop());
  await page.waitForFunction(() => window.practiceCoach.connection.state !== 'connected');
  check('held key is released when the piano drops', (await page.locator('.kb-key.is-down').count()) === 0);
  await page.waitForFunction(() => window.practiceCoach.connection.state === 'connected', null, { timeout: 20000 });
  check('reconnects by itself', true);

  console.log('free play');
  await page.click('#tab-freeplay');
  await page.evaluate(() => [60, 64, 67].forEach((n) => window.fakePiano.on(n)));
  await page.waitForTimeout(150);
  check('names the chord being held', (await page.textContent('#fp-chord')).trim() === 'C', await page.textContent('#fp-chord'));
  check('live readout lists the held notes', /C4 E4 G4/.test(await page.textContent('#live-notes')));
  await shot(page, '06-free-play');
  await page.evaluate(() => [60, 64, 67].forEach((n) => window.fakePiano.off(n)));
  before = await coachBubbles(page);
  for (const midi of [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65]) {
    await playStep(page, { notes: [midi] }, { holdMs: 140, gapMs: 60 });
  }
  await waitForCoachReply(page, before);
  check('coach comments on free play', (await coachBubbles(page)) > before);
  check('phrase stats are shown', /Last phrase/.test(await page.textContent('#fp-status')));

  console.log('chat, next, persistence');
  await page.click('#tab-exercise');
  before = await coachBubbles(page);
  await page.fill('#coach-input', 'What should I focus on?');
  await page.click('#coach-form button[type=submit]');
  await waitForCoachReply(page, before);
  check('chat gets an answer', (await page.locator('.msg-you').count()) >= 1);
  const titleBefore = await page.textContent('#ex-title');
  before = await coachBubbles(page);
  await page.click('#btn-next');
  await waitForCoachReply(page, before);
  const titleAfter = await page.textContent('#ex-title');
  check('next exercise changes the exercise', titleAfter !== titleBefore, `${titleBefore} -> ${titleAfter}`);

  await page.click('#btn-demo');
  await page.waitForTimeout(700);
  check('listen demo runs', (await page.textContent('#btn-demo')) === 'Stop');
  await page.click('#btn-demo');

  await page.click('#btn-settings');
  check('settings show usage', /repl/.test(await page.textContent('#set-usage')));
  check('midi monitor shows messages', /90|80/.test(await page.textContent('#midi-log')));
  await page.click('#dlg-settings button[value=close]');
  await page.click('#btn-library');
  check('library lists exercises', (await page.locator('#library-list .choice').count()) >= 8);
  await shot(page, '07-library');
  await page.click('#dlg-library button[value=cancel]');

  const logCount = await page.locator('#coach-log .msg').count();
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForFunction(() => window.practiceCoach?.exercise);
  check('no setup dialog after reload', !(await page.locator('#dlg-setup[open]').count()));
  check('exercise survives a reload', (await page.textContent('#ex-title')) === titleAfter);
  check('chat log survives a reload', (await page.locator('#coach-log .msg').count()) >= logCount - 1);

  console.log('layouts');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, '08-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no sideways page scroll on a phone', overflow <= 1, `overflow ${overflow}px`);
  await shot(page, '09-phone');

  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (err) {
  failures.push(`crashed: ${err?.stack ?? err}`);
  console.log(`  FAIL crashed: ${err?.stack ?? err}`);
  try {
    const state = await page.evaluate(() => ({
      title: document.getElementById('ex-title').textContent,
      status: document.getElementById('ex-status').textContent,
      attempt: window.practiceCoach?.attemptStatus,
      stepIndex: window.practiceCoach?.stepIndex,
      stepStates: window.practiceCoach?.stepStates?.join(','),
      mode: window.practiceCoach?.exercise?.mode,
      bpm: window.practiceCoach?.exercise?.bpm,
      totals: window.practiceCoach?.result?.totals,
      connection: window.practiceCoach?.connection,
      coachLog: [...document.querySelectorAll('#coach-log .msg')].slice(-4).map((el) => el.textContent),
    }));
    console.log(`app state at the failure:\n${JSON.stringify(state, null, 2)}`);
    if (errors.length) console.log(`browser errors:\n${errors.join('\n')}`);
  } catch {
    // the page is gone: nothing more to report
  }
} finally {
  await browser?.close();
  server.kill();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`server log:\n${serverLog}`);
  process.exit(1);
}
