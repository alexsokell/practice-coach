import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLE_MIDI_SERVICE_UUID,
  BLE_MIDI_CHARACTERISTIC_UUID,
  BleMidiParser,
  BleMidiClock,
  encodeBleMidiPacket,
} from '../shared/ble-midi.js';
import { decodeMidiMessage, midiDataLength } from '../shared/midi.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Header byte for a 13-bit timestamp. */
const H = (ts) => 0x80 | ((ts >> 7) & 0x3f);
/** Timestamp byte for a 13-bit timestamp. */
const T = (ts) => 0x80 | (ts & 0x7f);
const pkt = (...bytes) => Uint8Array.from(bytes);

/** Parse result as plain data: [[timestamp, [bytes]], ...]. */
const plain = (messages) => messages.map((m) => [m.timestamp, Array.from(m.data)]);
const parseOne = (...bytes) => plain(new BleMidiParser().parse(pkt(...bytes)));

/** Small deterministic random generator (LCG), returns numbers in [0, 1). */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('UUIDs', () => {
  test('match the BLE MIDI specification, lowercase for Web Bluetooth', () => {
    assert.equal(BLE_MIDI_SERVICE_UUID, '03b80e5a-ede8-4b33-a751-6ce34ec4c700');
    assert.equal(BLE_MIDI_CHARACTERISTIC_UUID, '7772e5db-3868-4112-a1a9-f2669d106bf3');
    assert.equal(BLE_MIDI_SERVICE_UUID, BLE_MIDI_SERVICE_UUID.toLowerCase());
    assert.equal(BLE_MIDI_CHARACTERISTIC_UUID, BLE_MIDI_CHARACTERISTIC_UUID.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// Parser: basic messages
// ---------------------------------------------------------------------------

describe('BleMidiParser: full messages', () => {
  test('single note on with a 13-bit timestamp from header and timestamp byte', () => {
    const ts = 4660; // high 36, low 52
    assert.equal(H(ts), 0xa4);
    assert.equal(T(ts), 0xb4);
    const out = new BleMidiParser().parse(pkt(0xa4, 0xb4, 0x90, 60, 100));
    assert.equal(out.length, 1);
    assert.equal(out[0].timestamp, 4660);
    assert.ok(out[0].data instanceof Uint8Array);
    assert.deepEqual(Array.from(out[0].data), [0x90, 60, 100]);
    assert.equal(decodeMidiMessage(out[0].data).type, 'noteon');
  });

  test('timestamp extremes: 0 and 8191', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60, 1), [[0, [0x90, 60, 1]]]);
    assert.deepEqual(parseOne(0xbf, 0xff, 0x90, 60, 1), [[8191, [0x90, 60, 1]]]);
  });

  test('two messages with two timestamps', () => {
    assert.deepEqual(parseOne(H(300), T(300), 0x90, 60, 100, T(305), 0x80, 60, 0), [
      [300, [0x90, 60, 100]],
      [305, [0x80, 60, 0]],
    ]);
  });

  test('every channel message type, with the right data length', () => {
    const out = parseOne(
      0x80,
      0x81, 0x85, 61, 2, // note off ch 6
      0x82, 0x93, 62, 3, // note on ch 4
      0x83, 0xa1, 63, 4, // poly aftertouch
      0x84, 0xb0, 64, 127, // control change (sustain)
      0x85, 0xc2, 5, // program change: one data byte
      0x86, 0xd3, 6, // channel pressure: one data byte
      0x87, 0xe4, 7, 8, // pitch bend
    );
    assert.deepEqual(out, [
      [1, [0x85, 61, 2]],
      [2, [0x93, 62, 3]],
      [3, [0xa1, 63, 4]],
      [4, [0xb0, 64, 127]],
      [5, [0xc2, 5]],
      [6, [0xd3, 6]],
      [7, [0xe4, 7, 8]],
    ]);
    for (const [, bytes] of out) assert.equal(bytes.length, 1 + midiDataLength(bytes[0]));
  });

  test('note on with velocity 0 passes through as bytes', () => {
    const out = new BleMidiParser().parse(pkt(0x80, 0x80, 0x90, 60, 0));
    assert.deepEqual(Array.from(out[0].data), [0x90, 60, 0]);
    // Decoding it as a note off is the caller's job.
    assert.equal(decodeMidiMessage(out[0].data).type, 'noteoff');
  });

  test('a data byte equal to 0x7f and note 0 are kept intact', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 0, 0x7f), [[0, [0x90, 0, 0x7f]]]);
  });

  test('output buffers are copies, not views of the packet', () => {
    const packet = pkt(0x80, 0x80, 0x90, 60, 100);
    const out = new BleMidiParser().parse(packet);
    packet.fill(0);
    assert.deepEqual(Array.from(out[0].data), [0x90, 60, 100]);
    assert.notEqual(out[0].data.buffer, packet.buffer);
  });

  test('system common messages', () => {
    assert.deepEqual(
      parseOne(0x80, 0x81, 0xf1, 0x23, 0x82, 0xf2, 0x10, 0x20, 0x83, 0xf3, 5, 0x84, 0xf6),
      [
        [1, [0xf1, 0x23]],
        [2, [0xf2, 0x10, 0x20]],
        [3, [0xf3, 5]],
        [4, [0xf6]],
      ],
    );
  });

  test('undefined status bytes F4 and F5 are skipped together with their data', () => {
    assert.deepEqual(
      parseOne(0x80, 0x81, 0x90, 60, 100, 0x82, 0xf4, 1, 2, 3, 0x83, 0xf5, 0x84, 0x80, 60, 0),
      [
        [1, [0x90, 60, 100]],
        [4, [0x80, 60, 0]],
      ],
    );
  });

  test('realtime messages alone in a packet', () => {
    assert.deepEqual(parseOne(0x80, 0x85, 0xfe), [[5, [0xfe]]]);
    assert.deepEqual(parseOne(0x80, 0x85, 0xf8, 0x86, 0xfa, 0x87, 0xfc), [
      [5, [0xf8]],
      [6, [0xfa]],
      [7, [0xfc]],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Parser: running status
// ---------------------------------------------------------------------------

describe('BleMidiParser: running status', () => {
  test('without timestamp bytes: shares the preceding timestamp', () => {
    assert.deepEqual(parseOne(H(200), T(200), 0x90, 60, 100, 64, 90, 67, 80), [
      [200, [0x90, 60, 100]],
      [200, [0x90, 64, 90]],
      [200, [0x90, 67, 80]],
    ]);
  });

  test('with timestamp bytes', () => {
    assert.deepEqual(parseOne(H(200), T(200), 0x90, 60, 100, T(203), 64, 90, T(207), 67, 80), [
      [200, [0x90, 60, 100]],
      [203, [0x90, 64, 90]],
      [207, [0x90, 67, 80]],
    ]);
  });

  test('mixed, as in the specification diagram', () => {
    // full, full, running, running with new timestamp, full
    const out = parseOne(
      H(1000),
      T(1000), 0x90, 60, 100,
      T(1001), 0x80, 62, 0,
      64, 0,
      T(1003), 65, 0,
      T(1004), 0xb0, 64, 127,
    );
    assert.deepEqual(out, [
      [1000, [0x90, 60, 100]],
      [1001, [0x80, 62, 0]],
      [1001, [0x80, 64, 0]],
      [1003, [0x80, 65, 0]],
      [1004, [0xb0, 64, 127]],
    ]);
  });

  test('one-data-byte messages (program change, channel pressure)', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0xd0, 10, 20, 30, 0x85, 40), [
      [0, [0xd0, 10]],
      [0, [0xd0, 20]],
      [0, [0xd0, 30]],
      [5, [0xd0, 40]],
    ]);
  });

  test('a new status replaces the running status', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60, 100, 0x81, 0xb0, 64, 127, 64, 0), [
      [0, [0x90, 60, 100]],
      [1, [0xb0, 64, 127]],
      [1, [0xb0, 64, 0]],
    ]);
  });

  test('note on velocity 0 through running status', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60, 100, 0x8a, 60, 0), [
      [0, [0x90, 60, 100]],
      [10, [0x90, 60, 0]],
    ]);
  });

  test('does not carry over to the next packet', () => {
    const parser = new BleMidiParser();
    assert.equal(parser.parse(pkt(0x80, 0x80, 0x90, 60, 100)).length, 1);
    // Timestamp then data: there is no running status in this packet.
    assert.deepEqual(parser.parse(pkt(0x80, 0x85, 64, 90)), []);
    // Data straight after the header: a SysEx continuation without a SysEx.
    assert.deepEqual(parser.parse(pkt(0x80, 64, 90)), []);
    assert.equal(parser.stats.skippedBytes, 4);
    // And the parser still works afterwards.
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x86, 0x80, 60, 0))), [[6, [0x80, 60, 0]]]);
  });

  test('opt-in carryRunningStatus: "header, timestamp, data" continues the previous packet', () => {
    const parser = new BleMidiParser({ carryRunningStatus: true });
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x80, 0x90, 60, 100))), [[0, [0x90, 60, 100]]]);
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x85, 64, 90, 67, 80, 0x88, 60, 0))), [
      [5, [0x90, 64, 90]],
      [5, [0x90, 67, 80]],
      [8, [0x90, 60, 0]],
    ]);
    // Realtime does not touch the carried status, as in a serial MIDI stream.
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x89, 0xfe))), [[9, [0xfe]]]);
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x8a, 64, 0))), [[10, [0x90, 64, 0]]]);
    // A new status replaces it.
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x8b, 0xb0, 64, 127))), [[11, [0xb0, 64, 127]]]);
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x8c, 64, 0))), [[12, [0xb0, 64, 0]]]);
  });

  test('opt-in carryRunningStatus: what still does not carry', () => {
    const parser = new BleMidiParser({ carryRunningStatus: true });
    // Nothing to carry yet.
    assert.deepEqual(parser.parse(pkt(0x80, 0x80, 60, 100)), []);
    parser.parse(pkt(0x80, 0x80, 0x90, 60, 100));
    // Data straight after the header is a SysEx continuation, never running status.
    assert.deepEqual(parser.parse(pkt(0x80, 64, 90)), []);
    // Data after a realtime message at the start of a packet is not the quirk either.
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x81, 0xf8, 64, 90))), [[1, [0xf8]]]);
    // System common and SysEx cancel the carried status, as in MIDI 1.0.
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x82, 0xf1, 5))), [[2, [0xf1, 5]]]);
    assert.deepEqual(parser.parse(pkt(0x80, 0x83, 64, 90)), []);
    parser.parse(pkt(0x80, 0x80, 0x90, 60, 100));
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x84, 0xf0, 1, 0x85, 0xf7))), [[5, [0xf0, 1, 0xf7]]]);
    assert.deepEqual(parser.parse(pkt(0x80, 0x86, 64, 90)), []);
    // A pending SysEx takes the data, and reset() clears the carried status.
    parser.parse(pkt(0x80, 0x80, 0x90, 60, 100, 0x81, 0xf0, 1));
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x90, 2, 3, 0x91, 0xf7))), [[17, [0xf0, 1, 2, 3, 0xf7]]]);
    parser.parse(pkt(0x80, 0x80, 0x90, 60, 100));
    parser.reset();
    assert.deepEqual(parser.parse(pkt(0x80, 0x87, 64, 90)), []);
    // Only the exact value true turns the option on.
    const strict = new BleMidiParser({ carryRunningStatus: 1 });
    strict.parse(pkt(0x80, 0x80, 0x90, 60, 100));
    assert.deepEqual(strict.parse(pkt(0x80, 0x85, 64, 90)), []);
  });

  test('stray data bytes before the first status are skipped, the rest is parsed', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 1, 2, 3, 0x81, 0x90, 60, 100), [[1, [0x90, 60, 100]]]);
  });
});

// ---------------------------------------------------------------------------
// Parser: realtime and system common in between
// ---------------------------------------------------------------------------

describe('BleMidiParser: realtime interleaved', () => {
  test('realtime between running status messages does not cancel running status', () => {
    // Exactly the layout of the specification: status, data, data, timestamp, realtime,
    // timestamp, data, data.
    assert.deepEqual(
      parseOne(H(500), T(500), 0x90, 60, 100, 62, 100, T(501), 0xf8, T(502), 64, 100),
      [
        [500, [0x90, 60, 100]],
        [500, [0x90, 62, 100]],
        [501, [0xf8]],
        [502, [0x90, 64, 100]],
      ],
    );
  });

  test('system common between running status messages does not cancel it either', () => {
    assert.deepEqual(
      parseOne(0x80, 0x80, 0x90, 60, 100, 0x81, 0xf1, 0x05, 0x82, 62, 100, 0x83, 0xf6, 0x84, 64, 100),
      [
        [0, [0x90, 60, 100]],
        [1, [0xf1, 0x05]],
        [2, [0x90, 62, 100]],
        [3, [0xf6]],
        [4, [0x90, 64, 100]],
      ],
    );
  });

  test('lenient: running status data right after a realtime byte, timestamp omitted', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60, 100, 0x81, 0xfe, 62, 100), [
      [0, [0x90, 60, 100]],
      [1, [0xfe]],
      [1, [0x90, 62, 100]],
    ]);
  });

  test('several realtime messages in a row, then a full message', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0xf8, 0x80, 0xf8, 0x81, 0xfe, 0x82, 0x90, 60, 1), [
      [0, [0xf8]],
      [0, [0xf8]],
      [1, [0xfe]],
      [2, [0x90, 60, 1]],
    ]);
  });

  test('realtime first in a packet does not create a running status', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0xf8, 60, 100), [[0, [0xf8]]]);
  });
});

// ---------------------------------------------------------------------------
// Parser: timestamps
// ---------------------------------------------------------------------------

describe('BleMidiParser: timestamp overflow inside a packet', () => {
  test('timestampLow going backwards advances timestampHigh by one', () => {
    // high = 2, low 120 then low 5: the second message is at (3 << 7) | 5.
    const out = parseOne(0x82, 0x80 | 120, 0x90, 60, 100, 0x80 | 5, 0x80, 60, 0);
    assert.deepEqual(out, [
      [(2 << 7) | 120, [0x90, 60, 100]],
      [(3 << 7) | 5, [0x80, 60, 0]],
    ]);
    assert.equal(out[1][0] - out[0][0], 13);
  });

  test('the incremented high part is kept for the rest of the packet', () => {
    const out = parseOne(0x82, 0xfe, 0x90, 60, 1, 0x81, 62, 1, 0x83, 64, 1, 0x84, 0xb0, 1, 2);
    assert.deepEqual(
      out.map((m) => m[0]),
      [(2 << 7) | 126, (3 << 7) | 1, (3 << 7) | 3, (3 << 7) | 4],
    );
  });

  test('equal timestampLow is not an overflow', () => {
    const out = parseOne(0x82, 0x90, 0x90, 60, 1, 0x90, 0x80, 60, 0);
    assert.deepEqual(out.map((m) => m[0]), [(2 << 7) | 16, (2 << 7) | 16]);
  });

  test('overflow of the whole 13-bit value wraps to zero', () => {
    const out = parseOne(0xbf, 0xff, 0x90, 60, 1, 0x82, 0x80, 60, 0);
    assert.deepEqual(out.map((m) => m[0]), [8191, 2]);
  });

  test('a running status timestamp can overflow too', () => {
    const out = parseOne(0x80, 0xff, 0x90, 60, 1, 0x80, 62, 1);
    assert.deepEqual(out, [
      [127, [0x90, 60, 1]],
      [128, [0x90, 62, 1]],
    ]);
  });

  test('a realtime timestamp takes part in overflow tracking', () => {
    const out = parseOne(0x80, 0xfa, 0x90, 60, 1, 0x81, 0xf8, 0x83, 62, 1);
    assert.deepEqual(out.map((m) => m[0]), [122, 129, 131]);
  });
});

// ---------------------------------------------------------------------------
// Parser: SysEx
// ---------------------------------------------------------------------------

describe('BleMidiParser: SysEx', () => {
  test('start and end in one packet', () => {
    const out = parseOne(H(700), T(700), 0xf0, 0x7e, 0x7f, 0x06, 0x01, T(702), 0xf7);
    assert.deepEqual(out, [[702, [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]]]);
  });

  test('empty SysEx', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0xf0, 0x80, 0xf7), [[0, [0xf0, 0xf7]]]);
  });

  test('across 2 packets', () => {
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(pkt(H(100), T(100), 0xf0, 1, 2, 3, 4, 5)), []);
    const out = plain(parser.parse(pkt(H(115), 6, 7, 8, 9, 10, T(117), 0xf7)));
    assert.deepEqual(out, [[117, [0xf0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0xf7]]]);
  });

  test('across 3 packets, with a header-only packet in between', () => {
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2, 3)), []);
    assert.deepEqual(parser.parse(pkt(0x80, 4, 5, 6)), []);
    assert.deepEqual(parser.parse(pkt(0x80)), []);
    const out = plain(parser.parse(pkt(0x81, 7, 8, 0x90, 0xf7)));
    assert.deepEqual(out, [[(1 << 7) | 16, [0xf0, 1, 2, 3, 4, 5, 6, 7, 8, 0xf7]]]);
  });

  test('end packet that holds only the timestamp and F7', () => {
    const parser = new BleMidiParser();
    parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2));
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x85, 0xf7))), [[5, [0xf0, 1, 2, 0xf7]]]);
  });

  test('realtime inside a SysEx, in one packet', () => {
    const out = parseOne(0x80, 0x80, 0xf0, 1, 2, 0x81, 0xf8, 3, 4, 0x82, 0xf7);
    assert.deepEqual(out, [
      [1, [0xf8]],
      [2, [0xf0, 1, 2, 3, 4, 0xf7]],
    ]);
  });

  test('realtime at the start of a continuation packet and before the end', () => {
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2)), []);
    // Continuation data may follow the header byte or a realtime byte.
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x83, 0xfe, 3, 4))), [[3, [0xfe]]]);
    assert.deepEqual(plain(parser.parse(pkt(0x80, 5, 0x86, 0xf8, 0x87, 0xf7))), [
      [6, [0xf8]],
      [7, [0xf0, 1, 2, 3, 4, 5, 0xf7]],
    ]);
  });

  test('aborted by a new status byte: nothing is delivered for it', () => {
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2, 3)), []);
    const out = plain(parser.parse(pkt(0x80, 0x85, 0x90, 60, 100)));
    assert.deepEqual(out, [[5, [0x90, 60, 100]]]);
    // A later end of SysEx has nothing to end.
    assert.deepEqual(parser.parse(pkt(0x80, 4, 5, 0x86, 0xf7)), []);
    assert.equal(parser.stats.sysexDropped, 1);
  });

  test('aborted inside one packet, the following message is kept', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0xf0, 1, 2, 0x81, 0x90, 60, 100, 0x82, 0xf7), [
      [1, [0x90, 60, 100]],
    ]);
  });

  test('a new SysEx start replaces an unfinished one', () => {
    const parser = new BleMidiParser();
    parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2, 3));
    const out = plain(parser.parse(pkt(0x80, 0x81, 0xf0, 9, 8, 0x82, 0xf7)));
    assert.deepEqual(out, [[2, [0xf0, 9, 8, 0xf7]]]);
  });

  test('two SysEx messages in two packets, the second one split', () => {
    const parser = new BleMidiParser();
    const first = plain(parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2, 0x81, 0xf7, 0x82, 0xf0)));
    assert.deepEqual(first, [[1, [0xf0, 1, 2, 0xf7]]]);
    const second = plain(parser.parse(pkt(0x80, 3, 4, 0x85, 0xf7)));
    assert.deepEqual(second, [[5, [0xf0, 3, 4, 0xf7]]]);
  });

  test('messages before and after a SysEx in the same packet', () => {
    const out = parseOne(0x80, 0x80, 0x90, 60, 1, 0x81, 0xf0, 5, 0x82, 0xf7, 0x83, 0x80, 60, 0);
    assert.deepEqual(out, [
      [0, [0x90, 60, 1]],
      [2, [0xf0, 5, 0xf7]],
      [3, [0x80, 60, 0]],
    ]);
  });

  test('a SysEx cancels running status', () => {
    const out = parseOne(0x80, 0x80, 0x90, 60, 1, 0x81, 0xf0, 5, 0x82, 0xf7, 0x83, 62, 1);
    assert.deepEqual(out, [
      [0, [0x90, 60, 1]],
      [2, [0xf0, 5, 0xf7]],
    ]);
  });

  test('continuation and end without a start are ignored', () => {
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(pkt(0x80, 1, 2, 3, 4)), []);
    assert.deepEqual(parser.parse(pkt(0x80, 5, 6, 0x81, 0xf7)), []);
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x82, 0x90, 60, 1))), [[2, [0x90, 60, 1]]]);
  });

  test('reset() forgets an unfinished SysEx', () => {
    const parser = new BleMidiParser();
    parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2, 3));
    parser.reset();
    assert.deepEqual(parser.parse(pkt(0x80, 4, 5, 0x81, 0xf7)), []);
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x80, 0xf0, 7, 0x81, 0xf7))), [[1, [0xf0, 7, 0xf7]]]);
  });

  test('lenient: F7 without its timestamp byte as the last byte of a packet', () => {
    assert.deepEqual(parseOne(0x81, 0x85, 0xf0, 1, 2, 0xf7), [[(1 << 7) | 5, [0xf0, 1, 2, 0xf7]]]);
    const parser = new BleMidiParser();
    parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2));
    assert.deepEqual(plain(parser.parse(pkt(0x83, 0xf7))), [[3 << 7, [0xf0, 1, 2, 0xf7]]]);
  });

  test('lenient: F7 without its timestamp byte followed by a timestamped message', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0xf0, 1, 2, 0xf7, 0x85, 0x90, 60, 100), [
      [0, [0xf0, 1, 2, 0xf7]],
      [5, [0x90, 60, 100]],
    ]);
  });

  test('F7 used as a timestamp byte in front of a status byte is still a timestamp', () => {
    // Timestamp low 0x77 followed by a complete note on: the SysEx is aborted.
    assert.deepEqual(parseOne(0x80, 0x80, 0xf0, 1, 2, 0xf7, 0x90, 60, 100), [
      [0x77, [0x90, 60, 100]],
    ]);
    // Timestamp low 0x77 followed by the real end of SysEx.
    assert.deepEqual(parseOne(0x80, 0x80, 0xf0, 1, 2, 0xf7, 0xf7), [[0x77, [0xf0, 1, 2, 0xf7]]]);
  });

  test('lenient: a stray timestamp byte in a continuation packet is ignored', () => {
    const parser = new BleMidiParser();
    parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2));
    assert.deepEqual(parser.parse(pkt(0x80, 0x90, 3, 4)), []);
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x99, 0xf7))), [[0x19, [0xf0, 1, 2, 3, 4, 0xf7]]]);
  });

  test('the SysEx size cap: at the cap it is delivered, one byte over it is dropped', () => {
    const cap = 16;
    const body = (count) => Array.from({ length: count }, (_, k) => k % 128);

    const fits = new BleMidiParser({ maxSysexBytes: cap });
    const ok = fits.parse(pkt(0x80, 0x80, 0xf0, ...body(cap - 2), 0x81, 0xf7));
    assert.equal(ok.length, 1);
    assert.equal(ok[0].data.length, cap);

    const over = new BleMidiParser({ maxSysexBytes: cap });
    assert.deepEqual(over.parse(pkt(0x80, 0x80, 0xf0, ...body(cap - 1), 0x81, 0xf7)), []);
    assert.equal(over.stats.sysexDropped, 1);
  });

  test('an oversize SysEx across many packets is swallowed whole, then parsing goes on', () => {
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(pkt(0x80, 0x80, 0xf0)), []);
    const chunk = new Uint8Array(201);
    chunk[0] = 0x80;
    for (let k = 1; k < chunk.length; k += 1) chunk[k] = k % 128;
    for (let sent = 0; sent < 70000; sent += 200) assert.deepEqual(parser.parse(chunk), []);
    // Its data must not leak out as notes, and its end delivers nothing.
    assert.deepEqual(parser.parse(pkt(0x80, 1, 2, 3, 0x81, 0xf7)), []);
    assert.equal(parser.stats.sysexDropped, 1);
    assert.equal(parser.stats.messages, 0);
    assert.deepEqual(plain(parser.parse(pkt(0x80, 0x82, 0x90, 60, 1))), [[2, [0x90, 60, 1]]]);
  });

  test('a SysEx of exactly 65536 bytes is delivered with the default cap', () => {
    const parser = new BleMidiParser();
    parser.parse(pkt(0x80, 0x80, 0xf0));
    const chunk = new Uint8Array(1 + 242);
    chunk[0] = 0x80;
    chunk.fill(0x55, 1);
    let data = 0;
    while (data + 242 <= 65534) {
      parser.parse(chunk);
      data += 242;
    }
    const rest = new Uint8Array(1 + (65534 - data));
    rest[0] = 0x80;
    rest.fill(0x2a, 1);
    parser.parse(rest);
    const out = parser.parse(pkt(0x80, 0x81, 0xf7));
    assert.equal(out.length, 1);
    assert.equal(out[0].data.length, 65536);
    assert.equal(out[0].data[0], 0xf0);
    assert.equal(out[0].data[1], 0x55);
    assert.equal(out[0].data[65534], 0x2a);
    assert.equal(out[0].data[65535], 0xf7);
  });
});

// ---------------------------------------------------------------------------
// Parser: malformed input
// ---------------------------------------------------------------------------

describe('BleMidiParser: malformed and edge input', () => {
  test('empty packet and header-only packet', () => {
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(new Uint8Array(0)), []);
    assert.deepEqual(parser.parse(pkt(0x80)), []);
    assert.deepEqual(parser.parse(pkt(0xbf)), []);
  });

  test('header and a timestamp byte only', () => {
    assert.deepEqual(parseOne(0x80, 0x85), []);
  });

  test('truncated at the end of the packet: the partial message is dropped', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0x90), []);
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60), []);
    assert.deepEqual(parseOne(0x80, 0x80, 0xf2, 1), []);
    // The complete message before it is kept.
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60, 100, 0x81, 0x80, 60), [[0, [0x90, 60, 100]]]);
    // A partial running status message is dropped as well.
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60, 100, 62), [[0, [0x90, 60, 100]]]);
  });

  test('a message cut short by the next timestamp is dropped, the next one is kept', () => {
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60, 0x81, 0x80, 62, 0), [[1, [0x80, 62, 0]]]);
    // The cut message still set the running status, as a status byte always does.
    assert.deepEqual(parseOne(0x80, 0x80, 0x90, 60, 0x81, 62, 5), [[1, [0x90, 62, 5]]]);
  });

  test('a packet whose first byte is not a header is ignored', () => {
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(pkt(0x00, 0x80, 0x90, 60, 100)), []);
    assert.deepEqual(parser.parse(pkt(0x7f)), []);
    assert.deepEqual(parser.parse(pkt(0x3c, 0x40)), []);
    assert.equal(parser.stats.messages, 0);
  });

  test('the reserved header bit is ignored', () => {
    assert.deepEqual(parseOne(0xc1, 0x85, 0x90, 60, 100), [[(1 << 7) | 5, [0x90, 60, 100]]]);
  });

  test('a timestamp byte that looks like a status byte is not taken for one', () => {
    // 0x90 here is a timestamp byte (low 16). There is no running status, so the data is dropped
    // instead of being turned into a note on.
    assert.deepEqual(parseOne(0x80, 0x90, 60, 100), []);
    // Timestamp 0x90, then the real status 0x80.
    assert.deepEqual(parseOne(0x80, 0x90, 0x80, 60, 100), [[16, [0x80, 60, 100]]]);
  });

  test('non-packet arguments give an empty result and do not throw', () => {
    const parser = new BleMidiParser();
    for (const bad of [undefined, null, 0, 42, 'abc', {}, { length: 3 }, [], () => {}, NaN, true, Symbol('x')]) {
      assert.deepEqual(parser.parse(bad), []);
    }
    assert.deepEqual(parser.parse(), []);
    assert.deepEqual(parser.parse([0x80, 0x80, 0x90, 300, 1]), []);
    assert.deepEqual(parser.parse([0x80, 0x80, 0x90, 'x', 1]), []);
  });

  test('constructor ignores bad options', () => {
    for (const bad of [undefined, null, 5, 'x', { maxSysexBytes: -1 }, { maxSysexBytes: NaN }, { maxSysexBytes: 1 }]) {
      const parser = new BleMidiParser(bad);
      assert.deepEqual(plain(parser.parse(pkt(0x80, 0x80, 0xf0, 1, 2, 3, 0x81, 0xf7))), [
        [1, [0xf0, 1, 2, 3, 0xf7]],
      ]);
    }
  });

  test('garbage never throws and never produces a malformed message', () => {
    const rnd = lcg(12345);
    const parser = new BleMidiParser({ maxSysexBytes: 64 });
    const carrying = new BleMidiParser({ maxSysexBytes: 64, carryRunningStatus: true });
    let total = 0;
    for (let round = 0; round < 20000; round += 1) {
      const length = Math.floor(rnd() * 24);
      const bytes = new Uint8Array(length);
      for (let k = 0; k < length; k += 1) {
        // Mostly data-like and status-like bytes, with a bias to interesting values.
        const r = rnd();
        if (r < 0.1) bytes[k] = 0xf0;
        else if (r < 0.2) bytes[k] = 0xf7;
        else if (r < 0.3) bytes[k] = 0xf8 + Math.floor(rnd() * 8);
        else bytes[k] = Math.floor(rnd() * 256);
      }
      if (length > 0 && rnd() < 0.8) bytes[0] |= 0x80;
      const out = parser.parse(bytes);
      assert.ok(Array.isArray(out));
      total += out.length;
      const lenient = carrying.parse(bytes);
      assert.ok(lenient.length >= out.length, 'the opt-in quirk only ever adds messages');
      for (const m of out.concat(lenient)) {
        assert.ok(Number.isInteger(m.timestamp) && m.timestamp >= 0 && m.timestamp <= 8191);
        assert.ok(m.data instanceof Uint8Array);
        const status = m.data[0];
        assert.ok(status >= 0x80, 'status byte first');
        assert.ok(status !== 0xf7 && status !== 0xf4 && status !== 0xf5);
        if (status === 0xf0) {
          assert.equal(m.data[m.data.length - 1], 0xf7);
          assert.ok(m.data.length <= 64);
          for (let k = 1; k < m.data.length - 1; k += 1) assert.ok(m.data[k] < 0x80);
        } else {
          assert.equal(m.data.length, 1 + midiDataLength(status));
          for (let k = 1; k < m.data.length; k += 1) assert.ok(m.data[k] < 0x80);
        }
      }
    }
    assert.ok(total > 1000, 'the fuzz input does produce messages');
    assert.equal(parser.stats.messages, total);
  });
});

// ---------------------------------------------------------------------------
// Parser: generated streams
// ---------------------------------------------------------------------------

describe('BleMidiParser: generated compliant streams', () => {
  test('random streams built by the rules of the specification decode exactly', () => {
    const rnd = lcg(2024);
    const pick = (count) => Math.floor(rnd() * count);
    const dataBytes = (count) => Array.from({ length: count }, () => pick(128));
    let messages = 0;

    for (let round = 0; round < 400; round += 1) {
      const expected = [];
      const packets = [];
      let t = pick(8192); // device time in ms, unbounded
      let body = []; // bytes of the current packet after its header
      let firstStamp = null; // device time of the first timestamp byte of the packet
      let lastStamp = null; // device time of the most recent timestamp byte
      let running = 0; // status that may be omitted in this packet
      let afterSystem = false; // the previous message was a system message

      const flush = () => {
        packets.push([H(firstStamp ?? t), ...body]);
        body = [];
        firstStamp = null;
        lastStamp = null;
        running = 0;
        afterSystem = false;
      };
      const stamp = () => {
        t += pick(100); // below 128, so timestampLow goes backwards exactly when it overflows
        if (firstStamp === null) firstStamp = t;
        lastStamp = t;
        body.push(T(t));
      };

      const count = 5 + pick(40);
      for (let m = 0; m < count; m += 1) {
        if (body.length > 0 && rnd() < 0.2) flush();
        const kind = rnd();
        if (kind < 0.65) {
          // Channel message, as a full message or with running status.
          const status = running !== 0 && rnd() < 0.5 ? running : 0x80 + pick(0x70);
          const data = dataBytes(midiDataLength(status));
          if (status === running && rnd() < 0.7) {
            // After a system message the timestamp byte is mandatory, otherwise optional.
            if (afterSystem || rnd() < 0.5) stamp();
            body.push(...data);
          } else {
            stamp();
            body.push(status, ...data);
            running = status;
          }
          afterSystem = false;
          expected.push([lastStamp % 8192, [status, ...data]]);
        } else if (kind < 0.8) {
          const status = 0xf8 + pick(8);
          stamp();
          body.push(status);
          afterSystem = true;
          expected.push([t % 8192, [status]]);
        } else if (kind < 0.9) {
          const status = [0xf1, 0xf2, 0xf3, 0xf6][pick(4)];
          const data = dataBytes(midiDataLength(status));
          stamp();
          body.push(status, ...data);
          afterSystem = true;
          expected.push([t % 8192, [status, ...data]]);
        } else {
          // SysEx: maybe split over packets, maybe with realtime messages inside.
          const data = dataBytes(pick(40));
          stamp();
          body.push(0xf0);
          for (const byte of data) {
            const r = rnd();
            if (r < 0.1) {
              flush(); // the rest goes into a continuation packet: header, then data
            } else if (r < 0.15) {
              const realtime = 0xf8 + pick(8);
              stamp();
              body.push(realtime);
              expected.push([t % 8192, [realtime]]);
            }
            body.push(byte);
          }
          if (rnd() < 0.2) flush(); // the end alone in the last packet
          stamp();
          body.push(0xf7);
          running = 0;
          afterSystem = true;
          expected.push([t % 8192, [0xf0, ...data, 0xf7]]);
        }
      }
      flush();

      const parser = new BleMidiParser();
      const got = packets.flatMap((bytes) => plain(parser.parse(Uint8Array.from(bytes))));
      assert.deepEqual(got, expected, `round ${round}`);
      assert.equal(parser.stats.skippedBytes, 0, `round ${round}: nothing skipped`);
      // The opt-in quirk changes nothing for a compliant stream.
      const lenient = new BleMidiParser({ carryRunningStatus: true });
      assert.deepEqual(packets.flatMap((bytes) => plain(lenient.parse(Uint8Array.from(bytes)))), expected);
      messages += expected.length;
    }
    assert.ok(messages > 5000);
  });
});

// ---------------------------------------------------------------------------
// Parser: input types
// ---------------------------------------------------------------------------

describe('BleMidiParser: input types', () => {
  const bytes = [H(2000), T(2000), 0x90, 60, 100, T(2004), 0x80, 60, 0];
  const expected = [
    [2000, [0x90, 60, 100]],
    [2004, [0x80, 60, 0]],
  ];

  test('Uint8Array', () => {
    assert.deepEqual(plain(new BleMidiParser().parse(Uint8Array.from(bytes))), expected);
  });

  test('ArrayBuffer', () => {
    assert.deepEqual(plain(new BleMidiParser().parse(Uint8Array.from(bytes).buffer)), expected);
  });

  test('DataView over a whole buffer (what Web Bluetooth delivers)', () => {
    const view = new DataView(Uint8Array.from(bytes).buffer);
    assert.deepEqual(plain(new BleMidiParser().parse(view)), expected);
  });

  test('DataView with a byteOffset and a byteLength inside a larger buffer', () => {
    const big = new Uint8Array(32).fill(0x90); // surrounding bytes must not be read
    big.set(bytes, 7);
    const view = new DataView(big.buffer, 7, bytes.length);
    assert.deepEqual(plain(new BleMidiParser().parse(view)), expected);
  });

  test('Uint8Array subarray with a byteOffset', () => {
    const big = new Uint8Array(32).fill(0x90);
    big.set(bytes, 11);
    assert.deepEqual(plain(new BleMidiParser().parse(big.subarray(11, 11 + bytes.length))), expected);
  });

  test('other typed array views are read byte by byte', () => {
    const view = new Int8Array(Uint8Array.from(bytes).buffer);
    assert.deepEqual(plain(new BleMidiParser().parse(view)), expected);
  });

  test('Node Buffer and a plain array of bytes', () => {
    assert.deepEqual(plain(new BleMidiParser().parse(Buffer.from(bytes))), expected);
    assert.deepEqual(plain(new BleMidiParser().parse(bytes)), expected);
  });

  test('zero-length views', () => {
    assert.deepEqual(new BleMidiParser().parse(new DataView(new ArrayBuffer(8), 4, 0)), []);
    assert.deepEqual(new BleMidiParser().parse(new ArrayBuffer(0)), []);
  });

  test('a detached buffer gives an empty result instead of throwing', () => {
    const buffer = Uint8Array.from(bytes).buffer;
    const view = new DataView(buffer);
    const array = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] }); // detaches `buffer`
    assert.equal(buffer.byteLength, 0);
    const parser = new BleMidiParser();
    assert.deepEqual(parser.parse(view), []);
    assert.deepEqual(parser.parse(array), []);
    assert.deepEqual(parser.parse(buffer), []);
  });

  test('stats count packets, messages and skipped bytes', () => {
    const parser = new BleMidiParser();
    parser.parse(Uint8Array.from(bytes));
    parser.parse(pkt(0x80, 1, 2));
    const stats = parser.stats;
    assert.deepEqual(stats, { packets: 2, messages: 2, skippedBytes: 2, sysexDropped: 0 });
    stats.messages = 99; // a copy
    assert.equal(parser.stats.messages, 2);
  });
});

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

describe('encodeBleMidiPacket', () => {
  test('one message: header, timestamp byte, message', () => {
    assert.deepEqual(Array.from(encodeBleMidiPacket([[0x90, 60, 100]], 4660)), [0xa4, 0xb4, 0x90, 60, 100]);
  });

  test('default timestamp is 0', () => {
    assert.deepEqual(Array.from(encodeBleMidiPacket([[0x80, 60, 0]])), [0x80, 0x80, 0x80, 60, 0]);
  });

  test('a timestamp byte in front of every message', () => {
    const out = encodeBleMidiPacket([[0x90, 60, 100], [0x90, 64, 100], [0xb0, 64, 127], [0xc0, 5], [0xf8]], 130);
    assert.deepEqual(Array.from(out), [
      0x81, 0x82, 0x90, 60, 100, 0x82, 0x90, 64, 100, 0x82, 0xb0, 64, 127, 0x82, 0xc0, 5, 0x82, 0xf8,
    ]);
  });

  test('only the low 13 bits of the timestamp are used', () => {
    const big = 8192 * 1000 + 4660.9; // like performance.now()
    assert.deepEqual(Array.from(encodeBleMidiPacket([[0xf8]], big)), [0xa4, 0xb4, 0xf8]);
    assert.deepEqual(Array.from(encodeBleMidiPacket([[0xf8]], -1)), [0xbf, 0xff, 0xf8]);
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x']) {
      const out = encodeBleMidiPacket([[0xf8]], bad);
      assert.deepEqual(Array.from(out), [0x80, 0x80, 0xf8]);
    }
  });

  test('SysEx gets a timestamp byte in front of its F7', () => {
    const out = encodeBleMidiPacket([[0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]], 5);
    assert.deepEqual(Array.from(out), [0x80, 0x85, 0xf0, 0x7e, 0x7f, 0x06, 0x01, 0x85, 0xf7]);
  });

  test('typed arrays and a single flat message are accepted', () => {
    assert.deepEqual(Array.from(encodeBleMidiPacket([Uint8Array.of(0x90, 60, 100)], 1)), [0x80, 0x81, 0x90, 60, 100]);
    assert.deepEqual(Array.from(encodeBleMidiPacket([0x90, 60, 100], 1)), [0x80, 0x81, 0x90, 60, 100]);
    assert.deepEqual(Array.from(encodeBleMidiPacket(Uint8Array.of(0x90, 60, 100), 1)), [0x80, 0x81, 0x90, 60, 100]);
  });

  test('malformed messages are left out, never sent broken', () => {
    const out = encodeBleMidiPacket(
      [
        [0x90, 60], // too short
        [0x90, 60, 100, 1], // too long
        [0x90, 60, 200], // data byte above 127
        [60, 100], // no status byte
        [], // empty
        [0xf7], // lone end of SysEx
        [0xf4],
        [0xf5, 1],
        [0xf8, 1], // realtime takes no data
        [0x90, 60.5, 100],
        [0x90, '60', 100],
        [0xf0, 1, 0x90, 0xf7], // status byte inside a SysEx
        [0xf0, 1, 2], // SysEx without its end
        [0xf0],
        null,
        undefined,
        7,
        'abc',
        {},
        [0x80, 60, 0], // the only valid one
      ],
      0,
    );
    assert.deepEqual(Array.from(out), [0x80, 0x80, 0x80, 60, 0]);
  });

  test('hostile array-likes are left out without throwing', () => {
    const throwing = { length: 3, get 0() { throw new Error('boom'); } };
    const huge = { length: 2 ** 31, 0: 0xf0 };
    const out = encodeBleMidiPacket([throwing, huge, [0xfe]], 0);
    assert.deepEqual(Array.from(out), [0x80, 0x80, 0xfe]);
    // The list itself can be hostile too.
    assert.deepEqual(Array.from(encodeBleMidiPacket({ length: 2 ** 31 }, 0)), [0x80]);
    assert.deepEqual(Array.from(encodeBleMidiPacket({ length: 1, get 0() { throw new Error('boom'); } }, 0)), [0x80]);
    assert.deepEqual(Array.from(encodeBleMidiPacket({ length: 1.5, 0: [0xfe] }, 0)), [0x80]);
  });

  test('an empty SysEx is a complete message', () => {
    assert.deepEqual(Array.from(encodeBleMidiPacket([[0xf0, 0xf7]], 3)), [0x80, 0x83, 0xf0, 0x83, 0xf7]);
  });

  test('nothing to send gives the header byte alone', () => {
    for (const empty of [[], undefined, null, 5, 'x', {}, [[]], [[60]]]) {
      const out = encodeBleMidiPacket(empty, 130);
      assert.ok(out instanceof Uint8Array);
      assert.deepEqual(Array.from(out), [0x81]);
    }
  });

  test('round trip through the parser', () => {
    const messages = [
      [0x90, 60, 100],
      [0x90, 64, 0],
      [0x80, 60, 64],
      [0xa0, 60, 1],
      [0xb0, 64, 127],
      [0xc3, 9],
      [0xd4, 99],
      [0xe5, 0, 64],
      [0xf1, 0x33],
      [0xf2, 1, 2],
      [0xf3, 7],
      [0xf6],
      [0xf8],
      [0xfe],
      [0xf0, 0x43, 0x10, 0x4c, 0, 0, 0x7e, 0, 0xf7],
      [0x90, 72, 1],
    ];
    for (const ts of [0, 1, 127, 128, 4660, 8191, 8192 + 77]) {
      const packet = encodeBleMidiPacket(messages, ts);
      const out = new BleMidiParser().parse(packet);
      assert.deepEqual(out.map((m) => Array.from(m.data)), messages);
      for (const m of out) assert.equal(m.timestamp, ts % 8192);
    }
  });

  test('round trip of one message per packet through a DataView', () => {
    const parser = new BleMidiParser();
    for (let note = 21; note <= 108; note += 1) {
      const packet = encodeBleMidiPacket([[0x90, note, 64]], note * 10);
      const out = parser.parse(new DataView(packet.buffer, packet.byteOffset, packet.byteLength));
      assert.deepEqual(plain(out), [[note * 10, [0x90, note, 64]]]);
    }
  });
});

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * Simulate a device and a jittery link.
 * @param {Object} o
 * @param {number[]} o.times      true event times on the local clock (ms), ascending
 * @param {number} [o.devBase]    device clock value at local time 0
 * @param {number} [o.rate]       device clock rate (1 = perfect)
 * @param {number} [o.minDelay]   minimum delivery delay
 * @param {number} [o.jitter]     extra delay, uniform in [0, jitter)
 * @param {() => number} [o.rnd]
 * @returns {{t: number, ts: number, arrival: number}[]}
 */
function simulate({ times, devBase = 1234, rate = 1, minDelay = 6, jitter = 12, rnd = lcg(1) }) {
  let lastArrival = -Infinity;
  return times.map((t) => {
    const dev = Math.round(devBase + t * rate);
    const ts = ((dev % 8192) + 8192) % 8192;
    // Packets are delivered in order.
    const arrival = Math.max(lastArrival, t + minDelay + rnd() * jitter);
    lastArrival = arrival;
    return { t, ts, arrival };
  });
}

/** Feed events to a clock, checking the hard guarantees on the way. */
function run(clock, events, maxLead = 80) {
  let prev = -Infinity;
  return events.map((e) => {
    const out = clock.toLocal(e.ts, e.arrival);
    assert.ok(out <= e.arrival, `not later than arrival: ${out} > ${e.arrival}`);
    assert.ok(out >= e.arrival - maxLead - 1e-9, `not earlier than arrival - maxLead: ${out} < ${e.arrival - maxLead}`);
    assert.ok(out >= prev, `non-decreasing: ${out} < ${prev}`);
    prev = out;
    return out;
  });
}

const range = (count, f) => Array.from({ length: count }, (_, k) => f(k));

/** Largest deviation of the output intervals from the true intervals, from index `from` on. */
function worstIntervalError(events, outs, from) {
  let worst = 0;
  for (let k = Math.max(1, from); k < events.length; k += 1) {
    const err = Math.abs(outs[k] - outs[k - 1] - (events[k].t - events[k - 1].t));
    if (err > worst) worst = err;
  }
  return worst;
}

describe('BleMidiClock: basics', () => {
  test('the first message is reported at its arrival time', () => {
    const clock = new BleMidiClock();
    assert.equal(clock.state, 'probing');
    assert.equal(clock.toLocal(4000, 123456.5), 123456.5);
  });

  test('default maxLeadMs is 80 and bad options fall back to it', () => {
    for (const options of [undefined, null, {}, { maxLeadMs: -5 }, { maxLeadMs: NaN }, { maxLeadMs: 'x' }, 7]) {
      const clock = new BleMidiClock(options);
      const events = simulate({ times: range(100, (k) => 1000 + 50 * k) });
      run(clock, events, 80);
      assert.equal(clock.state, 'synced');
      const last = events[events.length - 1];
      // A packet that arrives 500 ms late is pulled back by exactly maxLeadMs.
      const ts = (last.ts + 50) % 8192;
      assert.equal(clock.toLocal(ts, last.t + 50 + 500), last.t + 50 + 500 - 80);
    }
  });
});

describe('BleMidiClock: qualifying the device clock', () => {
  test('until the device clock has proven itself the result is the arrival time', () => {
    const events = simulate({ times: range(200, (k) => 1000 + 100 * k), rnd: lcg(101) });
    const clock = new BleMidiClock();
    let syncedAt = -1;
    events.forEach((e, k) => {
      const wasProbing = clock.state === 'probing';
      const out = clock.toLocal(e.ts, e.arrival);
      if (clock.state === 'probing') assert.equal(out, e.arrival);
      if (wasProbing && clock.state === 'synced') syncedAt = k;
    });
    // Four good segments of at least 250 ms after the first one: well under 3 s of playing.
    assert.ok(syncedAt > 4 && syncedAt <= 25, `synced at message ${syncedAt}`);
    assert.equal(clock.state, 'synced');
  });

  test('a few sparse notes are enough to sync', () => {
    // One note per second: note on, note off 600 ms later.
    const times = [];
    for (let k = 0; k < 6; k += 1) times.push(1000 + 1000 * k, 1600 + 1000 * k);
    const clock = new BleMidiClock();
    run(clock, simulate({ times, rnd: lcg(103) }));
    assert.equal(clock.state, 'synced');
  });

  test('dense traffic from a slightly slow device clock: the window stays bounded', () => {
    // A message every 5 ms whose offset creeps up by 0.01 ms each time (a clock 0.2 percent
    // slow). Every sample is a new maximum, so the sliding window would hold 800 entries
    // without its cap of 256.
    const clock = new BleMidiClock();
    let prev = -Infinity;
    let worstLead = 0;
    for (let k = 0; k < 4000; k += 1) {
      const t = 1000 + 5 * k;
      const arrival = t + 6 + 0.01 * k;
      const out = clock.toLocal((1234 + t) % 8192, arrival);
      assert.ok(out <= arrival && out >= arrival - 80 && out >= prev);
      prev = out;
      if (k > 1000) worstLead = Math.max(worstLead, arrival - out);
    }
    assert.equal(clock.state, 'synced');
    // The lag is the drift across the window: 256 entries of 0.01 ms, not 800.
    assert.ok(worstLead > 2 && worstLead < 3, `lead ${worstLead}`);
  });

  test('a device clock 1 percent slow lags by less than the stale-estimate limit', () => {
    const events = simulate({ times: range(4000, (k) => 1000 + 5 * k), rate: 0.99, jitter: 0 });
    const clock = new BleMidiClock();
    const outs = run(clock, events);
    assert.equal(clock.state, 'synced');
    for (let k = 1000; k < events.length; k += 1) {
      assert.ok(events[k].arrival - outs[k] <= 41, `lead ${events[k].arrival - outs[k]}`);
    }
  });
});

describe('BleMidiClock: jitter removal', () => {
  test('evenly spaced device stamps with jittered arrival come out evenly spaced', () => {
    const events = simulate({ times: range(400, (k) => 1000 + 100 * k), jitter: 12, rnd: lcg(7) });
    const clock = new BleMidiClock();
    const outs = run(clock, events);
    assert.equal(clock.state, 'synced');

    // The arrival times themselves are off by up to the jitter.
    let rawWorst = 0;
    for (let k = 41; k < events.length; k += 1) {
      rawWorst = Math.max(rawWorst, Math.abs(events[k].arrival - events[k - 1].arrival - 100));
    }
    assert.ok(rawWorst > 8, `the input is jittery (${rawWorst})`);

    // After the warm-up the corrected times are even to within 2 ms.
    const worst = worstIntervalError(events, outs, 41);
    assert.ok(worst <= 2, `worst interval error ${worst} ms`);
    let sum = 0;
    for (let k = 41; k < events.length; k += 1) sum += Math.abs(outs[k] - outs[k - 1] - 100);
    assert.ok(sum / (events.length - 41) < 0.5, `mean interval error ${sum / (events.length - 41)} ms`);

    // And they sit at the true time plus the minimum delay, within 2 ms.
    for (let k = 41; k < events.length; k += 1) {
      const error = outs[k] - (events[k].t + 6);
      assert.ok(error >= -0.51 && error <= 2, `absolute error ${error} at ${k}`);
    }
  });

  test('irregular rhythm with a slow connection interval (50 ms of jitter)', () => {
    const rnd = lcg(21);
    let t = 500;
    const times = range(600, () => {
      t += 40 + Math.floor(rnd() * 400);
      return t;
    });
    const events = simulate({ times, jitter: 50, rnd: lcg(22) });
    const clock = new BleMidiClock();
    const outs = run(clock, events);
    assert.equal(clock.state, 'synced');
    // Count how much better than the raw arrival times the result is.
    let rawSum = 0;
    let outSum = 0;
    for (let k = 100; k < events.length; k += 1) {
      const trueGap = events[k].t - events[k - 1].t;
      rawSum += Math.abs(events[k].arrival - events[k - 1].arrival - trueGap);
      outSum += Math.abs(outs[k] - outs[k - 1] - trueGap);
    }
    assert.ok(outSum < rawSum * 0.6, `corrected ${outSum} vs raw ${rawSum}`);
  });

  test('messages of one packet keep their device spacing', () => {
    // A packet every 30 ms carrying three messages stamped 10, 5 and 0 ms before it was sent.
    const rnd = lcg(3);
    const clock = new BleMidiClock();
    const spacing = [];
    let prev = -Infinity;
    for (let k = 0; k < 200; k += 1) {
      const sendTime = 2000 + 30 * k;
      const arrival = sendTime + 4 + rnd() * 6;
      const outs = [10, 5, 0].map((ago) => clock.toLocal((777 + sendTime - ago) % 8192, arrival));
      for (const out of outs) {
        assert.ok(out <= arrival && out >= arrival - 80 && out >= prev);
        prev = out;
      }
      if (k >= 100) spacing.push(outs[1] - outs[0], outs[2] - outs[1]);
    }
    assert.equal(clock.state, 'synced');
    for (const gap of spacing) assert.ok(Math.abs(gap - 5) < 1e-6, `gap ${gap}`);
  });

  test('a chord inside one packet is not flattened to a single instant', () => {
    const clock = new BleMidiClock();
    const events = simulate({ times: range(100, (k) => 1000 + 60 * k), rnd: lcg(5) });
    run(clock, events);
    const last = events[events.length - 1];
    const arrival = last.t + 60 + 20;
    const base = (last.ts + 60) % 8192;
    const a = clock.toLocal(base, arrival);
    const b = clock.toLocal((base + 7) % 8192, arrival);
    const c = clock.toLocal((base + 12) % 8192, arrival);
    assert.ok(Math.abs(b - a - 7) < 1e-6);
    assert.ok(Math.abs(c - b - 5) < 1e-6);
  });

  test('wrap of the 13-bit timestamp at 8192', () => {
    // 40 s of events, device clock starting just below the wrap: five wraps.
    const events = simulate({ times: range(800, (k) => 100 + 50 * k), devBase: 8100, rnd: lcg(11) });
    assert.ok(events.some((e, k) => k > 0 && e.ts < events[k - 1].ts), 'the stamps do wrap');
    const clock = new BleMidiClock();
    const outs = run(clock, events);
    assert.equal(clock.state, 'synced');
    const worst = worstIntervalError(events, outs, 60);
    assert.ok(worst <= 2, `worst interval error ${worst} ms`);
  });

  test('wrap exactly between two messages, with a pause shorter than the re-sync gap', () => {
    const clock = new BleMidiClock();
    const first = simulate({ times: range(100, (k) => 1000 + 50 * k), devBase: 0, jitter: 0, minDelay: 5 });
    run(clock, first);
    assert.equal(clock.state, 'synced');
    // 3.5 s of silence across the wrap (device time 5950 -> 9450 = 1258 mod 8192).
    const t = 5950 + 3500;
    assert.equal(clock.toLocal(t % 8192, t + 5 + 9), t + 5);
  });

  test('device clock drift of 300 ppm, fast or slow, is followed', () => {
    for (const rate of [1.0003, 0.9997]) {
      const events = simulate({ times: range(1200, (k) => 1000 + 50 * k), rate, rnd: lcg(13) });
      const clock = new BleMidiClock();
      const outs = run(clock, events);
      assert.equal(clock.state, 'synced');
      // Over 60 s the two clocks drift apart by 18 ms. The result must stay on the local clock.
      for (let k = 100; k < events.length; k += 1) {
        const error = outs[k] - (events[k].t + 6);
        assert.ok(Math.abs(error) <= 3, `rate ${rate}: absolute error ${error} at ${k}`);
      }
      assert.ok(worstIntervalError(events, outs, 100) <= 2);
    }
  });
});

describe('BleMidiClock: bounds and order', () => {
  test('a late packet is pulled back by at most maxLeadMs, never past its arrival', () => {
    for (const maxLeadMs of [80, 20, 200]) {
      const clock = new BleMidiClock({ maxLeadMs });
      const events = simulate({ times: range(100, (k) => 1000 + 50 * k), jitter: 0, minDelay: 5 });
      run(clock, events, maxLeadMs);
      const last = events[events.length - 1];
      const next = (delta) => (last.ts + delta) % 8192;
      // 30 ms late: fully corrected (30 is within all three limits).
      assert.equal(clock.toLocal(next(50), last.t + 50 + 5 + 10), last.t + 50 + 5);
      // 500 ms late: clamped to arrival - maxLeadMs.
      const arrival = last.t + 100 + 5 + 500;
      assert.equal(clock.toLocal(next(100), arrival), arrival - maxLeadMs);
    }
  });

  test('maxLeadMs 0 turns the correction off', () => {
    const clock = new BleMidiClock({ maxLeadMs: 0 });
    const events = simulate({ times: range(300, (k) => 1000 + 50 * k), rnd: lcg(17) });
    const outs = run(clock, events, 0);
    outs.forEach((out, k) => assert.equal(out, events[k].arrival));
  });

  test('a message that seems to arrive before the fastest packet is reported at its arrival', () => {
    const clock = new BleMidiClock();
    const events = simulate({ times: range(100, (k) => 1000 + 50 * k), jitter: 0, minDelay: 5 });
    run(clock, events);
    const last = events[events.length - 1];
    // Device stamp 20 ms ahead of what the arrival time allows.
    const arrival = last.t + 50 + 5;
    assert.equal(clock.toLocal((last.ts + 50 + 20) % 8192, arrival), arrival);
  });

  test('device stamps that go backwards inside a packet never make time go backwards', () => {
    const clock = new BleMidiClock();
    const events = simulate({ times: range(100, (k) => 1000 + 50 * k), rnd: lcg(19) });
    run(clock, events);
    const last = events[events.length - 1];
    const arrival = last.t + 50 + 10;
    const base = (last.ts + 50) % 8192;
    const a = clock.toLocal(base, arrival);
    const b = clock.toLocal((base + 8192 - 4) % 8192, arrival); // 4 ms in the past
    const c = clock.toLocal((base + 3) % 8192, arrival);
    assert.ok(b >= a && c >= b && c <= arrival);
  });

  test('random workloads: bounds and order always hold', () => {
    const rnd = lcg(99);
    for (let trial = 0; trial < 60; trial += 1) {
      const maxLeadMs = [0, 10, 80, 300][trial % 4];
      const clock = new BleMidiClock({ maxLeadMs });
      const kind = trial % 5;
      let arrival = rnd() * 1e6;
      let dev = Math.floor(rnd() * 8192);
      let prev = -Infinity;
      for (let k = 0; k < 600; k += 1) {
        const step = rnd() < 0.05 ? rnd() * 9000 : rnd() < 0.3 ? 0 : rnd() * 120;
        arrival += step;
        let ts;
        if (kind === 0) ts = Math.floor(rnd() * 8192); // garbage
        else if (kind === 1) ts = 42; // constant
        else {
          dev += step * (kind === 2 ? 1 : kind === 3 ? 0.7 : 1.4) + (rnd() - 0.5) * 30;
          if (rnd() < 0.02) dev += (rnd() - 0.5) * 6000; // clock jumps
          ts = ((Math.round(dev) % 8192) + 8192) % 8192;
        }
        const out = clock.toLocal(ts, arrival);
        assert.ok(Number.isFinite(out));
        assert.ok(out <= arrival, `trial ${trial}: ${out} > ${arrival}`);
        assert.ok(out >= arrival - maxLeadMs - 1e-9, `trial ${trial}: ${out} < ${arrival} - ${maxLeadMs}`);
        assert.ok(out >= prev, `trial ${trial}: ${out} < ${prev}`);
        prev = out;
      }
    }
  });
});

describe('BleMidiClock: unusable device clocks', () => {
  test('constant timestamps fall back to arrival time', () => {
    for (const constant of [0, 1, 4242, 8191]) {
      const rnd = lcg(constant + 1);
      const clock = new BleMidiClock();
      let arrival = 5000;
      for (let k = 0; k < 500; k += 1) {
        arrival += 5 + rnd() * 300;
        assert.equal(clock.toLocal(constant, arrival), arrival);
        // Chords: a second message in the same packet.
        if (k % 7 === 0) assert.equal(clock.toLocal(constant, arrival), arrival);
      }
      assert.notEqual(clock.state, 'synced');
    }
  });

  test('constant timestamps with fast, dense traffic fall back to arrival time', () => {
    const clock = new BleMidiClock();
    for (let k = 0; k < 2000; k += 1) {
      const arrival = 100 + k * 7.5;
      assert.equal(clock.toLocal(0, arrival), arrival);
    }
    assert.notEqual(clock.state, 'synced');
  });

  test('a counter that advances by one per message is not mistaken for a clock', () => {
    const rnd = lcg(31);
    const clock = new BleMidiClock();
    let arrival = 0;
    for (let k = 0; k < 2000; k += 1) {
      arrival += 10 + rnd() * 200;
      assert.equal(clock.toLocal(k % 8192, arrival), arrival);
    }
    assert.notEqual(clock.state, 'synced');
  });

  test('random timestamps fall back to arrival time', () => {
    const rnd = lcg(77);
    const clock = new BleMidiClock();
    let arrival = 0;
    for (let k = 0; k < 5000; k += 1) {
      arrival += 5 + rnd() * 150;
      assert.equal(clock.toLocal(Math.floor(rnd() * 8192), arrival), arrival);
    }
    assert.notEqual(clock.state, 'synced');
  });

  test('a device clock that runs 5 percent slow ends in fallback', () => {
    const events = simulate({ times: range(1200, (k) => 1000 + 50 * k), rate: 0.95, rnd: lcg(41) });
    const clock = new BleMidiClock();
    let prev = -Infinity;
    let fallbackAt = -1;
    events.forEach((e, k) => {
      const out = clock.toLocal(e.ts, e.arrival);
      assert.ok(out <= e.arrival && out >= e.arrival - 80 && out >= prev);
      prev = out;
      if (fallbackAt < 0 && clock.state === 'fallback') fallbackAt = k;
      // Once in fallback the result is the arrival time, for good.
      if (fallbackAt >= 0) {
        assert.equal(clock.state, 'fallback');
        assert.equal(out, e.arrival);
      }
    });
    assert.ok(fallbackAt > 0, 'reaches fallback');
    assert.ok(events[fallbackAt].t - events[0].t < 15000, `gave up after ${events[fallbackAt].t - events[0].t} ms`);
    // reset() gives the device another chance.
    clock.reset();
    assert.equal(clock.state, 'probing');
  });

  test('a device clock at half speed is never used for long', () => {
    const events = simulate({ times: range(1200, (k) => 1000 + 50 * k), rate: 0.5, rnd: lcg(43) });
    const clock = new BleMidiClock();
    const outs = run(clock, events);
    assert.notEqual(clock.state, 'synced');
    for (let k = 600; k < events.length; k += 1) assert.equal(outs[k], events[k].arrival);
  });

  test('a clock that turns to garbage in mid session is dropped within two seconds', () => {
    const clock = new BleMidiClock();
    const events = simulate({ times: range(200, (k) => 1000 + 50 * k), rnd: lcg(53) });
    run(clock, events);
    assert.equal(clock.state, 'synced');
    const rnd = lcg(54);
    const start = events[events.length - 1].arrival;
    let prev = -Infinity;
    for (let k = 1; k <= 400; k += 1) {
      const arrival = start + 25 * k;
      const out = clock.toLocal(Math.floor(rnd() * 8192), arrival);
      assert.ok(out <= arrival && out >= arrival - 80 && out >= prev);
      prev = out;
      if (arrival - start > 2000) assert.equal(out, arrival, `still using garbage after ${arrival - start} ms`);
    }
    assert.notEqual(clock.state, 'synced');
  });

  test('a clock that freezes in mid session is dropped', () => {
    const clock = new BleMidiClock();
    const events = simulate({ times: range(200, (k) => 1000 + 50 * k), rnd: lcg(47) });
    run(clock, events);
    assert.equal(clock.state, 'synced');
    const frozen = events[events.length - 1].ts;
    let arrival = events[events.length - 1].arrival;
    let prev = -Infinity;
    const tail = [];
    for (let k = 0; k < 400; k += 1) {
      arrival += 50;
      const out = clock.toLocal(frozen, arrival);
      assert.ok(out <= arrival && out >= arrival - 80 && out >= prev);
      prev = out;
      tail.push(arrival - out);
    }
    assert.notEqual(clock.state, 'synced');
    assert.ok(tail.slice(200).every((lead) => lead === 0), 'arrival times once the freeze is noticed');
  });
});

describe('BleMidiClock: gaps, jumps and outliers', () => {
  test('re-sync after a long gap, whatever the device clock did meanwhile', () => {
    const clock = new BleMidiClock();
    const first = simulate({ times: range(100, (k) => 1000 + 50 * k), rnd: lcg(51) });
    run(clock, first);
    assert.equal(clock.state, 'synced');

    // 20 s of silence, and the device clock is somewhere else entirely afterwards.
    const second = simulate({ times: range(200, (k) => 26000 + 50 * k), devBase: 5000, rnd: lcg(52) });
    let prev = -Infinity;
    const outs = second.map((e) => {
      const out = clock.toLocal(e.ts, e.arrival);
      assert.ok(out <= e.arrival && out >= prev);
      // No stale offset: the correction never exceeds the jitter of this link (12 ms).
      assert.ok(out >= e.arrival - 12.001, `stale offset after the gap: ${e.arrival - out}`);
      prev = out;
      return out;
    });
    assert.equal(outs[0], second[0].arrival);
    assert.equal(clock.state, 'synced');
    assert.ok(worstIntervalError(second, outs, 40) <= 2);
  });

  test('every message after its own long gap is reported at arrival time', () => {
    const clock = new BleMidiClock();
    run(clock, simulate({ times: range(100, (k) => 1000 + 50 * k) }));
    let t = 10000;
    for (let k = 0; k < 20; k += 1) {
      t += 4001 + k * 977; // also far beyond one wrap
      assert.equal(clock.toLocal((t * 3) % 8192, t), t);
    }
  });

  test('long pauses never cost trust, even when the device clock restarts in each of them', () => {
    const clock = new BleMidiClock();
    run(clock, simulate({ times: range(100, (k) => 1000 + 50 * k), rnd: lcg(55) }));
    assert.equal(clock.state, 'synced');
    const rnd = lcg(56);
    let t = 6000;
    for (let round = 0; round < 12; round += 1) {
      t += 6000;
      const devBase = Math.floor(rnd() * 8192); // unrelated to the previous round
      const stamp = (at) => (devBase + at) % 8192;
      // Two notes 300 ms apart, the second one delivered 9 ms late.
      assert.equal(clock.toLocal(stamp(t), t + 5), t + 5);
      assert.equal(clock.toLocal(stamp(t + 300), t + 300 + 5 + 9), t + 300 + 5);
      assert.equal(clock.state, 'synced', `round ${round}`);
    }
  });

  test('a device clock that jumps back is picked up again after one strike', () => {
    const before = simulate({ times: range(200, (k) => 1000 + 50 * k), rnd: lcg(61) });
    const after = simulate({ times: range(400, (k) => 11000 + 50 * k), devBase: 1234 - 500, rnd: lcg(62) });
    const clock = new BleMidiClock();
    run(clock, before);
    const outs = run(clock, after);
    assert.equal(clock.state, 'synced');
    assert.ok(worstIntervalError(after, outs, 120) <= 2);
    for (let k = 120; k < after.length; k += 1) {
      const error = outs[k] - (after[k].t + 6);
      assert.ok(error >= -0.51 && error <= 2.5, `absolute error ${error} at ${k}`);
    }
  });

  test('a device clock that jumps ahead is followed from the second packet on', () => {
    const before = simulate({ times: range(200, (k) => 1000 + 50 * k), rnd: lcg(63) });
    const after = simulate({ times: range(300, (k) => 11000 + 50 * k), devBase: 1234 + 500, rnd: lcg(64) });
    const clock = new BleMidiClock();
    run(clock, before);
    const outs = run(clock, after);
    assert.equal(outs[0], after[0].arrival);
    assert.equal(clock.state, 'synced');
    assert.ok(worstIntervalError(after, outs, 90) <= 2);
  });

  test('one early outlier does not poison the estimate', () => {
    const events = simulate({ times: range(300, (k) => 1000 + 50 * k), rnd: lcg(65) });
    const reference = run(new BleMidiClock(), events);

    const clock = new BleMidiClock();
    const outs = [];
    events.forEach((e, k) => {
      if (k === 150) {
        // A single message stamped 60 ms in the future.
        const arrival = (events[k - 1].arrival + e.arrival) / 2;
        assert.equal(clock.toLocal((e.ts + 60) % 8192, arrival), arrival);
      }
      outs.push(clock.toLocal(e.ts, e.arrival));
    });
    assert.equal(clock.state, 'synced');
    for (let k = 152; k < events.length; k += 1) {
      assert.ok(Math.abs(outs[k] - reference[k]) < 1e-6, `message ${k} moved by ${outs[k] - reference[k]}`);
    }
  });

  test('a stalled main thread: the queued packets keep order and the clock stays synced', () => {
    const clock = new BleMidiClock();
    const before = simulate({ times: range(200, (k) => 1000 + 30 * k), rnd: lcg(71) });
    run(clock, before);
    const start = before[before.length - 1].t + 30;
    const devAt = (t) => Math.round(1234 + t) % 8192;
    // Ten packets 30 ms apart, all delivered together 320 ms after the first was sent.
    const flush = start + 320;
    let prev = -Infinity;
    const outs = range(10, (k) => {
      const out = clock.toLocal(devAt(start + 30 * k), flush);
      assert.ok(out <= flush && out >= flush - 80 && out >= prev);
      prev = out;
      return out;
    });
    // Packets 0..7 waited more than 80 ms and are clamped to flush - 80. The last two waited
    // about 74 and 44 ms and keep their true 30 ms spacing.
    for (let k = 0; k <= 7; k += 1) assert.equal(outs[k], flush - 80);
    assert.ok(outs[8] > flush - 80);
    assert.ok(Math.abs(outs[9] - outs[8] - 30) < 1e-6);
    assert.equal(clock.state, 'synced');
    // Normal traffic afterwards is unaffected.
    const after = simulate({ times: range(100, (k) => start + 300 + 30 * k), rnd: lcg(72) });
    const tail = after.map((e) => clock.toLocal(e.ts, Math.max(e.arrival, flush)));
    assert.equal(clock.state, 'synced');
    for (let k = 20; k < after.length; k += 1) {
      assert.ok(Math.abs(tail[k] - tail[k - 1] - 30) <= 2);
    }
  });
});

describe('BleMidiClock: bad calls', () => {
  test('never throws, always returns a number', () => {
    const clock = new BleMidiClock();
    assert.equal(clock.toLocal(0, NaN), 0);
    assert.equal(clock.toLocal(undefined, undefined), 0);
    assert.equal(clock.toLocal(5, 1000), 1000);
    // A bad arrival time repeats the previous result.
    for (const bad of [NaN, Infinity, -Infinity, undefined, null, '1001', {}, Symbol('x')]) {
      assert.equal(clock.toLocal(6, bad), 1000);
    }
    // A bad timestamp falls back to the arrival time.
    let arrival = 1000;
    for (const bad of [NaN, Infinity, undefined, null, '7', {}, [], Symbol('x'), 10n]) {
      arrival += 10;
      assert.equal(clock.toLocal(bad, arrival), arrival);
    }
    assert.equal(clock.toLocal(), arrival);
  });

  test('timestamps outside 0..8191 are reduced to 13 bits', () => {
    const a = new BleMidiClock();
    const b = new BleMidiClock();
    const events = simulate({ times: range(300, (k) => 1000 + 50 * k), rnd: lcg(81) });
    events.forEach((e, k) => {
      const odd = e.ts + 8192 * ((k % 5) - 2) + 0.4;
      assert.equal(b.toLocal(odd, e.arrival), a.toLocal(e.ts, e.arrival));
    });
    assert.equal(b.state, 'synced');
  });

  test('arrival time going backwards: the result is never later than the arrival', () => {
    const clock = new BleMidiClock();
    assert.equal(clock.toLocal(100, 5000), 5000);
    assert.equal(clock.toLocal(110, 4000), 4000);
    assert.equal(clock.toLocal(120, 4010), 4010);
  });

  test('reset() starts over', () => {
    const clock = new BleMidiClock();
    run(clock, simulate({ times: range(100, (k) => 1000 + 50 * k) }));
    assert.equal(clock.state, 'synced');
    clock.reset();
    assert.equal(clock.state, 'probing');
    // Earlier arrival times are fine after a reset.
    assert.equal(clock.toLocal(1, 10), 10);
    assert.equal(clock.toLocal(11, 25), 25);
  });
});

describe('parser and clock together', () => {
  test('a played phrase over a jittery link keeps its rhythm', () => {
    const parser = new BleMidiParser();
    const clock = new BleMidiClock();
    const rnd = lcg(91);
    const onsets = [];
    const truth = [];
    // Eighth notes at 120 bpm: a note on every 250 ms, its note off 200 ms later.
    const events = [];
    for (let k = 0; k < 120; k += 1) {
      events.push({ t: 3000 + 250 * k, bytes: [0x90, 60 + (k % 12), 80] });
      events.push({ t: 3000 + 250 * k + 200, bytes: [0x80, 60 + (k % 12), 0] });
    }
    for (const e of events) {
      const packet = encodeBleMidiPacket([e.bytes], 4321 + e.t);
      const arrival = e.t + 8 + rnd() * 15;
      for (const m of parser.parse(new DataView(packet.buffer))) {
        const time = clock.toLocal(m.timestamp, arrival);
        if (decodeMidiMessage(m.data).type === 'noteon') {
          onsets.push(time);
          truth.push(e.t);
        }
      }
    }
    assert.equal(onsets.length, 120);
    assert.equal(clock.state, 'synced');
    for (let k = 30; k < onsets.length; k += 1) {
      assert.ok(Math.abs(onsets[k] - onsets[k - 1] - 250) <= 2, `interval ${onsets[k] - onsets[k - 1]}`);
    }
  });
});
