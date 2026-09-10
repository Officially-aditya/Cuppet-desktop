import type { Task, TaskPriority, TaskStatus } from '../core/task.js'

export type TaskIndexFilter = {
  status?: TaskStatus
  priority?: TaskPriority
  tag?: string
}

type IndexedTask = Pick<Task, 'id' | 'status' | 'priority' | 'tags'>

const entries = new Map<string, IndexedTask>()

export function indexTask(task: IndexedTask): void {
  entries.set(task.id, {
    id: task.id,
    status: task.status,
    ...(task.priority ? { priority: task.priority } : {}),
    tags: [...task.tags],
  })
}

export function updateTaskIndex(task: IndexedTask): void {
  indexTask(task)
}

export function removeTaskFromIndex(id: string): void {
  entries.delete(id)
}

export function clearTaskIndex(): void {
  entries.clear()
}

export function queryTaskIds(filter: TaskIndexFilter = {}): string[] {
  return [...entries.values()]
    .filter((task) => {
      if (filter.status && task.status !== filter.status) return false
      if (filter.priority && task.priority !== filter.priority) return false
      if (filter.tag && !task.tags.includes(filter.tag)) return false
      return true
    })
    .map((task) => task.id)
    .sort()
}
