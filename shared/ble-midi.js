// Bluetooth LE MIDI: packet parser, device-clock mapper and packet encoder.
// Pure and isomorphic: no DOM, no Node built-ins, no top-level side effects.
//
// Packet format (MIDI Association, "Specification for MIDI over Bluetooth Low
// Energy (BLE-MIDI)" 1.0, which adopts Apple's protocol):
//
//   header     1 r h h h h h h   bit 7 set, bit 6 reserved (0), bits 5..0 = timestampHigh
//   timestamp  1 l l l l l l l   bit 7 set, bits 6..0 = timestampLow
//
// The 13-bit timestamp (timestampHigh << 7 | timestampLow) is in milliseconds
// on the sender's clock and wraps every 8192 ms. After the header a packet
// holds MIDI messages, each full message (status byte included) preceded by a
// timestamp byte. Rules implemented here, all taken from the specification:
//
// - Running status: a channel message may omit its status byte when it matches
//   the most recent full message in the same packet. It may or may not have its
//   own timestamp byte; without one it shares the preceding timestamp.
// - System common and system realtime messages do not cancel running status.
// - The end of a packet does cancel running status.
// - If timestampLow is smaller than the preceding timestampLow in the same
//   packet, timestampHigh has advanced by one.
// - Only SysEx may span packets. The start (F0) has a timestamp byte, a
//   continuation packet is the header followed directly by data bytes, and the
//   end (F7) has its own timestamp byte. Realtime messages (with a timestamp
//   byte) may appear anywhere inside a SysEx.
//
// The grammar is ambiguous on purpose: a byte with bit 7 set is a timestamp at
// a message boundary and a status byte right after a timestamp. The parser
// follows that alternation strictly, because guessing (for example reading a
// byte in 0x80..0xEF as a status byte whenever data follows it) turns ordinary
// timestamps into phantom notes.

import { midiDataLength } from './midi.js';

/** MIDI service UUID, lowercase as Web Bluetooth requires. */
export const BLE_MIDI_SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
/** MIDI data I/O characteristic UUID (write without response, read, notify). */
export const BLE_MIDI_CHARACTERISTIC_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';

/** The 13-bit device timestamp wraps at this many milliseconds. */
const TIMESTAMP_RANGE = 8192;
const DEFAULT_MAX_SYSEX_BYTES = 65536;

/**
 * One complete MIDI message taken out of a BLE MIDI packet.
 * @typedef {Object} BleMidiMessage
 * @property {number} timestamp  13-bit device time in ms, 0..8191
 * @property {Uint8Array} data   status byte first, running status expanded, SysEx whole (F0 ... F7)
 */

/**
 * Lifetime counters of a parser, for a debug view.
 * @typedef {Object} BleMidiParserStats
 * @property {number} packets       non-empty packets seen
 * @property {number} messages      messages delivered
 * @property {number} skippedBytes  bytes that could not be parsed and were dropped
 * @property {number} sysexDropped  SysEx messages aborted, left unfinished or over the size cap
 */

/** Mathematical modulo: the result is always in 0..m-1. */
function mod(value, m) {
  return ((value % m) + m) % m;
}

/**
 * View any supported packet type as bytes without copying, or null.
 * @param {unknown} packet
 * @returns {Uint8Array|null}
 */
function toBytes(packet) {
  try {
    if (packet instanceof Uint8Array) return packet;
    if (ArrayBuffer.isView(packet)) {
      // DataView (what Web Bluetooth delivers) and other typed arrays: respect the view window.
      return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
    }
    const tag = Object.prototype.toString.call(packet);
    if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
      return new Uint8Array(packet);
    }
    if (Array.isArray(packet)) {
      for (let i = 0; i < packet.length; i += 1) {
        const v = packet[i];
        if (!Number.isInteger(v) || v < 0 || v > 255) return null;
      }
      return Uint8Array.from(packet);
    }
  } catch {
    // A detached buffer or an exotic object: nothing usable in it.
  }
  return null;
}

/**
 * Stateful BLE MIDI packet parser. Feed it every characteristic notification
 * in order. The only state kept between packets is an unfinished SysEx (and,
 * with the carryRunningStatus option, the running status).
 *
 * Tolerated deviations from the specification (each one has no valid reading
 * that the lenient reading could be confused with):
 * - Data bytes that follow a system common or realtime message without the
 *   timestamp byte the specification asks for are still read as running status.
 * - Header bit 6 (reserved) is ignored.
 * - A 0xF7 that is the last byte of a packet, or that is followed by a
 *   timestamp and a status byte, ends a pending SysEx even though its own
 *   timestamp byte is missing.
 * - A stray timestamp byte in front of SysEx continuation data is ignored.
 *
 * Deliberately not tolerated: status bytes without a timestamp byte. They are
 * indistinguishable from timestamp bytes, so a byte with bit 7 set at a message
 * boundary is always a timestamp.
 *
 * Running status does not carry over to the next packet: the specification
 * says the end of a packet cancels it, so data bytes with no running status in
 * their own packet are skipped. Android's decoder knowingly allows it, which
 * suggests that some adapters forward a serial MIDI stream without restoring
 * the status byte at each packet start. For such a device construct the parser
 * with { carryRunningStatus: true }: a packet that starts "header, timestamp,
 * data" then continues the running status of the previous packets (kept the
 * MIDI 1.0 way: set by channel messages, cleared by system common and SysEx,
 * untouched by realtime).
 */
export class BleMidiParser {
  #maxSysex;
  /** @type {Uint8Array|null} */
  #sysex = null;
  #sysexLen = 0;
  #inSysex = false;
  #sysexOverflow = false;
  #carry = false;
  #carried = 0; // running status across packets, used with carryRunningStatus only
  #stats = { packets: 0, messages: 0, skippedBytes: 0, sysexDropped: 0 };

  /**
   * @param {{maxSysexBytes?: number, carryRunningStatus?: boolean}} [options]
   *   maxSysexBytes: longest SysEx delivered, counting F0 and F7 (default 65536). Longer ones
   *   are swallowed and dropped.
   *   carryRunningStatus: off by default (the specification). See the class comment.
   */
  constructor(options) {
    const max = options?.maxSysexBytes;
    this.#maxSysex = Number.isInteger(max) && max >= 2 ? max : DEFAULT_MAX_SYSEX_BYTES;
    this.#carry = options?.carryRunningStatus === true;
  }

  /**
   * Parse one BLE MIDI packet (one characteristic notification). Never throws
   * on malformed input: it skips what it cannot parse.
   *
   * A SysEx is delivered once, when its end arrives, with the timestamp of its
   * F7. Note-on with velocity 0 is passed through as it is (decoding is the
   * caller's job, see decodeMidiMessage).
   *
   * @param {Uint8Array|DataView|ArrayBuffer} packet
   * @returns {BleMidiMessage[]} complete messages in packet order
   */
  parse(packet) {
    /** @type {BleMidiMessage[]} */
    const out = [];
    const p = toBytes(packet);
    if (p === null || p.length === 0) return out;
    const stats = this.#stats;
    const n = p.length;
    stats.packets += 1;
    if ((p[0] & 0x80) === 0) {
      // Not a BLE MIDI packet: the header byte always has bit 7 set.
      stats.skippedBytes += n;
      return out;
    }

    let tsHigh = p[0] & 0x3f;
    let tsLow = -1; // no timestamp byte seen in this packet yet
    let ts = tsHigh << 7;
    let running = 0; // running status, valid inside this packet only
    let swallow = false; // dropping the data bytes of a message that was skipped
    let i = 1;
    if (this.#carry && !this.#inSysex && n > 2 && p[1] >= 0x80 && p[2] < 0x80) {
      // Opt-in quirk: "header, timestamp, data" continues the previous packet's running status.
      running = this.#carried;
    }

    const stamp = (byte) => {
      const low = byte & 0x7f;
      // timestampLow going backwards means timestampHigh advanced by one.
      if (tsLow >= 0 && low < tsLow) tsHigh = (tsHigh + 1) & 0x3f;
      tsLow = low;
      ts = (tsHigh << 7) | low;
    };
    /** Number of data bytes available at `from`, at most `max`. */
    const dataRun = (from, max) => {
      let k = 0;
      while (k < max && from + k < n && p[from + k] < 0x80) k += 1;
      return k;
    };
    const emit = (status, from, count) => {
      const data = new Uint8Array(1 + count);
      data[0] = status;
      for (let k = 0; k < count; k += 1) data[1 + k] = p[from + k];
      out.push({ timestamp: ts, data });
      stats.messages += 1;
    };
    /** Read the data bytes of `status` at i. A short message is dropped. */
    const readMessage = (status, statusBytes) => {
      const need = midiDataLength(status);
      const got = dataRun(i, need);
      if (got < need) {
        // Truncated by the end of the packet or cut short by the next timestamp.
        stats.skippedBytes += statusBytes + got;
      } else {
        emit(status, i, need);
      }
      i += got;
    };

    while (i < n) {
      const b = p[i];

      if (b < 0x80) {
        // A data byte at a message boundary.
        if (this.#inSysex) {
          this.#sysexPush(b);
          i += 1;
        } else if (swallow || running === 0) {
          // Stray data: no running status in this packet (or SysEx data whose start we never saw).
          stats.skippedBytes += 1;
          i += 1;
        } else {
          readMessage(running, 0);
        }
        continue;
      }

      // A byte with bit 7 set at a message boundary is a timestamp byte.
      if (i + 1 >= n) {
        // It is the last byte of the packet, so no message can follow it.
        if (this.#inSysex && b === 0xf7) this.#sysexFinish(ts, out);
        else stats.skippedBytes += 1;
        break;
      }
      const next = p[i + 1];

      if (next < 0x80) {
        if (this.#inSysex) {
          // No valid reading inside a SysEx: treat it as a stray timestamp and keep collecting.
          stats.skippedBytes += 1;
        } else {
          // Timestamp of a running status message, handled on the next turn.
          stamp(b);
          swallow = false;
        }
        i += 1;
        continue;
      }

      if (this.#inSysex && b === 0xf7 && next < 0xf4 && next !== 0xf0 && i + 2 < n && p[i + 2] >= 0x80) {
        // "F7, byte, status": read as a timestamp, F7 would introduce a status byte that is
        // immediately cut short. It is an end of SysEx whose own timestamp byte is missing.
        this.#sysexFinish(ts, out);
        i += 1;
        continue;
      }

      // Timestamp byte followed by a status byte.
      stamp(b);
      swallow = false;
      const status = next;
      i += 2;

      if (status >= 0xf8) {
        // System realtime: one byte, legal anywhere, cancels nothing.
        emit(status, i, 0);
        continue;
      }
      if (status === 0xf7) {
        if (this.#inSysex) this.#sysexFinish(ts, out);
        else stats.skippedBytes += 1; // end of a SysEx we never saw the start of
        continue;
      }
      // Any other status byte ends an unfinished SysEx.
      if (this.#inSysex) this.#sysexAbort();
      if (status >= 0xf0) this.#carried = 0;
      if (status === 0xf0) {
        this.#sysexStart();
        running = 0; // as in MIDI 1.0, a SysEx cancels running status
        continue;
      }
      if (status >= 0xf0) {
        if (status === 0xf4 || status === 0xf5) {
          // Undefined status bytes of unknown length: skip them and their data.
          stats.skippedBytes += 1;
          swallow = true;
          continue;
        }
        // System common (F1, F2, F3, F6): running status is kept.
        readMessage(status, 1);
        continue;
      }
      // Channel voice or mode message.
      running = status;
      this.#carried = status;
      readMessage(status, 1);
    }

    return out;
  }

  /** Forget an unfinished SysEx and any carried running status (call on disconnect or reconnect). */
  reset() {
    if (this.#inSysex) this.#stats.sysexDropped += 1;
    this.#sysexClear();
    this.#carried = 0;
  }

  /** @returns {BleMidiParserStats} a copy of the lifetime counters */
  get stats() {
    return { ...this.#stats };
  }

  #sysexStart() {
    this.#inSysex = true;
    this.#sysexOverflow = false;
    this.#sysexLen = 0;
    this.#sysexPush(0xf0);
  }

  #sysexPush(byte) {
    if (this.#sysexOverflow) return;
    // Keep one byte of room for the closing F7.
    if (this.#sysexLen >= this.#maxSysex - 1) {
      this.#sysexOverflow = true;
      this.#sysex = null;
      return;
    }
    let buf = this.#sysex;
    if (buf === null || this.#sysexLen >= buf.length) {
      const grown = new Uint8Array(Math.max(256, (buf === null ? 0 : buf.length) * 2));
      if (buf !== null) grown.set(buf.subarray(0, this.#sysexLen));
      buf = grown;
      this.#sysex = buf;
    }
    buf[this.#sysexLen] = byte;
    this.#sysexLen += 1;
  }

  #sysexFinish(timestamp, out) {
    if (this.#sysexOverflow || this.#sysex === null) {
      this.#stats.sysexDropped += 1;
    } else {
      const data = new Uint8Array(this.#sysexLen + 1);
      data.set(this.#sysex.subarray(0, this.#sysexLen));
      data[this.#sysexLen] = 0xf7;
      out.push({ timestamp, data });
      this.#stats.messages += 1;
    }
    this.#sysexClear();
  }

  #sysexAbort() {
    this.#stats.sysexDropped += 1;
    this.#sysexClear();
  }

  #sysexClear() {
    this.#inSysex = false;
    this.#sysexOverflow = false;
    this.#sysexLen = 0;
    this.#sysex = null;
  }
}

// ---------------------------------------------------------------------------
// BleMidiClock
// ---------------------------------------------------------------------------
//
// Problem. A BLE MIDI device stamps each message with its own millisecond
// clock, then holds it until the next connection event (every 7.5 to 50 ms
// depending on the host) before the radio, the OS and the browser deliver it.
// The arrival time therefore equals the true event time plus a delay that
// varies from packet to packet, and all messages of one packet arrive at the
// same instant. The device timestamps have no such jitter, but they are on
// another clock, only 13 bits wide, and some devices fill them with constants
// or garbage.
//
// Algorithm.
//
// 1. Unwrap. Device time is tracked as an unbounded number. For each message
//    the step from the previous one is the value congruent to the 13-bit
//    difference (mod 8192) that is nearest to the elapsed arrival time, so a
//    wrap, several wraps and small backward steps are all resolved without
//    assuming anything but "jitter is far below 4 seconds".
//
// 2. Offset. offset = arrivalMs - deviceMs = (clock difference) + (delivery
//    delay of this packet). The clock difference is constant apart from drift
//    and the delay is never below some minimum, so the smallest offset seen
//    recently belongs to a packet that was delivered with the least delay.
//    The estimate is the minimum offset over a sliding window of the last
//    SYNC_WINDOW_MS (a monotonic queue). Then
//      local = deviceMs + minOffset = arrivalMs - (offset - minOffset)
//    which removes the delay in excess of the minimum, and is clamped to
//    [arrivalMs - maxLeadMs, arrivalMs]. The window lets the estimate follow
//    clock drift: a device clock that runs slow by r lags by at most
//    r * window (0.4 ms at 100 ppm).
//
// 3. Two witnesses. An estimate that is too high only weakens the correction,
//    one that is too low shifts every note early. So a sample more than
//    DOWN_STEP_MS below the current minimum is not believed until a later
//    packet agrees. One early outlier cannot poison the estimate.
//
// 4. Qualifying the device clock. Until the device clock has proven itself the
//    result is simply arrivalMs ('probing'). Proof: arrival time is cut into
//    segments of at least SEGMENT_MS. The lowest offset of a segment must stay
//    within SEGMENT_TOLERANCE_MS of the previous segment's. A good segment
//    scores +1, a bad one -2 (score 0..SCORE_MAX). At SCORE_TRUST the clock is
//    'synced', at 0 it is back to 'probing'. A constant timestamp fails every
//    segment (its offset grows by the segment length), random timestamps fail
//    almost every one, a real clock passes even on a 50 ms connection interval.
//
// 5. Stale estimate. While synced, if every message for at least
//    LATE_RUN_MIN_SPAN_MS (and LATE_RUN_MIN_COUNT messages) is more than
//    LATE_LEAD_MS late, no packet is arriving anywhere near the estimated
//    minimum delay: the device clock jumped back or runs slow. That is a
//    strike: the estimate restarts from the current message. STRIKE_LIMIT
//    strikes within STRIKE_WINDOW_MS mean the device clock cannot be used, and
//    the clock stays in 'fallback' (arrival time) until reset().
//
// 6. Gaps. After a silence longer than SYNC_WINDOW_MS, or if arrival time goes
//    backwards, the device time is re-anchored and the estimate restarts. The
//    first message after a gap is reported at its arrival time.
//
// 7. Order. The result never goes below the previous result as long as arrival
//    times do not go backwards.

const DEFAULT_MAX_LEAD_MS = 80;
/** Sliding window of the minimum filter, and the silence after which the clock re-syncs. */
const SYNC_WINDOW_MS = 4000;
const WINDOW_MAX_ENTRIES = 256;
/** A sample this far below the current minimum needs a second packet to confirm it. */
const DOWN_STEP_MS = 30;
/** Packets closer together than this count as one witness. */
const MIN_PACKET_GAP_MS = 2;
const SEGMENT_MS = 250;
const SEGMENT_TOLERANCE_MS = 100;
const SCORE_MAX = 8;
const SCORE_TRUST = 4;
const LATE_LEAD_MS = 40;
const LATE_RUN_MIN_COUNT = 8;
const LATE_RUN_MIN_SPAN_MS = 1000;
const STRIKE_LIMIT = 3;
const STRIKE_WINDOW_MS = 30000;

/**
 * Maps 13-bit device timestamps onto the local clock to remove BLE delivery
 * jitter. Call toLocal() once per message, in the order the parser returned
 * them, passing the same arrivalMs for all messages of one packet.
 *
 * Guarantees: the result is never later than arrivalMs, never earlier than
 * arrivalMs - maxLeadMs, and never decreases while arrivalMs does not
 * decrease. With a device clock that is constant, random or badly off rate the
 * result is arrivalMs.
 */
export class BleMidiClock {
  #maxLead;
  /** @type {'probing'|'synced'|'fallback'} */
  #mode = 'probing';
  #score = 0;

  #hasLast = false;
  #lastTs = 0;
  #lastArrival = 0;
  #devMs = 0; // unwrapped device time of the last message

  #hasOut = false;
  #lastOut = 0;

  // Sliding window minimum of the offset: a queue with increasing offsets, the head is the minimum.
  #winArrival = [];
  #winOffset = [];

  // A sample far below the minimum that is waiting for a second witness.
  #lowPending = false;
  #lowArrival = 0;
  #lowOffset = 0;

  // Segment bookkeeping for qualifying the device clock (a segment is always open once anchored).
  #segStart = 0;
  #segMin = 0;
  #hasPrevSeg = false;
  #prevSegMin = 0;

  #lateCount = 0;
  #lateStart = 0;
  #strikes = [];

  /**
   * @param {{maxLeadMs?: number}} [options] maxLeadMs: the most a result may precede its
   *   arrival time (default 80). 0 turns the correction off.
   */
  constructor(options) {
    const lead = options?.maxLeadMs;
    this.#maxLead =
      typeof lead === 'number' && Number.isFinite(lead) && lead >= 0 ? lead : DEFAULT_MAX_LEAD_MS;
  }

  /**
   * 'probing': the device clock is not (or no longer) proven, results are arrival times.
   * 'synced': device timestamps are in use.
   * 'fallback': the device clock was found unusable, results are arrival times until reset().
   * @returns {'probing'|'synced'|'fallback'}
   */
  get state() {
    return this.#mode;
  }

  /**
   * @param {number} timestamp  13-bit device timestamp of the message (0..8191)
   * @param {number} arrivalMs  local time at which its packet arrived
   * @returns {number} local time in ms for the message
   */
  toLocal(timestamp, arrivalMs) {
    const arrival = typeof arrivalMs === 'number' ? arrivalMs : NaN;
    if (!Number.isFinite(arrival)) return this.#hasOut ? this.#lastOut : 0;
    if (this.#mode === 'fallback' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return this.#emit(arrival, arrival);
    }
    const ts = mod(Math.floor(timestamp), TIMESTAMP_RANGE);

    const gap = this.#hasLast ? arrival - this.#lastArrival : -1;
    if (!(gap >= 0 && gap <= SYNC_WINDOW_MS)) {
      this.#anchor(ts, arrival);
      return this.#emit(arrival, arrival);
    }

    // Unwrap: the device step congruent to the 13-bit difference and nearest to the arrival step.
    const step13 = mod(ts - this.#lastTs, TIMESTAMP_RANGE);
    const step = step13 + TIMESTAMP_RANGE * Math.round((gap - step13) / TIMESTAMP_RANGE);
    this.#devMs += step;
    this.#lastTs = ts;
    this.#lastArrival = arrival;
    const offset = arrival - this.#devMs;

    this.#scoreSegment(arrival, offset);
    this.#addSample(arrival, offset);
    if (this.#mode !== 'synced') return this.#emit(arrival, arrival);

    // How much later than the best recent packet this one was delivered.
    const lead = Math.max(0, offset - this.#winOffset[0]);
    if (lead > LATE_LEAD_MS) {
      if (this.#lateCount === 0) this.#lateStart = arrival;
      this.#lateCount += 1;
      if (
        this.#lateCount >= LATE_RUN_MIN_COUNT &&
        arrival - this.#lateStart >= LATE_RUN_MIN_SPAN_MS
      ) {
        this.#strike(arrival, offset);
        return this.#emit(arrival, arrival);
      }
    } else {
      this.#lateCount = 0;
    }
    return this.#emit(arrival - Math.min(lead, this.#maxLead), arrival);
  }

  /** Forget everything (call when the device disconnects or another one connects). */
  reset() {
    this.#mode = 'probing';
    this.#score = 0;
    this.#hasLast = false;
    this.#lastTs = 0;
    this.#lastArrival = 0;
    this.#devMs = 0;
    this.#hasOut = false;
    this.#lastOut = 0;
    this.#clearWindow();
    this.#segStart = 0;
    this.#segMin = 0;
    this.#hasPrevSeg = false;
    this.#prevSegMin = 0;
    this.#lateCount = 0;
    this.#lateStart = 0;
    this.#strikes = [];
  }

  /** Apply the ordering guarantee without ever passing the arrival time. */
  #emit(candidate, arrival) {
    let out = candidate;
    if (this.#hasOut && this.#lastOut > out) out = Math.min(this.#lastOut, arrival);
    this.#hasOut = true;
    this.#lastOut = out;
    return out;
  }

  /** Start tracking the device clock afresh from this message. Trust is kept. */
  #anchor(ts, arrival) {
    this.#hasLast = true;
    this.#lastTs = ts;
    this.#lastArrival = arrival;
    this.#devMs = ts;
    const offset = arrival - ts;
    this.#clearWindow();
    this.#pushSample(arrival, offset);
    this.#segStart = arrival;
    this.#segMin = offset;
    this.#hasPrevSeg = false;
    this.#lateCount = 0;
  }

  #clearWindow() {
    this.#winArrival.length = 0;
    this.#winOffset.length = 0;
    this.#lowPending = false;
  }

  #pushSample(arrival, offset) {
    const arrivals = this.#winArrival;
    const offsets = this.#winOffset;
    while (offsets.length > 0 && offsets[offsets.length - 1] >= offset) {
      offsets.pop();
      arrivals.pop();
    }
    offsets.push(offset);
    arrivals.push(arrival);
    if (offsets.length > WINDOW_MAX_ENTRIES) {
      offsets.shift();
      arrivals.shift();
    }
  }

  /** Feed one offset sample to the sliding minimum (step 2 and 3 of the algorithm). */
  #addSample(arrival, offset) {
    const arrivals = this.#winArrival;
    const offsets = this.#winOffset;
    const cutoff = arrival - SYNC_WINDOW_MS;
    while (arrivals.length > 0 && arrivals[0] < cutoff) {
      arrivals.shift();
      offsets.shift();
    }
    if (offsets.length > 0 && offset < offsets[0] - DOWN_STEP_MS) {
      if (!this.#lowPending) {
        this.#lowPending = true;
        this.#lowArrival = arrival;
        this.#lowOffset = offset;
      } else if (arrival - this.#lowArrival < MIN_PACKET_GAP_MS) {
        // Same packet: later messages of a packet waited less, keep its lowest offset.
        if (offset < this.#lowOffset) this.#lowOffset = offset;
      } else {
        // A second packet agrees that the minimum is too high. Take the more cautious of the two.
        const adopted = Math.max(offset, this.#lowOffset);
        this.#clearWindow();
        this.#pushSample(arrival, adopted);
      }
      return;
    }
    this.#lowPending = false;
    this.#pushSample(arrival, offset);
  }

  /** Step 4 of the algorithm: score the device clock segment by segment. */
  #scoreSegment(arrival, offset) {
    if (arrival - this.#segStart < SEGMENT_MS) {
      if (offset < this.#segMin) this.#segMin = offset;
      return;
    }
    if (this.#hasPrevSeg) {
      const good = Math.abs(this.#segMin - this.#prevSegMin) <= SEGMENT_TOLERANCE_MS;
      this.#score = Math.min(SCORE_MAX, Math.max(0, this.#score + (good ? 1 : -2)));
      if (this.#mode === 'probing') {
        if (!good) {
          this.#clearWindow();
        } else if (this.#score >= SCORE_TRUST) {
          this.#mode = 'synced';
          this.#lateCount = 0;
        }
      } else if (this.#mode === 'synced' && this.#score <= 0) {
        this.#mode = 'probing';
        this.#clearWindow();
      }
    }
    this.#prevSegMin = this.#segMin;
    this.#hasPrevSeg = true;
    this.#segStart = arrival;
    this.#segMin = offset;
  }

  /** Step 5 of the algorithm: the estimate is stale. Restart it, or give up on the device clock. */
  #strike(arrival, offset) {
    this.#strikes = this.#strikes.filter((t) => arrival - t <= STRIKE_WINDOW_MS);
    this.#strikes.push(arrival);
    this.#lateCount = 0;
    this.#clearWindow();
    if (this.#strikes.length >= STRIKE_LIMIT) {
      this.#mode = 'fallback';
      return;
    }
    this.#pushSample(arrival, offset);
  }
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/** Longest message, and longest message list, the encoder accepts (a guard against absurd array-likes). */
const MAX_OUTGOING_MESSAGE_BYTES = 65536;

/**
 * Check one outgoing message. Returns its bytes as a plain array, or null when
 * it is not one complete, well-formed MIDI message.
 * @param {unknown} message
 * @returns {number[]|null}
 */
function validMessageBytes(message) {
  if (message === null || typeof message !== 'object') return null;
  const length = /** @type {ArrayLike<number>} */ (message).length;
  if (!Number.isInteger(length) || length < 1 || length > MAX_OUTGOING_MESSAGE_BYTES) return null;
  const bytes = Array.prototype.slice.call(message);
  for (const v of bytes) {
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
  }
  const status = bytes[0];
  if (status < 0x80) return null;
  if (status === 0xf0) {
    // SysEx: F0, data bytes only, F7. One without its end is not a complete message.
    if (length < 2 || bytes[length - 1] !== 0xf7) return null;
    for (let i = 1; i < length - 1; i += 1) {
      if (bytes[i] > 0x7f) return null;
    }
    return bytes;
  }
  // A lone F7 and the undefined status bytes F4 and F5 are never sent.
  if (status === 0xf7 || status === 0xf4 || status === 0xf5) return null;
  if (length !== 1 + midiDataLength(status)) return null;
  for (let i = 1; i < length; i += 1) {
    if (bytes[i] > 0x7f) return null;
  }
  return bytes;
}

/**
 * Encode complete MIDI messages into one BLE MIDI packet: the header byte, then
 * for each message a timestamp byte and the message. Every message gets the
 * same timestamp. A SysEx (F0 ... F7) gets a second timestamp byte in front of
 * its F7, as the specification requires.
 *
 * Messages that are not one complete, well-formed MIDI message (wrong length,
 * data byte above 127, no status byte, SysEx without its F7) are left out
 * rather than sent broken, and nothing here throws. With nothing to send the
 * result is the header byte alone, so check for `length > 1` before writing.
 * The packet is not split: keeping it within the negotiated MTU minus 3 bytes
 * (20 bytes by default) is up to the caller.
 *
 * @param {ArrayLike<number>[]} messages  complete MIDI messages, status byte first
 *   (one flat message such as [0x90, 60, 100] is accepted too)
 * @param {number} [timestampMs]  any millisecond clock, only its low 13 bits are sent
 * @returns {Uint8Array}
 */
export function encodeBleMidiPacket(messages, timestampMs = 0) {
  const ts = Number.isFinite(timestampMs) ? mod(Math.floor(timestampMs), TIMESTAMP_RANGE) : 0;
  const timestampByte = 0x80 | (ts & 0x7f);
  const out = [0x80 | (ts >> 7)];

  let list = [];
  try {
    if (
      messages !== null &&
      typeof messages === 'object' &&
      Number.isInteger(messages.length) &&
      messages.length <= MAX_OUTGOING_MESSAGE_BYTES
    ) {
      // A single flat message such as [0x90, 60, 100] is accepted as a list of one.
      list = typeof messages[0] === 'number' ? [messages] : Array.prototype.slice.call(messages);
    }
  } catch {
    list = [];
  }

  for (const message of list) {
    let bytes = null;
    try {
      bytes = validMessageBytes(message);
    } catch {
      bytes = null; // an array-like whose elements cannot be read
    }
    if (bytes === null) continue;
    out.push(timestampByte);
    if (bytes[0] === 0xf0) {
      for (let i = 0; i < bytes.length - 1; i += 1) out.push(bytes[i]);
      out.push(timestampByte, 0xf7);
    } else {
      for (let i = 0; i < bytes.length; i += 1) out.push(bytes[i]);
    }
  }
  return Uint8Array.from(out);
}
