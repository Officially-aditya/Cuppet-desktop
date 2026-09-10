import assert from 'node:assert/strict'
import { validate } from '../src/core/task.js'
import { createTask, listAllTasks } from '../src/api/handlers.js'
import { execute } from '../src/cli/commands.js'
import { parseArgs } from '../src/cli/parser.js'
import { clearTasks, addTask, getTask, removeTask, setStatus, updateTask } from '../src/store/taskStore.js'
import { listFilteredTasks } from '../src/query/taskQueries.js'
import { futureDate, taskInput } from './fixtures.js'

function runTest(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`[PASS] ${name}`)
  } catch (error) {
    console.error(`[FAIL] ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

clearTasks()

runTest('validate accepts a well-formed future due date and priority', () => {
  assert.deepEqual(validate(taskInput()), { valid: true })
})

runTest('validate rejects malformed dates and invalid priorities', () => {
  assert.equal(validate(taskInput({ dueDate: 'not-a-date' })).valid, false)
  assert.equal(validate({ ...taskInput(), priority: 'urgent' as never }).valid, false)
})

runTest('store supports create, read, update, and delete', () => {
  clearTasks()
  const task = addTask(taskInput({ id: 'crud-1' }))
  assert.equal(getTask('crud-1')?.title, task.title)
  assert.equal(setStatus('crud-1', 'done')?.status, 'done')
  assert.equal(removeTask('crud-1'), true)
  assert.equal(getTask('crud-1'), undefined)
})

runTest('API handlers create and list tasks', () => {
  clearTasks()
  createTask(taskInput({ id: 'api-1', title: 'API task', priority: 'high' }))
  assert.equal(listAllTasks({ priority: 'high' }).length, 1)
})

runTest('CLI parser and command formatter work together', () => {
  clearTasks()
  const parsed = parseArgs(['add', 'CLI task', '--due-date', futureDate, '--priority', 'high'])
  assert.equal(parsed.kind, 'add')
  const output = execute(parsed)
  assert.match(output, /CLI task/)
  assert.match(output, /high/)
})

runTest('indexed filters select status and tags', () => {
  clearTasks()
  addTask(taskInput({ id: 'indexed-1', tags: ['benchmark', 'urgent'] }))
  assert.equal(listFilteredTasks({ status: 'todo', tag: 'urgent' }).length, 1)
})

runTest('store preserves due dates and refreshes indexes after updates', () => {
  clearTasks()
  addTask(taskInput({
    id: 'indexed-update',
    dueDate: futureDate,
    priority: 'low',
    tags: ['backlog'],
  }))
  assert.equal(getTask('indexed-update')?.dueDate, futureDate)

  updateTask('indexed-update', { status: 'done', priority: 'high', tags: ['urgent'] })
  assert.equal(listFilteredTasks({ status: 'todo' }).length, 0)
  assert.equal(listFilteredTasks({ priority: 'low' }).length, 0)
  assert.equal(listFilteredTasks({ tag: 'backlog' }).length, 0)
  assert.equal(listFilteredTasks({ status: 'done', priority: 'high', tag: 'urgent' }).length, 1)
})
