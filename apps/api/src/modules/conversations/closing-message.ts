// The inbox's closing message (pilot, item 08): what the contact reads
// when an agent resolves the conversation. Written once per inbox, so it
// takes variables: `{{contact.name}}`, or `{{contact.name|cliente}}` with a
// fallback for a contact the desk never got a name for.

export type ClosingVariables = Record<string, string | null>

type ClosingSource = {
  displayId: number
  contact: {
    name: string | null
    email: string | null
    phoneNumber: string | null
    customAttributes: unknown
  } | null
  inbox: { name: string }
}

/** Everything a closing message may mention about this conversation. */
export function closingVariables(conv: ClosingSource, agentName: string | null): ClosingVariables {
  const c = conv.contact
  const name = c?.name?.trim() || null
  const firstName = name ? name.split(/\s+/)[0]! : null
  const vars: ClosingVariables = {}
  // A contact's custom attributes (plan, CPF, protocol...) as contact.<key>.
  // Set first so the built-in fields below always win over a lookalike key.
  const custom = c?.customAttributes
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    for (const [k, v] of Object.entries(custom)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') vars[`contact.${k}`] = String(v)
    }
  }
  Object.assign(vars, {
    'contact.name': name,
    'contact.first_name': firstName,
    'contact.email': c?.email ?? null,
    'contact.phone': c?.phoneNumber ?? null,
    // The flow builder's spellings, so one habit works everywhere.
    name,
    first_name: firstName,
    email: c?.email ?? null,
    phone: c?.phoneNumber ?? null,
    'agent.name': agentName,
    'inbox.name': conv.inbox.name,
    'conversation.id': String(conv.displayId),
  })
  return vars
}

/**
 * Fill `{{var}}` and `{{var|fallback}}`. An unknown or empty variable with no
 * fallback becomes nothing, never the raw braces: the contact must not read
 * template syntax.
 */
export function renderClosingMessage(template: string, vars: ClosingVariables): string {
  return template
    .replace(/\{\{\s*([^}|]+?)\s*(?:\|([^}]*))?\}\}/g, (_m, key: string, fallback?: string) => {
      const v = vars[key]
      return v ? v : (fallback ?? '').trim()
    })
    .trim()
}
