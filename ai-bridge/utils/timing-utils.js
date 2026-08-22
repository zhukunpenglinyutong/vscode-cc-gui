/**
 * Shared timing helpers for rate-limiting event handlers and async triggers.
 */

function normalizeWait(wait) {
  const value = Number(wait);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function assertFunction(fn, name) {
  if (typeof fn !== 'function') {
    throw new TypeError(`${name} expected a function`);
  }
}

/**
 * Delay execution until calls stop for the provided wait period.
 *
 * @param {Function} fn Function to debounce
 * @param {number} [wait=0] Delay in milliseconds
 * @param {Object} [options] Options
 * @param {boolean} [options.leading=false] Invoke on the first call in a burst
 * @param {boolean} [options.trailing=true] Invoke after the final call in a burst
 * @returns {Function & {cancel: Function, flush: Function, pending: Function}}
 */
export function debounce(fn, wait = 0, options = {}) {
  assertFunction(fn, 'debounce');

  const delay = normalizeWait(wait);
  const leading = options.leading === true;
  const trailing = options.trailing !== false;

  let timeoutId;
  let lastArgs;
  let lastThis;
  let result;

  function clearPendingArgs() {
    lastArgs = undefined;
    lastThis = undefined;
  }

  function invoke() {
    const args = lastArgs;
    const thisArg = lastThis;
    clearPendingArgs();
    result = fn.apply(thisArg, args);
    return result;
  }

  function onTimerExpired() {
    timeoutId = undefined;

    if (trailing && lastArgs) {
      invoke();
      return;
    }

    clearPendingArgs();
  }

  function debounced(...args) {
    lastArgs = args;
    lastThis = this;

    const shouldInvokeLeading = leading && timeoutId === undefined;

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(onTimerExpired, delay);

    if (shouldInvokeLeading) {
      return invoke();
    }

    return result;
  }

  debounced.cancel = function cancel() {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    timeoutId = undefined;
    clearPendingArgs();
  };

  debounced.flush = function flush() {
    if (timeoutId === undefined) {
      return result;
    }

    clearTimeout(timeoutId);
    timeoutId = undefined;

    if (trailing && lastArgs) {
      return invoke();
    }

    clearPendingArgs();
    return result;
  };

  debounced.pending = function pending() {
    return timeoutId !== undefined;
  };

  return debounced;
}

/**
 * Ensure a function runs at most once per wait period.
 *
 * @param {Function} fn Function to throttle
 * @param {number} [wait=0] Delay in milliseconds
 * @param {Object} [options] Options
 * @param {boolean} [options.leading=true] Invoke immediately on the first call
 * @param {boolean} [options.trailing=true] Invoke once more with latest args
 * @returns {Function & {cancel: Function, flush: Function, pending: Function}}
 */
export function throttle(fn, wait = 0, options = {}) {
  assertFunction(fn, 'throttle');

  const delay = normalizeWait(wait);
  const leading = options.leading !== false;
  const trailing = options.trailing !== false;

  let timeoutId;
  let lastArgs;
  let lastThis;
  let lastInvokeTime = 0;
  let result;

  function clearPendingArgs() {
    lastArgs = undefined;
    lastThis = undefined;
  }

  function invoke(time) {
    lastInvokeTime = time;
    const args = lastArgs;
    const thisArg = lastThis;
    clearPendingArgs();
    result = fn.apply(thisArg, args);
    return result;
  }

  function remainingWait(time) {
    const sinceLastInvoke = time - lastInvokeTime;
    return delay - sinceLastInvoke;
  }

  function onTimerExpired() {
    timeoutId = undefined;

    if (trailing && lastArgs) {
      invoke(Date.now());
      return;
    }

    clearPendingArgs();
  }

  function throttled(...args) {
    if (!leading && !trailing) {
      return result;
    }

    const now = Date.now();

    if (lastInvokeTime === 0 && !leading) {
      lastInvokeTime = now;
    }

    lastArgs = args;
    lastThis = this;

    const waitRemaining = remainingWait(now);

    if (waitRemaining <= 0 || waitRemaining > delay) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      return invoke(now);
    }

    if (timeoutId === undefined && trailing) {
      timeoutId = setTimeout(onTimerExpired, waitRemaining);
    }

    return result;
  }

  throttled.cancel = function cancel() {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    timeoutId = undefined;
    lastInvokeTime = 0;
    clearPendingArgs();
  };

  throttled.flush = function flush() {
    if (timeoutId === undefined) {
      return result;
    }

    clearTimeout(timeoutId);
    onTimerExpired();
    return result;
  };

  throttled.pending = function pending() {
    return timeoutId !== undefined;
  };

  return throttled;
}
