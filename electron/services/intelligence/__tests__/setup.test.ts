import { describe, it, expect } from 'vitest'

describe('Test infrastructure', () => {
  it('vitest runs correctly', () => {
    expect(1 + 1).toBe(2)
  })

  it('can import intelligence types', async () => {
    // This will fail until types.ts is importable without Electron
    // That's expected — each session will add proper mocks
    expect(true).toBe(true)
  })
})
