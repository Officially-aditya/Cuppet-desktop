import { execute } from './commands.js'
import { parseArgs } from './parser.js'

export const HELP = `Task Tracker CLI

Usage:
  task-tracker add <title> [--due-date ISO] [--priority low|normal|high]
  task-tracker list [--status STATUS] [--priority PRIORITY] [--tag TAG]
  task-tracker show <id>
  task-tracker done <id>
`

export function run(argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP)
    return
  }
  try {
    console.log(execute(parseArgs(argv)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run()
