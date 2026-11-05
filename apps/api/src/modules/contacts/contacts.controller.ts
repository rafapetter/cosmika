import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  BulkContactActionInput,
  BulkContactActionResult,
  ContactDTO,
  ContactImportInput,
  ContactImportResult,
  ContactWithInboxesDTO,
  ContactsPage,
  CreateContactInput,
  ContactNoteDTO,
  CreateContactNoteInput,
  ListContactsQuery,
  MergeContactsInput,
  SetContactBlockedInput,
  UpdateContactInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { ContactsService } from './contacts.service'

@Controller('accounts/:accountId/contacts')
@UseGuards(AuthGuard)
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(ListContactsQuery)) query: ListContactsQuery,
  ): Promise<ContactsPage> {
    const { data, nextCursor, total } = await this.contacts.list(
      auth.user.id,
      accountId,
      query,
    )
    return {
      data: data.map((c) => this.contacts.toContactDTO(c)),
      nextCursor,
      total,
    }
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateContactInput)) body: CreateContactInput,
  ): Promise<ContactDTO> {
    const contact = await this.contacts.create(auth.user.id, accountId, body)
    return this.contacts.toContactDTO(contact)
  }

  @Post('import')
  async importBatch(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(ContactImportInput)) body: ContactImportInput,
  ): Promise<ContactImportResult> {
    return this.contacts.importBatch(auth.user.id, accountId, body)
  }

  @Post('bulk')
  async bulkAction(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(BulkContactActionInput))
    body: BulkContactActionInput,
  ): Promise<BulkContactActionResult> {
    const result = await this.contacts.bulkAction(
      auth.user.id,
      accountId,
      body,
    )
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: `contact.bulk.${result.action}`,
      target: null,
      metadata: { requested: body.contactIds.length, affected: result.affected },
    })
    return result
  }

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<ContactWithInboxesDTO> {
    const contact = await this.contacts.getWithInboxes(
      auth.user.id,
      accountId,
      id,
    )
    return {
      ...this.contacts.toContactDTO(contact),
      contactInboxes: contact.contactInboxes.map((ci) =>
        this.contacts.toContactInboxRefDTO(ci),
      ),
    }
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateContactInput)) body: UpdateContactInput,
  ): Promise<ContactDTO> {
    const contact = await this.contacts.update(
      auth.user.id,
      accountId,
      id,
      body,
    )
    return this.contacts.toContactDTO(contact)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.contacts.remove(auth.user.id, accountId, id)
  }

  @Post(':id/merge')
  async merge(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(MergeContactsInput)) body: MergeContactsInput,
  ): Promise<ContactWithInboxesDTO> {
    const merged = await this.contacts.merge(auth.user.id, accountId, id, body)
    return {
      ...this.contacts.toContactDTO(merged),
      contactInboxes: merged.contactInboxes.map((ci) =>
        this.contacts.toContactInboxRefDTO(ci),
      ),
    }
  }

  @Get(':id/notes')
  async listNotes(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<ContactNoteDTO[]> {
    const notes = await this.contacts.listNotes(auth.user.id, accountId, id)
    return notes.map((n) => this.contacts.toContactNoteDTO(n))
  }

  @Post(':id/notes')
  async addNote(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateContactNoteInput))
    body: CreateContactNoteInput,
  ): Promise<ContactNoteDTO> {
    const note = await this.contacts.addNote(
      auth.user.id,
      accountId,
      id,
      body.body,
    )
    return this.contacts.toContactNoteDTO(note)
  }

  @Delete(':id/notes/:noteId')
  @HttpCode(204)
  async deleteNote(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
  ): Promise<void> {
    await this.contacts.deleteNote(auth.user.id, accountId, id, noteId)
  }

  @Post(':id/block')
  async setBlocked(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetContactBlockedInput))
    body: SetContactBlockedInput,
  ): Promise<ContactDTO> {
    const c = await this.contacts.setBlocked(
      auth.user.id,
      accountId,
      id,
      body.blocked,
    )
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: body.blocked ? 'contact.block' : 'contact.unblock',
      target: `contact:${id}`,
    })
    return this.contacts.toContactDTO(c)
  }

  @Get(':id/export')
  async exportContact(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    const bundle = await this.contacts.exportContact(auth.user.id, accountId, id)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'contact.export',
      target: `contact:${id}`,
    })
    return bundle
  }

  @Post(':id/anonymize')
  async anonymizeContact(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<ContactDTO> {
    const c = await this.contacts.anonymizeContact(auth.user.id, accountId, id)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'contact.anonymize',
      target: `contact:${id}`,
    })
    return this.contacts.toContactDTO(c)
  }
}
