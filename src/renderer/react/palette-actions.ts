import type { CommandDefinition, CommandResult } from '../types';
import { askChoice, askForm, askText } from './dialog-store';

/**
 * Runs a palette action. Actions that need input ask for it through the dialog queue, which replaces the blocking
 * window.prompt()/confirm() calls (Electron does not implement prompt(), and confirm() freezes the renderer).
 * Resolves null when the user cancels, and throws if the action cannot run or the runtime rejects it.
 */
export async function executePaletteAction(item: CommandDefinition, sessionId: string | null, mode: 'plan' | 'build'): Promise<CommandResult | null> {
  if (item.requiresSession && !sessionId) throw new Error('Start or open a chat before using this action.');
  let input: Record<string, unknown> = {};

  if (item.id === 'cuppet.memory.remember') {
    const answer = await askForm({
      title: 'Remember something',
      message: 'Saved to this project\u2019s memory.',
      confirmLabel: 'Remember',
      fields: [
        { name: 'key', label: 'Memory key', placeholder: 'for example: test-command' },
        { name: 'value', label: 'What should Cuppet remember?', multiline: true },
      ],
    });
    if (!answer) return null;
    input = { key: answer.key, value: answer.value, scope: 'project' };
  } else if (item.id === 'cuppet.memory.forget') {
    const key = await askText({ title: 'Forget a memory', label: 'Memory key to forget', confirmLabel: 'Forget', destructive: true });
    if (!key) return null;
    input = { key };
  } else if (item.id === 'cuppet.memory.clear') {
    // Choosing a scope and pressing the destructive button is the confirmation, so there is no second prompt.
    const scope = await askChoice({
      title: 'Clear memory',
      message: 'Choose which memory to clear.',
      confirmLabel: 'Clear memory',
      destructive: true,
      defaultValue: 'session',
      options: [
        { value: 'session', label: 'This chat', description: 'Memory tied to this chat.' },
        { value: 'project', label: 'This project', description: 'Memory tied to this project.' },
        { value: 'global', label: 'Everywhere', description: 'Memory that applies across all projects.' },
      ],
    });
    if (!scope) return null;
    input = { scope };
  } else if (item.id === 'cuppet.steer.interrupt') {
    const text = await askText({ title: 'Steer the current turn', label: 'Instruction', multiline: true, confirmLabel: 'Send', placeholder: 'What should change?' });
    if (!text) return null;
    input = { text };
  } else if (item.id === 'cuppet.plan.agent') {
    const next = await askChoice({
      title: 'Agent mode',
      confirmLabel: 'Switch',
      defaultValue: mode,
      options: [
        { value: 'plan', label: 'Plan', description: 'Read-only: Cuppet plans and does not change files.' },
        { value: 'build', label: 'Build', description: 'Cuppet can make changes, with the usual approvals.' },
      ],
    });
    if (!next) return null;
    input = { mode: next };
  }

  return window.cuppet.commands.execute(sessionId, { id: item.id, input });
}
