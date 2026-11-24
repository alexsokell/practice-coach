// Tests for web/midi/input.js with hand-written fakes of Web Bluetooth and Web MIDI.
// Time and timers are injected, so nothing here waits on the real clock.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MidiInput, MidiInputError } from '../web/midi/input.js';
import { BLE_MIDI_SERVICE_UUID, BLE_MIDI_CHARACTERISTIC_UUID, BleMidiParser } from '../shared/ble-midi.js';

// ------------------------------------------------------------------ helpers

/** Lets every pending promise reaction run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function domError(name, message) {
  return new DOMException(message, name);
}

/** A manual clock with timers. advance() runs the timers that come due, in order. */
function makeClock(start = 1000) {
  const clock = {
    t: start,
    timers: [],
    nextId: 1,
    now: () => clock.t,
    setTimer(fn, ms) {
      const id = clock.nextId;
      clock.nextId += 1;
      clock.timers.push({ id, fn, ms, at: clock.t + ms });
      return id;
    },
    clearTimer(id) {
      clock.timers = clock.timers.filter((timer) => timer.id !== id);
    },
    /** Delays of the timers that are waiting, smallest first. */
    pending: () => clock.timers.map((timer) => timer.ms).sort((a, b) => a - b),
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        await flush();
        const due = clock.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        clock.timers = clock.timers.filter((timer) => timer !== due);
        clock.t = Math.max(clock.t, due.at);
        due.fn();
      }
      clock.t = end;
      await flush();
    },
  };
  return clock;
}

/** One BLE MIDI packet: header, then a timestamp byte in front of every message. */
function pkt(timestampMs, ...messages) {
  const ts = Math.floor(timestampMs) & 0x1fff;
  const bytes = [0x80 | (ts >> 7)];
  for (const message of messages) bytes.push(0x80 | (ts & 0x7f), ...message);
  return bytes;
}

class FakeCharacteristic extends EventTarget {
  constructor(piano) {
    super();
    this.piano = piano;
    this.uuid = BLE_MIDI_CHARACTERISTIC_UUID;
    this.properties = { ...piano.properties };
    this.value = null;
  }

  async readValue() {
    this.piano.log.push('read');
    if (this.piano.readFails) throw domError('NotSupportedError', 'GATT operation not permitted.');
    this.value = new DataView(new ArrayBuffer(0));
    // A real read announces its result the same way a notification does.
    this.dispatchEvent(new Event('characteristicvaluechanged'));
    return this.value;
  }

  async startNotifications() {
    this.piano.log.push('notify');
    if (this.piano.notifyFails) throw domError('NotSupportedError', 'GATT Error: Not supported.');
    return this;
  }

  async stopNotifications() {
    return this;
  }

  async #write(kind, value) {
    const piano = this.piano;
    piano.activeWrites += 1;
    piano.maxActiveWrites = Math.max(piano.maxActiveWrites, piano.activeWrites);
    piano.writes.push({ kind, bytes: [...value], characteristic: this });
    try {
      if (piano.writeGate) await piano.writeGate();
      if (piano.writeFails) throw domError('NetworkError', 'GATT operation failed for unknown reason.');
    } finally {
      piano.activeWrites -= 1;
    }
  }

  writeValue(value) {
    return this.#write('writeValue', value);
  }

  writeValueWithResponse(value) {
    return this.#write('writeValueWithResponse', value);
  }

  writeValueWithoutResponse(value) {
    return this.#write('writeValueWithoutResponse', value);
  }
}

/**
 * A BLE MIDI piano as Web Bluetooth shows it. Same shape as the fake in e2e/smoke.mjs:
 * gatt.connect() resolves to the gatt object, notifications are a plain Event on the
 * characteristic with `value` set first, a drop is a 'gattserverdisconnected' Event on the device.
 */
class FakePiano extends EventTarget {
  constructor({ name = 'Test Piano BLE', reuseCharacteristic = false, properties } = {}) {
    super();
    this.id = `fake-${name}`;
    this.name = name;
    this.reuseCharacteristic = reuseCharacteristic;
    this.properties = properties ?? { read: true, notify: true, write: true, writeWithoutResponse: true };
    /** What the next gatt.connect() calls do: 'ok' (default), 'fail' or 'hang'. */
    this.connectPlan = [];
    this.log = [];
    this.characteristics = [];
    this.characteristic = null;
    this.writes = [];
    this.activeWrites = 0;
    this.maxActiveWrites = 0;
    this.writeGate = null;
    this.hung = null;
    const piano = this;
    this.service = {
      uuid: BLE_MIDI_SERVICE_UUID,
      device: this,
      async getCharacteristic(uuid) {
        piano.log.push(`characteristic:${uuid}`);
        if (piano.noCharacteristic) throw domError('NotFoundError', `No Characteristics matching UUID ${uuid} found in Service.`);
        return piano.characteristic;
      },
    };
    this.gatt = {
      device: this,
      connected: false,
      connect() {
        piano.log.push('connect');
        const plan = piano.connectPlan.shift() ?? 'ok';
        if (plan === 'fail') return Promise.reject(domError('NetworkError', 'Connection attempt failed.'));
        if (plan === 'hang') {
          return new Promise((_, reject) => {
            piano.hung = reject;
          });
        }
        this.connected = true;
        if (!piano.reuseCharacteristic || !piano.characteristic) {
          piano.characteristic = new FakeCharacteristic(piano);
          piano.characteristics.push(piano.characteristic);
        }
        return Promise.resolve(this);
      },
      disconnect() {
        piano.log.push('disconnect');
        if (piano.hung) {
          piano.hung(domError('AbortError', 'GATT Server disconnect() called while connecting.'));
          piano.hung = null;
        }
        if (!this.connected) return;
        this.connected = false;
        piano.dispatchEvent(new Event('gattserverdisconnected'));
      },
      async getPrimaryService(uuid) {
        piano.log.push(`service:${uuid}`);
        if (!this.connected) throw domError('NetworkError', 'GATT Server is disconnected. Cannot retrieve services.');
        if (piano.noService) throw domError('NotFoundError', `No Services matching UUID ${uuid} found in Device.`);
        return piano.service;
      },
    };
  }

  /** Deliver one raw BLE MIDI packet as a GATT notification on the given (default: current) characteristic. */
  packet(bytes, characteristic = this.characteristic) {
    characteristic.value = new DataView(new Uint8Array(bytes).buffer);
    characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
  }

  /** The piano drops off Bluetooth. */
  drop() {
    this.gatt.connected = false;
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }

  count(entry) {
    return this.log.filter((item) => item === entry).length;
  }
}

function makeBluetooth(piano) {
  const bluetooth = {
    requests: [],
    available: true,
    async requestDevice(options) {
      bluetooth.requests.push(options);
      return piano;
    },
    async getAvailability() {
      return bluetooth.available;
    },
  };
  return bluetooth;
}

class FakePort {
  constructor(type, name, id = `${type}:${name}`) {
    this.type = type;
    this.name = name;
    this.id = id;
    this.state = 'connected';
    this.connection = 'closed';
    this.listeners = new Set();
    this.sent = [];
    this.opened = 0;
    this.closed = 0;
  }

  addEventListener(type, fn) {
    if (type === 'midimessage') this.listeners.add(fn);
  }

  removeEventListener(type, fn) {
    if (type === 'midimessage') this.listeners.delete(fn);
  }

  async open() {
    this.opened += 1;
    this.connection = 'open';
    return this;
  }

  async close() {
    this.closed += 1;
    this.connection = 'closed';
    return this;
  }

  /** A MIDI message arrives from the device. */
  emit(data, timeStamp) {
    for (const fn of [...this.listeners]) fn({ data: Uint8Array.from(data), timeStamp, target: this });
  }

  send(data) {
    if (this.sendFails) throw domError('InvalidStateError', 'Port is not connected.');
    this.sent.push([...data]);
  }
}

class FakeAccess {
  constructor(inputs = [], outputs = []) {
    this.inputs = new Map(inputs.map((port) => [port.id, port]));
    this.outputs = new Map(outputs.map((port) => [port.id, port]));
    this.listeners = new Set();
  }

  addEventListener(type, fn) {
    if (type === 'statechange') this.listeners.add(fn);
  }

  removeEventListener(type, fn) {
    if (type === 'statechange') this.listeners.delete(fn);
  }

  fire(port) {
    for (const fn of [...this.listeners]) fn({ port });
  }

  plug(port) {
    port.state = 'connected';
    (port.type === 'input' ? this.inputs : this.outputs).set(port.id, port);
    this.fire(port);
  }

  unplug(port, { keepInMap = false } = {}) {
    port.state = 'disconnected';
    if (!keepInMap) (port.type === 'input' ? this.inputs : this.outputs).delete(port.id);
    this.fire(port);
  }
}

/** Records every event of an input. */
function record(input) {
  const all = [];
  for (const type of ['note', 'pedal', 'status', 'raw']) {
    input.addEventListener(type, (event) => all.push({ type, detail: event.detail }));
  }
  const of = (type) => all.filter((entry) => entry.type === type).map((entry) => entry.detail);
  return {
    all,
    notes: () => of('note'),
    pedals: () => of('pedal'),
    statuses: () => of('status'),
    raws: () => of('raw'),
    clear: () => {
      all.length = 0;
    },
  };
}

function setup({ piano = new FakePiano(), bluetooth, access, input: inputOptions } = {}) {
  const clock = makeClock();
  const bt = bluetooth === undefined ? makeBluetooth(piano) : bluetooth;
  const midiRequests = [];
  const input = new MidiInput({
    bluetooth: bt,
    requestMIDIAccess: access
      ? async (options) => {
          midiRequests.push(options);
          return access;
        }
      : undefined,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...inputOptions,
  });
  return { clock, piano, bluetooth: bt, input, events: record(input), midiRequests, access };
}

const CONNECTED_BLE = { state: 'connected', transport: 'ble', deviceName: 'Test Piano BLE', message: null };
const DISCONNECTED = { state: 'disconnected', transport: null, deviceName: null, message: null };

// ------------------------------------------------------------------ construction and support

describe('MidiInput basics', () => {
  it('can be constructed in Node with no arguments and starts disconnected', () => {
    const input = new MidiInput();
    assert.deepEqual(input.status, DISCONNECTED);
    assert.equal(input.canSend, false);
    assert.equal(input.sustain, false);
    assert.equal(input.held.size, 0);
    assert.equal(input.send([0x90, 60, 72]), false);
    assert.ok(input instanceof EventTarget);
  });

  it('tolerates null and junk options', () => {
    assert.doesNotThrow(() => new MidiInput(null));
    const input = new MidiInput({ now: 'soon', reconnectDelaysMs: 'fast', connectTimeoutMs: -1, setTimer: 5 });
    input.noteOn(60);
    assert.equal(input.held.size, 1);
  });

  it('status is a snapshot that callers cannot use to change the input', () => {
    const input = new MidiInput();
    input.status.state = 'connected';
    assert.equal(input.status.state, 'disconnected');
  });
});

describe('MidiInput.support', () => {
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

  it('reports everything fine with an empty hint', () => {
    const env = {
      isSecureContext: true,
      navigator: { userAgent: chrome, bluetooth: { requestDevice() {} }, requestMIDIAccess() {} },
    };
    assert.deepEqual(MidiInput.support(env), { bluetooth: true, webmidi: true, secureContext: true, hint: '' });
  });

  it('explains a browser with neither API', () => {
    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    const support = MidiInput.support({ isSecureContext: true, navigator: { userAgent: safari } });
    assert.equal(support.bluetooth, false);
    assert.equal(support.webmidi, false);
    assert.equal(support.hint, 'This browser cannot use Bluetooth MIDI. Use Chrome or Edge on a computer or Android.');
  });

  it('names iPhone and iPad', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    assert.match(MidiInput.support({ isSecureContext: true, navigator: { userAgent: iphone } }).hint, /iPhone and iPad/);
    const ipad =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    assert.match(
      MidiInput.support({ isSecureContext: true, navigator: { userAgent: ipad, maxTouchPoints: 5 } }).hint,
      /iPhone and iPad/,
    );
  });

  it('explains Web MIDI without Bluetooth (Firefox, Chrome on Linux)', () => {
    const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';
    const viaFirefox = MidiInput.support({ isSecureContext: true, navigator: { userAgent: firefox, requestMIDIAccess() {} } });
    assert.deepEqual([viaFirefox.bluetooth, viaFirefox.webmidi], [false, true]);
    assert.match(viaFirefox.hint, /cannot use Bluetooth MIDI directly/);

    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    const viaLinux = MidiInput.support({ isSecureContext: true, navigator: { userAgent: linux, requestMIDIAccess() {} } });
    assert.match(viaLinux.hint, /enable-experimental-web-platform-features/);
  });

  it('explains Bluetooth without Web MIDI', () => {
    const support = MidiInput.support({
      isSecureContext: true,
      navigator: { userAgent: chrome, bluetooth: { requestDevice() {} } },
    });
    assert.deepEqual([support.bluetooth, support.webmidi], [true, false]);
    assert.match(support.hint, /USB/);
  });

  it('explains an insecure page', () => {
    const support = MidiInput.support({ isSecureContext: false, navigator: { userAgent: chrome } });
    assert.deepEqual([support.bluetooth, support.webmidi, support.secureContext], [false, false, false]);
    assert.match(support.hint, /http:\/\/localhost/);
  });

  it('hints are one line and work with no environment at all', () => {
    for (const env of [undefined, {}, { navigator: {} }, { isSecureContext: false }]) {
      const support = MidiInput.support(env);
      assert.equal(typeof support.hint, 'string');
      assert.ok(!support.hint.includes('\n'));
      assert.equal(typeof support.bluetooth, 'boolean');
      assert.equal(typeof support.webmidi, 'boolean');
      assert.equal(typeof support.secureContext, 'boolean');
    }
  });
});

// ------------------------------------------------------------------ Bluetooth: connect and notes

describe('Bluetooth connect', () => {
  it('asks for the MIDI service, runs the GATT setup and reports each stage', async () => {
    const { piano, bluetooth, input, events } = setup();
    const result = await input.connectBluetooth();
    assert.deepEqual(bluetooth.requests, [
      { filters: [{ services: [BLE_MIDI_SERVICE_UUID] }], optionalServices: [BLE_MIDI_SERVICE_UUID] },
    ]);
    assert.deepEqual(piano.log, [
      'connect',
      `service:${BLE_MIDI_SERVICE_UUID}`,
      `characteristic:${BLE_MIDI_CHARACTERISTIC_UUID}`,
      'read',
      'notify',
    ]);
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.deepEqual(result, CONNECTED_BLE);
    const statuses = events.statuses();
    assert.deepEqual(
      statuses.map((status) => [status.state, status.transport, status.deviceName]),
      [
        ['connecting', 'ble', null],
        ['connecting', 'ble', 'Test Piano BLE'],
        ['connected', 'ble', 'Test Piano BLE'],
      ],
    );
    assert.match(statuses[0].message, /Choose your piano/);
    assert.equal(input.canSend, true);
  });

  it('acceptAll lists every device but still asks for the MIDI service', async () => {
    const { bluetooth, input } = setup();
    await input.connectBluetooth({ acceptAll: true });
    assert.deepEqual(bluetooth.requests, [{ acceptAllDevices: true, optionalServices: [BLE_MIDI_SERVICE_UUID] }]);
    assert.equal(input.status.state, 'connected');
  });

  it('calls requestDevice before anything asynchronous (the user gesture must still be live)', () => {
    const { bluetooth, input } = setup();
    const pending = input.connectBluetooth();
    assert.equal(bluetooth.requests.length, 1);
    return pending;
  });

  it('a failing read of the characteristic is ignored', async () => {
    const piano = new FakePiano();
    piano.readFails = true;
    const { input } = setup({ piano });
    await input.connectBluetooth();
    assert.equal(input.status.state, 'connected');
    assert.deepEqual(piano.log.slice(-2), ['read', 'notify']);
  });

  it('the read is skipped when the characteristic is not readable, and its result is never parsed', async () => {
    const piano = new FakePiano({ properties: { read: false, notify: true, write: true, writeWithoutResponse: true } });
    const { input, events } = setup({ piano });
    await input.connectBluetooth();
    assert.equal(piano.count('read'), 0);
    assert.equal(input.status.state, 'connected');

    const readable = setup();
    await readable.input.connectBluetooth();
    assert.equal(readable.piano.count('read'), 1);
    assert.deepEqual(readable.events.raws(), []);
    assert.deepEqual(events.raws(), []);
  });

  it('a device without a name connects with deviceName null', async () => {
    const piano = new FakePiano({ name: '' });
    const { input } = setup({ piano });
    await input.connectBluetooth();
    assert.deepEqual(input.status, { state: 'connected', transport: 'ble', deviceName: null, message: null });
  });
});

describe('Bluetooth notes', () => {
  it('turns a real BLE MIDI packet into note events with the arrival time', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    clock.t = 1500;
    piano.packet(pkt(1500, [0x90, 60, 100]));
    assert.deepEqual([...input.held.keys()], [60]);
    clock.t = 1620;
    piano.packet(pkt(1620, [0x80, 60, 40]));
    assert.deepEqual(events.notes(), [
      { type: 'on', midi: 60, velocity: 100, time: 1500, channel: 0, source: 'ble' },
      { type: 'off', midi: 60, velocity: 40, time: 1620, channel: 0, source: 'ble' },
    ]);
    const raws = events.raws();
    assert.equal(raws.length, 2);
    assert.ok(raws[0].bytes instanceof Uint8Array);
    assert.deepEqual([...raws[0].bytes], [0x90, 60, 100]);
    assert.deepEqual([...raws[1].bytes], [0x80, 60, 40]);
    assert.deepEqual([raws[0].time, raws[0].source], [1500, 'ble']);
    assert.equal(input.held.size, 0);
  });

  it('emits raw before the note it describes', async () => {
    const { piano, input, events } = setup();
    await input.connectBluetooth();
    events.clear();
    piano.packet(pkt(1000, [0x90, 60, 100]));
    assert.deepEqual(
      events.all.map((entry) => entry.type),
      ['raw', 'note'],
    );
  });

  it('expands running status: one packet, several notes', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    clock.t = 2000;
    const ts = 2000 & 0x1fff;
    const low = 0x80 | (ts & 0x7f);
    // header, ts, note-on C4, then two more notes with no status byte (one with its own timestamp byte)
    piano.packet([0x80 | (ts >> 7), low, 0x90, 60, 100, 64, 90, low, 67, 80]);
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi, note.velocity, note.time]),
      [
        ['on', 60, 100, 2000],
        ['on', 64, 90, 2000],
        ['on', 67, 80, 2000],
      ],
    );
    assert.deepEqual([...input.held.keys()].sort(), [60, 64, 67]);
  });

  it('several messages in one packet share one arrival time and stay in order', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    let reads = 0;
    const realNow = clock.now;
    clock.now = () => {
      reads += 1;
      return realNow();
    };
    const counting = new MidiInput({
      bluetooth: makeBluetooth(piano),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const seen = record(counting);
    await counting.connectBluetooth();
    clock.t = 3000;
    reads = 0;
    piano.packet(pkt(3000, [0x90, 60, 100], [0x90, 64, 100], [0x80, 60, 0], [0xb0, 64, 127]));
    assert.equal(reads, 1, 'the clock is read once per notification');
    const times = seen.notes().map((note) => note.time);
    assert.deepEqual(times, [3000, 3000, 3000]);
    assert.deepEqual(
      seen.pedals().map((pedal) => pedal.time),
      [3000],
    );
    assert.equal(events.notes().length, 0, 'the first input was replaced on this piano and hears nothing');
    assert.equal(input.status.state, 'connected');
  });

  it('note-on with velocity 0 is a note-off', async () => {
    const { piano, input, events } = setup();
    await input.connectBluetooth();
    piano.packet(pkt(1000, [0x91, 72, 90]));
    piano.packet(pkt(1010, [0x91, 72, 0]));
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi, note.velocity, note.channel]),
      [
        ['on', 72, 90, 1],
        ['off', 72, 0, 1],
      ],
    );
  });

  it('active sensing and MIDI clock are not passed on', async () => {
    const { piano, input, events } = setup();
    await input.connectBluetooth();
    piano.packet(pkt(1000, [0xfe]));
    piano.packet(pkt(1010, [0xf8], [0x90, 60, 100], [0xfe]));
    assert.deepEqual(
      events.raws().map((raw) => [...raw.bytes]),
      [[0x90, 60, 100]],
    );
    assert.equal(events.notes().length, 1);
  });

  it('active sensing still feeds the clock, so the first note already has jitter removed', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    // The piano sends active sensing every 100 ms. Each packet takes 5 ms to arrive.
    let device = 20000;
    for (let i = 0; i < 40; i += 1) {
      device += 100;
      clock.t = device + 5;
      piano.packet(pkt(device, [0xfe]));
    }
    assert.deepEqual(events.raws(), []);
    // The first note is delivered 35 ms late: 30 ms more than the best packets.
    device += 100;
    clock.t = device + 35;
    piano.packet(pkt(device, [0x90, 60, 100]));
    const [note] = events.notes();
    assert.equal(note.time, device + 5, 'reported at the time implied by the device clock, not at arrival');
    assert.ok(note.time <= clock.t && note.time >= clock.t - 80);
  });

  it('other messages reach the raw log only', async () => {
    const { piano, input, events } = setup();
    await input.connectBluetooth();
    const ts = 0x80 | (1000 & 0x7f);
    piano.packet(pkt(1000, [0xc0, 5], [0xe0, 0, 64], [0xb0, 7, 100]));
    piano.packet([0x80 | ((1000 & 0x1fff) >> 7), ts, 0xf0, 0x7e, 0x7f, 0x09, 0x01, ts, 0xf7]);
    assert.deepEqual(
      events.raws().map((raw) => [...raw.bytes]),
      [
        [0xc0, 5],
        [0xe0, 0, 64],
        [0xb0, 7, 100],
        [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7],
      ],
    );
    assert.equal(events.notes().length, 0);
    assert.equal(events.pedals().length, 0);
  });

  it('never throws on garbage from the device', async () => {
    const { piano, input, events } = setup();
    await input.connectBluetooth();
    events.clear();
    assert.doesNotThrow(() => {
      piano.packet([]);
      piano.packet([0x00, 0x90, 60, 100]);
      piano.packet([0x80]);
      piano.packet([0x80, 0x80]);
      piano.packet([0x80, 0x80, 0x90, 60]);
      piano.packet([0xff, 0xff, 0xff, 0xff, 0xff]);
      piano.characteristic.value = null;
      piano.characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
      piano.characteristic.value = 'not a DataView';
      piano.characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
      let seed = 7;
      for (let i = 0; i < 300; i += 1) {
        const bytes = [];
        const length = 1 + (i % 19);
        for (let k = 0; k < length; k += 1) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          bytes.push((seed >> 8) & 0xff);
        }
        piano.packet(bytes);
      }
    });
    for (const note of events.notes()) {
      assert.ok(Number.isInteger(note.midi) && note.midi >= 0 && note.midi <= 127);
      assert.ok(note.type === 'on' || note.type === 'off');
      assert.ok(Number.isFinite(note.time));
    }
    assert.equal(input.status.state, 'connected');
  });
});

describe('held keys, retriggers and the pedal', () => {
  it('tracks held keys and gives out copies', async () => {
    const { clock, piano, input } = setup();
    await input.connectBluetooth();
    clock.t = 1200;
    piano.packet(pkt(1200, [0x90, 60, 100], [0x90, 67, 50]));
    const held = input.held;
    assert.ok(held instanceof Map);
    assert.deepEqual([...held.keys()], [60, 67]);
    assert.deepEqual(held.get(60), { velocity: 100, time: 1200, source: 'ble', channel: 0 });
    held.clear();
    held.set(1, {});
    assert.deepEqual([...input.held.keys()], [60, 67]);
    piano.packet(pkt(1300, [0x80, 60, 0]));
    assert.deepEqual([...input.held.keys()], [67]);
  });

  it('a second note-on for a held key closes the first note, so on and off always alternate', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    clock.t = 1000;
    piano.packet(pkt(1000, [0x90, 60, 100]));
    clock.t = 1200;
    piano.packet(pkt(1200, [0x90, 60, 70]));
    clock.t = 1400;
    piano.packet(pkt(1400, [0x80, 60, 0]));
    // A piano that sends one note-off per note-on: the extra one finds nothing to release.
    piano.packet(pkt(1401, [0x80, 60, 0]));
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi, note.velocity, note.time]),
      [
        ['on', 60, 100, 1000],
        ['off', 60, 0, 1200],
        ['on', 60, 70, 1200],
        ['off', 60, 0, 1400],
      ],
    );
    assert.equal(events.raws().length, 4, 'every message from the piano is still in the raw log');
  });

  it('a note-off for a key that is not down is ignored', async () => {
    const { piano, input, events } = setup();
    await input.connectBluetooth();
    piano.packet(pkt(1000, [0x80, 60, 0]));
    assert.equal(events.notes().length, 0);
    assert.equal(events.raws().length, 1);
  });

  it('reports the pedal only when it goes down or comes up', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    assert.equal(input.sustain, false);
    const values = [10, 40, 63, 64, 90, 127, 127, 80, 64, 63, 20, 0, 0, 100];
    const sustain = [];
    for (const [i, value] of values.entries()) {
      clock.t = 2000 + i * 10;
      piano.packet(pkt(clock.t, [0xb0, 64, value]));
      sustain.push(input.sustain);
    }
    assert.deepEqual(events.pedals(), [
      { down: true, value: 64, time: 2030, source: 'ble' },
      { down: false, value: 63, time: 2090, source: 'ble' },
      { down: true, value: 100, time: 2130, source: 'ble' },
    ]);
    assert.deepEqual(sustain, [false, false, false, true, true, true, true, true, true, false, false, false, false, true]);
    assert.equal(events.raws().length, values.length);
  });

  it('other controllers are not the pedal', async () => {
    const { piano, input, events } = setup();
    await input.connectBluetooth();
    piano.packet(pkt(1000, [0xb0, 66, 127], [0xb0, 67, 127], [0xb0, 1, 127]));
    assert.equal(events.pedals().length, 0);
    assert.equal(input.sustain, false);
  });
});

// ------------------------------------------------------------------ Bluetooth: losing the link

describe('Bluetooth reconnect', () => {
  it('an unexpected disconnect releases held notes and the pedal, then reconnects with backoff', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    clock.t = 30000;
    piano.packet(pkt(30000, [0x90, 60, 100], [0x91, 64, 90], [0xb0, 64, 127]));
    input.noteOn(72);
    events.clear();
    piano.connectPlan = ['fail', 'fail', 'ok'];
    clock.t = 31000;
    piano.drop();

    // All of this happens at once, before any retry.
    assert.deepEqual(events.notes(), [
      { type: 'off', midi: 60, velocity: 0, time: 31000, channel: 0, source: 'ble' },
      { type: 'off', midi: 64, velocity: 0, time: 31000, channel: 1, source: 'ble' },
    ]);
    assert.deepEqual(events.pedals(), [{ down: false, value: 0, time: 31000, source: 'ble' }]);
    assert.deepEqual([...input.held.keys()], [72], 'the on-screen key is not touched');
    assert.equal(input.sustain, false);
    assert.equal(input.canSend, false);
    assert.equal(input.status.state, 'reconnecting');
    assert.equal(input.status.deviceName, 'Test Piano BLE');
    assert.match(input.status.message, /Trying to reconnect/);
    assert.deepEqual(
      events.all.map((entry) => entry.type),
      ['note', 'note', 'pedal', 'status'],
      'keys are released before the status changes',
    );

    assert.deepEqual(clock.pending(), [500]);
    await clock.advance(499);
    assert.equal(piano.count('connect'), 1);
    await clock.advance(1);
    assert.equal(piano.count('connect'), 2);
    assert.equal(input.status.state, 'reconnecting');
    assert.deepEqual(clock.pending(), [1000]);
    await clock.advance(1000);
    assert.equal(piano.count('connect'), 3);
    assert.deepEqual(clock.pending(), [2000]);
    await clock.advance(2000);
    assert.equal(piano.count('connect'), 4);
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.deepEqual(clock.pending(), []);
    assert.equal(input.canSend, true);

    // The new link works, and the real note-offs for the released keys change nothing.
    events.clear();
    piano.packet(pkt(clock.t, [0x80, 60, 0], [0x90, 62, 80]));
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi]),
      [['on', 62]],
    );
  });

  it('gives up after six tries with a helpful error', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    piano.connectPlan = Array(6).fill('fail');
    clock.t = 40000;
    piano.drop();
    const waits = [];
    for (let i = 0; i < 6; i += 1) {
      assert.equal(input.status.state, 'reconnecting');
      const pending = clock.pending();
      assert.equal(pending.length, 1);
      waits.push(pending[0]);
      await clock.advance(pending[0]);
    }
    assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 8000]);
    assert.equal(piano.count('connect'), 7);
    assert.equal(input.status.state, 'error');
    assert.equal(input.status.transport, 'ble');
    assert.match(input.status.message, /Could not reconnect to Test Piano BLE after 6 tries/);
    assert.deepEqual(clock.pending(), []);
    assert.equal(input.canSend, false);

    // Nothing more happens by itself.
    events.clear();
    piano.dispatchEvent(new Event('gattserverdisconnected'));
    await clock.advance(60000);
    assert.equal(piano.count('connect'), 7);
    assert.deepEqual(events.all, []);

    // The learner can connect again.
    await input.connectBluetooth();
    assert.deepEqual(input.status, CONNECTED_BLE);
  });

  it('a reconnect try that hangs is cut off and the next one follows', async () => {
    const { clock, piano, input } = setup({ input: { reconnectDelaysMs: [100, 200], connectTimeoutMs: 3000 } });
    await input.connectBluetooth();
    piano.connectPlan = ['hang', 'ok'];
    clock.t = 50000;
    piano.drop();
    await clock.advance(100);
    assert.equal(piano.count('connect'), 2);
    assert.deepEqual(clock.pending(), [3000]);
    const disconnectsBefore = piano.count('disconnect');
    await clock.advance(3000);
    assert.equal(piano.count('disconnect'), disconnectsBefore + 1, 'the waiting connect() is cancelled');
    assert.deepEqual(clock.pending(), [200]);
    await clock.advance(200);
    assert.deepEqual(input.status, CONNECTED_BLE);
  });

  it('a link that keeps dropping right after reconnecting does not retry forever', async () => {
    const { clock, piano, input } = setup({ input: { reconnectDelaysMs: [10, 20] } });
    await input.connectBluetooth();
    clock.t = 60000; // the first link was stable for a long time
    piano.drop();
    assert.deepEqual(clock.pending(), [10]);
    await clock.advance(10);
    assert.equal(input.status.state, 'connected');
    piano.drop(); // drops again at once
    assert.deepEqual(clock.pending(), [20], 'the try counter was not reset');
    await clock.advance(20);
    assert.equal(input.status.state, 'connected');
    piano.drop();
    assert.equal(input.status.state, 'error');
    assert.match(input.status.message, /after 2 tries/);
    assert.deepEqual(clock.pending(), []);
  });

  it('a link that was stable again gets a fresh set of tries', async () => {
    const { clock, piano, input } = setup({ input: { reconnectDelaysMs: [10, 20] } });
    await input.connectBluetooth();
    clock.t = 60000;
    piano.drop();
    await clock.advance(10);
    assert.equal(input.status.state, 'connected');
    await clock.advance(15000);
    piano.drop();
    assert.deepEqual(clock.pending(), [10]);
    await clock.advance(10);
    assert.equal(input.status.state, 'connected');
  });

  it('with no reconnect tries configured a drop is an error at once', async () => {
    const { piano, input } = setup({ input: { reconnectDelaysMs: [] } });
    await input.connectBluetooth();
    piano.drop();
    assert.equal(input.status.state, 'error');
    assert.match(input.status.message, /Lost the Bluetooth connection/);
  });

  it('resets the packet parser on reconnect: half a SysEx from the old link is forgotten', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    const ts = 0x80 | 5;
    piano.packet([0x80, ts, 0xf0, 0x01, 0x02]); // SysEx start, not finished
    piano.drop();
    await clock.advance(500);
    assert.equal(input.status.state, 'connected');
    events.clear();
    piano.packet([0x80, 0x03, 0x04, ts, 0xf7]); // would finish it if the parser had kept state
    assert.deepEqual(events.raws(), []);
  });

  it('events from the characteristic of the old link are ignored', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    const old = piano.characteristic;
    piano.drop();
    await clock.advance(500);
    assert.equal(piano.characteristics.length, 2);
    events.clear();
    piano.packet(pkt(clock.t, [0x90, 60, 100]), old);
    assert.deepEqual(events.all, []);
    piano.packet(pkt(clock.t, [0x90, 60, 100]));
    assert.equal(events.notes().length, 1);
  });

  it('works with a device that hands out the same characteristic object every time (the e2e fake)', async () => {
    const piano = new FakePiano({ reuseCharacteristic: true });
    const { clock, input, events } = setup({ piano });
    await input.connectBluetooth();
    piano.packet(pkt(clock.t, [0x90, 72, 80]));
    piano.drop();
    assert.equal(input.held.size, 0);
    assert.notEqual(input.status.state, 'connected');
    await clock.advance(500);
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.equal(piano.characteristics.length, 1);
    events.clear();
    piano.packet(pkt(clock.t, [0x90, 60, 100]));
    assert.equal(events.notes().length, 1, 'exactly one listener is attached after a reconnect');
    assert.equal(events.raws().length, 1);
  });

  it('a status listener that disconnects when the link drops stops the reconnect', async () => {
    const { clock, piano, input } = setup();
    await input.connectBluetooth();
    input.addEventListener('status', (event) => {
      if (event.detail.state === 'reconnecting') input.disconnect();
    });
    piano.drop();
    await clock.advance(60000);
    assert.deepEqual(input.status, DISCONNECTED);
    assert.equal(piano.count('connect'), 1);
    assert.deepEqual(clock.pending(), []);
  });
});

describe('Bluetooth disconnect', () => {
  it('a manual disconnect releases keys, drops the link and does not reconnect', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    clock.t = 2000;
    piano.packet(pkt(2000, [0x90, 60, 100], [0xb0, 64, 127]));
    events.clear();
    clock.t = 2500;
    await input.disconnect();
    assert.deepEqual(events.notes(), [{ type: 'off', midi: 60, velocity: 0, time: 2500, channel: 0, source: 'ble' }]);
    assert.deepEqual(events.pedals(), [{ down: false, value: 0, time: 2500, source: 'ble' }]);
    assert.deepEqual(events.statuses(), [DISCONNECTED]);
    assert.deepEqual(input.status, DISCONNECTED);
    assert.equal(piano.gatt.connected, false);
    assert.equal(input.canSend, false);
    assert.deepEqual(clock.pending(), []);
    await clock.advance(120000);
    assert.equal(piano.count('connect'), 1);
    assert.deepEqual(input.status, DISCONNECTED);

    // The old characteristic is deaf now.
    events.clear();
    piano.packet(pkt(clock.t, [0x90, 60, 100]));
    piano.dispatchEvent(new Event('gattserverdisconnected'));
    assert.deepEqual(events.all, []);
  });

  it('a manual disconnect cancels a pending reconnect', async () => {
    const { clock, piano, input } = setup();
    await input.connectBluetooth();
    piano.connectPlan = ['fail'];
    piano.drop();
    await clock.advance(500);
    assert.deepEqual(clock.pending(), [1000]);
    await input.disconnect();
    assert.deepEqual(clock.pending(), []);
    await clock.advance(120000);
    assert.equal(piano.count('connect'), 2);
    assert.deepEqual(input.status, DISCONNECTED);
  });

  it('a manual disconnect during a reconnect try stops it', async () => {
    const { clock, piano, input } = setup();
    await input.connectBluetooth();
    piano.connectPlan = ['hang'];
    piano.drop();
    await clock.advance(500);
    assert.equal(piano.count('connect'), 2);
    await input.disconnect();
    await clock.advance(120000);
    assert.deepEqual(input.status, DISCONNECTED);
    assert.equal(piano.count('connect'), 2);
    assert.deepEqual(clock.pending(), []);
  });

  it('disconnect while the first connect is still running ends it quietly', async () => {
    const piano = new FakePiano();
    piano.connectPlan = ['hang'];
    const { clock, input, events } = setup({ piano });
    const connecting = input.connectBluetooth();
    await flush();
    assert.equal(input.status.state, 'connecting');
    await input.disconnect();
    assert.deepEqual(await connecting, DISCONNECTED);
    assert.deepEqual(clock.pending(), []);
    assert.equal(events.statuses().at(-1).state, 'disconnected');
    await clock.advance(120000);
    assert.equal(piano.count('connect'), 1);
  });

  it('a status listener that disconnects as soon as the device is known stops the connect before any GATT call', async () => {
    const { clock, piano, input } = setup();
    input.addEventListener('status', (event) => {
      if (event.detail.state === 'connecting' && event.detail.deviceName) input.disconnect();
    });
    assert.deepEqual(await input.connectBluetooth(), DISCONNECTED);
    assert.equal(piano.count('connect'), 0);
    assert.equal(piano.gatt.connected, false);
    assert.deepEqual(clock.pending(), []);
  });

  it('disconnect while the chooser is open: a device picked afterwards is not connected', async () => {
    const piano = new FakePiano();
    let pick;
    const bluetooth = {
      requestDevice: () =>
        new Promise((resolve) => {
          pick = resolve;
        }),
    };
    const { input } = setup({ piano, bluetooth });
    const connecting = input.connectBluetooth();
    await flush();
    await input.disconnect();
    pick(piano);
    assert.deepEqual(await connecting, DISCONNECTED);
    assert.equal(piano.count('connect'), 0);
  });

  it('disconnect when nothing is connected is harmless, and clears an error', async () => {
    const { input, events } = setup({ bluetooth: null });
    await input.disconnect();
    assert.deepEqual(events.all, []);
    await assert.rejects(input.connectBluetooth());
    assert.equal(input.status.state, 'error');
    await input.disconnect();
    assert.deepEqual(input.status, DISCONNECTED);
  });
});

// ------------------------------------------------------------------ Bluetooth: failures

describe('Bluetooth failures', () => {
  it('closing the chooser rethrows the browser error and goes back to disconnected quietly', async () => {
    const cancel = domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
    const bluetooth = {
      async requestDevice() {
        throw cancel;
      },
    };
    const { input, events } = setup({ bluetooth });
    await assert.rejects(input.connectBluetooth(), (err) => err === cancel);
    assert.deepEqual(input.status, DISCONNECTED);
    assert.deepEqual(
      events.statuses().map((status) => status.state),
      ['connecting', 'disconnected'],
    );
    // What the app checks to stay quiet.
    assert.equal(cancel.name, 'NotFoundError');
    assert.match(cancel.message, /cancel/i);
  });

  it('closing the chooser while a piano is connected keeps that connection', async () => {
    const { clock, piano, bluetooth, input, events } = setup();
    await input.connectBluetooth();
    piano.packet(pkt(clock.t, [0x90, 60, 100]));
    events.clear();
    const cancel = domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
    bluetooth.requestDevice = async () => {
      throw cancel;
    };
    await assert.rejects(input.connectBluetooth(), (err) => err === cancel);
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.deepEqual(events.all, []);
    assert.equal(piano.gatt.connected, true);
    assert.deepEqual([...input.held.keys()], [60]);
  });

  it('picking the piano that is already connected keeps the link', async () => {
    const { piano, input, events } = setup();
    await input.connectBluetooth();
    events.clear();
    await input.connectBluetooth();
    assert.equal(piano.count('connect'), 1);
    assert.equal(piano.count('disconnect'), 0);
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.deepEqual(events.all, []);
  });

  it('reports a browser without Web Bluetooth', async () => {
    const { input, events } = setup({ bluetooth: null });
    await assert.rejects(input.connectBluetooth(), (err) => {
      assert.ok(err instanceof MidiInputError);
      assert.equal(err.code, 'unsupported');
      assert.equal(err.message, input.status.message);
      return true;
    });
    assert.equal(input.status.state, 'error');
    assert.match(input.status.message, /cannot use Bluetooth MIDI/);
    assert.equal(events.statuses().length, 1);
  });

  it('reports a page that is not a secure context', async (t) => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
    Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true, writable: true });
    t.after(() => {
      if (had) Object.defineProperty(globalThis, 'isSecureContext', had);
      else delete globalThis.isSecureContext;
    });
    const { bluetooth, input } = setup();
    await assert.rejects(input.connectBluetooth(), (err) => err instanceof MidiInputError && err.code === 'insecure-context');
    assert.equal(bluetooth.requests.length, 0);
    assert.equal(input.status.state, 'error');
    assert.match(input.status.message, /http:\/\/localhost/);
  });

  it('reports a missing or switched-off Bluetooth adapter (also a NotFoundError in Chrome)', async () => {
    const bluetooth = {
      async requestDevice() {
        throw domError('NotFoundError', 'Bluetooth adapter not available.');
      },
    };
    const { input } = setup({ bluetooth });
    await assert.rejects(input.connectBluetooth(), (err) => {
      assert.ok(err instanceof MidiInputError);
      assert.equal(err.code, 'adapter-off');
      assert.notEqual(err.name, 'NotFoundError');
      assert.equal(err.cause.message, 'Bluetooth adapter not available.');
      return true;
    });
    assert.equal(input.status.state, 'error');
    assert.match(input.status.message, /Bluetooth is not available/);
    assert.doesNotMatch(input.status.message, /cancel/i);
  });

  it('reports blocked Bluetooth and other chooser failures', async () => {
    const cases = [
      [
        domError('SecurityError', 'Must be handling a user gesture to show a permission request.'),
        'permission',
        /not allowed to use Bluetooth/,
      ],
      [
        domError('NotFoundError', 'User denied the browser permission to scan for Bluetooth devices.'),
        'permission',
        /not allowed to use Bluetooth/,
      ],
      [domError('NotFoundError', 'Web Bluetooth API globally disabled.'), 'unsupported', /Bluetooth/],
      [new TypeError('Failed to execute requestDevice'), 'failed', /Could not open the Bluetooth device list/],
    ];
    for (const [error, code, pattern] of cases) {
      const bluetooth = {
        async requestDevice() {
          throw error;
        },
      };
      const { input } = setup({ bluetooth });
      await assert.rejects(input.connectBluetooth(), (err) => err instanceof MidiInputError && err.code === code);
      assert.equal(input.status.state, 'error');
      assert.match(input.status.message, pattern);
    }
  });

  it('reports a device without the MIDI service and does not retry', async () => {
    const piano = new FakePiano({ name: 'Headphones' });
    piano.noService = true;
    const { clock, input } = setup({ piano });
    await assert.rejects(input.connectBluetooth(), (err) => err instanceof MidiInputError && err.code === 'no-midi-service');
    assert.equal(input.status.state, 'error');
    assert.equal(input.status.deviceName, 'Headphones');
    assert.match(input.status.message, /Headphones does not offer Bluetooth MIDI/);
    assert.match(input.status.message, /pairing/);
    assert.equal(piano.count('connect'), 1);
    assert.equal(piano.gatt.connected, false, 'the half-open link is closed');
    assert.deepEqual(clock.pending(), []);
    piano.dispatchEvent(new Event('gattserverdisconnected'));
    assert.equal(input.status.state, 'error');
  });

  it('reports a device without the MIDI characteristic', async () => {
    const piano = new FakePiano();
    piano.noCharacteristic = true;
    const { input } = setup({ piano });
    await assert.rejects(input.connectBluetooth(), (err) => err.code === 'no-midi-service');
    assert.equal(piano.gatt.connected, false);
  });

  it('retries a failed GATT connect, then reports it', async () => {
    const piano = new FakePiano();
    piano.connectPlan = ['fail', 'fail', 'fail'];
    const { clock, input, events } = setup({ piano });
    let outcome = null;
    const connecting = input.connectBluetooth().then(
      () => {
        outcome = 'resolved';
      },
      (err) => {
        outcome = err;
      },
    );
    await flush();
    assert.equal(outcome, null);
    assert.deepEqual(clock.pending(), [500]);
    assert.match(input.status.message, /try 2 of 3/);
    await clock.advance(500);
    assert.deepEqual(clock.pending(), [1500]);
    await clock.advance(1500);
    await connecting;
    assert.ok(outcome instanceof MidiInputError);
    assert.equal(outcome.code, 'gatt-failed');
    assert.equal(outcome.cause.name, 'NetworkError');
    assert.equal(piano.count('connect'), 3);
    assert.equal(input.status.state, 'error');
    assert.match(input.status.message, /Could not connect to Test Piano BLE/);
    assert.match(input.status.message, /switched on/);
    assert.equal(events.statuses().filter((status) => status.state === 'connected').length, 0);
    assert.deepEqual(clock.pending(), []);
  });

  it('a GATT connect that fails once succeeds on the retry', async () => {
    const piano = new FakePiano();
    piano.connectPlan = ['fail'];
    const { clock, input } = setup({ piano });
    const connecting = input.connectBluetooth();
    await clock.advance(500);
    await connecting;
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.equal(piano.count('connect'), 2);
  });

  it('a GATT connect that never answers times out', async () => {
    const piano = new FakePiano();
    piano.connectPlan = ['hang'];
    const { clock, input } = setup({ piano, input: { connectRetryDelaysMs: [], connectTimeoutMs: 4000 } });
    let outcome = null;
    const connecting = input.connectBluetooth().catch((err) => {
      outcome = err;
    });
    await flush();
    assert.deepEqual(clock.pending(), [4000]);
    await clock.advance(4000);
    await connecting;
    assert.equal(outcome.code, 'timeout');
    assert.match(input.status.message, /did not answer in time/);
    assert.equal(piano.count('disconnect') >= 1, true);
    assert.equal(input.status.state, 'error');
  });

  it('reports a piano that connects but will not start notifications', async () => {
    const piano = new FakePiano();
    piano.notifyFails = true;
    const { input, events } = setup({ piano });
    await assert.rejects(input.connectBluetooth(), (err) => err.code === 'notify-failed');
    assert.match(input.status.message, /would not send notes/);
    assert.equal(piano.gatt.connected, false);
    events.clear();
    piano.packet(pkt(1000, [0x90, 60, 100]));
    assert.deepEqual(events.all, [], 'no listener is left behind');
  });

  it('a link that drops during setup is retried', async () => {
    const piano = new FakePiano();
    const { clock, input } = setup({ piano });
    const realService = piano.gatt.getPrimaryService.bind(piano.gatt);
    let first = true;
    piano.gatt.getPrimaryService = (uuid) => {
      if (first) {
        first = false;
        return new Promise(() => {
          setImmediate(() => piano.drop());
        });
      }
      return realService(uuid);
    };
    const connecting = input.connectBluetooth();
    await flush();
    await flush();
    assert.equal(input.status.state, 'connecting');
    assert.match(input.status.message, /try 2 of 3/);
    assert.deepEqual(clock.pending(), [500]);
    await clock.advance(500);
    await connecting;
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.equal(piano.count('connect'), 2);
  });

  it('a piano that hangs up when its characteristic is read is connected without the read', async () => {
    const piano = new FakePiano();
    const { clock, input } = setup({ piano });
    const connect = piano.gatt.connect.bind(piano.gatt);
    piano.gatt.connect = async () => {
      const server = await connect();
      piano.characteristic.readValue = () => {
        piano.log.push('read');
        setImmediate(() => piano.drop());
        return new Promise(() => {});
      };
      return server;
    };
    const connecting = input.connectBluetooth();
    await flush();
    await flush();
    assert.deepEqual(clock.pending(), [500]);
    await clock.advance(500);
    await connecting;
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.equal(piano.count('read'), 1, 'the second try did not read');
    assert.equal(piano.count('notify'), 1);
  });

  it('a broken getAvailability() does not get in the way of the real error', async () => {
    const piano = new FakePiano();
    piano.connectPlan = ['fail'];
    const { clock, bluetooth, input } = setup({ piano, input: { connectRetryDelaysMs: [] } });
    bluetooth.getAvailability = () => Promise.reject(new Error('no idea'));
    await assert.rejects(input.connectBluetooth(), (err) => err.code === 'gatt-failed');
    assert.deepEqual(clock.pending(), [], 'no timer is left behind');
    bluetooth.getAvailability = () => new Promise(() => {});
    piano.connectPlan = ['fail'];
    const connecting = input.connectBluetooth().catch((err) => err);
    await clock.advance(1000);
    assert.equal((await connecting).code, 'gatt-failed');
    assert.deepEqual(clock.pending(), []);
  });

  it('says so when the system has no Bluetooth at all', async () => {
    const piano = new FakePiano();
    piano.connectPlan = ['fail'];
    const { bluetooth, input } = setup({ piano, input: { connectRetryDelaysMs: [] } });
    bluetooth.available = false;
    await assert.rejects(input.connectBluetooth(), (err) => err.code === 'adapter-off');
    assert.match(input.status.message, /Bluetooth is not available/);
  });

  it('a failed Bluetooth attempt next to a live Web MIDI connection keeps that connection', async () => {
    const port = new FakePort('input', 'USB Piano');
    const access = new FakeAccess([port]);
    const bluetooth = {
      async requestDevice() {
        throw domError('NotFoundError', 'Bluetooth adapter not available.');
      },
    };
    const { input } = setup({ bluetooth, access });
    await input.connectWebMidi();
    await assert.rejects(input.connectBluetooth(), (err) => err.code === 'adapter-off');
    assert.equal(input.status.state, 'connected');
    assert.equal(input.status.transport, 'webmidi');
    assert.match(input.status.message, /Bluetooth is not available/);
    port.emit([0x90, 60, 100], 0);
    assert.equal(input.held.size, 1);
  });
});

describe('overlapping and replaced connections', () => {
  it('two connect calls at once end in one connection', async () => {
    const { clock, piano, input, events } = setup();
    const results = await Promise.all([input.connectBluetooth(), input.connectBluetooth()]);
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.deepEqual(results[1], CONNECTED_BLE);
    assert.equal(piano.count('connect'), 1);
    assert.equal(events.statuses().filter((status) => status.state === 'connected').length, 1);
    events.clear();
    piano.packet(pkt(clock.t, [0x90, 60, 100]));
    assert.equal(events.notes().length, 1);
  });

  it('a second connect call replaces one that is still connecting', async () => {
    const piano = new FakePiano({ reuseCharacteristic: true });
    piano.connectPlan = ['hang', 'ok'];
    const { clock, input, events } = setup({ piano });
    const first = input.connectBluetooth();
    await flush();
    assert.equal(piano.count('connect'), 1);
    const second = input.connectBluetooth();
    await Promise.all([first, second]);
    assert.deepEqual(input.status, CONNECTED_BLE);
    assert.equal(piano.count('connect'), 2);
    assert.equal(events.statuses().filter((status) => status.state === 'connected').length, 1);
    assert.equal(events.statuses().filter((status) => status.state === 'error').length, 0);
    events.clear();
    piano.packet(pkt(clock.t, [0x90, 60, 100]));
    assert.equal(events.notes().length, 1);
    assert.deepEqual(clock.pending(), []);
  });

  it('connecting another piano drops the first, and its late events are ignored', async () => {
    const first = new FakePiano({ name: 'Piano A' });
    const second = new FakePiano({ name: 'Piano B' });
    const bluetooth = makeBluetooth(first);
    const { clock, input, events } = setup({ piano: first, bluetooth });
    await input.connectBluetooth();
    first.packet(pkt(clock.t, [0x90, 60, 100]));
    const oldCharacteristic = first.characteristic;
    bluetooth.requestDevice = async () => second;
    events.clear();
    await input.connectBluetooth();
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi]),
      [['off', 60]],
    );
    assert.equal(first.gatt.connected, false);
    assert.equal(input.status.deviceName, 'Piano B');
    assert.equal(input.status.state, 'connected');

    events.clear();
    first.packet(pkt(clock.t, [0x90, 61, 100]), oldCharacteristic);
    first.dispatchEvent(new Event('gattserverdisconnected'));
    await clock.advance(60000);
    assert.deepEqual(events.all, []);
    assert.equal(first.count('connect'), 1);
    assert.equal(input.status.deviceName, 'Piano B');
    second.packet(pkt(clock.t, [0x90, 62, 100]));
    assert.deepEqual([...input.held.keys()], [62]);
  });

  it('only one hardware transport at a time: Web MIDI replaces Bluetooth and back', async () => {
    const port = new FakePort('input', 'USB Piano');
    const access = new FakeAccess([port]);
    const { clock, piano, input, events } = setup({ access });
    await input.connectBluetooth();
    piano.packet(pkt(clock.t, [0x90, 60, 100], [0xb0, 64, 127]));
    events.clear();

    await input.connectWebMidi();
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi, note.source]),
      [['off', 60, 'ble']],
    );
    assert.deepEqual(
      events.pedals().map((pedal) => pedal.down),
      [false],
    );
    assert.equal(piano.gatt.connected, false);
    assert.deepEqual(input.status, { state: 'connected', transport: 'webmidi', deviceName: 'USB Piano', message: null });
    await clock.advance(60000);
    assert.equal(piano.count('connect'), 1, 'the replaced Bluetooth link does not reconnect');
    assert.equal(input.status.transport, 'webmidi');

    port.emit([0x90, 64, 90], 0);
    events.clear();
    await input.connectBluetooth();
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi, note.source]),
      [['off', 64, 'webmidi']],
    );
    assert.equal(port.listeners.size, 0);
    assert.equal(port.closed, 1);
    assert.deepEqual(input.status, CONNECTED_BLE);
    events.clear();
    port.emit([0x90, 65, 90], 0);
    assert.deepEqual(events.all, []);
  });
});

// ------------------------------------------------------------------ Bluetooth: sending

describe('Bluetooth send', () => {
  const decode = (bytes) => new BleMidiParser().parse(Uint8Array.from(bytes)).map((message) => [...message.data]);

  it('encodes one message as a BLE MIDI packet and writes it without response', async () => {
    const { clock, piano, input } = setup();
    await input.connectBluetooth();
    clock.t = 5000;
    assert.equal(input.send([0x90, 60, 72]), true);
    assert.equal(piano.writes.length, 0, 'the write starts on a later tick');
    await flush();
    assert.equal(piano.writes.length, 1);
    const [write] = piano.writes;
    assert.equal(write.kind, 'writeValueWithoutResponse');
    const ts = 5000 & 0x1fff;
    assert.deepEqual(write.bytes, [0x80 | (ts >> 7), 0x80 | (ts & 0x7f), 0x90, 60, 72]);
    assert.deepEqual(decode(write.bytes), [[0x90, 60, 72]]);
    assert.equal(write.characteristic, piano.characteristic);
  });

  it('accepts typed arrays too', async () => {
    const { piano, input } = setup();
    await input.connectBluetooth();
    assert.equal(input.send(Uint8Array.of(0x80, 60, 0)), true);
    await flush();
    assert.deepEqual(decode(piano.writes[0].bytes), [[0x80, 60, 0]]);
  });

  it('messages sent together share a packet, within 20 bytes', async () => {
    const { piano, input } = setup();
    await input.connectBluetooth();
    for (const midi of [60, 64, 67]) input.send([0x90, midi, 72]);
    await flush();
    assert.equal(piano.writes.length, 1);
    assert.deepEqual(decode(piano.writes[0].bytes), [
      [0x90, 60, 72],
      [0x90, 64, 72],
      [0x90, 67, 72],
    ]);

    piano.writes.length = 0;
    for (const midi of [60, 62, 64, 65, 67, 69]) input.send([0x80, midi, 0]);
    await flush();
    assert.deepEqual(
      piano.writes.map((write) => write.bytes.length),
      [17, 9],
    );
    assert.ok(piano.writes.every((write) => write.bytes.length <= 20));
    assert.deepEqual(
      piano.writes.flatMap((write) => decode(write.bytes)).map((message) => message[1]),
      [60, 62, 64, 65, 67, 69],
    );
  });

  it('writes never overlap and keep their order', async () => {
    const { piano, input } = setup();
    await input.connectBluetooth();
    const gates = [];
    piano.writeGate = () =>
      new Promise((resolve) => {
        gates.push(resolve);
      });
    input.send([0x90, 60, 72]);
    await flush();
    assert.equal(piano.writes.length, 1);
    input.send([0x90, 62, 72]);
    await flush();
    input.send([0x90, 64, 72]);
    await flush();
    assert.equal(piano.writes.length, 1, 'nothing is written while a write is in flight');
    gates.shift()();
    await flush();
    assert.equal(piano.writes.length, 2);
    input.send([0x80, 60, 0]);
    gates.shift()();
    await flush();
    assert.equal(piano.writes.length, 3);
    gates.shift()();
    await flush();
    assert.equal(piano.maxActiveWrites, 1);
    assert.deepEqual(
      piano.writes.flatMap((write) => decode(write.bytes)),
      [
        [0x90, 60, 72],
        [0x90, 62, 72],
        [0x90, 64, 72],
        [0x80, 60, 0],
      ],
    );
    // The queue is idle again and still works.
    input.send([0x80, 62, 0]);
    await flush();
    assert.equal(piano.writes.length, 4);
  });

  it('a write that fails or hangs does not throw and does not block later messages', async () => {
    const { clock, piano, input } = setup();
    await input.connectBluetooth();
    piano.writeFails = true;
    assert.equal(input.send([0x90, 60, 72]), true);
    await flush();
    piano.writeFails = false;
    assert.equal(input.send([0x80, 60, 0]), true);
    await flush();
    assert.equal(piano.writes.length, 2);

    piano.writeGate = () => new Promise(() => {});
    input.send([0x90, 61, 72]);
    await flush();
    piano.writeGate = null;
    input.send([0x80, 61, 0]);
    await flush();
    assert.equal(piano.writes.length, 3);
    await clock.advance(5000);
    assert.equal(piano.writes.length, 4, 'the stuck write is given up after 5 seconds');
  });

  it('falls back to writeValue when write without response is not offered', async () => {
    const piano = new FakePiano({ properties: { read: true, notify: true, write: true, writeWithoutResponse: false } });
    const { input } = setup({ piano });
    await input.connectBluetooth();
    assert.equal(input.canSend, true);
    input.send([0x90, 60, 72]);
    await flush();
    assert.equal(piano.writes[0].kind, 'writeValue');
  });

  it('canSend follows the link, and send returns false when nothing can be sent', async () => {
    const { clock, piano, input } = setup();
    assert.equal(input.canSend, false);
    assert.equal(input.send([0x90, 60, 72]), false);
    await input.connectBluetooth();
    assert.equal(input.canSend, true);
    piano.connectPlan = ['fail'];
    piano.drop();
    assert.equal(input.canSend, false);
    assert.equal(input.send([0x90, 60, 72]), false);
    await clock.advance(500);
    assert.equal(input.canSend, false);
    await clock.advance(1000);
    assert.equal(input.canSend, true);
    assert.equal(input.send([0x90, 60, 72]), true);
    await flush();
    assert.equal(piano.writes.at(-1).characteristic, piano.characteristic, 'written to the new characteristic');
    await input.disconnect();
    assert.equal(input.canSend, false);
    assert.equal(input.send([0x90, 60, 72]), false);
  });

  it('messages still queued when the link drops are discarded, not sent late', async () => {
    const { clock, piano, input } = setup();
    await input.connectBluetooth();
    const gates = [];
    piano.writeGate = () =>
      new Promise((resolve) => {
        gates.push(resolve);
      });
    input.send([0x90, 60, 72]);
    await flush();
    input.send([0x80, 60, 0]);
    piano.drop();
    gates.shift()();
    await clock.advance(500);
    assert.equal(input.status.state, 'connected');
    await flush();
    assert.equal(piano.writes.length, 1);
  });

  it('a characteristic that cannot be written means canSend is false', async () => {
    const piano = new FakePiano({ properties: { read: true, notify: true, write: false, writeWithoutResponse: false } });
    const { input } = setup({ piano });
    await input.connectBluetooth();
    assert.equal(input.status.state, 'connected');
    assert.equal(input.canSend, false);
    assert.equal(input.send([0x90, 60, 72]), false);
  });

  it('refuses anything that is not one complete MIDI message, without throwing', async () => {
    const { piano, input } = setup();
    await input.connectBluetooth();
    const bad = [
      null,
      undefined,
      'abc',
      60,
      {},
      [],
      [60, 1, 2],
      [0x90, 60],
      [0x90, 60, 200],
      [0x90, 60, 72, 1],
      [0xf0, 1, 2],
      [0xf7],
      [[0x90, 60, 72]],
    ];
    for (const bytes of bad) {
      assert.doesNotThrow(() => assert.equal(input.send(bytes), false), `send(${JSON.stringify(bytes)})`);
    }
    await flush();
    assert.equal(piano.writes.length, 0);
  });
});

// ------------------------------------------------------------------ Web MIDI

describe('Web MIDI', () => {
  it('asks without SysEx, attaches to every input and names them', async () => {
    const piano = new FakePort('input', 'Digital Piano');
    const pads = new FakePort('input', 'Pad Controller');
    const access = new FakeAccess([piano, pads]);
    const { input, events, midiRequests } = setup({ access });
    const result = await input.connectWebMidi();
    assert.deepEqual(midiRequests, [{ sysex: false }]);
    const expected = { state: 'connected', transport: 'webmidi', deviceName: 'Digital Piano + Pad Controller', message: null };
    assert.deepEqual(input.status, expected);
    assert.deepEqual(result, expected);
    assert.deepEqual(
      events.statuses().map((status) => status.state),
      ['connecting', 'connected'],
    );
    assert.equal(piano.listeners.size, 1);
    assert.equal(pads.listeners.size, 1);
    assert.equal(piano.opened, 1);
  });

  it('shows a count when there are many inputs', async () => {
    const ports = ['A', 'B', 'C'].map((name) => new FakePort('input', name));
    const { input } = setup({ access: new FakeAccess(ports) });
    await input.connectWebMidi();
    assert.equal(input.status.deviceName, '3 MIDI devices');
  });

  it('produces note, pedal and raw events from MIDI messages', async () => {
    const port = new FakePort('input', 'Digital Piano');
    const { clock, input, events } = setup({ access: new FakeAccess([port]) });
    await input.connectWebMidi();
    clock.t = 2000;
    port.emit([0x90, 60, 100], 1990);
    port.emit([0xb0, 64, 127], 1995);
    port.emit([0x90, 60, 0], 2000);
    port.emit([0xfe], 2000);
    port.emit([0xf8], 2000);
    assert.deepEqual(events.notes(), [
      { type: 'on', midi: 60, velocity: 100, time: 1990, channel: 0, source: 'webmidi' },
      { type: 'off', midi: 60, velocity: 0, time: 2000, channel: 0, source: 'webmidi' },
    ]);
    assert.deepEqual(events.pedals(), [{ down: true, value: 127, time: 1995, source: 'webmidi' }]);
    assert.deepEqual(
      events.raws().map((raw) => [...raw.bytes]),
      [
        [0x90, 60, 100],
        [0xb0, 64, 127],
        [0x90, 60, 0],
      ],
    );
    assert.ok(events.raws()[0].bytes instanceof Uint8Array);
    assert.equal(events.raws()[0].source, 'webmidi');
    assert.equal(input.sustain, true);
  });

  it('uses event.timeStamp only when it is a sane performance.now() value', async () => {
    const port = new FakePort('input', 'Digital Piano');
    const { clock, input, events } = setup({ access: new FakeAccess([port]) });
    await input.connectWebMidi();
    clock.t = 10000;
    const stamps = [9990, 0, undefined, NaN, 1.7e12, 10100, 10003, 4000, -5, '9990'];
    for (const [i, stamp] of stamps.entries()) port.emit([0x90, 40 + i, 100], stamp);
    assert.deepEqual(
      events.notes().map((note) => note.time),
      [9990, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 10000],
    );
  });

  it('no device plugged in is not an error, and a device that appears is picked up', async () => {
    const access = new FakeAccess();
    const { clock, input, events } = setup({ access });
    await input.connectWebMidi();
    assert.equal(input.status.state, 'connected');
    assert.equal(input.status.deviceName, null);
    assert.match(input.status.message, /No MIDI device is plugged in/);

    const port = new FakePort('input', 'Digital Piano');
    access.plug(port);
    assert.deepEqual(input.status, { state: 'connected', transport: 'webmidi', deviceName: 'Digital Piano', message: null });
    clock.t = 3000;
    port.emit([0x90, 60, 100], 3000);
    port.emit([0xb0, 64, 100], 3000);
    assert.deepEqual([...input.held.keys()], [60]);

    events.clear();
    clock.t = 4000;
    access.unplug(port);
    assert.deepEqual(events.notes(), [{ type: 'off', midi: 60, velocity: 0, time: 4000, channel: 0, source: 'webmidi' }]);
    assert.deepEqual(events.pedals(), [{ down: false, value: 0, time: 4000, source: 'webmidi' }]);
    assert.equal(input.status.state, 'connected');
    assert.match(input.status.message, /No MIDI device is plugged in/);
    assert.equal(port.listeners.size, 0);

    events.clear();
    port.emit([0x90, 62, 100], 4000);
    assert.deepEqual(events.all, []);

    access.plug(port);
    port.emit([0x90, 62, 100], 4000);
    assert.equal(input.status.deviceName, 'Digital Piano');
    assert.deepEqual([...input.held.keys()], [62]);
    assert.equal(port.listeners.size, 1, 'attached exactly once after coming back');
  });

  it('a port that stays in the map but is marked disconnected is dropped too', async () => {
    const port = new FakePort('input', 'Digital Piano');
    const other = new FakePort('input', 'Second Keyboard');
    const access = new FakeAccess([port, other]);
    const { input } = setup({ access });
    await input.connectWebMidi();
    port.emit([0x90, 60, 100], 0);
    other.emit([0x90, 72, 100], 0);
    access.unplug(port, { keepInMap: true });
    assert.deepEqual([...input.held.keys()], [72], 'only the keys of the unplugged device are released');
    assert.equal(input.status.deviceName, 'Second Keyboard');
  });

  it('repeated statechange events do not attach twice or repeat the status', async () => {
    const port = new FakePort('input', 'Digital Piano');
    const access = new FakeAccess([port]);
    const { input, events } = setup({ access });
    await input.connectWebMidi();
    events.clear();
    access.fire(port);
    access.fire(port);
    assert.equal(port.listeners.size, 1);
    assert.deepEqual(events.all, []);
    port.emit([0x90, 60, 100], 0);
    assert.equal(events.notes().length, 1);
  });

  it('the same key from two ports at once is one key press', async () => {
    const one = new FakePort('input', 'Piano Port 1');
    const two = new FakePort('input', 'Piano Port 2');
    const { clock, input, events } = setup({ access: new FakeAccess([one, two]) });
    await input.connectWebMidi();
    clock.t = 5000;
    one.emit([0x90, 60, 100], 5000);
    two.emit([0x90, 60, 100], 5000);
    clock.t = 5200;
    two.emit([0x80, 60, 0], 5200);
    one.emit([0x80, 60, 0], 5200);
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi, note.time]),
      [
        ['on', 60, 5000],
        ['off', 60, 5200],
      ],
    );
    assert.equal(events.raws().length, 4);
  });

  it('ignores cut-off and malformed messages', async () => {
    const port = new FakePort('input', 'Digital Piano');
    const { input, events } = setup({ access: new FakeAccess([port]) });
    await input.connectWebMidi();
    events.clear();
    assert.doesNotThrow(() => {
      port.emit([], 0);
      port.emit([0x90], 0);
      port.emit([0x90, 60], 0);
      port.emit([60, 100], 0);
      port.emit([0x90, 200, 100], 0);
      for (const listener of [...port.listeners]) {
        listener(null);
        listener({});
        listener({ data: 'x' });
        listener({ data: { length: 3 } });
      }
    });
    assert.deepEqual(events.all, []);
  });

  it('sends to every output, skips broken ones, and reports whether anything was sent', async () => {
    const input1 = new FakePort('input', 'Digital Piano');
    const out1 = new FakePort('output', 'Digital Piano');
    const out2 = new FakePort('output', 'Sound Module');
    const access = new FakeAccess([input1], [out1, out2]);
    const { input } = setup({ access });
    assert.equal(input.canSend, false);
    await input.connectWebMidi();
    assert.equal(input.canSend, true);
    assert.equal(input.send([0x90, 60, 72]), true);
    assert.deepEqual(out1.sent, [[0x90, 60, 72]]);
    assert.deepEqual(out2.sent, [[0x90, 60, 72]]);

    out1.sendFails = true;
    assert.doesNotThrow(() => assert.equal(input.send([0x80, 60, 0]), true));
    assert.deepEqual(out2.sent.at(-1), [0x80, 60, 0]);
    out2.sendFails = true;
    assert.equal(input.send([0x80, 60, 0]), false);
    assert.equal(input.send([0x90, 60]), false);

    access.unplug(out1);
    access.unplug(out2);
    assert.equal(input.canSend, false);
    assert.equal(input.send([0x90, 60, 72]), false);
  });

  it('leaves loopback and software synth ports alone', async () => {
    const through = new FakePort('input', 'Midi Through Port-0');
    const throughOut = new FakePort('output', 'Midi Through Port-0');
    const synth = new FakePort('output', 'Microsoft GS Wavetable Synth');
    const { input, events } = setup({ access: new FakeAccess([through], [throughOut, synth]) });
    await input.connectWebMidi();
    assert.equal(through.listeners.size, 0);
    assert.equal(input.status.deviceName, null);
    assert.match(input.status.message, /No MIDI device is plugged in/);
    assert.equal(input.canSend, false);
    assert.equal(input.send([0x90, 60, 72]), false);
    assert.deepEqual(throughOut.sent, []);
    assert.deepEqual(synth.sent, []);
    through.emit([0x90, 60, 100], 0);
    assert.deepEqual(events.notes(), []);
  });

  it('reports refused permission and a browser without Web MIDI', async () => {
    const denied = setup();
    const refusing = new MidiInput({
      bluetooth: null,
      requestMIDIAccess: async () => {
        throw domError('NotAllowedError', 'Permission denied.');
      },
    });
    await assert.rejects(refusing.connectWebMidi(), (err) => err instanceof MidiInputError && err.code === 'permission');
    assert.equal(refusing.status.state, 'error');
    assert.equal(refusing.status.transport, 'webmidi');
    assert.match(refusing.status.message, /blocked access to MIDI devices/);

    await assert.rejects(denied.input.connectWebMidi(), (err) => err instanceof MidiInputError && err.code === 'unsupported');
    assert.equal(denied.input.status.state, 'error');
    assert.match(denied.input.status.message, /cannot use MIDI devices/);

    const broken = new MidiInput({
      bluetooth: null,
      requestMIDIAccess: async () => {
        throw domError('InvalidStateError', 'The MIDI system is busy.');
      },
    });
    await assert.rejects(broken.connectWebMidi(), (err) => err.code === 'failed');
    assert.match(broken.status.message, /Could not open the MIDI devices\. \(The MIDI system is busy\.\)/);
  });

  it('disconnect releases keys, closes the ports and stops listening', async () => {
    const port = new FakePort('input', 'Digital Piano');
    const access = new FakeAccess([port]);
    const { input, events } = setup({ access });
    await input.connectWebMidi();
    port.emit([0x90, 60, 100], 0);
    events.clear();
    await input.disconnect();
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi]),
      [['off', 60]],
    );
    assert.deepEqual(input.status, DISCONNECTED);
    assert.equal(port.listeners.size, 0);
    assert.equal(port.closed, 1);
    assert.equal(access.listeners.size, 0);
    events.clear();
    port.emit([0x90, 62, 100], 0);
    access.plug(new FakePort('input', 'Late Device'));
    assert.deepEqual(events.all, []);
    assert.deepEqual(input.status, DISCONNECTED);
  });

  it('disconnect while the permission prompt is open: access granted later is not used', async () => {
    const port = new FakePort('input', 'Digital Piano');
    const access = new FakeAccess([port]);
    let grant;
    const input = new MidiInput({
      bluetooth: null,
      requestMIDIAccess: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    });
    const connecting = input.connectWebMidi();
    assert.equal(input.status.state, 'connecting');
    await input.disconnect();
    grant(access);
    assert.deepEqual(await connecting, DISCONNECTED);
    assert.equal(port.listeners.size, 0);
  });

  it('connecting again asks the browser again and replaces the first session cleanly', async () => {
    const port = new FakePort('input', 'Digital Piano');
    const access = new FakeAccess([port]);
    const { input, events, midiRequests } = setup({ access });
    await input.connectWebMidi();
    await input.connectWebMidi();
    assert.equal(midiRequests.length, 2);
    assert.equal(port.listeners.size, 1);
    assert.equal(access.listeners.size, 1);
    port.emit([0x90, 60, 100], 0);
    assert.equal(events.notes().length, 1);
  });
});

// ------------------------------------------------------------------ virtual input

describe('virtual input', () => {
  it('emits the same note events with source virtual and the current time', () => {
    const { clock, input, events } = setup();
    clock.t = 7000;
    input.noteOn(60);
    clock.t = 7100;
    input.noteOn(64, 110);
    clock.t = 7300;
    input.noteOff(60);
    assert.deepEqual(events.notes(), [
      { type: 'on', midi: 60, velocity: 80, time: 7000, channel: 0, source: 'virtual' },
      { type: 'on', midi: 64, velocity: 110, time: 7100, channel: 0, source: 'virtual' },
      { type: 'off', midi: 60, velocity: 0, time: 7300, channel: 0, source: 'virtual' },
    ]);
    assert.deepEqual(input.held.get(64), { velocity: 110, time: 7100, source: 'virtual', channel: 0 });
    assert.deepEqual(events.raws(), [], 'virtual keys are not MIDI messages');
    assert.deepEqual(input.status, DISCONNECTED);
  });

  it('ignores keys that are not MIDI numbers and clamps the velocity', () => {
    const { input, events } = setup();
    for (const bad of [-1, 128, 60.5, NaN, Infinity, null, undefined, 'C4', {}, '']) {
      assert.doesNotThrow(() => {
        input.noteOn(bad);
        input.noteOff(bad);
      });
    }
    assert.deepEqual(events.all, []);
    input.noteOn(60, 500);
    input.noteOn(61, 0.4);
    input.noteOn(62, 'loud');
    input.noteOn('63', 90);
    input.noteOn(64, null);
    input.noteOn(65, '100');
    assert.deepEqual(
      events.notes().map((note) => [note.midi, note.velocity]),
      [
        [60, 127],
        [62, 80],
        [63, 90],
        [64, 80],
        [65, 100],
      ],
    );
  });

  it('velocity 0 is a release, a second noteOff does nothing, a second noteOn retriggers', () => {
    const { input, events } = setup();
    input.noteOn(60);
    input.noteOn(60, 0);
    input.noteOff(60);
    input.noteOn(62);
    input.noteOn(62, 100);
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi]),
      [
        ['on', 60],
        ['off', 60],
        ['on', 62],
        ['off', 62],
        ['on', 62],
      ],
    );
  });

  it('works next to a connected piano and survives its disconnect', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    input.noteOn(48);
    piano.packet(pkt(clock.t, [0x90, 60, 100]));
    assert.deepEqual([...input.held.keys()].sort(), [48, 60]);
    assert.deepEqual([input.held.get(48).source, input.held.get(60).source], ['virtual', 'ble']);
    await input.disconnect();
    assert.deepEqual([...input.held.keys()], [48]);
    events.clear();
    input.noteOff(48);
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.midi, note.source]),
      [['off', 48, 'virtual']],
    );
  });

  it('the same key on screen and on the piano: the later press takes it over, nothing sticks', async () => {
    const { clock, piano, input, events } = setup();
    await input.connectBluetooth();
    clock.t = 1000;
    piano.packet(pkt(1000, [0x90, 60, 100]));
    clock.t = 1500;
    input.noteOn(60);
    clock.t = 1600;
    piano.packet(pkt(1600, [0x80, 60, 0])); // the piano key comes up: the on-screen key is still down
    assert.deepEqual([...input.held.keys()], [60]);
    clock.t = 1700;
    input.noteOff(60);
    assert.deepEqual(
      events.notes().map((note) => [note.type, note.source, note.time]),
      [
        ['on', 'ble', 1000],
        ['off', 'ble', 1500],
        ['on', 'virtual', 1500],
        ['off', 'virtual', 1700],
      ],
    );
    assert.equal(input.held.size, 0);
  });
});
