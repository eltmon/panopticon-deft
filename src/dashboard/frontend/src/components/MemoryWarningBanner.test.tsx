import { describe, it, expect } from 'vitest'
import {
  formatGBDecimal,
  shouldShowWarning,
  shouldRedisplay,
  isCriticalMemory,
} from './MemoryWarningBanner'

const GB = 1024 ** 3

describe('formatGBDecimal', () => {
  it('formats bytes to GB with 1 decimal place', () => {
    expect(formatGBDecimal(4 * GB)).toBe('4.0')
    expect(formatGBDecimal(1.5 * GB)).toBe('1.5')
    expect(formatGBDecimal(0)).toBe('0.0')
  })
})

describe('shouldShowWarning', () => {
  it('returns true when free memory is below the threshold', () => {
    expect(shouldShowWarning(3 * GB, 4 * GB)).toBe(true)
  })

  it('returns false when free memory equals the threshold', () => {
    expect(shouldShowWarning(4 * GB, 4 * GB)).toBe(false)
  })

  it('returns false when free memory is above the threshold', () => {
    expect(shouldShowWarning(8 * GB, 4 * GB)).toBe(false)
  })

  it('returns true at exactly 1 byte below threshold', () => {
    const threshold = 4 * GB
    expect(shouldShowWarning(threshold - 1, threshold)).toBe(true)
  })
})

describe('shouldRedisplay', () => {
  const DROP = 512 * 1024 * 1024 // 512 MB

  it('returns true when memory drops more than DROP below dismissedAt', () => {
    const dismissedAt = 3 * GB
    const currentFree = dismissedAt - DROP - 1
    expect(shouldRedisplay(currentFree, dismissedAt, DROP)).toBe(true)
  })

  it('returns false when memory drops exactly DROP below dismissedAt', () => {
    const dismissedAt = 3 * GB
    const currentFree = dismissedAt - DROP
    expect(shouldRedisplay(currentFree, dismissedAt, DROP)).toBe(false)
  })

  it('returns false when memory has not dropped significantly', () => {
    const dismissedAt = 3 * GB
    const currentFree = 2.8 * GB // dropped less than 512 MB
    expect(shouldRedisplay(currentFree, dismissedAt, DROP)).toBe(false)
  })

  it('returns false when memory is higher than at dismiss time', () => {
    const dismissedAt = 2 * GB
    const currentFree = 3 * GB
    expect(shouldRedisplay(currentFree, dismissedAt, DROP)).toBe(false)
  })
})

describe('isCriticalMemory', () => {
  it('returns true when free memory is below block threshold', () => {
    expect(isCriticalMemory(1.5 * GB, 2 * GB)).toBe(true)
  })

  it('returns false when free memory equals block threshold', () => {
    expect(isCriticalMemory(2 * GB, 2 * GB)).toBe(false)
  })

  it('returns false when free memory is above block threshold', () => {
    expect(isCriticalMemory(3 * GB, 2 * GB)).toBe(false)
  })
})
