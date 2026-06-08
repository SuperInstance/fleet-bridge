'use strict';

/**
 * Health Monitor — Tracks which fleet nodes are alive via heartbeat pulses.
 * Detects deaths (missed heartbeats) and revivals, emitting callbacks.
 */
class HealthMonitor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.checkInterval=15000] - How often to check for dead nodes (ms)
   * @param {number} [opts.heartbeatThreshold=60000] - Max ms since last heartbeat before considered dead
   */
  constructor(opts = {}) {
    this.checkInterval = opts.checkInterval || 15000;
    this.heartbeatThreshold = opts.heartbeatThreshold || 60000;

    /** @type {Map<string, { transport: string, lastHeartbeat: number, alive: boolean, meta: object }>} */
    this._nodes = new Map();
    this._deathHandlers = [];
    this._reviveHandlers = [];
    this._checkTimer = null;
    this._running = false;
  }

  /**
   * Register a node to monitor.
   * @param {string} nodeId
   * @param {string} transport - The transport type ('i2i' or 'tminus')
   * @param {object} [meta={}] - Optional metadata
   */
  register(nodeId, transport, meta = {}) {
    this._nodes.set(nodeId.toLowerCase(), {
      transport,
      lastHeartbeat: Date.now(),
      alive: true,
      meta
    });
    console.log(`[FleetBridge:Health] Registered node: ${nodeId} (${transport})`);
  }

  /**
   * Record a heartbeat from a node.
   * @param {string} nodeId
   */
  heartbeat(nodeId) {
    const key = nodeId.toLowerCase();
    const node = this._nodes.get(key);
    if (!node) {
      // Auto-register unknown nodes that heartbeat
      this.register(nodeId, 'unknown');
      return;
    }

    const wasDead = !node.alive;
    node.lastHeartbeat = Date.now();
    node.alive = true;

    if (wasDead) {
      console.log(`[FleetBridge:Health] ❤️‍🩹 Node revived: ${nodeId}`);
      for (const handler of this._reviveHandlers) {
        try { handler(nodeId, node); } catch (err) {
          console.error(`[FleetBridge:Health] Revive handler error: ${err.message}`);
        }
      }
    }
  }

  /**
   * Check if a node is currently considered alive.
   * @param {string} nodeId
   * @returns {boolean}
   */
  isAlive(nodeId) {
    const node = this._nodes.get(nodeId.toLowerCase());
    if (!node) return false;
    const elapsed = Date.now() - node.lastHeartbeat;
    return elapsed < this.heartbeatThreshold;
  }

  /**
   * Shortcut: deregister (remove) a node
   * @param {string} nodeId
   */
  deregister(nodeId) {
    const key = nodeId.toLowerCase();
    if (this._nodes.has(key)) {
      this._nodes.delete(key);
      console.log(`[FleetBridge:Health] Deregistered node: ${nodeId}`);
    }
  }

  /**
   * Start periodic health checks.
   */
  start() {
    if (this._running) return;
    this._running = true;

    // Immediate check
    this._runCheck();

    this._checkTimer = setInterval(() => {
      this._runCheck();
    }, this.checkInterval);

    console.log(`[FleetBridge:Health] Monitor started (check every ${this.checkInterval}ms, threshold ${this.heartbeatThreshold}ms)`);
  }

  /**
   * Stop periodic health checks.
   */
  stop() {
    this._running = false;
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
    console.log('[FleetBridge:Health] Monitor stopped');
  }

  /**
   * Register a callback for when a node is considered dead.
   * @param {function} handler - Called with (nodeId, nodeEntry)
   */
  onDeath(handler) {
    if (typeof handler === 'function') this._deathHandlers.push(handler);
  }

  /**
   * Register a callback for when a previously dead node revives.
   * @param {function} handler - Called with (nodeId, nodeEntry)
   */
  onRevive(handler) {
    if (typeof handler === 'function') this._reviveHandlers.push(handler);
  }

  /**
   * Get a snapshot of all node health.
   * @returns {object} nodeId -> { alive, lastHeartbeat, transport, meta }
   */
  status() {
    const snapshot = {};
    for (const [nodeId, node] of this._nodes) {
      snapshot[nodeId] = {
        alive: (Date.now() - node.lastHeartbeat) < this.heartbeatThreshold,
        lastHeartbeat: new Date(node.lastHeartbeat).toISOString(),
        transport: node.transport,
        meta: node.meta
      };
    }
    return snapshot;
  }

  /**
   * Get list of currently alive nodes.
   * @returns {string[]}
   */
  aliveNodes() {
    const alive = [];
    for (const [nodeId, node] of this._nodes) {
      if ((Date.now() - node.lastHeartbeat) < this.heartbeatThreshold) {
        alive.push(nodeId);
      }
    }
    return alive;
  }

  /**
   * Get list of dead nodes.
   * @returns {string[]}
   */
  deadNodes() {
    const dead = [];
    for (const [nodeId, node] of this._nodes) {
      if ((Date.now() - node.lastHeartbeat) >= this.heartbeatThreshold) {
        dead.push(nodeId);
      }
    }
    return dead;
  }

  /** Run a single health check pass */
  _runCheck() {
    const now = Date.now();
    for (const [nodeId, node] of this._nodes) {
      const elapsed = now - node.lastHeartbeat;
      if (elapsed >= this.heartbeatThreshold && node.alive) {
        node.alive = false;
        console.log(`[FleetBridge:Health] 💀 Node died: ${nodeId} (no heartbeat for ${elapsed}ms)`);
        for (const handler of this._deathHandlers) {
          try { handler(nodeId, node); } catch (err) {
            console.error(`[FleetBridge:Health] Death handler error: ${err.message}`);
          }
        }
      }
    }
  }
}

module.exports = { HealthMonitor };
