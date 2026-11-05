import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  AddTeamMemberInput,
  CreateTeamInput,
  TeamDTO,
  TeamMemberDTO,
  TeamWithMembersDTO,
  UpdateTeamInput,
} from '@cosmika/shared'

import { ZodValidationPipe } from '../../common/zod-validation.pipe'
import { Auth, AuthGuard } from '../auth/auth.guard'
import { SessionContext } from '../auth/auth.service'

import { TeamsService } from './teams.service'

@Controller('accounts/:accountId/teams')
@UseGuards(AuthGuard)
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  async list(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
  ): Promise<TeamDTO[]> {
    const rows = await this.teams.list(auth.user.id, accountId)
    return rows.map((t) => this.teams.toDTO(t))
  }

  @Post()
  async create(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(CreateTeamInput)) body: CreateTeamInput,
  ): Promise<TeamDTO> {
    const team = await this.teams.create(auth.user.id, accountId, body)
    return this.teams.toDTO({ ...team, _count: { members: 0 } })
  }

  @Get(':id')
  async get(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<TeamWithMembersDTO> {
    const team = await this.teams.getWithMembers(auth.user.id, accountId, id)
    return this.teams.toWithMembersDTO(team)
  }

  @Patch(':id')
  async update(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateTeamInput)) body: UpdateTeamInput,
  ): Promise<TeamDTO> {
    const team = await this.teams.update(auth.user.id, accountId, id, body)
    return this.teams.toDTO(team)
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.teams.remove(auth.user.id, accountId, id)
  }

  @Post(':id/members')
  async addMember(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddTeamMemberInput))
    body: AddTeamMemberInput,
  ): Promise<TeamMemberDTO> {
    const m = await this.teams.addMember(auth.user.id, accountId, id, body)
    return this.teams.toMemberDTO(m)
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Auth() auth: SessionContext,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Param('userId') memberUserId: string,
  ): Promise<void> {
    await this.teams.removeMember(auth.user.id, accountId, id, memberUserId)
  }
}
