import { useMemo, useState } from 'react';
import type { QuestionRequest } from '../types';

export function QuestionModal({ request, onAnswer }: { request: QuestionRequest; onAnswer: (answers: string[][] | null) => void | Promise<void> }) {
  const questions = request.questions ?? [];
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const complete = useMemo(() => answers.length === questions.length && answers.every((group) => group.length > 0 && group.some((value) => value.trim())), [answers, questions.length]);

  const setGroup = (index: number, value: string[]) => setAnswers((current) => current.map((group, itemIndex) => itemIndex === index ? value : group));
  const submit = async () => {
    if (!complete) { setNote('Answer every question before continuing.'); return; }
    setBusy(true);
    try { await onAnswer(answers.map((group) => group.map((value) => value.trim().slice(0, 512)).filter(Boolean))); }
    finally { setBusy(false); }
  };
  const reject = async () => { setBusy(true); try { await onAnswer(null); } finally { setBusy(false); } };

  return (
    <div className="modal-backdrop modal-priority" role="presentation">
      <section className="react-modal settings-dialog wide-dialog" role="dialog" aria-modal="true" aria-labelledby="question-title">
        <div className="dialog-header"><div><h2 id="question-title">Cuppet needs your input</h2><p>The model is waiting for an answer before it can continue.</p></div></div>
        <div className="question-fields">
          {questions.map((question, index) => (
            <fieldset className="question-group" key={`${question.header || 'question'}-${index}`} disabled={busy}>
              <legend>{question.header || `Question ${index + 1}`}</legend>
              <p>{question.question || ''}</p>
              {(question.options ?? []).length ? (question.options ?? []).map((option, optionIndex) => {
                const label = String(option.label || '').slice(0, 512);
                const checked = answers[index]?.includes(label) ?? false;
                return <label className="question-option" key={`${label}-${optionIndex}`}><input type={question.multiple ? 'checkbox' : 'radio'} name={`question-${index}`} checked={checked} onChange={(event) => {
                  if (question.multiple) setGroup(index, event.target.checked ? [...answers[index].filter((value) => value !== label), label] : answers[index].filter((value) => value !== label));
                  else setGroup(index, [label]);
                }} /><span>{option.description ? `${label} — ${option.description}` : label}</span></label>;
              }) : <textarea rows={3} maxLength={512} value={answers[index]?.[0] ?? ''} placeholder="Type your answer…" onChange={(event) => setGroup(index, event.target.value ? [event.target.value] : [])} />}
            </fieldset>
          ))}
        </div>
        {note && <p className="settings-note">{note}</p>}
        <div className="dialog-actions"><button type="button" className="ghost-button" disabled={busy} onClick={() => void reject()}>Reject</button><button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>Answer</button></div>
      </section>
    </div>
  );
}
