import { Global, Module } from '@nestjs/common'

import { ActivityModule } from '../activity/activity.module'
import { NotificationsModule } from '../notifications/notifications.module'

import { AssignmentService } from './assignment.service'

// Global: conversations, flows, the AI tools, the widget and automations all
// route conversations, and several of those modules already import each other
// through forwardRef. One global provider keeps routing out of those cycles.
@Global()
@Module({
  imports: [ActivityModule, NotificationsModule],
  providers: [AssignmentService],
  exports: [AssignmentService],
})
export class AssignmentModule {}
