import { useEffect, useMemo, useState } from 'react';
import type { QuestionRequest } from '../types';

export function QuestionInline({
  request,
  onAnswer,
}: {
  request: QuestionRequest;
  onAnswer: (answers: string[][] | null) => void | Promise<void>;
}) {
  const questions = request.questions ?? [];
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    setStepIndex(0);
    setAnswers(questions.map(() => []));
    setNote('');
  }, [request.id]);

  const totalSteps = questions.length;
  const isMultiStep = totalSteps > 1;
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex >= totalSteps - 1;

  const currentQuestion = questions[stepIndex] ?? null;
  const currentAnswer = answers[stepIndex] ?? [];
  const currentAnswered = currentAnswer.length > 0 && currentAnswer.some((val) => val.trim().length > 0);

  const complete = useMemo(
    () =>
      answers.length === totalSteps &&
      answers.every((group) => group.length > 0 && group.some((value) => value.trim())),
    [answers, totalSteps]
  );

  const setGroup = (index: number, value: string[]) => {
    if (note) setNote('');
    setAnswers((current) => current.map((group, itemIndex) => (itemIndex === index ? value : group)));
  };

  const nextStep = () => {
    if (!currentAnswered) {
      setNote('Please answer this question before continuing.');
      return;
    }
    if (note) setNote('');
    setStepIndex((idx) => Math.min(totalSteps - 1, idx + 1));
  };

  const prevStep = () => {
    if (note) setNote('');
    setStepIndex((idx) => Math.max(0, idx - 1));
  };

  const submit = async () => {
    if (!complete) {
      const firstUnanswered = answers.findIndex(
        (group) => !group.length || !group.some((value) => value.trim())
      );
      if (firstUnanswered >= 0) {
        setStepIndex(firstUnanswered);
        setNote(`Please answer Question ${firstUnanswered + 1} before continuing.`);
      } else {
        setNote('Please answer all questions before continuing.');
      }
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

  if (!currentQuestion) return null;

  const hasOptions = (currentQuestion.options ?? []).length > 0;

  return (
    <section className="question-inline-bar" role="alert" aria-labelledby="question-title">
      <div className="question-inline-header">
        <div className="question-inline-title">
          <span className="question-inline-badge">?</span>
          <strong id="question-title">Cuppet needs your input</strong>
          {isMultiStep && (
            <span className="question-inline-step-pill">
              Question {stepIndex + 1} of {totalSteps}
            </span>
          )}
          <span className="question-inline-subtitle">· Model is waiting for an answer to continue</span>
        </div>

        {isMultiStep && (
          <div className="question-inline-steps" aria-label="Question steps">
            {questions.map((_, idx) => {
              const isAnswered = answers[idx]?.length > 0 && answers[idx].some((v) => v.trim());
              const isActive = idx === stepIndex;
              return (
                <button
                  key={idx}
                  type="button"
                  className={`question-step-dot${isActive ? ' active' : ''}${isAnswered ? ' answered' : ''}`}
                  title={`Question ${idx + 1}${isAnswered ? ' (answered)' : ''}`}
                  aria-label={`Go to question ${idx + 1}`}
                  disabled={busy}
                  onClick={() => {
                    if (note) setNote('');
                    setStepIndex(idx);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="question-inline-body">
        <div className="question-inline-group" key={`${currentQuestion.header || 'question'}-${stepIndex}`}>
          {currentQuestion.header && <div className="question-inline-legend">{currentQuestion.header}</div>}
          {currentQuestion.question && <div className="question-inline-prompt">{currentQuestion.question}</div>}

          {hasOptions ? (
            <div className="question-inline-options">
              {(currentQuestion.options ?? []).map((option, optionIndex) => {
                const label = String(option.label || '').slice(0, 512);
                const checked = currentAnswer.includes(label);
                return (
                  <label
                    className={`question-inline-option${checked ? ' selected' : ''}`}
                    key={`${label}-${optionIndex}`}
                  >
                    <input
                      type={currentQuestion.multiple ? 'checkbox' : 'radio'}
                      name={`question-${stepIndex}`}
                      checked={checked}
                      disabled={busy}
                      onChange={(event) => {
                        if (currentQuestion.multiple) {
                          setGroup(
                            stepIndex,
                            event.target.checked
                              ? [...currentAnswer.filter((v) => v !== label), label]
                              : currentAnswer.filter((v) => v !== label)
                          );
                        } else {
                          setGroup(stepIndex, [label]);
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
              value={currentAnswer[0] ?? ''}
              disabled={busy}
              autoFocus
              onChange={(event) =>
                setGroup(stepIndex, event.target.value ? [event.target.value] : [])
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (isLastStep) {
                    void submit();
                  } else {
                    nextStep();
                  }
                }
              }}
            />
          )}
        </div>
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

          {isMultiStep && !isFirstStep && (
            <button
              type="button"
              className="question-inline-button"
              disabled={busy}
              onClick={prevStep}
            >
              Back
            </button>
          )}

          {isMultiStep && !isLastStep ? (
            <button
              type="button"
              className="question-inline-button primary"
              disabled={busy || !currentAnswered}
              onClick={nextStep}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="question-inline-button primary"
              disabled={busy || !complete}
              onClick={() => void submit()}
            >
              Answer
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export const QuestionModal = QuestionInline;
