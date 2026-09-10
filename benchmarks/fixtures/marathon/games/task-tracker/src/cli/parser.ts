import { parsePriority, type TaskPriority } from '../core/priority.js'
import type { TaskStatus } from '../core/task.js'

export type ParsedCommand =
  | { kind: 'add'; title: string; dueDate?: string; priority?: TaskPriority }
  | { kind: 'list'; status?: TaskStatus; priority?: TaskPriority; tag?: string }
  | { kind: 'show'; id: string }
  | { kind: 'done'; id: string }

export function parseArgs(args: readonly string[]): ParsedCommand {
  const [command, ...rest] = args
  if (command === 'list' || command === undefined) {
    const status = optionValue(rest, '--status')
    const priority = parsePriority(optionValue(rest, '--priority'))
    const tag = optionValue(rest, '--tag')
    if (status !== undefined && !['todo', 'doing', 'done'].includes(status)) throw new Error(`invalid status: ${status}`)
    return {
      kind: 'list',
      ...(status ? { status: status as TaskStatus } : {}),
      ...(priority ? { priority } : {}),
      ...(tag ? { tag } : {}),
    }
  }
  if (command === 'show' && rest[0]) return { kind: 'show', id: rest[0] }
  if (command === 'done' && rest[0]) return { kind: 'done', id: rest[0] }
  if (command === 'add' && rest[0]) {
    const title = rest[0]
    const dueDate = optionValue(rest, '--due-date')
    const priority = parsePriority(optionValue(rest, '--priority'))
    return { kind: 'add', title, ...(dueDate ? { dueDate } : {}), ...(priority ? { priority } : {}) }
  }
  throw new Error('usage: add <title> [--due-date ISO] [--priority low|normal|high] | list [--status STATUS] [--priority PRIORITY] [--tag TAG] | show <id> | done <id>')
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option)
  return index >= 0 ? args[index + 1] : undefined
}
