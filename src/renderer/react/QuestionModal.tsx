import { useMemo, useState } from 'react';
import type { QuestionRequest } from '../types';

export function QuestionInline({
  request,
  onAnswer,
}: {
  request: QuestionRequest;
  onAnswer: (answers: string[][] | null) => void | Promise<void>;
}) {
  const questions = request.questions ?? [];
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const complete = useMemo(
    () =>
      answers.length === questions.length &&
      answers.every((group) => group.length > 0 && group.some((value) => value.trim())),
    [answers, questions.length]
  );

  const setGroup = (index: number, value: string[]) => {
    if (note) setNote('');
    setAnswers((current) => current.map((group, itemIndex) => (itemIndex === index ? value : group)));
  };

  const submit = async () => {
    if (!complete) {
      setNote('Please answer all questions before continuing.');
      return;
    }
    setBusy(true);
    try {
      await onAnswer(
        answers.map((group) => group.map((value) => value.trim().slice(0, 512)).filter(Boolean))
      );
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await onAnswer(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="question-inline-bar" role="alert" aria-labelledby="question-title">
      <div className="question-inline-header">
        <div className="question-inline-title">
          <span className="question-inline-badge">?</span>
          <strong id="question-title">Cuppet needs your input</strong>
          <span className="question-inline-subtitle">· Model is waiting for an answer to continue</span>
        </div>
      </div>

      <div className="question-inline-body">
        {questions.map((question, index) => {
          const hasOptions = (question.options ?? []).length > 0;
          return (
            <div className="question-inline-group" key={`${question.header || 'question'}-${index}`}>
              {question.header && <div className="question-inline-legend">{question.header}</div>}
              {question.question && <div className="question-inline-prompt">{question.question}</div>}

              {hasOptions ? (
                <div className="question-inline-options">
                  {(question.options ?? []).map((option, optionIndex) => {
                    const label = String(option.label || '').slice(0, 512);
                    const checked = answers[index]?.includes(label) ?? false;
                    return (
                      <label
                        className={`question-inline-option${checked ? ' selected' : ''}`}
                        key={`${label}-${optionIndex}`}
                      >
                        <input
                          type={question.multiple ? 'checkbox' : 'radio'}
                          name={`question-${index}`}
                          checked={checked}
                          disabled={busy}
                          onChange={(event) => {
                            if (question.multiple) {
                              setGroup(
                                index,
                                event.target.checked
                                  ? [...answers[index].filter((v) => v !== label), label]
                                  : answers[index].filter((v) => v !== label)
                              );
                            } else {
                              setGroup(index, [label]);
                            }
                          }}
                        />
                        <span>{option.description ? `${label} — ${option.description}` : label}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <input
                  type="text"
                  className="question-inline-input"
                  placeholder="Type your answer…"
                  maxLength={512}
                  value={answers[index]?.[0] ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setGroup(index, event.target.value ? [event.target.value] : [])
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="question-inline-footer">
        {note ? <span className="question-inline-note">{note}</span> : <span />}
        <div className="question-inline-actions">
          <button
            type="button"
            className="question-inline-button danger"
            disabled={busy}
            onClick={() => void reject()}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="question-inline-button primary"
            disabled={busy || !complete}
            onClick={() => void submit()}
          >
            Answer
          </button>
        </div>
      </div>
    </section>
  );
}

export const QuestionModal = QuestionInline;
