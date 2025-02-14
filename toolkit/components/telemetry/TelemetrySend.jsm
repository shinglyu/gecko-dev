/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * This module is responsible for uploading pings to the server and persisting
 * pings that can't be send now.
 * Those pending pings are persisted on disk and sent at the next opportunity,
 * newest first.
 */

"use strict";

this.EXPORTED_SYMBOLS = [
  "TelemetrySend",
];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm", this);
Cu.import("resource://gre/modules/Task.jsm", this);
Cu.import("resource://gre/modules/Log.jsm", this);
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/PromiseUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm", this);
Cu.import("resource://gre/modules/TelemetryUtils.jsm", this);
Cu.import("resource://gre/modules/Timer.jsm", this);

XPCOMUtils.defineLazyModuleGetter(this, "AsyncShutdown",
                                  "resource://gre/modules/AsyncShutdown.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "TelemetryStorage",
                                  "resource://gre/modules/TelemetryStorage.jsm");
XPCOMUtils.defineLazyServiceGetter(this, "Telemetry",
                                   "@mozilla.org/base/telemetry;1",
                                   "nsITelemetry");

const Utils = TelemetryUtils;

const LOGGER_NAME = "Toolkit.Telemetry";
const LOGGER_PREFIX = "TelemetrySend::";

const PREF_BRANCH = "toolkit.telemetry.";
const PREF_SERVER = PREF_BRANCH + "server";
const PREF_UNIFIED = PREF_BRANCH + "unified";
const PREF_TELEMETRY_ENABLED = PREF_BRANCH + "enabled";
const PREF_FHR_UPLOAD_ENABLED = "datareporting.healthreport.uploadEnabled";

const TOPIC_IDLE_DAILY = "idle-daily";
const TOPIC_QUIT_APPLICATION = "quit-application";

// Whether the FHR/Telemetry unification features are enabled.
// Changing this pref requires a restart.
const IS_UNIFIED_TELEMETRY = Preferences.get(PREF_UNIFIED, false);

const PING_FORMAT_VERSION = 4;

const MS_IN_A_MINUTE = 60 * 1000;

const PING_TYPE_DELETION = "deletion";

// We try to spread "midnight" pings out over this interval.
const MIDNIGHT_FUZZING_INTERVAL_MS = 60 * MS_IN_A_MINUTE;
// We delay sending "midnight" pings on this client by this interval.
const MIDNIGHT_FUZZING_DELAY_MS = Math.random() * MIDNIGHT_FUZZING_INTERVAL_MS;

// Timeout after which we consider a ping submission failed.
const PING_SUBMIT_TIMEOUT_MS = 1.5 * MS_IN_A_MINUTE;

// To keep resource usage in check, we limit ping sending to a maximum number
// of pings per minute.
const MAX_PING_SENDS_PER_MINUTE = 10;

// If we have more pending pings then we can send right now, we schedule the next
// send for after SEND_TICK_DELAY.
const SEND_TICK_DELAY = 1 * MS_IN_A_MINUTE;
// If we had any ping send failures since the last ping, we use a backoff timeout
// for the next ping sends. We increase the delay exponentially up to a limit of
// SEND_MAXIMUM_BACKOFF_DELAY_MS.
// This exponential backoff will be reset by external ping submissions & idle-daily.
const SEND_MAXIMUM_BACKOFF_DELAY_MS = 120 * MS_IN_A_MINUTE;

// Files that have been lying around for longer than MAX_PING_FILE_AGE are
// deleted without being loaded.
const MAX_PING_FILE_AGE = 14 * 24 * 60 * MS_IN_A_MINUTE; // 2 weeks

// Files that are older than OVERDUE_PING_FILE_AGE, but younger than
// MAX_PING_FILE_AGE indicate that we need to send all of our pings ASAP.
const OVERDUE_PING_FILE_AGE = 7 * 24 * 60 * MS_IN_A_MINUTE; // 1 week

// Maximum number of pings to save.
const MAX_LRU_PINGS = 50;

/**
 * This is a policy object used to override behavior within this module.
 * Tests override properties on this object to allow for control of behavior
 * that would otherwise be very hard to cover.
 */
let Policy = {
  now: () => new Date(),
  midnightPingFuzzingDelay: () => MIDNIGHT_FUZZING_DELAY_MS,
  setSchedulerTickTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearSchedulerTickTimeout: (id) => clearTimeout(id),
};

/**
 * Determine if the ping has the new v4 ping format or the legacy v2 one or earlier.
 */
function isV4PingFormat(aPing) {
  return ("id" in aPing) && ("application" in aPing) &&
         ("version" in aPing) && (aPing.version >= 2);
}

/**
 * Check if the provided ping is a deletion ping.
 * @param {Object} aPing The ping to check.
 * @return {Boolean} True if the ping is a deletion ping, false otherwise.
 */
function isDeletionPing(aPing) {
  return isV4PingFormat(aPing) && (aPing.type == PING_TYPE_DELETION);
}

function tomorrow(date) {
  let d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d;
}

/**
 * @return {String} This returns a string with the gzip compressed data.
 */
function gzipCompressString(string) {
  let observer = {
    buffer: "",
    onStreamComplete: function(loader, context, status, length, result) {
      this.buffer = String.fromCharCode.apply(this, result);
    }
  };

  let scs = Cc["@mozilla.org/streamConverters;1"]
            .getService(Ci.nsIStreamConverterService);
  let listener = Cc["@mozilla.org/network/stream-loader;1"]
                .createInstance(Ci.nsIStreamLoader);
  listener.init(observer);
  let converter = scs.asyncConvertData("uncompressed", "gzip",
                                       listener, null);
  let stringStream = Cc["@mozilla.org/io/string-input-stream;1"]
                     .createInstance(Ci.nsIStringInputStream);
  stringStream.data = string;
  converter.onStartRequest(null, null);
  converter.onDataAvailable(null, null, stringStream, 0, string.length);
  converter.onStopRequest(null, null, null);
  return observer.buffer;
}


this.TelemetrySend = {
  /**
   * Maximum age in ms of a pending ping file before it gets evicted.
   */
  get MAX_PING_FILE_AGE() {
    return MAX_PING_FILE_AGE;
  },

  /**
   * Age in ms of a pending ping to be considered overdue.
   */
  get OVERDUE_PING_FILE_AGE() {
    return OVERDUE_PING_FILE_AGE;
  },

  /**
   * The maximum number of pending pings we keep in the backlog.
   */
  get MAX_LRU_PINGS() {
    return MAX_LRU_PINGS;
  },

  get pendingPingCount() {
    return TelemetrySendImpl.pendingPingCount;
  },

  /**
   * Initializes this module.
   *
   * @param {Boolean} testing Whether this is run in a test. This changes some behavior
   * to enable proper testing.
   * @return {Promise} Resolved when setup is finished.
   */
  setup: function(testing = false) {
    return TelemetrySendImpl.setup(testing);
  },

  /**
   * Shutdown this module - this will cancel any pending ping tasks and wait for
   * outstanding async activity like network and disk I/O.
   *
   * @return {Promise} Promise that is resolved when shutdown is finished.
   */
  shutdown: function() {
    return TelemetrySendImpl.shutdown();
  },

  /**
   * Submit a ping for sending. This will:
   * - send the ping right away if possible or
   * - save the ping to disk and send it at the next opportunity
   *
   * @param {Object} ping The ping data to send, must be serializable to JSON.
   * @return {Promise} Test-only - a promise that is resolved when the ping is sent or saved.
   */
  submitPing: function(ping) {
    return TelemetrySendImpl.submitPing(ping);
  },

  /**
   * Count of pending pings that were discarded at startup due to being too old.
   */
  get discardedPingsCount() {
    return TelemetrySendImpl.discardedPingsCount;
  },

  /**
   * Count of pending pings that were found to be overdue at startup.
   */
  get overduePingsCount() {
    return TelemetrySendImpl.overduePingsCount;
  },

  /**
   * Only used in tests. Used to reset the module data to emulate a restart.
   */
  reset: function() {
    return TelemetrySendImpl.reset();
  },

  /**
   * Only used in tests.
   */
  setServer: function(server) {
    return TelemetrySendImpl.setServer(server);
  },

  /**
   * Only used in tests to wait on outgoing pending pings.
   */
  testWaitOnOutgoingPings: function() {
    return TelemetrySendImpl.promisePendingPingActivity();
  },

  /**
   * Test-only - this allows overriding behavior to enable ping sending in debug builds.
   */
  setTestModeEnabled: function(testing) {
    TelemetrySendImpl.setTestModeEnabled(testing);
  },
};

let CancellableTimeout = {
  _deferred: null,
  _timer: null,

  /**
   * This waits until either the given timeout passed or the timeout was cancelled.
   *
   * @param {Number} timeoutMs The timeout in ms.
   * @return {Promise<bool>} Promise that is resolved with false if the timeout was cancelled,
   *                         false otherwise.
   */
  promiseWaitOnTimeout: function(timeoutMs) {
    if (!this._deferred) {
      this._deferred = PromiseUtils.defer();
      this._timer = Policy.setSchedulerTickTimeout(() => this._onTimeout(), timeoutMs);
    }

    return this._deferred.promise;
  },

  _onTimeout: function() {
    if (this._deferred) {
      this._deferred.resolve(false);
      this._timer = null;
      this._deferred = null;
    }
  },

  cancelTimeout: function() {
    if (this._deferred) {
      Policy.clearSchedulerTickTimeout(this._timer);
      this._deferred.resolve(true);
      this._timer = null;
      this._deferred = null;
    }
  },
};

/**
 * SendScheduler implements the timer & scheduling behavior for ping sends.
 */
let SendScheduler = {
  // Whether any ping sends failed since the last tick. If yes, we start with our exponential
  // backoff timeout.
  _sendsFailed: false,
  // The current retry delay after ping send failures. We use this for the exponential backoff,
  // increasing this value everytime we had send failures since the last tick.
  _backoffDelay: SEND_TICK_DELAY,
  _shutdown: false,
  _sendTask: null,

  _logger: null,

  get _log() {
    if (!this._logger) {
      this._logger = Log.repository.getLoggerWithMessagePrefix(LOGGER_NAME, LOGGER_PREFIX + "Scheduler::");
    }

    return this._logger;
  },

  shutdown: function() {
    this._log.trace("shutdown");
    this._shutdown = true;
    CancellableTimeout.cancelTimeout();
    return Promise.resolve(this._sendTask);
  },

  /**
   * Only used for testing, resets the state to emulate a restart.
   */
  reset: function() {
    this._log.trace("reset");
    return this.shutdown().then(() => {
      this._sendsFailed = false;
      this._backoffDelay = SEND_TICK_DELAY;
      this._shutdown = false;
    });
  },

  /**
   * Notify the scheduler of a failure in sending out pings that warrants retrying.
   * This will trigger the exponential backoff timer behavior on the next tick.
   */
  notifySendsFailed: function() {
    this._log.trace("notifySendsFailed");
    if (this._sendsFailed) {
      return;
    }

    this._sendsFailed = true;
    this._log.trace("notifySendsFailed - had send failures");
  },

  /**
   * Returns whether ping submissions are currently throttled.
   */
  isThrottled: function() {
    const now = Policy.now();
    const nextPingSendTime = this._getNextPingSendTime(now);
    return (nextPingSendTime > now.getTime());
  },

  waitOnSendTask: function() {
    return Promise.resolve(this._sendTask);
  },

  triggerSendingPings: function(immediately) {
    this._log.trace("triggerSendingPings - active send task: " + !!this._sendTask + ", immediately: " + immediately);

    if (!this._sendTask) {
      this._sendTask = this._doSendTask();
      let clear = () => this._sendTask = null;
      this._sendTask.then(clear, clear);
    } else if (immediately) {
      CancellableTimeout.cancelTimeout();
    }

    return this._sendTask;
  },

  _doSendTask: Task.async(function*() {
    this._backoffDelay = SEND_TICK_DELAY;
    this._sendsFailed = false;

    const resetBackoffTimer = () => {
      this._backoffDelay = SEND_TICK_DELAY;
    };

    for (;;) {
      this._log.trace("_doSendTask iteration");

      if (this._shutdown) {
        this._log.trace("_doSendTask - shutting down, bailing out");
        return;
      }

      // Get a list of pending pings, sorted by last modified, descending.
      // Filter out all the pings we can't send now. This addresses scenarios like "deletion" pings
      // which can be send even when upload is disabled.
      let pending = TelemetryStorage.getPendingPingList();
      let current = TelemetrySendImpl.getUnpersistedPings();
      this._log.trace("_doSendTask - pending: " + pending.length + ", current: " + current.length);
      pending = pending.filter(p => TelemetrySendImpl.canSend(p));
      current = current.filter(p => TelemetrySendImpl.canSend(p));
      this._log.trace("_doSendTask - can send - pending: " + pending.length + ", current: " + current.length);

      // Bail out if there is nothing to send.
      if ((pending.length == 0) && (current.length == 0)) {
        this._log.trace("_doSendTask - no pending pings, bailing out");
        return;
      }

      // If we are currently throttled (e.g. fuzzing to avoid midnight spikes), wait for the next send window.
      const now = Policy.now();
      if (this.isThrottled()) {
        const nextPingSendTime = this._getNextPingSendTime(now);
        this._log.trace("_doSendTask - throttled, delaying ping send to " + new Date(nextPingSendTime));
        const delay = nextPingSendTime - now.getTime();
        const cancelled = yield CancellableTimeout.promiseWaitOnTimeout(delay);
        if (cancelled) {
          this._log.trace("_doSendTask - throttling wait was cancelled, resetting backoff timer");
          resetBackoffTimer();
        }

        continue;
      }

      let sending = pending.slice(0, MAX_PING_SENDS_PER_MINUTE);
      pending = pending.slice(MAX_PING_SENDS_PER_MINUTE);
      this._log.trace("_doSendTask - triggering sending of " + sending.length + " pings now" +
                      ", " + pending.length + " pings waiting");

      this._sendsFailed = false;
      const sendStartTime = Policy.now();
      yield TelemetrySendImpl.sendPings(current, [for (p of sending) p.id]);
      if (this._shutdown || (TelemetrySend.pendingPingCount == 0)) {
        this._log.trace("_doSendTask - bailing out after sending, shutdown: " + this._shutdown +
                        ", pendingPingCount: " + TelemetrySend.pendingPingCount);
        return;
      }

      // Calculate the delay before sending the next batch of pings.
      // We start with a delay that makes us send max. 1 batch per minute.
      // If we had send failures in the last batch, we will override this with
      // a backoff delay.
      const timeSinceLastSend = Policy.now() - sendStartTime;
      let nextSendDelay = Math.max(0, SEND_TICK_DELAY - timeSinceLastSend);

      if (!this._sendsFailed) {
        this._log.trace("_doSendTask - had no send failures, resetting backoff timer");
        resetBackoffTimer();
      } else {
        const newDelay = Math.min(SEND_MAXIMUM_BACKOFF_DELAY_MS,
                                  this._backoffDelay * 2);
        this._log.trace("_doSendTask - had send failures, backing off -" +
                        " old timeout: " + this._backoffDelay +
                        ", new timeout: " + newDelay);
        this._backoffDelay = newDelay;
        nextSendDelay = this._backoffDelay;
      }

      this._log.trace("_doSendTask - waiting for next send opportunity, timeout is " + nextSendDelay)
      const cancelled = yield CancellableTimeout.promiseWaitOnTimeout(nextSendDelay);
      if (cancelled) {
        this._log.trace("_doSendTask - batch send wait was cancelled, resetting backoff timer");
        resetBackoffTimer();
      }
    }
  }),

  /**
   * This helper calculates the next time that we can send pings at.
   * Currently this mostly redistributes ping sends from midnight until one hour after
   * to avoid submission spikes around local midnight for daily pings.
   *
   * @param now Date The current time.
   * @return Number The next time (ms from UNIX epoch) when we can send pings.
   */
  _getNextPingSendTime: function(now) {
    // 1. First we check if the time is between 0am and 1am. If it's not, we send
    // immediately.
    // 2. If we confirmed the time is indeed between 0am and 1am in step 1, we disallow
    // sending before (midnight + fuzzing delay), which is a random time between 0am-1am
    // (decided at startup).

    const midnight = Utils.truncateToDays(now);
    // Don't delay pings if we are not within the fuzzing interval.
    if ((now.getTime() - midnight.getTime()) > MIDNIGHT_FUZZING_INTERVAL_MS) {
      return now.getTime();
    }

    // Delay ping send if we are within the midnight fuzzing range.
    // We spread those ping sends out between |midnight| and |midnight + midnightPingFuzzingDelay|.
    return midnight.getTime() + Policy.midnightPingFuzzingDelay();
  },
 };

let TelemetrySendImpl = {
  _sendingEnabled: false,
  _logger: null,
  // Timer for scheduled ping sends.
  _pingSendTimer: null,
  // This tracks all pending ping requests to the server.
  _pendingPingRequests: new Map(),
  // This tracks all the pending async ping activity.
  _pendingPingActivity: new Set(),
  // This is true when running in the test infrastructure.
  _testMode: false,
  // This holds pings that we currently try and haven't persisted yet.
  _currentPings: new Map(),

  // Count of pending pings we discarded for age on startup.
  _discardedPingsCount: 0,
  // Count of pending pings that were overdue.
  _overduePingCount: 0,

  OBSERVER_TOPICS: [
    TOPIC_IDLE_DAILY,
  ],

  get _log() {
    if (!this._logger) {
      this._logger = Log.repository.getLoggerWithMessagePrefix(LOGGER_NAME, LOGGER_PREFIX);
    }

    return this._logger;
  },

  get discardedPingsCount() {
    return this._discardedPingsCount;
  },

  get overduePingsCount() {
    return this._overduePingCount;
  },

  get pendingPingRequests() {
    return this._pendingPingRequests;
  },

  get pendingPingCount() {
    return TelemetryStorage.getPendingPingList().length + this._currentPings.size;
  },

  setTestModeEnabled: function(testing) {
    this._testMode = testing;
  },

  setup: Task.async(function*(testing) {
    this._log.trace("setup");

    this._testMode = testing;
    this._sendingEnabled = true;

    this._discardedPingsCount = 0;

    Services.obs.addObserver(this, TOPIC_IDLE_DAILY, false);

    this._server = Preferences.get(PREF_SERVER, undefined);

    // Check the pending pings on disk now.
    try {
      yield this._checkPendingPings();
    } catch (ex) {
      this._log.error("setup - _checkPendingPings rejected", ex);
    }

    // Start sending pings, but don't block on this.
    SendScheduler.triggerSendingPings(true);
  }),

  /**
   * Discard old pings from the pending pings and detect overdue ones.
   * @return {Boolean} True if we have overdue pings, false otherwise.
   */
  _checkPendingPings: Task.async(function*() {
    // Scan the pending pings - that gives us a list sorted by last modified, descending.
    let infos = yield TelemetryStorage.loadPendingPingList();
    this._log.info("_checkPendingPings - pending ping count: " + infos.length);
    if (infos.length == 0) {
      this._log.trace("_checkPendingPings - no pending pings");
      return;
    }

    // Remove old pings that we haven't been able to send yet.
    const now = new Date();
    const tooOld = (info) => (now.getTime() - info.lastModificationDate) > MAX_PING_FILE_AGE;

    const oldPings = infos.filter((info) => tooOld(info));
    infos = infos.filter((info) => !tooOld(info));
    this._log.info("_checkPendingPings - clearing out " + oldPings.length + " old pings");

    for (let info of oldPings) {
      try {
        yield TelemetryStorage.removePendingPing(info.id);
        ++this._discardedPingsCount;
      } catch(ex) {
        this._log.error("_checkPendingPings - failed to remove old ping", ex);
      }
    }

    // Keep only the last MAX_LRU_PINGS entries to avoid that the backlog overgrows.
    const shouldEvict = infos.splice(MAX_LRU_PINGS, infos.length);
    let evictedCount = 0;
    this._log.info("_checkPendingPings - evicting " + shouldEvict.length + " pings to " +
                   "avoid overgrowing the backlog");

    for (let info of shouldEvict) {
      try {
        yield TelemetryStorage.removePendingPing(info.id);
        ++evictedCount;
      } catch(ex) {
        this._log.error("_checkPendingPings - failed to evict ping", ex);
      }
    }

    Services.telemetry.getHistogramById('TELEMETRY_FILES_EVICTED')
                      .add(evictedCount);

    // Check for overdue pings.
    const overduePings = infos.filter((info) =>
      (now.getTime() - info.lastModificationDate) > OVERDUE_PING_FILE_AGE);
    this._overduePingCount = overduePings.length;
   }),

  shutdown: Task.async(function*() {
    for (let topic of this.OBSERVER_TOPICS) {
      try {
        Services.obs.removeObserver(this, topic);
      } catch (ex) {
        this._log.error("shutdown - failed to remove observer for " + topic, ex);
      }
    }

    // We can't send anymore now.
    this._sendingEnabled = false;

    // Cancel any outgoing requests.
    yield this._cancelOutgoingRequests();

    // Stop any active send tasks.
    yield SendScheduler.shutdown();

    // Wait for any outstanding async ping activity.
    yield this.promisePendingPingActivity();

    // Save any outstanding pending pings to disk.
    yield this._persistCurrentPings();
  }),

  reset: function() {
    this._log.trace("reset");

    this._currentPings = new Map();

    this._overduePingCount = 0;
    this._discardedPingsCount = 0;

    const histograms = [
      "TELEMETRY_SUCCESS",
      "TELEMETRY_FILES_EVICTED",
      "TELEMETRY_SEND",
      "TELEMETRY_PING",
    ];

    histograms.forEach(h => Telemetry.getHistogramById(h).clear());

    return SendScheduler.reset();
  },

  observe: function(subject, topic, data) {
    switch(topic) {
    case TOPIC_IDLE_DAILY:
      SendScheduler.triggerSendingPings(true);
      break;
    }
  },

  submitPing: function(ping) {
    this._log.trace("submitPing - ping id: " + ping.id);

    if (!this.canSend(ping)) {
      this._log.trace("submitPing - Telemetry is not allowed to send pings.");
      return Promise.resolve();
    }

    if (!this._sendingEnabled) {
      // Sending is disabled or throttled, add this to the persisted pending pings.
      this._log.trace("submitPing - can't send ping now, persisting to disk - " +
                      "sendingEnabled: " + this._sendingEnabled);
      return TelemetryStorage.savePendingPing(ping);
    }

    // Let the scheduler trigger sending pings if possible.
    // As a safety mechanism, this resets any currently active throttling.
    this._log.trace("submitPing - can send pings, trying to send now");
    this._currentPings.set(ping.id, ping);
    SendScheduler.triggerSendingPings(true);
    return Promise.resolve();
  },

  /**
   * Only used in tests.
   */
  setServer: function (server) {
    this._log.trace("setServer", server);
    this._server = server;
  },

  _cancelOutgoingRequests: function() {
    // Abort any pending ping XHRs.
    for (let [id, request] of this._pendingPingRequests) {
      this._log.trace("_cancelOutgoingRequests - aborting ping request for id " + id);
      try {
        request.abort();
      } catch (e) {
        this._log.error("_cancelOutgoingRequests - failed to abort request for id " + id, e);
      }
    }
    this._pendingPingRequests.clear();
  },

  sendPings: function(currentPings, persistedPingIds) {
    let pingSends = [];

    for (let current of currentPings) {
      let ping = current;
      let p = Task.spawn(function*() {
        try {
          yield this._doPing(ping, ping.id, false);
        } catch (ex) {
          this._log.info("sendPings - ping " + ping.id + " not sent, saving to disk", ex);
          yield TelemetryStorage.savePendingPing(ping);
        } finally {
          this._currentPings.delete(ping.id);
        }
      }.bind(this));

      this._trackPendingPingTask(p);
      pingSends.push(p);
    }

    if (persistedPingIds.length > 0) {
      pingSends.push(this._sendPersistedPings(persistedPingIds).catch((ex) => {
        this._log.info("sendPings - persisted pings not sent", ex);
      }));
    }

    return Promise.all(pingSends);
  },

  /**
   * Send the persisted pings to the server.
   *
   * @param {Array<string>} List of ping ids that should be sent.
   *
   * @return Promise A promise that is resolved when all pings finished sending or failed.
   */
  _sendPersistedPings: Task.async(function*(pingIds) {
    this._log.trace("sendPersistedPings");

    if (TelemetryStorage.pendingPingCount < 1) {
      this._log.trace("_sendPersistedPings - no pings to send");
      return;
    }

    if (pingIds.length < 1) {
      this._log.trace("sendPersistedPings - no pings to send");
      return;
    }

    // We can send now.
    // If there are any send failures, _doPing() sets up handlers that e.g. trigger backoff timer behavior.
    this._log.trace("sendPersistedPings - sending " + pingIds.length + " pings");
    let pingSendPromises = [];
    for (let pingId of pingIds) {
      const id = pingId;
      pingSendPromises.push(
        TelemetryStorage.loadPendingPing(id)
          .then((data) => this._doPing(data, id, true))
          .catch(e => this._log.error("sendPersistedPings - failed to send ping " + id, e)));
    }

    let promise = Promise.all(pingSendPromises);
    this._trackPendingPingTask(promise);
    yield promise;
  }),

  _onPingRequestFinished: function(success, startTime, id, isPersisted) {
    this._log.trace("_onPingRequestFinished - success: " + success + ", persisted: " + isPersisted);

    Telemetry.getHistogramById("TELEMETRY_SEND").add(new Date() - startTime);
    let hping = Telemetry.getHistogramById("TELEMETRY_PING");
    let hsuccess = Telemetry.getHistogramById("TELEMETRY_SUCCESS");

    hsuccess.add(success);
    hping.add(new Date() - startTime);

    if (!success) {
      // Let the scheduler know about send failures for triggering backoff timeouts.
      SendScheduler.notifySendsFailed();
    }

    if (success && isPersisted) {
      return TelemetryStorage.removePendingPing(id);
    } else {
      return Promise.resolve();
    }
  },

  _getSubmissionPath: function(ping) {
    // The new ping format contains an "application" section, the old one doesn't.
    let pathComponents;
    if (isV4PingFormat(ping)) {
      // We insert the Ping id in the URL to simplify server handling of duplicated
      // pings.
      let app = ping.application;
      pathComponents = [
        ping.id, ping.type, app.name, app.version, app.channel, app.buildId
      ];
    } else {
      // This is a ping in the old format.
      if (!("slug" in ping)) {
        // That's odd, we don't have a slug. Generate one so that TelemetryStorage.jsm works.
        ping.slug = Utils.generateUUID();
      }

      // Do we have enough info to build a submission URL?
      let payload = ("payload" in ping) ? ping.payload : null;
      if (payload && ("info" in payload)) {
        let info = ping.payload.info;
        pathComponents = [ ping.slug, info.reason, info.appName, info.appVersion,
                           info.appUpdateChannel, info.appBuildID ];
      } else {
        // Only use the UUID as the slug.
        pathComponents = [ ping.slug ];
      }
    }

    let slug = pathComponents.join("/");
    return "/submit/telemetry/" + slug;
  },

  _doPing: function(ping, id, isPersisted) {
    if (!this.canSend(ping)) {
      // We can't send the pings to the server, so don't try to.
      this._log.trace("_doPing - Can't send ping " + ping.id);
      return Promise.resolve();
    }

    this._log.trace("_doPing - server: " + this._server + ", persisted: " + isPersisted +
                    ", id: " + id);

    const isNewPing = isV4PingFormat(ping);
    const version = isNewPing ? PING_FORMAT_VERSION : 1;
    const url = this._server + this._getSubmissionPath(ping) + "?v=" + version;

    let request = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                  .createInstance(Ci.nsIXMLHttpRequest);
    request.mozBackgroundRequest = true;
    request.timeout = PING_SUBMIT_TIMEOUT_MS;

    request.open("POST", url, true);
    request.overrideMimeType("text/plain");
    request.setRequestHeader("Content-Type", "application/json; charset=UTF-8");

    this._pendingPingRequests.set(id, request);

    let startTime = new Date();
    let deferred = PromiseUtils.defer();

    let onRequestFinished = (success, event) => {
      let onCompletion = () => {
        if (success) {
          deferred.resolve();
        } else {
          deferred.reject(event);
        }
      };

      this._pendingPingRequests.delete(id);
      this._onPingRequestFinished(success, startTime, id, isPersisted)
        .then(() => onCompletion(),
              (error) => {
                this._log.error("_doPing - request success: " + success + ", error: " + error);
                onCompletion();
              });
    };

    let errorhandler = (event) => {
      this._log.error("_doPing - error making request to " + url + ": " + event.type);
      onRequestFinished(false, event);
    };
    request.onerror = errorhandler;
    request.ontimeout = errorhandler;
    request.onabort = errorhandler;

    request.onload = (event) => {
      let status = request.status;
      let statusClass = status - (status % 100);
      let success = false;

      if (statusClass === 200) {
        // We can treat all 2XX as success.
        this._log.info("_doPing - successfully loaded, status: " + status);
        success = true;
      } else if (statusClass === 400) {
        // 4XX means that something with the request was broken.
        this._log.error("_doPing - error submitting to " + url + ", status: " + status
                        + " - ping request broken?");
        // TODO: we should handle this better, but for now we should avoid resubmitting
        // broken requests by pretending success.
        success = true;
      } else if (statusClass === 500) {
        // 5XX means there was a server-side error and we should try again later.
        this._log.error("_doPing - error submitting to " + url + ", status: " + status
                        + " - server error, should retry later");
      } else {
        // We received an unexpected status code.
        this._log.error("_doPing - error submitting to " + url + ", status: " + status
                        + ", type: " + event.type);
      }

      onRequestFinished(success, event);
    };

    // If that's a legacy ping format, just send its payload.
    let networkPayload = isNewPing ? ping : ping.payload;
    request.setRequestHeader("Content-Encoding", "gzip");
    let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                    .createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    startTime = new Date();
    let utf8Payload = converter.ConvertFromUnicode(JSON.stringify(networkPayload));
    utf8Payload += converter.Finish();
    Telemetry.getHistogramById("TELEMETRY_STRINGIFY").add(new Date() - startTime);
    let payloadStream = Cc["@mozilla.org/io/string-input-stream;1"]
                        .createInstance(Ci.nsIStringInputStream);
    startTime = new Date();
    payloadStream.data = gzipCompressString(utf8Payload);
    Telemetry.getHistogramById("TELEMETRY_COMPRESS").add(new Date() - startTime);
    startTime = new Date();
    request.send(payloadStream);

    return deferred.promise;
  },

  /**
   * Check if pings can be sent to the server. If FHR is not allowed to upload,
   * pings are not sent to the server (Telemetry is a sub-feature of FHR). If trying
   * to send a deletion ping, don't block it.
   * If unified telemetry is off, don't send pings if Telemetry is disabled.
   *
   * @param {Object} [ping=null] A ping to be checked.
   * @return {Boolean} True if pings can be send to the servers, false otherwise.
   */
  canSend: function(ping = null) {
    // We only send pings from official builds, but allow overriding this for tests.
    if (!Telemetry.isOfficialTelemetry && !this._testMode) {
      return false;
    }

    // With unified Telemetry, the FHR upload setting controls whether we can send pings.
    // The Telemetry pref enables sending extended data sets instead.
    if (IS_UNIFIED_TELEMETRY) {
      // Deletion pings are sent even if the upload is disabled.
      if (ping && isDeletionPing(ping)) {
        return true;
      }
      return Preferences.get(PREF_FHR_UPLOAD_ENABLED, false);
    }

    // Without unified Telemetry, the Telemetry enabled pref controls ping sending.
    return Preferences.get(PREF_TELEMETRY_ENABLED, false);
  },

  /**
   * Track any pending ping send and save tasks through the promise passed here.
   * This is needed to block shutdown on any outstanding ping activity.
   */
  _trackPendingPingTask: function (promise) {
    let clear = () => this._pendingPingActivity.delete(promise);
    promise.then(clear, clear);
    this._pendingPingActivity.add(promise);
  },

  /**
   * Return a promise that allows to wait on pending pings.
   * @return {Object<Promise>} A promise resolved when all the pending pings promises
   *         are resolved.
   */
  promisePendingPingActivity: function () {
    this._log.trace("promisePendingPingActivity - Waiting for ping task");
    let p = [for (p of this._pendingPingActivity) p.catch(ex => {
      this._log.error("promisePendingPingActivity - ping activity had an error", ex);
    })];
    p.push(SendScheduler.waitOnSendTask());
    return Promise.all(p);
  },

  _persistCurrentPings: Task.async(function*() {
    for (let [id, ping] of this._currentPings) {
      try {
        yield TelemetryStorage.savePendingPing(ping);
        this._log.trace("_persistCurrentPings - saved ping " + id);
      } catch (ex) {
        this._log.error("_persistCurrentPings - failed to save ping " + id, ex);
      } finally {
        this._currentPings.delete(id);
      }
    }
  }),

  /**
   * Returns the current pending, not yet persisted, pings, newest first.
   */
  getUnpersistedPings: function() {
    let current = [...this._currentPings.values()];
    current.reverse();
    return current;
  },
};
