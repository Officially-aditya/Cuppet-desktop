import { randomUUID } from 'node:crypto';

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
const MAX_ANSWER_VALUES = 12;

export class QuestionInteractionRequiredError extends Error {
  constructor(message = 'Interactive question requires a trusted interactive client.') {
    super(message);
    this.name = 'QuestionInteractionRequiredError';
    this.code = 'interaction_required';
  }
}

export class QuestionRejectedError extends Error {
  constructor(message = 'Question rejected by user.', requestId = null) {
    super(message);
    this.name = 'QuestionRejectedError';
    this.code = 'question_rejected';
    this.requestId = requestId;
  }
}

export class QuestionBroker {
  #emit; #interactive; #pending = new Map();

  constructor({ emit = () => {}, interactive = true } = {}) {
    this.#emit = emit;
    this.#interactive = interactive;
  }

  close() {
    for (const pending of this.#pending.values()) {
      pending.signal?.removeEventListener('abort', pending.abortListener);
      pending.reject(abortError());
    }
    this.#pending.clear();
  }

  forgetSession(sessionId) {
    if (!sessionId) return { sessionId, forgotten: false };
    let forgotten = false;
    for (const [requestId, pending] of this.#pending) {
      if (pending.request.sessionId !== sessionId) continue;
      this.#pending.delete(requestId);
      pending.signal?.removeEventListener('abort', pending.abortListener);
      pending.reject(abortError());
      forgotten = true;
    }
    return { sessionId, forgotten };
  }

  list(sessionId = null) {
    return [...this.#pending.values()].map((entry) => structuredClone(entry.request)).filter((request) => !sessionId || request.sessionId === sessionId);
  }

  async ask({ sessionId, questions, signal }) {
    if (!sessionId) throw new Error('sessionId is required');
    const normalized = normalizeQuestions(questions);
    if (!normalized.length) throw new Error('at least one question is required');
    if (!this.#interactive) throw new QuestionInteractionRequiredError();
    if (signal?.aborted) throw abortError();

    const request = { id: `question_${randomUUID()}`, sessionId, questions: normalized, createdAt: Date.now() };
    return new Promise((resolve, reject) => {
      const abortListener = () => {
        if (!this.#pending.delete(request.id)) return;
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', abortListener, { once: true });
      this.#pending.set(request.id, { request, resolve, reject, signal, abortListener });
      this.#emit({ type: 'question.requested', request: structuredClone(request) });
    });
  }

  reply(requestId, answers) {
    const pending = this.#pending.get(requestId);
    if (!pending) return { resolved: false, requestId };
    const normalized = normalizeAnswers(answers, pending.request.questions);
    this.#pending.delete(requestId);
    pending.signal?.removeEventListener('abort', pending.abortListener);
    this.#emit({ type: 'question.resolved', sessionId: pending.request.sessionId, requestId, accepted: true });
    pending.resolve({ requestId, answers: normalized });
    return { resolved: true, requestId, accepted: true };
  }

  reject(requestId) {
    const pending = this.#pending.get(requestId);
    if (!pending) return { resolved: false, requestId };
    this.#pending.delete(requestId);
    pending.signal?.removeEventListener('abort', pending.abortListener);
    this.#emit({ type: 'question.resolved', sessionId: pending.request.sessionId, requestId, accepted: false });
    pending.reject(new QuestionRejectedError('Question rejected by user.', requestId));
    return { resolved: true, requestId, accepted: false };
  }
}

export function normalizeQuestions(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, MAX_QUESTIONS).flatMap((value) => {
    const source = record(value);
    const question = clean(source.question, 500);
    if (!question) return [];
    const options = Array.isArray(source.options) ? source.options.slice(0, MAX_OPTIONS).flatMap((option) => {
      const item = record(option); const label = clean(item.label, 120); if (!label) return [];
      const description = clean(item.description, 240);
      return [{ label, ...(description ? { description } : {}) }];
    }) : [];
    const header = clean(source.header, 80);
    return [{ ...(header ? { header } : {}), question, options, multiple: source.multiple === true }];
  });
}

function normalizeAnswers(values, questions) {
  if (!Array.isArray(values) || values.length !== questions.length) throw new Error(`answers must contain exactly ${questions.length} answer group(s)`);
  return values.map((value, index) => {
    if (!Array.isArray(value)) throw new Error(`answers[${index}] must be an array`);
    const question = questions[index];
    const answers = value.slice(0, MAX_ANSWER_VALUES).flatMap((item) => {
      const text = clean(item, 512); return text ? [text] : [];
    });
    if (!question.multiple && answers.length > 1) throw new Error(`answers[${index}] accepts only one value`);
    if (!answers.length) throw new Error(`answers[${index}] must contain at least one value`);
    return answers;
  });
}
function clean(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function abortError() { const error = new Error('Generation stopped'); error.name = 'AbortError'; return error; }
