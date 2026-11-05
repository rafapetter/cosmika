import { z } from 'zod'

const DayOfWeek = z.number().int().min(0).max(6)

/**
 * One working-hours row per (inbox, dayOfWeek). 0 = Sunday, 6 = Saturday.
 * `closedAllDay = true` means the inbox is closed that day regardless of
 * open/close hours (which clients may still send but should ignore).
 */
export const WorkingHourInput = z.object({
  dayOfWeek: DayOfWeek,
  closedAllDay: z.boolean().default(false),
  openHour: z.number().int().min(0).max(23).default(9),
  openMinute: z.number().int().min(0).max(59).default(0),
  closeHour: z.number().int().min(0).max(23).default(18),
  closeMinute: z.number().int().min(0).max(59).default(0),
})
export type WorkingHourInput = z.infer<typeof WorkingHourInput>

export const SetWorkingHoursInput = z.object({
  hours: z.array(WorkingHourInput).max(7),
})
export type SetWorkingHoursInput = z.infer<typeof SetWorkingHoursInput>

export const WorkingHourDTO = z.object({
  id: z.string(),
  inboxId: z.string(),
  dayOfWeek: z.number().int(),
  closedAllDay: z.boolean(),
  openHour: z.number().int(),
  openMinute: z.number().int(),
  closeHour: z.number().int(),
  closeMinute: z.number().int(),
})
export type WorkingHourDTO = z.infer<typeof WorkingHourDTO>

export const CreateHolidayInput = z.object({
  name: z.string().min(1).max(120),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
})
export type CreateHolidayInput = z.infer<typeof CreateHolidayInput>

export const HolidayDTO = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  date: z.string(),
  createdAt: z.string(),
})
export type HolidayDTO = z.infer<typeof HolidayDTO>
