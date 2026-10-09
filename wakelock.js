/* ---------------- Keep the screen awake while the app is open ----------------
   Uses the browser's Screen Wake Lock API so the display doesn't dim, lock or fall back to the system screensaver
   while Sri Karaoke is open. Shared by all three pages (main screen, remote, Screen 2); each calls
   KeepAwake.start() when it loads and KeepAwake.stop() when the person logs out / leaves.

   Things the browser does that this has to live with:
   - it only grants the lock to a visible tab, and takes it back whenever the tab is hidden  -> asked for again as
     soon as the tab is visible again (and on focus / the first tap, in case the first request came too early);
   - it can refuse or revoke it at any time (battery saver, system policy)  -> retried a few seconds later, backing off;
   - it needs HTTPS and a reasonably recent browser  -> otherwise nothing can be done from a web page, and status()
     reports 'unsupported' so the Settings page can say so instead of silently not working.                        */
(function (global) {
  'use strict';

  var RETRY_STEPS_MS = [5000, 15000, 60000]; // then stays at the last step
  var sentinel = null;      // the active WakeLockSentinel
  var pending = null;       // a request currently in flight (so two callers never take two locks)
  var wanted = false;       // true between start() and stop()
  var state = 'off';        // 'off' | 'active' | 'waiting' | 'unsupported'
  var retryTimer = null;
  var retryStep = 0;
  var listeners = [];
  var bound = false;

  function supported() {
    return !!(global.navigator && global.navigator.wakeLock && typeof global.navigator.wakeLock.request === 'function');
  }
  function setState(next) {
    if (state === next) return;
    state = next;
    listeners.slice().forEach(function (fn) { try { fn(next); } catch (e) { /* a listener must never break this */ } });
  }
  function visible() { return global.document.visibilityState === 'visible'; }
  function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } }
  function scheduleRetry() {
    if (retryTimer || !wanted) return;
    var delay = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)];
    retryStep++;
    retryTimer = setTimeout(function () { retryTimer = null; acquire(); }, delay);
  }

  function acquire() {
    if (!wanted) return Promise.resolve();
    if (!supported()) { setState('unsupported'); return Promise.resolve(); }
    if (!visible()) { setState('waiting'); return Promise.resolve(); } // asked again when it becomes visible
    if (sentinel && !sentinel.released) { setState('active'); return Promise.resolve(); }
    if (pending) return pending;
    pending = global.navigator.wakeLock.request('screen').then(function (s) {
      pending = null;
      if (!wanted) { try { s.release(); } catch (e) { /* already gone */ } return; } // stopped while it was being granted
      sentinel = s;
      retryStep = 0;
      clearRetry();
      setState('active');
      s.addEventListener('release', function () {
        if (sentinel === s) sentinel = null;
        if (wanted) { setState('waiting'); if (visible()) scheduleRetry(); } // taken back by the browser/system
      });
    }).catch(function () {
      pending = null;
      if (!wanted) return;
      setState('waiting'); // refused for now (battery saver, not focused yet, ...)
      if (visible()) scheduleRetry();
    });
    return pending;
  }

  function onWake() { if (wanted && state !== 'active') acquire(); }
  function bind() {
    if (bound) return;
    bound = true;
    global.document.addEventListener('visibilitychange', function () {
      if (!wanted) return;
      if (visible()) { retryStep = 0; acquire(); } else if (state === 'active') { setState('waiting'); } // the browser lets go of it itself
    });
    global.addEventListener('focus', onWake);
    global.addEventListener('pageshow', onWake);
    // Some browsers won't grant it until the person has touched the page once
    ['click', 'touchstart', 'keydown'].forEach(function (ev) { global.document.addEventListener(ev, onWake, { passive: true }); });
  }

  global.KeepAwake = {
    start: function () { wanted = true; bind(); return acquire(); },
    stop: function () {
      wanted = false;
      clearRetry();
      retryStep = 0;
      var s = sentinel; sentinel = null;
      if (s) { try { var r = s.release(); if (r && r.catch) r.catch(function () {}); } catch (e) { /* already released */ } }
      setState('off');
    },
    status: function () { return state; },
    isSupported: supported,
    onChange: function (fn) { if (typeof fn === 'function') { listeners.push(fn); try { fn(state); } catch (e) { /* ignore */ } } }
  };
})(window);
