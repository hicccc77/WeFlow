/**
 * 并发控制：限制同时执行的 Promise 数量
 */
export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0
  let hasError = false
  let globalError: any = null

  const worker = async () => {
    while (currentIndex < items.length && !hasError) {
      const index = currentIndex++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        hasError = true
        globalError = err
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)

  if (hasError) throw globalError
  return results
}
