import { StringDecoder } from 'string_decoder'

/**
 * Iterates JSONL records using only ASCII LF (U+000A) as the delimiter.
 *
 * Node's readline also treats U+2028 and U+2029 as line endings. Both
 * characters are valid inside a JSON string, so readline can split a valid
 * JSONL record in the middle of message_content.
 */
export async function* iterateJsonlLines(
  input: AsyncIterable<string | Buffer>
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let hasBufferedBytes = false
  let remainder = ''

  for await (const chunk of input) {
    let text: string
    if (typeof chunk === 'string') {
      if (hasBufferedBytes) {
        remainder += decoder.end()
        hasBufferedBytes = false
      }
      text = chunk
    } else {
      text = decoder.write(chunk)
      hasBufferedBytes = true
    }

    remainder += text
    let newlineIndex = remainder.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = remainder.slice(0, newlineIndex)
      remainder = remainder.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      yield line
      newlineIndex = remainder.indexOf('\n')
    }
  }

  if (hasBufferedBytes) remainder += decoder.end()
  if (remainder) {
    if (remainder.endsWith('\r')) remainder = remainder.slice(0, -1)
    yield remainder
  }
}
