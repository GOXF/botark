/**
 * GOXF: a quote reply goes out as "> quoted\n\nreply" (so every platform sees the context),
 * while the bubble shows the quote as a chip. Split it back so the bubble does not show it twice
 * and so the server copy matches the local message it echoes.
 */
export function splitLeadingQuote(text: string): { quote?: string; body: string } {
  if (!text.startsWith('>')) return { body: text }
  const lines = text.split('\n')
  let i = 0
  const quoted: string[] = []
  while (i < lines.length && lines[i].startsWith('>')) {
    quoted.push(lines[i].replace(/^>\s?/, ''))
    i++
  }
  while (i < lines.length && lines[i].trim() === '') i++
  const body = lines.slice(i).join('\n').trim()
  if (!body) return { body: text }
  return { quote: quoted.join('\n').trim(), body }
}

/** Text used to match a server copy against the message just sent. */
export function comparableText(text: string): string {
  return splitLeadingQuote(text.trim()).body.trim()
}
