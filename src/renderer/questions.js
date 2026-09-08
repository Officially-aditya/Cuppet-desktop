(() => {
  if (!window.cuppet?.questions) return;

  let current = null;
  const dialog = document.createElement('dialog');
  dialog.className = 'settings-dialog wide-dialog';
  dialog.setAttribute('aria-labelledby', 'question-title');

  const header = document.createElement('div'); header.className = 'dialog-header';
  const headingWrap = document.createElement('div');
  const title = document.createElement('h2'); title.id = 'question-title'; title.textContent = 'Cuppet needs your input';
  const subtitle = document.createElement('p'); subtitle.textContent = 'The model is waiting for an answer before it can continue.';
  headingWrap.append(title, subtitle); header.append(headingWrap);

  const form = document.createElement('form');
  const fields = document.createElement('div'); fields.className = 'question-fields';
  const note = document.createElement('p'); note.className = 'settings-note';
  const actions = document.createElement('div'); actions.className = 'dialog-actions';
  const reject = button('Reject', 'ghost-button');
  const submit = button('Answer', 'primary-button'); submit.type = 'submit';
  actions.append(reject, submit); form.append(fields, note, actions); dialog.append(header, form); document.body.append(dialog);

  function button(label, className) { const element = document.createElement('button'); element.type = 'button'; element.className = className; element.textContent = label; return element; }

  function render(request) {
    current = request; fields.replaceChildren(); note.textContent = '';
    for (const [index, question] of (request.questions || []).entries()) {
      const group = document.createElement('fieldset'); group.className = 'question-group';
      const legend = document.createElement('legend'); legend.textContent = question.header || `Question ${index + 1}`;
      const prompt = document.createElement('p'); prompt.textContent = question.question || '';
      group.append(legend, prompt);
      const options = Array.isArray(question.options) ? question.options : [];
      if (options.length) {
        for (const option of options) {
          const label = document.createElement('label'); label.className = 'question-option';
          const input = document.createElement('input'); input.type = question.multiple ? 'checkbox' : 'radio'; input.name = `question-${index}`; input.value = String(option.label || '').slice(0, 512);
          const text = document.createElement('span'); text.textContent = option.description ? `${option.label} — ${option.description}` : option.label;
          label.append(input, text); group.append(label);
        }
      } else {
        const input = document.createElement('textarea'); input.rows = 3; input.maxLength = 512; input.dataset.questionIndex = String(index); input.placeholder = 'Type your answer…'; group.append(input);
      }
      fields.append(group);
    }
    setBusy(false); if (!dialog.open) dialog.showModal();
  }

  function collectAnswers() {
    return (current?.questions || []).map((question, index) => {
      if ((question.options || []).length) {
        return [...fields.querySelectorAll(`input[name="question-${index}"]:checked`)].map((input) => input.value).slice(0, 12);
      }
      const value = fields.querySelector(`textarea[data-question-index="${index}"]`)?.value.trim() || '';
      return value ? [value.slice(0, 512)] : [];
    });
  }

  async function answer() {
    if (!current) return;
    const answers = collectAnswers();
    if (answers.some((group) => !group.length)) { note.textContent = 'Answer every question before continuing.'; return; }
    const id = current.id; setBusy(true);
    try { await window.cuppet.questions.reply(id, answers); }
    catch (error) { note.textContent = error?.message || String(error); setBusy(false); return; }
    current = null; dialog.close(); await showNext();
  }

  async function rejectCurrent() {
    if (!current) return;
    const id = current.id; setBusy(true);
    try { await window.cuppet.questions.reject(id); }
    catch (error) { note.textContent = error?.message || String(error); setBusy(false); return; }
    current = null; dialog.close(); await showNext();
  }

  function setBusy(busy) { submit.disabled = busy; reject.disabled = busy; for (const input of fields.querySelectorAll('input,textarea')) input.disabled = busy; }
  async function showNext() { const pending = await window.cuppet.questions.list().catch(() => []); if (pending[0]) render(pending[0]); }

  form.addEventListener('submit', (event) => { event.preventDefault(); void answer(); });
  reject.addEventListener('click', () => void rejectCurrent());
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); void rejectCurrent(); });
  window.cuppet.onEvent((event) => {
    if (event?.type === 'question.requested' && event.request) render(event.request);
    if (event?.type === 'question.resolved' && current?.id === event.requestId) { current = null; if (dialog.open) dialog.close(); void showNext(); }
  });
  void showNext();
})();
