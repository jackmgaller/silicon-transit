// Fully associative LRU cache of 64-byte lines. A line stays as long as
// fewer than `lines` other lines have been used since its own last use, so
// every miss is either a first use or a line pushed out for room: the lesson
// is about locality and capacity, not about unlucky address alignment.

export class Cache {
  constructor(bytes) {
    const n = Math.max(1, Math.floor(bytes / 64));
    this.lines = n;
    // Slots in a doubly linked list from most (head) to least (tail)
    // recently used, plus an index from line to slot.
    this.tag = new Int32Array(n);
    this.prev = new Int32Array(n);
    this.next = new Int32Array(n);
    this.index = new Map();
    this.head = -1;
    this.tail = -1;
    this.used = 0;
  }

  get size() {
    return this.used;
  }

  has(line) {
    return this.index.has(line);
  }

  unlink(s) {
    const p = this.prev[s];
    const q = this.next[s];
    if (p >= 0) this.next[p] = q;
    else this.head = q;
    if (q >= 0) this.prev[q] = p;
    else this.tail = p;
  }

  pushFront(s) {
    this.prev[s] = -1;
    this.next[s] = this.head;
    if (this.head >= 0) this.prev[this.head] = s;
    this.head = s;
    if (this.tail < 0) this.tail = s;
  }

  // Hit: refresh recency and return true. Miss: return false, no change.
  touch(line) {
    const s = this.index.get(line);
    if (s === undefined) return false;
    if (s !== this.head) {
      this.unlink(s);
      this.pushFront(s);
    }
    return true;
  }

  // Bring a line in as the most recently used. Returns the line it pushed
  // out, or -1.
  insert(line) {
    if (this.touch(line)) return -1;
    let s;
    let out = -1;
    if (this.used < this.lines) s = this.used++;
    else {
      s = this.tail;
      out = this.tag[s];
      this.index.delete(out);
      this.unlink(s);
    }
    this.tag[s] = line;
    this.index.set(line, s);
    this.pushFront(s);
    return out;
  }

  access(line) {
    if (this.touch(line)) return true;
    this.insert(line);
    return false;
  }
}
