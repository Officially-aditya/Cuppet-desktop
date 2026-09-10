import type { Task } from '../core/task.js'

export function formatTask(task: Task): string {
  const { id, title, status, dueDate, priority } = task
  const dateLabel = dueDate ? ` · due ${dueDate}` : ''
  return `[${status}/${priority ?? 'normal'}] ${id} ${title}${dateLabel}`
}

export function formatTaskList(tasks: readonly Task[]): string {
  return tasks.length === 0 ? '(no tasks)' : tasks.map(formatTask).join('\n')
}
