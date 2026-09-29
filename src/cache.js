// Set-associative LRU cache of 64-byte lines. Set indices are hashed so the
// lesson is about capacity, not about unlucky address alignment.

export class Cache {
  constructor(bytes, ways) {
    const lines = Math.max(1, Math.floor(bytes / 64));
    this.ways = Math.max(1, Math.min(ways, lines));
    this.sets = Math.max(1, Math.floor(lines / this.ways));
    this.tags = new Int32Array(this.sets * this.ways).fill(-1);
    this.stamp = new Float64Array(this.sets * this.ways);
    this.clock = 1;
  }

  base(line) {
    const h = Math.imul(line ^ (line >>> 11) ^ (line >>> 19), 0x9e3779b1) >>> 0;
    return (h % this.sets) * this.ways;
  }

  has(line) {
    const b = this.base(line);
    for (let w = 0; w < this.ways; w++) if (this.tags[b + w] === line) return true;
    return false;
  }

  // Hit: refresh recency and return true. Miss: return false, no change.
  touch(line) {
    const b = this.base(line);
    for (let w = 0; w < this.ways; w++) {
      if (this.tags[b + w] === line) {
        this.stamp[b + w] = this.clock++;
        return true;
      }
    }
    return false;
  }

  insert(line) {
    const b = this.base(line);
    let victim = b;
    for (let w = 0; w < this.ways; w++) {
      const k = b + w;
      if (this.tags[k] === line) {
        this.stamp[k] = this.clock++;
        return;
      }
      if (this.tags[k] === -1) {
        victim = k;
        break;
      }
      if (this.stamp[k] < this.stamp[victim]) victim = k;
    }
    this.tags[victim] = line;
    this.stamp[victim] = this.clock++;
  }

  access(line) {
    if (this.touch(line)) return true;
    this.insert(line);
    return false;
  }
}
