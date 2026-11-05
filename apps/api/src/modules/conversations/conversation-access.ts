import type { Prisma, Role } from '@cosmika/db'

/** Roles that see every conversation on the account. */
export const PRIVILEGED_ROLES: Role[] = ['ADMINISTRATOR', 'SUPERVISOR']

/**
 * Which conversations a member may see, as a Prisma filter. The one rule
 * shared by the list, opening a conversation, bulk actions and global search,
 * so none of them can show what another hides.
 *
 * An agent sees what is assigned to them, what they take part in, and the
 * conversations of inboxes they belong to. With `teamScoped` on the account,
 * that last part narrows to conversations with no team yet or of a team the
 * agent is in: Financeiro's queue stays out of Cadastro's screen.
 */
export function conversationAccessWhere(
  member: { accountId: string; userId: string; role: Role },
  teamScoped: boolean,
): Prisma.ConversationWhereInput {
  if (PRIVILEGED_ROLES.includes(member.role)) return { accountId: member.accountId }
  const inInbox: Prisma.ConversationWhereInput = {
    inbox: { members: { some: { userId: member.userId } } },
  }
  return {
    accountId: member.accountId,
    OR: [
      { assigneeId: member.userId },
      { participants: { some: { userId: member.userId } } },
      teamScoped
        ? {
            AND: [
              inInbox,
              { OR: [{ teamId: null }, { team: { members: { some: { userId: member.userId } } } }] },
            ],
          }
        : inInbox,
    ],
  }
}
