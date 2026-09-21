'use strict';

/**
 * Bounded LRU cache backed by an insertion-order Map: delete+re-insert on
 * access = O(1) get/set/evict. Single implementation shared by
 * historyAggregator.cjs and transcripts.cjs.
 */
class LRUCache {
  constructor(max) {
    this._max = max;
    this._m = new Map();
  }
  get size() {
    return this._m.size;
  }
  has(k) {
    return this._m.has(k);
  }
  delete(k) {
    return this._m.delete(k);
  }
  clear() {
    this._m.clear();
  }
  get(k) {
    if (!this._m.has(k)) return undefined;
    const v = this._m.get(k);
    this._m.delete(k);
    this._m.set(k, v);
    return v;
  }
  set(k, v) {
    this._m.delete(k);
    this._m.set(k, v);
    if (this._m.size > this._max) this._m.delete(this._m.keys().next().value);
  }
}

module.exports = { LRUCache };
