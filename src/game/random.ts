/**
 * 재현 가능한 난수. 같은 seed면 같은 순서다 — 테스트와 "같은 레이스 다시 보기"를 위해.
 * modes.ts·coursePath.ts 등에 같은 알고리즘(FNV-1a + mulberry32)이 각자 들어 있다. 재미 요소 모듈은 이 하나를 같이 쓴다.
 */
export function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function seededRandom(seed: string): () => number {
  let state = hashString(seed) || 1
  return () => {
    state += 0x6d2b79f5
    let n = state
    n = Math.imul(n ^ (n >>> 15), n | 1)
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

/** [min, max) 범위의 난수 */
export function range(random: () => number, min: number, max: number): number {
  return min + random() * (max - min)
}
