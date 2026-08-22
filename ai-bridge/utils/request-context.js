/**
 * Shared per-request async context for the AI bridge daemon.
 * Allows concurrent turns to tag output and register aborts by request id.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** @type {AsyncLocalStorage<{ id: string, doneSent?: boolean }>} */
export const requestContext = new AsyncLocalStorage();

/** @returns {string|null} */
export function getRequestId() {
  return requestContext.getStore()?.id ?? null;
}
