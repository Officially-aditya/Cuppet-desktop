export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const

export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const DEFAULT_PRIORITY: TaskPriority = 'normal'

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && TASK_PRIORITIES.includes(value as TaskPriority)
}

export function parsePriority(value: string | undefined): TaskPriority | undefined {
  if (value === undefined) return undefined
  if (!isTaskPriority(value)) throw new Error(`invalid priority: ${value}`)
  return value
}
