import { addTask, getTask as findTask, setStatus } from '../store/taskStore.js'
import { compactTask } from '../format/compact.js'
import { listFilteredTasks } from '../query/taskQueries.js'
import type { CreateTaskRequest, ListTasksRequest } from './types.js'
import type { Task } from '../core/task.js'

export function createTask(request: CreateTaskRequest): Task {
  return addTask(request)
}

export function listAllTasks(filter: ListTasksRequest = {}): Task[] {
  return listFilteredTasks(filter)
}

export function getTask(id: string): Task | undefined {
  return findTask(id)
}

export function completeTask(id: string): Task | undefined {
  return setStatus(id, 'done')
}

export function summarizeTask(id: string): string | undefined {
  const task = findTask(id)
  return task ? compactTask(task) : undefined
}
