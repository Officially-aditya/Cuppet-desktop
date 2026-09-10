import { validate, type NewTask, type Task } from './task.js'

export function buildTask(input: NewTask, now = new Date('2026-01-01T00:00:00.000Z')): Task {
  const result = validate(input)
  if (!result.valid) throw new Error(result.errors.join('; '))

  return {
    id: input.id,
    title: input.title.trim(),
    ...(input.description ? { description: input.description.trim() } : {}),
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    status: input.status ?? 'todo',
    tags: [...(input.tags ?? [])],
    createdAt: now.toISOString(),
  }
}
