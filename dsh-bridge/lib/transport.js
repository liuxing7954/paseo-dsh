/**
 * Newline-delimited JSON-RPC 2.0 over byte streams.
 *
 * This is deliberately modelled on the shipped `dsh-sdk-protocol` transport,
 * but it exists as a local copy for two reasons:
 *
 * 1. `@deepseek-ai/dsh-sdk-protocol` / `dsh-sdk-jsonrpc-server` are not
 *    published at the runtime version and are not resolvable from a profile,
 *    so importing them would drag an unresolvable dependency into the profile.
 * 2. The Paseo bridge needs the *server -> client request* direction, which the
 *    shipped SDK transport supports but never exercises.
 *
 * @module dsh-paseo-bridge/transport
 */
import { StringDecoder } from 'node:string_decoder';

/** A JSON-RPC error response, preserving the wire `code` and optional `data`. */
export class JsonRpcResponseError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'JsonRpcResponseError';
    this.code = code;
    this.data = data;
  }
}

export class PaseoTransport {
  #input;
  #output;
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #started = false;
  #closed = false;
  #requestHandler;
  #notificationHandler;
  #pending = new Map();
  #nextId = 1;

  constructor(input, output) {
    this.#input = input;
    this.#output = output;
  }

  /** Attach stream listeners and begin reading frames. Idempotent. */
  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#input.on('data', this.#onData);
    this.#input.on('error', this.#onError);
    this.#input.on('end', this.#onEnd);
  }

  /** Detach listeners and reject pending requests without destroying streams. */
  close() {
    if (!this.#started) return;
    this.#started = false;
    this.#input.off('data', this.#onData);
    this.#input.off('error', this.#onError);
    this.#input.off('end', this.#onEnd);
    this.#failPending(new Error('paseo bridge transport closed'));
  }

  /** Install the handler for client -> server requests, replacing any prior one. */
  onRequest(handler) {
    this.#requestHandler = handler;
  }

  /** Install the handler for client -> server notifications, replacing any prior one. */
  onNotification(handler) {
    this.#notificationHandler = handler;
  }

  /** Wait for prior frame write callbacks; the empty barrier emits no bytes. */
  flush() {
    return new Promise((resolve) => {
      this.#output.write('', () => resolve());
    });
  }

  /** Send a notification; omitted params produce no `params` member. */
  notify(method, params) {
    this.#write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /**
   * Send a server -> client request and await its response.
   * @param method - JSON-RPC method name.
   * @param params - request parameters.
   * @param signal - optional abandonment signal; aborting drops the pending entry.
   */
  request(method, params, signal) {
    if (this.#closed) return Promise.reject(new Error('paseo bridge transport closed'));
    if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error('aborted'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: undefined };
      if (signal !== undefined) {
        entry.onAbort = () => {
          if (this.#pending.delete(id)) reject(signal.reason ?? new Error('aborted'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#pending.set(id, entry);
      this.#write({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    });
  }

  #release(entry) {
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = undefined;
    }
  }

  #failPending(error) {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      this.#release(entry);
      entry.reject(error);
    }
  }

  #write(frame) {
    if (this.#closed) return;
    try {
      void this.#output.write(`${JSON.stringify(frame)}\n`);
    } catch {
      /* a dead stdout surface must not take the runtime down */
    }
  }

  #onData = (chunk) => {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        continue;
      }
      void this.#handleFrame(frame);
    }
  };

  #onError = (error) => {
    this.#failPending(error);
  };

  #onEnd = () => {
    this.#failPending(new Error('paseo bridge input ended'));
  };

  async #handleFrame(frame) {
    if (frame === null || typeof frame !== 'object') return;
    const hasMethod = typeof frame.method === 'string';
    const hasId = frame.id !== undefined && frame.id !== null;
    if (hasMethod && hasId) return this.#handleIncomingRequest(frame);
    if (hasMethod) return this.#handleIncomingNotification(frame);
    if (hasId) return this.#handleIncomingResponse(frame);
  }

  async #handleIncomingRequest(frame) {
    try {
      if (this.#requestHandler === undefined) {
        throw new Error(`no request handler for ${frame.method}`);
      }
      const result = await this.#requestHandler(frame.method, frame.params ?? {});
      this.#write({ jsonrpc: '2.0', id: frame.id, result: result === undefined ? null : result });
    } catch (error) {
      this.#write({
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  #handleIncomingNotification(frame) {
    try {
      this.#notificationHandler?.(frame.method, frame.params ?? {});
    } catch {
      /* notifications are fire-and-forget */
    }
  }

  #handleIncomingResponse(frame) {
    const entry = this.#pending.get(frame.id);
    if (entry === undefined) return;
    this.#pending.delete(frame.id);
    this.#release(entry);
    if (frame.error !== undefined) {
      entry.reject(
        new JsonRpcResponseError(frame.error?.code, frame.error?.message ?? 'request failed', frame.error?.data),
      );
    } else {
      entry.resolve(frame.result);
    }
  }
}
