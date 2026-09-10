import type { NewTask } from '../src/core/task.js'
import type { TaskPriority } from '../src/core/priority.js'

export const futureDate = '2099-01-15T00:00:00.000Z'
export const defaultPriority: TaskPriority = 'normal'

export function taskInput(overrides: Partial<NewTask> = {}): NewTask {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Write benchmark report',
    ...(overrides.description ? { description: overrides.description } : {}),
    dueDate: overrides.dueDate ?? futureDate,
    priority: overrides.priority ?? defaultPriority,
    status: overrides.status ?? 'todo',
    tags: overrides.tags ?? ['benchmark'],
  }
}
