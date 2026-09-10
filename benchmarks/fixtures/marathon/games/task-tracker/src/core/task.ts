import { isTaskPriority, type TaskPriority } from './priority.js'

export type { TaskPriority } from './priority.js'

export type TaskStatus = 'todo' | 'doing' | 'done'

export interface Task {
  id: string
  title: string
  description?: string
  dueDate?: string
  priority?: TaskPriority
  status: TaskStatus
  tags: string[]
  createdAt: string
}

export interface NewTask {
  id: string
  title: string
  description?: string
  dueDate?: string
  priority?: TaskPriority
  status?: TaskStatus
  tags?: string[]
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] }

export function validate(task: Pick<NewTask, 'id' | 'title' | 'dueDate' | 'priority'>): ValidationResult {
  const errors: string[] = []
  if (!task.id.trim()) errors.push('id is required')
  if (!task.title.trim()) errors.push('title is required')
  if (task.dueDate && Number.isNaN(Date.parse(task.dueDate))) {
    errors.push('due date must be an ISO date')
  } else if (task.dueDate && Date.parse(task.dueDate) < Date.now()) {
    errors.push('due date must not be in the past')
  }
  if (task.priority !== undefined && !isTaskPriority(task.priority)) errors.push('priority must be low, normal, or high')
  return errors.length > 0 ? { valid: false, errors } : { valid: true }
}
