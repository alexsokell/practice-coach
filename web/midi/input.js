// MidiInput: every way a note can reach the app, as one event stream.
//
//   Web Bluetooth (BLE MIDI)  the main path: the browser talks to the piano directly
//   Web MIDI                  USB cables and devices the operating system already knows
//   virtual                   on-screen keys and the computer keyboard
//
// One hardware transport is active at a time; virtual input always works next to it.
//
// How the pieces fit:
//
// - A "session" object stands for one hardware connection. Every callback that
//   comes from the browser (GATT notification, disconnect event, MIDI message,
//   timer, promise continuation) first checks that its session is still the
//   current one, so events from a replaced device or an abandoned attempt are
//   dropped instead of acted on.
// - An "intent" counter is bumped by every connect and disconnect call. A
//   connect call that finds a newer intent after waiting (for the device
//   chooser, a permission prompt) gives up quietly: the newest call wins.
// - The note stream is normalized so that consumers can rely on it: for each
//   key, 'on' and 'off' strictly alternate. See #noteOn for the rules.

import { decodeMidiMessage, midiDataLength, CC_SUSTAIN } from '../../shared/midi.js';
import {
  BLE_MIDI_SERVICE_UUID,
  BLE_MIDI_CHARACTERISTIC_UUID,
  BleMidiParser,
  BleMidiClock,
  encodeBleMidiPacket,
} from '../../shared/ble-midi.js';

/**
 * @typedef {Object} MidiStatus
 * @property {'disconnected'|'connecting'|'connected'|'reconnecting'|'error'} state
 * @property {'ble'|'webmidi'|null} transport
 * @property {string|null} deviceName
 * @property {string|null} message  a sentence for the learner, or null
 */
/**
 * Detail of a 'note' event.
 * @typedef {Object} NoteEvent
 * @property {'on'|'off'} type
 * @property {number} midi      MIDI note number, 60 = middle C
 * @property {number} velocity  1..127 for 'on'; the release velocity (often 0) for 'off'
 * @property {number} time      ms on the performance.now() clock
 * @property {number} channel   0..15
 * @property {'ble'|'webmidi'|'virtual'} source
 */
/**
 * Detail of a 'pedal' event (sustain pedal, CC 64). Sent only when `down` changes.
 * @typedef {Object} PedalEvent
 * @property {boolean} down
 * @property {number} value  0..127
 * @property {number} time
 * @property {'ble'|'webmidi'} source
 */
/**
 * Detail of a 'raw' event: one MIDI message from the instrument.
 * @typedef {Object} RawEvent
 * @property {Uint8Array} bytes
 * @property {number} time
 * @property {'ble'|'webmidi'} source
 */
/**
 * @typedef {Object} MidiSupport
 * @property {boolean} bluetooth      navigator.bluetooth.requestDevice can be called here
 * @property {boolean} webmidi        navigator.requestMIDIAccess can be called here
 * @property {boolean} secureContext
 * @property {string} hint            one line for the UI, '' when nothing is missing
 */

/** Waits before reconnect tries 1..6 after the link drops. After the last one fails the state is 'error'. */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 8000];
/** Waits before the extra tries of a first connect that failed for a reason that may pass. */
const CONNECT_RETRY_DELAYS_MS = [500, 1500];
/** Longest wait for one GATT step. gatt.connect() itself can wait forever for a device that is gone. */
const CONNECT_TIMEOUT_MS = 15000;
const WRITE_TIMEOUT_MS = 5000;
/** A link that lasted this long before dropping gets a fresh set of reconnect tries. */
const STABLE_LINK_MS = 10000;
/** The same key from two different ports within this time is one key press, not two. */
const DUPLICATE_NOTE_MS = 30;
/** BLE payload that fits every link: the default ATT MTU of 23 minus 3 bytes of header. */
const BLE_PACKET_BYTES = 20;
const MAX_QUEUED_MESSAGES = 256;
/**
 * Web MIDI ports that are not instruments. "Midi Through" (always present on Linux and ChromeOS)
 * loops output back to input, so demo notes sent to the piano would come back as if the learner
 * had played them. The Windows software synth would play the demo on the computer instead.
 */
const IGNORED_PORT = /^midi through|microsoft gs wavetable/i;

const TEXT = {
  noBluetooth: 'This browser cannot use Bluetooth MIDI. Use Chrome or Edge on a computer or Android.',
  noBluetoothIos: 'iPhone and iPad browsers cannot use Bluetooth MIDI. Use Chrome or Edge on a computer or an Android phone.',
  bluetoothOnly: 'This browser cannot use MIDI devices connected by USB. Bluetooth pianos work.',
  midiOnly: 'This browser cannot use Bluetooth MIDI directly. Use Chrome or Edge, or connect the piano by USB.',
  linuxFlag:
    'Bluetooth is switched off in this browser. On Linux, enable chrome://flags/#enable-experimental-web-platform-features and restart the browser, or connect the piano by USB.',
  linuxAlso: 'On Linux, Chrome also needs chrome://flags/#enable-experimental-web-platform-features switched on.',
  insecure: 'Open this app at http://localhost or over https. Browsers only allow Bluetooth and MIDI on secure pages.',
  choose: "Choose your piano in the browser's Bluetooth window.",
  adapter:
    'Bluetooth is not available. Check that this computer has Bluetooth, that it is switched on, and that the browser is allowed to use it.',
  blocked:
    'The browser is not allowed to use Bluetooth here. Allow Bluetooth for the browser and for this site (on Android also Nearby devices or Location), then click connect again.',
  platform: 'Bluetooth MIDI is not available in this browser on this system. Connect the piano by USB instead.',
  noDevice: 'The browser did not return a Bluetooth device. Try again.',
  chooserFailed: (detail) => `Could not open the Bluetooth device list.${detail ? ` (${detail})` : ''}`,
  connecting: (label) => `Connecting to ${label}...`,
  retrying: (label, attempt, total) => `Still trying to reach ${label} (try ${attempt} of ${total})...`,
  noGatt: (label) => `The browser cannot open a connection to ${label}. Try again, or connect by USB.`,
  noMidiService: (label) =>
    `${upperFirst(label)} does not offer Bluetooth MIDI. It may not be a Bluetooth MIDI device, Bluetooth MIDI may be switched off on it, or it may need pairing in the system Bluetooth settings first.`,
  noNotify: (label) =>
    `${upperFirst(label)} connected but would not send notes. Remove it from the system Bluetooth settings, switch its Bluetooth off and on, then connect again.`,
  timeout: (label) =>
    `${upperFirst(label)} did not answer in time. Check that it is switched on, close by, and not connected to another phone, tablet or app, then try again.`,
  gattFailed: (label) =>
    `Could not connect to ${label}. Check that it is switched on, close by, has Bluetooth MIDI turned on, and is not connected to another phone, tablet or app, then try again.`,
  lost: (label) => `Lost the Bluetooth connection to ${label}. Trying to reconnect...`,
  lostForGood: (label) => `Lost the Bluetooth connection to ${label}. Connect again when the piano is ready.`,
  gaveUp: (label, tries) =>
    `Could not reconnect to ${label} after ${tries} ${tries === 1 ? 'try' : 'tries'}. Check that it is switched on and close by, then connect again.`,
  noWebMidi: 'This browser cannot use MIDI devices. Use Chrome, Edge or Firefox on a computer.',
  midiPermission: 'Waiting for permission to use MIDI devices...',
  midiBlocked:
    'The browser blocked access to MIDI devices. Allow MIDI devices for this site in the site settings, then try again.',
  midiFailed: (detail) => `Could not open the MIDI devices.${detail ? ` (${detail})` : ''}`,
  noMidiDevice:
    'No MIDI device is plugged in. Connect your piano by USB, or pair it in the system Bluetooth settings, and it will show up here.',
};

function upperFirst(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function errorName(err) {
  return typeof err?.name === 'string' ? err.name : '';
}

function errorText(err) {
  return typeof err?.message === 'string' ? err.message : '';
}

/** A list of waits in ms, or the fallback when the option is missing or malformed. */
function delayList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.every((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) ? [...value] : fallback;
}

function userAgent(env = globalThis) {
  const ua = env?.navigator?.userAgent;
  return typeof ua === 'string' ? ua : '';
}

function isLinuxDesktop(env = globalThis) {
  const ua = userAgent(env);
  return /Linux/i.test(ua) && !/Android|CrOS/i.test(ua);
}

function isIos(env = globalThis) {
  const ua = userAgent(env);
  // iPadOS reports itself as a Mac, but no Mac has a touch screen.
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && env?.navigator?.maxTouchPoints > 1);
}

/**
 * The failure every connect method rejects with, except when the learner closes the browser's
 * device chooser (then the browser's own NotFoundError is rethrown untouched). `message` is the
 * same sentence that is left in `status.message`.
 */
export class MidiInputError extends Error {
  /**
   * @param {'unsupported'|'insecure-context'|'adapter-off'|'permission'|'no-midi-service'|'notify-failed'|'timeout'|'gatt-failed'|'failed'} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message);
    this.name = 'MidiInputError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Internal: the session this work belonged to was replaced or closed. Never reaches a caller. */
class Superseded extends Error {}

/** Internal: opening the GATT link failed at `stage`. */
class OpenError extends Error {
  /**
   * @param {'gatt'|'link'|'connect'|'service'|'characteristic'|'read'|'notify'} stage
   * @param {unknown} cause
   * @param {'timeout'|'dropped'|null} [reason]
   */
  constructor(stage, cause, reason = null) {
    super(`BLE MIDI setup failed at ${stage}`);
    this.stage = stage;
    this.cause = cause;
    this.reason = reason;
  }
}

/**
 * True when requestDevice() rejected because no device was picked: the learner closed the chooser.
 * Chrome uses NotFoundError for that ("User cancelled the requestDevice() chooser.") and also for
 * a few real problems, which are told apart by their text.
 */
function isChooserCancel(err) {
  if (errorName(err) !== 'NotFoundError') return false;
  return !/adapter|not available|unavailable|not supported|disabled|permission|blocked|denied/i.test(errorText(err));
}

/** @returns {[string, string]} error code and a sentence for the learner */
function describeChooserError(err) {
  const name = errorName(err);
  const text = errorText(err);
  // Chrome on Linux has Web Bluetooth behind a flag; without it the failure reads like a missing adapter.
  if (/adapter|not available|unavailable/i.test(text)) {
    return ['adapter-off', isLinuxDesktop() ? `${TEXT.adapter} ${TEXT.linuxAlso}` : TEXT.adapter];
  }
  if (/not supported|disabled/i.test(text)) return ['unsupported', isLinuxDesktop() ? TEXT.linuxFlag : TEXT.platform];
  if (name === 'SecurityError' || name === 'NotAllowedError' || /permission|blocked|denied|gesture/i.test(text)) {
    return ['permission', TEXT.blocked];
  }
  return ['failed', TEXT.chooserFailed(text)];
}

/** @returns {[string, string]} error code and a sentence for the learner */
function describeOpenError(err, label) {
  const stage = err instanceof OpenError ? err.stage : 'connect';
  const reason = err instanceof OpenError ? err.reason : null;
  const causeName = errorName(err?.cause);
  if (stage === 'gatt') return ['gatt-failed', TEXT.noGatt(label)];
  if ((stage === 'service' || stage === 'characteristic') && causeName === 'NotFoundError') {
    return ['no-midi-service', TEXT.noMidiService(label)];
  }
  if (reason === 'timeout') return ['timeout', TEXT.timeout(label)];
  if (stage === 'notify' && reason === null) return ['notify-failed', TEXT.noNotify(label)];
  return ['gatt-failed', TEXT.gattFailed(label)];
}

/** A first connect is tried again only for failures that are often gone a moment later. */
function isRetryableOpenError(err) {
  if (!(err instanceof OpenError) || err.stage === 'gatt') return false;
  if (err.reason !== null) return true;
  return err.stage === 'connect' || errorName(err.cause) === 'NetworkError';
}

function describeMidiError(err) {
  const name = errorName(err);
  if (name === 'SecurityError' || name === 'NotAllowedError') return ['permission', TEXT.midiBlocked];
  if (name === 'NotSupportedError') return ['unsupported', TEXT.noWebMidi];
  return ['failed', TEXT.midiFailed(errorText(err))];
}

/** Ports of a MIDIInputMap or MIDIOutputMap as an array. Never throws. */
function listPorts(map) {
  const ports = [];
  try {
    if (map && typeof map.forEach === 'function') {
      map.forEach((port) => {
        if (port && typeof port === 'object') ports.push(port);
      });
    }
  } catch {
    // A broken map: treat it as empty.
  }
  return ports;
}

function isUsablePort(port) {
  return port.state !== 'disconnected' && !IGNORED_PORT.test(String(port.name ?? ''));
}

function portName(port) {
  for (const value of [port.name, port.manufacturer]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'MIDI device';
}

function canWrite(characteristic) {
  if (!characteristic) return false;
  const hasMethod =
    typeof characteristic.writeValueWithoutResponse === 'function' ||
    typeof characteristic.writeValue === 'function' ||
    typeof characteristic.writeValueWithResponse === 'function';
  const props = characteristic.properties;
  return hasMethod && (!props || Boolean(props.write) || Boolean(props.writeWithoutResponse));
}

/** BLE MIDI data is written without response when the characteristic allows it, as the spec intends. */
function writePacket(characteristic, packet) {
  if (characteristic.properties?.writeWithoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
    return characteristic.writeValueWithoutResponse(packet);
  }
  if (typeof characteristic.writeValue === 'function') return characteristic.writeValue(packet);
  if (typeof characteristic.writeValueWithResponse === 'function') return characteristic.writeValueWithResponse(packet);
  return characteristic.writeValueWithoutResponse(packet);
}

/** Bytes one message takes inside a BLE MIDI packet: a timestamp byte, the message, and for SysEx a second timestamp. */
function packedSize(message) {
  return message.length + (message[0] === 0xf0 ? 2 : 1);
}

function toKeyNumber(value) {
  const midi = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(midi) && midi >= 0 && midi <= 127 ? midi : null;
}

export class MidiInput extends EventTarget {
  #bluetooth;
  #requestMIDIAccess;
  #now;
  #setTimer;
  #clearTimer;
  #reconnectDelays;
  #connectRetryDelays;
  #connectTimeoutMs;

  #parser = new BleMidiParser();
  #clock = new BleMidiClock();

  /** @type {MidiStatus} */
  #status = { state: 'disconnected', transport: null, deviceName: null, message: null };
  /** The current hardware connection (or attempt), or null. */
  #session = null;
  #intent = 0;
  #originSeq = 0;
  #lastTime = 0;

  /** Keys that are down: midi -> { velocity, time, source, channel, origin }. */
  #held = new Map();
  /** Who holds the sustain pedal down: { source, origin }, or null when it is up. */
  #pedal = null;

  /**
   * @param {Object} [options]
   * @param {Object} [options.bluetooth]  navigator.bluetooth or a fake
   * @param {(options: {sysex: boolean}) => Promise<Object>} [options.requestMIDIAccess]
   *   defaults to navigator.requestMIDIAccess
   * @param {() => number} [options.now]  the clock for event times, performance.now() by default
   * @param {number[]} [options.reconnectDelaysMs]  waits before each reconnect try (default
   *   500, 1000, 2000, 4000, 8000, 8000). The number of entries is the number of tries.
   * @param {number[]} [options.connectRetryDelaysMs]  waits before the extra tries of a first
   *   connect (default 500, 1500). An empty list means one try.
   * @param {number} [options.connectTimeoutMs]  longest wait for one GATT step (default 15000)
   * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]  setTimeout or a fake
   * @param {(handle: unknown) => void} [options.clearTimer]  clearTimeout or a fake
   */
  constructor(options = {}) {
    super();
    const {
      bluetooth = globalThis.navigator?.bluetooth,
      requestMIDIAccess,
      now = () => performance.now(),
      reconnectDelaysMs,
      connectRetryDelaysMs,
      connectTimeoutMs,
      setTimer,
      clearTimer,
    } = options ?? {};
    this.#bluetooth = bluetooth ?? null;
    if (typeof requestMIDIAccess === 'function') {
      this.#requestMIDIAccess = requestMIDIAccess;
    } else if (typeof globalThis.navigator?.requestMIDIAccess === 'function') {
      this.#requestMIDIAccess = (midiOptions) => globalThis.navigator.requestMIDIAccess(midiOptions);
    } else {
      this.#requestMIDIAccess = null;
    }
    this.#now = typeof now === 'function' ? now : () => performance.now();
    this.#setTimer = typeof setTimer === 'function' ? setTimer : (fn, ms) => globalThis.setTimeout(fn, ms);
    this.#clearTimer = typeof clearTimer === 'function' ? clearTimer : (handle) => globalThis.clearTimeout(handle);
    this.#reconnectDelays = delayList(reconnectDelaysMs, RECONNECT_DELAYS_MS);
    this.#connectRetryDelays = delayList(connectRetryDelaysMs, CONNECT_RETRY_DELAYS_MS);
    this.#connectTimeoutMs = typeof connectTimeoutMs === 'number' && connectTimeoutMs > 0 ? connectTimeoutMs : CONNECT_TIMEOUT_MS;
  }

  /**
   * What this browser can do, for the connect dialog. Synchronous, so it cannot tell whether
   * the Bluetooth adapter is switched on.
   * @param {{navigator?: Object, isSecureContext?: boolean}} [env]  defaults to globalThis (a seam for tests)
   * @returns {MidiSupport}
   */
  static support(env = globalThis) {
    const nav = env?.navigator;
    const insecure = env?.isSecureContext === false;
    const bluetooth = !insecure && typeof nav?.bluetooth?.requestDevice === 'function';
    const webmidi = !insecure && typeof nav?.requestMIDIAccess === 'function';
    let hint = '';
    if (insecure) hint = TEXT.insecure;
    else if (!bluetooth && !webmidi) hint = isIos(env) ? TEXT.noBluetoothIos : TEXT.noBluetooth;
    else if (!bluetooth) hint = isLinuxDesktop(env) && /Chrome|Chromium/i.test(userAgent(env)) ? TEXT.linuxFlag : TEXT.midiOnly;
    else if (!webmidi) hint = TEXT.bluetoothOnly;
    return { bluetooth, webmidi, secureContext: env?.isSecureContext === true, hint };
  }

  /** @returns {MidiStatus} a snapshot; listen to 'status' for changes */
  get status() {
    return { ...this.#status };
  }

  /**
   * Keys that are down right now, from any source.
   * @returns {Map<number, {velocity: number, time: number, source: string, channel: number}>} a copy
   */
  get held() {
    const copy = new Map();
    for (const [midi, entry] of this.#held) {
      copy.set(midi, { velocity: entry.velocity, time: entry.time, source: entry.source, channel: entry.channel });
    }
    return copy;
  }

  /** @returns {boolean} the sustain pedal is down (CC 64 at 64 or more) */
  get sustain() {
    return this.#pedal !== null;
  }

  /** @returns {boolean} true when send() can reach the instrument right now */
  get canSend() {
    const session = this.#session;
    if (!session || session.phase !== 'connected') return false;
    if (session.kind === 'ble') {
      return session.device?.gatt?.connected !== false && canWrite(session.characteristic);
    }
    return listPorts(session.access.outputs).some(isUsablePort);
  }

  // ------------------------------------------------------------------ Bluetooth

  /**
   * Show the browser's Bluetooth chooser and connect to the piano the learner picks. Must be
   * called from a click or key handler: the chooser only opens during a user gesture.
   *
   * Rejects with the browser's own NotFoundError when the learner closes the chooser (the status
   * goes back to what it was, nothing is reported). Every other failure rejects with a
   * MidiInputError and leaves its sentence in `status.message`. Resolves, without being
   * connected, when a newer connect or disconnect call replaced this one: check `status.state`.
   *
   * A connection that is already up is kept until a device has been picked, so closing the
   * chooser costs nothing.
   *
   * @param {{acceptAll?: boolean}} [options]  acceptAll lists every nearby Bluetooth device, for
   *   pianos that do not advertise the MIDI service
   * @returns {Promise<MidiStatus>}
   */
  async connectBluetooth(options) {
    const acceptAll = options?.acceptAll === true;
    const bluetooth = this.#bluetooth;
    if (globalThis.isSecureContext === false) {
      throw this.#failed('insecure-context', 'ble', null, TEXT.insecure);
    }
    if (!bluetooth || typeof bluetooth.requestDevice !== 'function') {
      throw this.#failed('unsupported', 'ble', null, isIos() ? TEXT.noBluetoothIos : TEXT.noBluetooth);
    }

    const intent = ++this.#intent;
    const ownsStatus = this.#session === null;
    if (ownsStatus) this.#setStatus('connecting', 'ble', null, TEXT.choose);

    const request = acceptAll
      ? { acceptAllDevices: true, optionalServices: [BLE_MIDI_SERVICE_UUID] }
      : { filters: [{ services: [BLE_MIDI_SERVICE_UUID] }], optionalServices: [BLE_MIDI_SERVICE_UUID] };
    let device;
    try {
      // Nothing may be awaited before this call, or the user gesture could be lost.
      device = await bluetooth.requestDevice(request);
    } catch (err) {
      const current = intent === this.#intent;
      if (isChooserCancel(err)) {
        if (current && ownsStatus && this.#session === null) this.#setStatus('disconnected', null, null, null);
        throw err;
      }
      if (!current) return this.status;
      const [code, message] = describeChooserError(err);
      throw this.#failed(code, 'ble', null, message, err);
    }
    if (intent !== this.#intent) return this.status;
    if (!device || typeof device !== 'object') throw this.#failed('failed', 'ble', null, TEXT.noDevice);

    const live = this.#session;
    if (live?.kind === 'ble' && live.device === device && live.phase === 'connected' && device.gatt?.connected !== false) {
      // The piano that is already connected was picked again: keep the healthy link.
      this.#setStatus('connected', 'ble', live.name, null);
      return this.status;
    }
    if (live) this.#teardown(live);

    const session = this.#startBleSession(device);
    this.#setStatus('connecting', 'ble', session.name, TEXT.connecting(session.label));
    let failure = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#openBle(session);
        failure = null;
        break;
      } catch (err) {
        if (this.#session !== session) return this.status;
        failure = err;
        if (!isRetryableOpenError(err) || attempt >= this.#connectRetryDelays.length) break;
        const total = this.#connectRetryDelays.length + 1;
        this.#setStatus('connecting', 'ble', session.name, TEXT.retrying(session.label, attempt + 2, total));
        await this.#sleep(session, this.#connectRetryDelays[attempt]);
        if (this.#session !== session) return this.status;
      }
    }
    if (failure) {
      this.#teardown(session);
      const noAdapter = await this.#bluetoothMissing();
      if (intent !== this.#intent || this.#session !== null) return this.status;
      const [code, message] = noAdapter ? ['adapter-off', TEXT.adapter] : describeOpenError(failure, session.label);
      throw this.#failed(code, 'ble', session.name, message, failure.cause ?? failure);
    }
    this.#bleConnected(session);
    return this.status;
  }

  #startBleSession(device) {
    const name = typeof device.name === 'string' && device.name.trim() ? device.name.trim() : null;
    const session = {
      kind: 'ble',
      /** 'opening' | 'connected' | 'reconnecting' | 'closed' */
      phase: 'opening',
      device,
      name,
      label: name ?? 'the piano',
      /** The GATT setup in flight: { abort(error) }. */
      attempt: null,
      characteristic: null,
      onValue: null,
      onDisconnected: null,
      timer: null,
      wake: null,
      retry: 0,
      connectedAt: 0,
      /** Set when the link dropped during the optional read, so that it is not tried again. */
      skipRead: false,
      queue: [],
      writing: false,
    };
    session.onDisconnected = () => this.#onBleDisconnected(session);
    this.#session = session;
    try {
      device.addEventListener('gattserverdisconnected', session.onDisconnected);
    } catch {
      // Without the event a drop is only noticed by the next failed write.
    }
    return session;
  }

  /**
   * One pass of the GATT setup: connect, find the MIDI characteristic, read it once, subscribe.
   * Throws OpenError, or Superseded when the session was closed meanwhile.
   */
  async #openBle(session) {
    // A status listener may have closed the session before the first step: touch nothing then.
    if (this.#session !== session) throw new Superseded();
    const gatt = session.device?.gatt;
    if (!gatt || typeof gatt.connect !== 'function') throw new OpenError('gatt', null);

    let abort;
    const aborted = new Promise((_, reject) => {
      abort = reject;
    });
    aborted.catch(() => {});
    const attempt = { abort };
    session.attempt = attempt;

    // Runs one GATT call. It ends early when the link drops, the session closes or time runs out,
    // so a browser promise that never settles cannot hang the connection logic.
    const step = async (stage, start, timeoutMs) => {
      let timer = null;
      try {
        const work = new Promise((resolve) => {
          resolve(start());
        });
        work.catch(() => {});
        const waits = [work, aborted];
        if (timeoutMs > 0) {
          waits.push(
            new Promise((_, reject) => {
              timer = this.#setTimer(() => reject(new OpenError(stage, null, 'timeout')), timeoutMs);
            }),
          );
        }
        const result = await Promise.race(waits);
        if (this.#session !== session || session.attempt !== attempt) throw new Superseded();
        if (gatt.connected === false) throw new OpenError(stage, null, 'dropped');
        return result;
      } catch (err) {
        if (err instanceof OpenError || err instanceof Superseded) throw err;
        throw new OpenError(stage, err);
      } finally {
        if (timer !== null) this.#clearTimer(timer);
      }
    };

    const limit = this.#connectTimeoutMs;
    try {
      const server = (await step('connect', () => gatt.connect(), limit)) ?? gatt;
      const service = await step('service', () => server.getPrimaryService(BLE_MIDI_SERVICE_UUID), limit);
      const characteristic = await step('characteristic', () => service.getCharacteristic(BLE_MIDI_CHARACTERISTIC_UUID), limit);
      if (!characteristic || typeof characteristic.addEventListener !== 'function') {
        throw new OpenError('characteristic', null);
      }

      // The BLE MIDI specification asks the central to read the characteristic once after
      // connecting (the answer has no payload). Some pianos want it before they talk, others
      // reject it, and on some systems it is what starts pairing. So: try, ignore failure. It
      // runs before the listener is attached because a read also fires characteristicvaluechanged.
      // No timeout: a pairing prompt may be waiting for the learner, and a dead link ends it.
      if (!session.skipRead && typeof characteristic.readValue === 'function' && characteristic.properties?.read !== false) {
        try {
          await step('read', () => characteristic.readValue(), 0);
        } catch (err) {
          if (err instanceof Superseded) throw err;
          if (err.reason === 'dropped' || gatt.connected === false) {
            // The link died while reading. In case the read itself upset the piano, the next try goes without.
            session.skipRead = true;
            throw err.reason === 'dropped' ? err : new OpenError('read', null, 'dropped');
          }
        }
      }

      // Listen before subscribing, so that no note can be missed however the browser orders things.
      this.#parser.reset();
      this.#clock.reset();
      const onValue = (event) => this.#onBleValue(session, characteristic, event);
      session.characteristic = characteristic;
      session.onValue = onValue;
      characteristic.addEventListener('characteristicvaluechanged', onValue);
      // Twice the usual limit: this write can be the one that makes the system ask for pairing.
      await step('notify', () => characteristic.startNotifications(), limit * 2);
    } catch (err) {
      if (session.attempt === attempt) session.attempt = null;
      if (!(err instanceof Superseded) && this.#session === session) {
        this.#detachCharacteristic(session);
        this.#release((entry) => entry.source === 'ble', this.#time());
        try {
          // Abort whatever is half open (this also cancels a connect() that is still waiting).
          gatt.disconnect?.();
        } catch {
          // Nothing more can be done with this link.
        }
      }
      throw err;
    }
    session.attempt = null;
  }

  #bleConnected(session) {
    session.phase = 'connected';
    session.connectedAt = this.#time();
    this.#setStatus('connected', 'ble', session.name, null);
  }

  #detachCharacteristic(session) {
    const characteristic = session.characteristic;
    const onValue = session.onValue;
    session.characteristic = null;
    session.onValue = null;
    if (!characteristic || !onValue) return;
    try {
      characteristic.removeEventListener('characteristicvaluechanged', onValue);
    } catch {
      // The object is gone with the link.
    }
  }

  /** One GATT notification: one BLE MIDI packet. */
  #onBleValue(session, characteristic, event) {
    if (this.#session !== session || session.characteristic !== characteristic) return;
    // One arrival time per packet, shared by all its messages: the clock relies on that.
    const arrival = this.#time();
    let messages;
    try {
      messages = this.#parser.parse(event?.target?.value ?? characteristic.value);
    } catch {
      return;
    }
    for (const message of messages) {
      if (this.#session !== session) return;
      // Every message goes through the clock, also the ones that are not passed on (active
      // sensing, MIDI clock): they let it sync with the piano before the first note.
      let time = arrival;
      try {
        time = this.#clock.toLocal(message.timestamp, arrival);
      } catch {
        time = arrival;
      }
      this.#handleMessage(message.data, time, 'ble', 'ble');
    }
  }

  #onBleDisconnected(session) {
    if (this.#session !== session) return;
    if (session.attempt) {
      // A setup is in flight: fail it. Whoever started it decides what happens next.
      session.attempt.abort(new OpenError('link', null, 'dropped'));
      return;
    }
    if (session.phase === 'connected') this.#bleLinkLost(session);
  }

  /** The piano dropped off: let go of its keys and start reconnecting. */
  #bleLinkLost(session) {
    const time = this.#time();
    this.#detachCharacteristic(session);
    session.queue.length = 0;
    session.phase = 'reconnecting';
    if (time - session.connectedAt >= STABLE_LINK_MS) session.retry = 0;
    this.#parser.reset();
    this.#clock.reset();
    this.#release((entry) => entry.source === 'ble', time);
    if (this.#session !== session) return;
    if (session.retry >= this.#reconnectDelays.length) {
      this.#bleGiveUp(session);
      return;
    }
    this.#setStatus('reconnecting', 'ble', session.name, TEXT.lost(session.label));
    if (this.#session === session) this.#scheduleReconnect(session);
  }

  #scheduleReconnect(session) {
    if (session.retry >= this.#reconnectDelays.length) {
      this.#bleGiveUp(session);
      return;
    }
    const delay = this.#reconnectDelays[session.retry];
    session.retry += 1;
    session.timer = this.#setTimer(() => {
      session.timer = null;
      this.#reconnect(session).catch(() => {});
    }, delay);
  }

  async #reconnect(session) {
    if (this.#session !== session || session.phase !== 'reconnecting') return;
    try {
      await this.#openBle(session);
    } catch {
      if (this.#session === session) this.#scheduleReconnect(session);
      return;
    }
    if (this.#session === session) this.#bleConnected(session);
  }

  #bleGiveUp(session) {
    const tries = session.retry;
    this.#teardown(session);
    this.#setStatus(
      'error',
      'ble',
      session.name,
      tries > 0 ? TEXT.gaveUp(session.label, tries) : TEXT.lostForGood(session.label),
    );
  }

  /** True when the browser says this system has no Bluetooth it can use. Never throws. */
  async #bluetoothMissing() {
    let timer = null;
    try {
      const bluetooth = this.#bluetooth;
      if (typeof bluetooth?.getAvailability !== 'function') return false;
      const answer = await Promise.race([
        bluetooth.getAvailability(),
        new Promise((resolve) => {
          timer = this.#setTimer(() => resolve(true), 1000);
        }),
      ]);
      return answer === false;
    } catch {
      return false;
    } finally {
      if (timer !== null) this.#clearTimer(timer);
    }
  }

  // ------------------------------------------------------------------ Web MIDI

  /**
   * Listen to every MIDI input the browser offers (USB, or Bluetooth devices paired in the
   * operating system). Devices plugged in later are picked up. Having no device is not an error:
   * the state is 'connected' with a message that says so.
   *
   * Rejects with a MidiInputError whose sentence is also in `status.message`. Resolves, without
   * being connected, when a newer connect or disconnect call replaced this one.
   * @returns {Promise<MidiStatus>}
   */
  async connectWebMidi() {
    const request = this.#requestMIDIAccess;
    if (typeof request !== 'function') {
      const insecure = globalThis.isSecureContext === false;
      throw this.#failed(
        insecure ? 'insecure-context' : 'unsupported',
        'webmidi',
        null,
        insecure ? TEXT.insecure : TEXT.noWebMidi,
      );
    }
    const intent = ++this.#intent;
    if (this.#session === null) this.#setStatus('connecting', 'webmidi', null, TEXT.midiPermission);

    let access;
    try {
      access = await request({ sysex: false });
    } catch (err) {
      if (intent !== this.#intent) return this.status;
      const [code, message] = describeMidiError(err);
      throw this.#failed(code, 'webmidi', null, message, err);
    }
    if (intent !== this.#intent) return this.status;
    if (!access || typeof access !== 'object') {
      throw this.#failed('failed', 'webmidi', null, TEXT.midiFailed(''));
    }

    if (this.#session) this.#teardown(this.#session);
    const session = {
      kind: 'webmidi',
      phase: 'connected',
      access,
      /** MIDIInput -> { port, origin, listener } */
      inputs: new Map(),
      onState: null,
      timer: null,
      wake: null,
    };
    session.onState = () => {
      if (this.#session === session) this.#syncMidiPorts(session);
    };
    this.#session = session;
    try {
      access.addEventListener('statechange', session.onState);
    } catch {
      // No hot-plug events from this browser: the ports present now still work.
    }
    this.#syncMidiPorts(session);
    return this.status;
  }

  /** Attach to inputs that appeared, let go of the ones that left, refresh the status. */
  #syncMidiPorts(session) {
    const present = new Set();
    for (const port of listPorts(session.access.inputs)) {
      if (!isUsablePort(port)) continue;
      present.add(port);
      if (!session.inputs.has(port)) this.#attachPort(session, port);
    }
    const time = this.#time();
    for (const [port, entry] of [...session.inputs]) {
      if (present.has(port)) continue;
      session.inputs.delete(port);
      this.#detachPort(entry, false);
      // Its keys can never be released by the device now.
      this.#release((held) => held.origin === entry.origin, time);
      if (this.#session !== session) return;
    }

    const names = [...new Set([...session.inputs.keys()].map(portName))];
    let deviceName = null;
    if (names.length > 0) deviceName = names.length <= 2 ? names.join(' + ') : `${names.length} MIDI devices`;
    this.#setStatus('connected', 'webmidi', deviceName, names.length === 0 ? TEXT.noMidiDevice : null);
  }

  #attachPort(session, port) {
    this.#originSeq += 1;
    const entry = { port, origin: `webmidi:${this.#originSeq}`, listener: null };
    entry.listener = (event) => this.#onMidiMessage(session, entry, event);
    session.inputs.set(port, entry);
    try {
      if (typeof port.addEventListener === 'function') port.addEventListener('midimessage', entry.listener);
      else port.onmidimessage = entry.listener;
      // Adding a listener opens the port by itself in current browsers. Asking is harmless.
      const opening = port.open?.();
      opening?.catch?.(() => {});
    } catch {
      // A port that cannot be opened stays silent; the others still work.
    }
  }

  #detachPort(entry, close) {
    const port = entry.port;
    try {
      if (typeof port.removeEventListener === 'function') port.removeEventListener('midimessage', entry.listener);
      else if (port.onmidimessage === entry.listener) port.onmidimessage = null;
      if (close) {
        // Give the device back: on some systems a MIDI port can only be open in one program.
        const closing = port.close?.();
        closing?.catch?.(() => {});
      }
    } catch {
      // The port is already gone.
    }
  }

  #onMidiMessage(session, entry, event) {
    if (this.#session !== session || !session.inputs.has(entry.port)) return;
    let bytes;
    try {
      const data = event?.data;
      if (!data || !(data.length >= 1)) return;
      bytes = Uint8Array.from(data);
    } catch {
      return;
    }
    this.#handleMessage(bytes, this.#midiEventTime(event), 'webmidi', entry.origin);
  }

  /**
   * MIDIMessageEvent.timeStamp is the moment the system received the message, on the
   * performance.now() clock, which is better than "now" when the page was busy. It is used when
   * it looks like such a value: not in the future and not older than a few seconds.
   */
  #midiEventTime(event) {
    const nowMs = this.#time();
    const stamp = event?.timeStamp;
    if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 && nowMs - stamp <= 5000) {
      return Math.min(stamp, nowMs);
    }
    return nowMs;
  }

  // ------------------------------------------------------------------ common

  /**
   * Drop the hardware connection, if any, and stop every pending connect or reconnect try.
   * Held hardware keys are released first. Never rejects.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.#intent += 1;
    const session = this.#session;
    if (session) this.#teardown(session);
    this.#setStatus('disconnected', null, null, null);
  }

  /**
   * Virtual key down (on-screen keys, computer keyboard). Ignored when `midi` is not 0..127.
   * @param {number} midi
   * @param {number} [velocity]  1..127; 0 counts as a release, as in MIDI
   */
  noteOn(midi, velocity = 80) {
    const key = toKeyNumber(midi);
    if (key === null) return;
    let force = typeof velocity === 'number' ? velocity : Number.parseFloat(velocity);
    if (!Number.isFinite(force)) force = 80;
    force = Math.round(force);
    if (force <= 0) {
      this.noteOff(key);
      return;
    }
    this.#noteOn(key, Math.min(127, force), this.#time(), 0, 'virtual', 'virtual');
  }

  /**
   * Virtual key up. Does nothing unless the key is held by virtual input.
   * @param {number} midi
   */
  noteOff(midi) {
    const key = toKeyNumber(midi);
    if (key === null) return;
    this.#noteOff(key, 0, this.#time(), 0, 'virtual');
  }

  /**
   * Send one complete MIDI message to the instrument, for example [0x90, 60, 72]. Never throws.
   * Bluetooth writes are queued and go out one at a time (messages queued together share a
   * packet, so a chord arrives as a chord); with Web MIDI the message goes to every output port.
   * @param {ArrayLike<number>} bytes
   * @returns {boolean} false when nothing was sent: not connected, cannot send, or not a valid message
   */
  send(bytes) {
    try {
      const session = this.#session;
      if (!session || !this.canSend) return false;
      // The encoder is also the validator: a packet of one byte means "not a complete MIDI message".
      if (encodeBleMidiPacket([bytes], 0).length <= 1) return false;
      const message = Array.from(bytes);

      if (session.kind === 'webmidi') {
        let sent = false;
        for (const port of listPorts(session.access.outputs)) {
          if (!isUsablePort(port)) continue;
          try {
            port.send(message);
            sent = true;
          } catch {
            // This port refused (unplugged, or SysEx without permission). Try the others.
          }
        }
        return sent;
      }

      if (session.queue.length >= MAX_QUEUED_MESSAGES) return false;
      session.queue.push(message);
      if (!session.writing) {
        session.writing = true;
        // Start on a microtask so that messages sent in the same breath share a packet.
        Promise.resolve()
          .then(() => this.#pumpWrites(session))
          .catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Writes queued messages one packet at a time: concurrent GATT writes are rejected by the browser. */
  async #pumpWrites(session) {
    try {
      while (session.queue.length > 0) {
        const characteristic = session.characteristic;
        if (this.#session !== session || session.phase !== 'connected' || !characteristic) {
          session.queue.length = 0;
          return;
        }
        const batch = [session.queue.shift()];
        let size = 1 + packedSize(batch[0]);
        while (session.queue.length > 0 && size + packedSize(session.queue[0]) <= BLE_PACKET_BYTES) {
          size += packedSize(session.queue[0]);
          batch.push(session.queue.shift());
        }
        const packet = encodeBleMidiPacket(batch, this.#time());
        if (packet.length <= 1) continue;
        let timer = null;
        try {
          await Promise.race([
            writePacket(characteristic, packet),
            new Promise((resolve) => {
              timer = this.#setTimer(resolve, WRITE_TIMEOUT_MS);
            }),
          ]);
        } catch {
          // The piano did not take this packet. It is not sent again: a late note is worse than a lost one.
        } finally {
          if (timer !== null) this.#clearTimer(timer);
        }
      }
    } finally {
      // Cleared in the same step as the last queue check, so a message can never be left waiting.
      session.writing = false;
    }
  }

  /** One complete MIDI message from an instrument. */
  #handleMessage(bytes, time, source, origin) {
    const status = bytes[0];
    if (!(status >= 0x80)) return;
    // Active sensing and MIDI clock arrive many times per second and carry nothing for us.
    if (status === 0xfe || status === 0xf8) return;
    if (status < 0xf0) {
      // Channel messages must be complete, or a cut-off note-on would read as velocity 0.
      const need = midiDataLength(status);
      if (bytes.length < 1 + need) return;
      for (let i = 1; i <= need; i += 1) {
        if (bytes[i] > 0x7f) return;
      }
    }
    this.#emit('raw', { bytes, time, source });

    const message = decodeMidiMessage(bytes);
    if (message.type === 'noteon') {
      this.#noteOn(message.note, message.velocity, time, message.channel, source, origin);
    } else if (message.type === 'noteoff') {
      this.#noteOff(message.note, message.velocity, time, message.channel, source);
    } else if (message.type === 'cc' && message.controller === CC_SUSTAIN) {
      const down = message.value >= 64;
      // Only the change is reported: a half-pedal sends a stream of values.
      if (down === (this.#pedal !== null)) return;
      this.#pedal = down ? { source, origin } : null;
      this.#emit('pedal', { down, value: message.value, time, source });
    }
  }

  /**
   * Key down. Rules that keep 'on' and 'off' strictly alternating for each key:
   *
   * - The key is already down and the new note-on comes within DUPLICATE_NOTE_MS: it is the same
   *   key press arriving twice, and the copy is ignored. That happens when one instrument shows
   *   up on two ports, and when a piano with two layered voices (piano plus strings, say) sends
   *   every key on two channels. No finger can strike a key twice that fast.
   * - The key is already down, from the same port, later than that: real instruments do this (a
   *   fast repeated note on a triple-sensor action may come without a note-off, and MIDI leaves
   *   it to the receiver). The first note is closed with an 'off' at the time of the new 'on', so
   *   every consumer sees two clean notes.
   * - The key is already down, from another port or from virtual input, earlier than that: the
   *   new press takes the key over (an 'off' for the old holder, then the 'on').
   */
  #noteOn(midi, velocity, time, channel, source, origin) {
    const current = this.#held.get(midi);
    if (current) {
      if (Math.abs(time - current.time) <= DUPLICATE_NOTE_MS) return;
      this.#held.delete(midi);
      this.#emit('note', {
        type: 'off',
        midi,
        velocity: 0,
        time: Math.max(time, current.time),
        channel: current.channel,
        source: current.source,
      });
    }
    this.#held.set(midi, { velocity, time, source, channel, origin });
    this.#emit('note', { type: 'on', midi, velocity, time, channel, source });
  }

  /**
   * Key up. Ignored when the key is not down for this source: after a reconnect its keys were
   * already released, a second port repeats the first, and a key taken over by another source is
   * released by that source.
   */
  #noteOff(midi, velocity, time, channel, source) {
    const current = this.#held.get(midi);
    if (!current || current.source !== source) return;
    this.#held.delete(midi);
    this.#emit('note', { type: 'off', midi, velocity, time, channel, source });
  }

  /** Emit 'off' for the held keys that match, and pedal up if the matching holder had it down. */
  #release(matches, time) {
    for (const [midi, entry] of [...this.#held]) {
      if (!matches(entry) || this.#held.get(midi) !== entry) continue;
      this.#held.delete(midi);
      this.#emit('note', { type: 'off', midi, velocity: 0, time, channel: entry.channel, source: entry.source });
    }
    const pedal = this.#pedal;
    if (pedal && matches(pedal)) {
      this.#pedal = null;
      this.#emit('pedal', { down: false, value: 0, time, source: pedal.source });
    }
  }

  /** Close a session: stop its timers and listeners, drop the link, release its keys. Emits no status. */
  #teardown(session) {
    if (session.phase === 'closed') return;
    session.phase = 'closed';
    if (this.#session === session) this.#session = null;
    if (session.wake) {
      session.wake();
    } else if (session.timer !== null) {
      this.#clearTimer(session.timer);
      session.timer = null;
    }
    if (session.kind === 'ble') {
      const attempt = session.attempt;
      session.attempt = null;
      attempt?.abort(new Superseded());
      this.#detachCharacteristic(session);
      session.queue.length = 0;
      try {
        session.device.removeEventListener('gattserverdisconnected', session.onDisconnected);
      } catch {
        // Not an EventTarget after all.
      }
      try {
        // Also cancels a connect() that is still waiting for the device.
        session.device.gatt?.disconnect?.();
      } catch {
        // Already gone.
      }
      this.#parser.reset();
      this.#clock.reset();
    } else {
      try {
        session.access.removeEventListener('statechange', session.onState);
      } catch {
        // Nothing to remove.
      }
      for (const entry of session.inputs.values()) this.#detachPort(entry, true);
      session.inputs.clear();
    }
    this.#release((entry) => entry.source === session.kind, this.#time());
  }

  /** A wait that ends early when the session is closed. */
  #sleep(session, ms) {
    return new Promise((resolve) => {
      const done = () => {
        session.timer = null;
        session.wake = null;
        resolve();
      };
      session.wake = () => {
        if (session.timer !== null) this.#clearTimer(session.timer);
        done();
      };
      session.timer = this.#setTimer(done, ms);
    });
  }

  /**
   * Record a failed connect call and build the error to throw. A connection that is still up
   * keeps its state and only gets the message; otherwise the state becomes 'error'.
   */
  #failed(code, transport, deviceName, message, cause) {
    if (this.#session) {
      const status = this.#status;
      this.#setStatus(status.state, status.transport, status.deviceName, message);
    } else {
      this.#setStatus('error', transport, deviceName, message);
    }
    return new MidiInputError(code, message, cause);
  }

  #setStatus(state, transport, deviceName, message) {
    const previous = this.#status;
    const next = { state, transport, deviceName: deviceName ?? null, message: message ?? null };
    if (
      previous.state === next.state &&
      previous.transport === next.transport &&
      previous.deviceName === next.deviceName &&
      previous.message === next.message
    ) {
      return;
    }
    this.#status = next;
    this.#emit('status', { ...next });
  }

  #time() {
    let time = NaN;
    try {
      time = Number(this.#now());
    } catch {
      time = NaN;
    }
    if (Number.isFinite(time)) this.#lastTime = time;
    return this.#lastTime;
  }

  #emit(type, detail) {
    try {
      const event =
        typeof CustomEvent === 'function' ? new CustomEvent(type, { detail }) : Object.assign(new Event(type), { detail });
      this.dispatchEvent(event);
    } catch {
      // Input handling must survive whatever happens while an event is delivered.
    }
  }
}
