/**
 * LRU (Least Recently Used) Cache implementation for memory management
 */
export class LRUCache<K, V> {
  private cache: Map<K, V>
  private maxSize: number

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize
    this.cache = new Map()
  }

  /**
   * Get value from cache
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  /**
   * Set value in cache
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // Update existing
      this.cache.delete(key)
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, value)
  }

  /**
   * Check if key exists
   */
  has(key: K): boolean {
    return this.cache.has(key)
  }

  /**
   * Delete key from cache
   */
  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Get all keys (for debugging)
   */
  keys(): IterableIterator<K> {
    return this.cache.keys()
  }

  /**
   * Get all values (for debugging)
   */
  values(): IterableIterator<V> {
    return this.cache.values()
  }

  /**
   * Get all entries (for iteration support)
   */
  entries(): IterableIterator<[K, V]> {
    return this.cache.entries()
  }

  /**
   * Make LRUCache iterable (for...of support)
   */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.cache.entries()
  }

  /**
   * Force cleanup (optional method for explicit memory management)
   */
  cleanup(): void {
    // In JavaScript/TypeScript, this is mainly for consistency
    // The garbage collector will handle actual memory cleanup
    if (this.cache.size > this.maxSize * 1.5) {
      // Emergency cleanup if cache somehow exceeds limit
      const entries = Array.from(this.cache.entries())
      this.cache.clear()
      // Keep only the most recent half
      const keepEntries = entries.slice(-Math.floor(this.maxSize / 2))
      keepEntries.forEach(([key, value]) => this.cache.set(key, value))
    }
  }
}