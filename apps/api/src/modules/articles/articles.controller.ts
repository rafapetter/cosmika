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
  ArticleDTO,
  ArticleHitDTO,
  CreateArticleInput,
  ListArticlesQuery,
  SearchArticlesQuery,
  UpdateArticleInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'
import { AuditLogService } from '../audit-log/audit-log.service'

import { ArticlesService } from './articles.service'

@Controller('accounts/:accountId/articles')
@UseGuards(AuthGuard)
export class ArticlesController {
  constructor(
    private readonly svc: ArticlesService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(ListArticlesQuery)) query: ListArticlesQuery,
  ): Promise<ArticleDTO[]> {
    const rows = await this.svc.list(auth.user.id, accountId, query)
    return rows.map((r) => this.svc.toDTO(r) as ArticleDTO)
  }

  @Get('search')
  async search(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Query(new ZodValidationPipe(SearchArticlesQuery))
    query: SearchArticlesQuery,
  ): Promise<ArticleHitDTO[]> {
    return this.svc.search(accountId, query.q, query.limit ?? 5)
  }

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<ArticleDTO> {
    const a = await this.svc.get(auth.user.id, accountId, id)
    return this.svc.toDTO(a) as ArticleDTO
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateArticleInput))
    body: CreateArticleInput,
  ): Promise<ArticleDTO> {
    const row = await this.svc.create(auth.user.id, accountId, body)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'article.create',
      target: `article:${row.id}`,
      metadata: { slug: row.slug, status: row.status },
    })
    return this.svc.toDTO(row) as ArticleDTO
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateArticleInput))
    body: UpdateArticleInput,
  ): Promise<ArticleDTO> {
    const row = await this.svc.update(auth.user.id, accountId, id, body)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'article.update',
      target: `article:${row.id}`,
      metadata: body,
    })
    return this.svc.toDTO(row) as ArticleDTO
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.svc.remove(auth.user.id, accountId, id)
    await this.audit.record({
      accountId,
      actorId: auth.user.id,
      action: 'article.delete',
      target: `article:${id}`,
    })
  }
}
