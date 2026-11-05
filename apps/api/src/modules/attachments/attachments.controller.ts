import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { AttachmentDTO } from '@cosmika/shared'

import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { errBody } from '../../common/app-error'

import { AttachmentsService } from './attachments.service'

type MultipartRequest = {
  isMultipart?: () => boolean
  file?: () => Promise<{
    filename?: string
    mimetype?: string
    toBuffer: () => Promise<Buffer>
  } | undefined>
}

type FastifyReply = {
  redirect: (url: string) => void
  type: (m: string) => FastifyReply
  send: (body: unknown) => void
  status: (s: number) => FastifyReply
}

@Controller('accounts/:accountId/attachments')
@UseGuards(AuthGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post()
  async upload(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Req() req: MultipartRequest,
  ): Promise<AttachmentDTO> {
    if (!req.isMultipart?.()) {
      throw new BadRequestException(errBody('upload_multipart_required', 'Use multipart/form-data'))
    }
    if (!req.file) throw new BadRequestException(errBody('upload_multipart_required', 'Multipart not configured'))
    const part = await req.file()
    if (!part) throw new BadRequestException(errBody('upload_no_file', 'No file in request'))
    const buffer = await part.toBuffer()
    const att = await this.attachments.ingest(auth.user.id, accountId, {
      filename: part.filename,
      mimetype: part.mimetype,
      buffer,
    })
    return this.attachments.toDTO(att)
  }

  @Get(':id/download')
  async download(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const url = await this.attachments.getDownloadUrl(auth.user.id, accountId, id)
    // Set the status explicitly: under Nest's `@Res()` the reply already has a
    // 200 on it, and Fastify's bare `redirect(url)` keeps whatever is there —
    // which sends a `location` header nobody follows.
    res.status(302).redirect(url)
  }
}

// Public file serving for local storage mode. The attachment row carries the
// accountId, so we look that up and check membership in one shot.
@Controller('attachments-files')
@UseGuards(AuthGuard)
export class AttachmentsFilesController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id')
  async serve(
    @Auth() auth: SessionContext,
    @Param('id') id: string,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const { stream, att } = await this.attachments.openLocalStream(
      auth.user.id,
      id,
    )
    res.type(att.mimeType ?? 'application/octet-stream')
    res.send(stream)
  }
}
