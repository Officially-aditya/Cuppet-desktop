import { createTaskHandler, getTaskHandler, listTasksHandler, completeTaskHandler } from '../api/routes.js'
import { formatTask, formatTaskList } from '../format/display.js'
import type { ParsedCommand } from './parser.js'

let nextId = 1

export function execute(command: ParsedCommand): string {
  switch (command.kind) {
    case 'add': {
      const created = createTaskHandler({
        id: `task-${nextId++}`,
        title: command.title,
        ...(command.dueDate ? { dueDate: command.dueDate } : {}),
        ...(command.priority ? { priority: command.priority } : {}),
        source: 'cli',
      })
      return formatTask(created)
    }
    case 'list': {
      const filter = {
        ...(command.status ? { status: command.status } : {}),
        ...(command.priority ? { priority: command.priority } : {}),
        ...(command.tag ? { tag: command.tag } : {}),
      }
      return formatTaskList(listTasksHandler(filter))
    }
    case 'show':
      return formatTask(getTaskHandler(command.id) ?? { id: command.id, title: 'not found', priority: 'normal', status: 'done', tags: [], createdAt: '' })
    case 'done':
      return formatTask(completeTaskHandler(command.id) ?? { id: command.id, title: 'not found', priority: 'normal', status: 'done', tags: [], createdAt: '' })
  }
}
