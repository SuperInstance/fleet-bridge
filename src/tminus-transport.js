'use strict';

const WebSocket = require('ws');

/**
 * T-minus Transport — WebSocket client for the t-minus cue dispatcher.
 * Connects to a WS endpoint, sends/receives JSON-RPC formatted cues.
 * Handles reconnection with exponential backoff and message queuing.
 */
class TminusTransport {
  /**
   * @param {string} url - WebSocket URL of the t-minus dispatcher
   * @param {object} [opts]
   * @param {number} [opts.reconnectDelayMs=1000] - Initial reconnect delay
   * @param {number} [opts.maxReconnectDelayMs=30000] - Maximum reconnect delay
   * @param {number} [opts.pingIntervalMs=30000] - Heartbeat ping interval
   * @param {number} [opts.pongTimeoutMs=10000] - Time to wait for pong before considering dead
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.opts = opts;
    this.reconnectDelayMs = opts.reconnectDelayMs || 1000;
    this.maxReconnectDelayMs = opts.maxReconnectDelayMs || 30000;
    this.pingIntervalMs = opts.pingIntervalMs || 30000;
    this.pongTimeoutMs = opts.pongTimeoutMs || 10000;

    /** @type {WebSocket|null} */
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.shouldReconnect = true;
    this.currentReconnectDelay = this.reconnectDelayMs;
    this.messageQueue = [];

    this._cueHandlers = [];
    this._statusHandlers = [];
    this._connectHandlers = [];
    this._disconnectHandlers = [];

    this._pingTimer = null;
    this._pongTimeout = null;
    this._pongPending = false;
  }

  /**
   * Open the WebSocket connection.
   * @returns {Promise<void>}
   */
  connect() {
    if (this.connected || this.connecting) return Promise.resolve();
    this.connecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
          this.connected = true;
          this.connecting = false;
          this.currentReconnectDelay = this.reconnectDelayMs;
          this._startPing();
          this._flushQueue();
          console.log(`[FleetBridge:Tminus] ✅ Connected to ${this.url}`);
          this._emit('connect');
          for (const h of this._connectHandlers) h();
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            this._handleMessage(msg);
          } catch (err) {
            console.warn(`[FleetBridge:Tminus] Failed to parse message: ${err.message}`);
          }
        });

        this.ws.on('close', (code, reason) => {
          this.connected = false;
          this.connecting = false;
          this._stopPing();
          console.log(`[FleetBridge:Tminus] Disconnected (${code}: ${reason || 'no reason'})`);
          this._emit('disconnect');
          for (const h of this._disconnectHandlers) h();
          this._scheduleReconnect();
        });

        this.ws.on('error', (err) => {
          console.error(`[FleetBridge:Tminus] WebSocket error: ${err.message}`);
          this.connecting = false;
          // close event will fire next and trigger reconnect
        });

        // Fail-safe: if connect doesn't happen within 10s, reject
        setTimeout(() => {
          if (!this.connected) {
            this.connecting = false;
            reject(new Error(`Connection timeout to ${this.url}`));
          } else {
            resolve();
          }
        }, 10000);

      } catch (err) {
        this.connecting = false;
        reject(err);
      }
    });
  }

  /**
   * Send a t-minus cue (JSON-RPC style).
   * @param {string} from - Sender agent ID
   * @param {string} to - Recipient agent ID
   * @param {string} type - Cue type (e.g. 'TASK', 'STATUS', 'CUE')
   * @param {object} payload - Message payload
   * @returns {boolean} true if queued/sent
   */
  sendCue(from, to, type, payload = {}) {
    const cue = {
      jsonrpc: '2.0',
      method: 'tminus.cue',
      params: {
        from,
        to,
        type,
        payload,
        timestamp: new Date().toISOString()
      }
    };

    const serialized = JSON.stringify(cue);

    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serialized);
      console.log(`[FleetBridge:Tminus] Cue sent: ${type} ${from} → ${to}`);
      return true;
    }

    // Queue for when connection is back
    this.messageQueue.push(cue);
    console.log(`[FleetBridge:Tminus] Cue queued (offline): ${type} ${from} → ${to}`);
    return false;
  }

  /**
   * Register a handler for incoming cues.
   * @param {function} handler - Called with ({ from, to, type, payload, timestamp })
   */
  onCue(handler) {
    if (typeof handler === 'function') this._cueHandlers.push(handler);
  }

  /**
   * Register a handler for status/event messages.
   * @param {function} handler - Called with (statusData)
   */
  onStatus(handler) {
    if (typeof handler === 'function') this._statusHandlers.push(handler);
  }

  /**
   * Register a handler for connection established.
   * @param {function} handler
   */
  onConnect(handler) {
    if (typeof handler === 'function') this._connectHandlers.push(handler);
  }

  /**
   * Register a handler for disconnection.
   * @param {function} handler
   */
  onDisconnect(handler) {
    if (typeof handler === 'function') this._disconnectHandlers.push(handler);
  }

  /**
   * Check if the WebSocket is currently connected.
   * @returns {boolean}
   */
  isConnected() {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Gracefully disconnect and stop reconnection.
   */
  disconnect() {
    this.shouldReconnect = false;
    this._stopPing();
    if (this.ws) {
      try {
        this.ws.close(1000, 'Client disconnect');
      } catch (_) { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
    this.connecting = false;
    console.log('[FleetBridge:Tminus] Disconnected (clean)');
  }

  // ---- Internal ----

  _handleMessage(msg) {
    // Handle JSON-RPC responses
    if (msg.jsonrpc === '2.0') {
      if (msg.method === 'tminus.cue' || msg.method === 'event') {
        const params = msg.params || {};
        const data = {
          from: params.from || params.agent_id,
          to: params.to,
          type: params.type,
          payload: params.payload || params.data,
          timestamp: params.timestamp,
          raw: msg
        };

        // Route to cue or status handlers
        if (params.channel && params.channel.startsWith('agent/')) {
          for (const h of this._statusHandlers) h(data);
        } else {
          for (const h of this._cueHandlers) h(data);
        }
      }

      // Handle pong responses
      if (msg.method === 'pong' || (msg.params && msg.params.pong)) {
        this._pongPending = false;
      }
    }
  }

  _emit(event) {
    // placeholder for future event system
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    const delay = this.currentReconnectDelay;
    console.log(`[FleetBridge:Tminus] Reconnecting in ${delay}ms...`);
    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connecting = true;
        this.connect().catch(err => {
          console.error(`[FleetBridge:Tminus] Reconnect failed: ${err.message}`);
          this.currentReconnectDelay = Math.min(
            this.currentReconnectDelay * 2,
            this.maxReconnectDelayMs
          );
        });
      }
    }, delay);
  }

  _flushQueue() {
    if (this.messageQueue.length === 0) return;
    const toSend = this.messageQueue.splice(0);
    for (const cue of toSend) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(cue));
        console.log(`[FleetBridge:Tminus] Queued cue sent: ${cue.params.type} → ${cue.params.to}`);
      }
    }
  }

  _startPing() {
    this._stopPing();
    if (this.pingIntervalMs <= 0) return;
    this._pingTimer = setInterval(() => {
      if (this.isConnected()) {
        this._pongPending = true;
        try {
          this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: { timestamp: Date.now() } }));
        } catch (_) { /* ignore */ }

        // Expect pong within pongTimeoutMs
        if (this._pongTimeout) clearTimeout(this._pongTimeout);
        this._pongTimeout = setTimeout(() => {
          if (this._pongPending) {
            console.warn('[FleetBridge:Tminus] Heartbeat timeout — terminating connection');
            try { this.ws.terminate(); } catch (_) { /* ignore */ }
          }
        }, this.pongTimeoutMs);
      }
    }, this.pingIntervalMs);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._pongTimeout) {
      clearTimeout(this._pongTimeout);
      this._pongTimeout = null;
    }
    this._pongPending = false;
  }
}

module.exports = { TminusTransport };
