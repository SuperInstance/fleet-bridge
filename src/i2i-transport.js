'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOTTLE_TYPES = [
  'TASK', 'STATUS', 'CHECKPOINT', 'BLOCKER', 'DELIVERABLE',
  'BOTTLE', 'ACK', 'SYNTHESIS', 'CHALLENGE', 'SESSION', 'SPLINE', 'REFLECT', 'PROMOTE'
];

/**
 * I2I Bottle Transport — file-based message passing via shared vessel directories.
 * Agents drop "bottles" into bottles/ for outgoing, harvest from harbor/ for incoming.
 */
class I2IBottleTransport {
  /**
   * @param {object} opts
   * @param {string} opts.vesselDir - Path to the shared vessel directory (default: i2i-vessel)
   * @param {string} opts.agentId - This agent's identifier
   * @param {boolean} opts.keepProcessed - Keep processed bottles instead of deleting (default: false)
   */
  constructor(opts = {}) {
    this.vesselDir = opts.vesselDir || path.join(process.env.HOME || '/tmp', '.openclaw', 'workspace', 'i2i-vessel');
    this.agentId = opts.agentId || 'unknown';
    this.keepProcessed = opts.keepProcessed || false;
    this.bottlesDir = path.join(this.vesselDir, 'bottles');
    this.harborDir = path.join(this.vesselDir, 'harbor');
    this._bottleCounter = 0;
  }

  /**
   * Ensure bottles/ and harbor/ directories exist.
   */
  init() {
    for (const dir of [this.bottlesDir, this.harborDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        throw new Error(`I2ITransport: cannot create directory ${dir}: ${err.message}`);
      }
    }
    console.log(`[FleetBridge:I2I] Initialized vessel at ${this.vesselDir}`);
    return this;
  }

  /**
   * Compute SHA-256 integrity hash of a JSON-serializable object.
   * @param {object} content
   * @returns {string} hex digest
   */
  hashBottle(content) {
    const serialized = JSON.stringify(content, Object.keys(content).sort());
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
  }

  /**
   * Write a bottle (outgoing) to bottles/ directory.
   * @param {string} to - Target agent ID
   * @param {string} type - Bottle type (one of BOTTLE_TYPES)
   * @param {object} shard - { artifacts, reasoning, blockers }
   * @param {object} [extra] - Extra fields to merge (e.g. { spline })
   * @returns {object} the bottle that was written
   */
  sendBottle(to, type, shard = {}, extra = {}) {
    if (!BOTTLE_TYPES.includes(type)) {
      throw new Error(`I2ITransport: invalid bottle type "${type}". Valid: ${BOTTLE_TYPES.join(', ')}`);
    }

    this._bottleCounter++;
    const now = new Date().toISOString();
    const id = `${this.agentId}-${Date.now()}-${this._bottleCounter}`;

    const bottle = {
      id,
      type,
      from: this.agentId,
      to,
      timestamp: now,
      shard: {
        artifacts: shard.artifacts || {},
        reasoning: shard.reasoning || [],
        blockers: shard.blockers || []
      },
      _meta: {
        generated: now,
        protocol: 'I2I-v2'
      },
      ...extra
    };

    // Compute integrity hash LAST, after all fields are set.
    // Hash excludes the integrity field itself but includes everything else.
    const { integrity: _skip, ...bodyForHash } = bottle;
    bottle.integrity = this.hashBottle(bodyForHash);

    // Write to bottles/
    const filename = `${Date.now()}-${type.toLowerCase()}-${to}-${this._bottleCounter}.json`;
    const outPath = path.join(this.bottlesDir, filename);

    try {
      fs.writeFileSync(outPath, JSON.stringify(bottle, null, 2), 'utf8');
      console.log(`[FleetBridge:I2I] Bottle dropped: ${filename} (${type} → ${to})`);
    } catch (err) {
      throw new Error(`I2ITransport: failed to write bottle ${filename}: ${err.message}`);
    }

    return bottle;
  }

  /**
   * Convenience: shorthand for sendBottle.
   */
  dropBottle(type, to, shard) {
    return this.sendBottle(to, type, shard);
  }

  /**
   * Scans harbor/ for incoming bottles. Reads and returns them.
   * By default, deletes processed bottles unless keepProcessed is true.
   * @returns {Array<object>} array of bottle objects
   */
  beachcomb() {
    const bottles = [];
    let files;

    try {
      files = fs.readdirSync(this.harborDir);
    } catch (err) {
      console.warn(`[FleetBridge:I2I] Cannot read harbor/: ${err.message}`);
      return bottles;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(this.harborDir, file);

      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const bottle = JSON.parse(raw);
        bottles.push(bottle);

        // Verify integrity
        const { integrity, ...bodyForHash } = bottle;
        if (integrity) {
          const expected = this.hashBottle(bodyForHash);
          if (expected !== integrity) {
            console.warn(`[FleetBridge:I2I] ⚠ INTEGRITY MISMATCH for ${file}: expected ${expected}, got ${integrity}`);
            bottle._integrityFail = true;
          } else {
            bottle._integrityOk = true;
          }
        }

        // Remove or archive
        if (!this.keepProcessed) {
          fs.unlinkSync(filePath);
          console.log(`[FleetBridge:I2I] Beachcombed & removed: ${file}`);
        } else {
          // Rename to .processed
          const procPath = filePath.replace(/\.json$/, '.processed.json');
          fs.renameSync(filePath, procPath);
          console.log(`[FleetBridge:I2I] Beachcombed & archived: ${file}`);
        }
      } catch (err) {
        console.error(`[FleetBridge:I2I] Error reading bottle ${file}: ${err.message}`);
      }
    }

    return bottles;
  }

  /**
   * List all bottles in both directions.
   * @returns {{ outgoing: string[], incoming: string[] }}
   */
  listBottles() {
    const result = { outgoing: [], incoming: [] };

    try {
      result.outgoing = fs.readdirSync(this.bottlesDir).filter(f => f.endsWith('.json'));
    } catch (_) { /* ignore */ }

    try {
      const harborFiles = fs.readdirSync(this.harborDir);
      result.incoming = harborFiles.filter(f => f.endsWith('.json'));
      result.processed = harborFiles.filter(f => f.endsWith('.processed.json'));
    } catch (_) { /* ignore */ }

    return result;
  }

  /**
   * Watch harbor/ for new files, calling callback for each.
   * @param {function} callback - called with (bottle) for each new bottle
   * @param {number} intervalMs - poll interval (default 5000)
   * @returns {object} { stop: function }
   */
  watch(callback, intervalMs = 5000) {
    const seen = new Set();

    // Seed already-seen files
    try {
      for (const f of fs.readdirSync(this.harborDir)) {
        seen.add(f);
      }
    } catch (_) { /* ignore */ }

    const timer = setInterval(() => {
      let files;
      try {
        files = fs.readdirSync(this.harborDir);
      } catch (_) { return; }

      for (const file of files) {
        if (!file.endsWith('.json') || seen.has(file)) continue;
        seen.add(file);

        try {
          const raw = fs.readFileSync(path.join(this.harborDir, file), 'utf8');
          const bottle = JSON.parse(raw);
          callback(bottle);
        } catch (err) {
          console.error(`[FleetBridge:I2I] Watch error: ${file}: ${err.message}`);
        }
      }
    }, intervalMs);

    console.log(`[FleetBridge:I2I] Watching harbor/ every ${intervalMs}ms`);
    return { stop: () => { clearInterval(timer); console.log('[FleetBridge:I2I] Watch stopped'); } };
  }
}

module.exports = { I2IBottleTransport, BOTTLE_TYPES };
