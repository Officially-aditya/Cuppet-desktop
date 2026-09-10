import type { Task } from '../core/task.js'

export function compactTask(task: Task): string {
  const { id, title, dueDate, priority, status } = task
  return [id, title, status, priority ?? 'normal', dueDate ?? 'no-date'].join('|')
}
