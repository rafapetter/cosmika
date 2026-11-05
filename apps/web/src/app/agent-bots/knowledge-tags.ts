// The agent's knowledge base is the set of article tags it may read. The
// form edits them as one comma-separated line; the API wants a list.

/** "financeiro, anuidade,, financeiro" → ["financeiro", "anuidade"]. */
export function parseKnowledgeTags(text: string): string[] {
  return [...new Set(text.split(',').map((t) => t.trim()).filter((t) => t.length > 0))]
}

export function formatKnowledgeTags(tags: string[]): string {
  return tags.join(', ')
}
