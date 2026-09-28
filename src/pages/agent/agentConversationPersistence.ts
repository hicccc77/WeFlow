export function scheduleAgentConversationPersist(input: {
  currentTimer: number | null
  delayMs: number
  schedule: (callback: () => void, delayMs: number) => number
  onDue: () => void
}): number {
  if (input.currentTimer !== null) return input.currentTimer
  return input.schedule(input.onDue, input.delayMs)
}

export async function sendWithImmediateAgentConversationPersist<T>(input: {
  send: () => Promise<void>
  readMessages: () => readonly T[]
  persist: (messages: T[]) => Promise<unknown>
}): Promise<void> {
  const sendPromise = input.send()
  const initialMessages = [...input.readMessages()]
  const persistPromise = initialMessages.length > 0
    ? input.persist(initialMessages)
    : Promise.resolve()
  await Promise.all([persistPromise, sendPromise])
}
