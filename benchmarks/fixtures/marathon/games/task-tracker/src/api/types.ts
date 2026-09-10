import type { NewTask, Task } from '../core/task.js'
import type { TaskListFilter } from '../query/taskQueries.js'

export interface CreateTaskRequest extends NewTask {
  source?: 'api' | 'cli'
}

export type TaskResponse = Task

export type ListTasksRequest = TaskListFilter
