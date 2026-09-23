import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('QuestionInline renders multi-question requests as a step-by-step wizard', async () => {
  const [modal, css, chatPane] = await Promise.all([
    source('src/renderer/react/QuestionModal.tsx'),
    source('src/renderer/permission-inline.css'),
    source('src/renderer/react/ChatPane.tsx'),
  ]);

  // QuestionInline component contracts
  assert.match(modal, /export function QuestionInline/);
  assert.match(modal, /const \[stepIndex, setStepIndex\] = useState\(0\)/);
  assert.match(modal, /const isMultiStep = totalSteps > 1/);
  assert.match(modal, /Question \{stepIndex \+ 1\} of \{totalSteps\}/);
  assert.match(modal, /className="question-inline-steps"/);
  assert.match(modal, /className=\{`question-step-dot\$\{isActive \? ' active' : ''\}\$\{isAnswered \? ' answered' : ''\}`\}/);
  assert.match(modal, /const nextStep =/);
  assert.match(modal, /const prevStep =/);
  assert.match(modal, /isMultiStep && !isFirstStep && \(/);
  assert.match(modal, />\s*Back\s*<\/button>/);
  assert.match(modal, /isMultiStep && !isLastStep \? \(/);
  assert.match(modal, />\s*Next\s*<\/button>/);
  assert.match(modal, />\s*Answer\s*<\/button>/);

  // ChatPane renders QuestionInline above composer
  assert.match(chatPane, /<QuestionInline request=\{question\} onAnswer=\{onAnswerQuestion \|\| \(\(\) => \{\}\)\} \/>/);

  // CSS wizard classes
  assert.match(css, /\.question-inline-step-pill/);
  assert.match(css, /\.question-inline-steps/);
  assert.match(css, /\.question-step-dot/);
  assert.match(css, /\.question-step-dot\.active/);
  assert.match(css, /\.question-step-dot\.answered/);
});
