import { z } from 'zod'

export const ProjectSchema = z.strictObject({})

export type Project = z.infer<typeof ProjectSchema>
