import { listTasks as readAllTasks } from '../store/taskStore.js'
import { queryTaskIds, type TaskIndexFilter } from '../store/taskIndex.js'
import type { Task } from '../core/task.js'

export type TaskListFilter = TaskIndexFilter

export function listFilteredTasks(filter: TaskListFilter = {}): Task[] {
  const tasks = new Map(readAllTasks().map((task) => [task.id, task]))
  return queryTaskIds(filter).flatMap((id) => {
    const task = tasks.get(id)
    return task ? [task] : []
  })
}
