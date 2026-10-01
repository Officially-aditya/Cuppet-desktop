import test from 'node:test';
import assert from 'node:assert/strict';
import { openAIInput, anthropicConversation, geminiInitialInput } from '../src/runtime/native-provider.mjs';
import { formatOpenAIChatMessages } from '../src/runtime/provider.mjs';

const SAMPLE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${SAMPLE_BASE64}`;
const JPEG_DATA_URL = `data:image/jpeg;base64,${SAMPLE_BASE64}`;

test('openAIInput serializes text and multimodal image attachments correctly', () => {
  const messages = [
    { role: 'user', content: 'Plain user message' },
    {
      role: 'user',
      content: 'Analyze this image',
      imageAttachments: [
        { name: 'diagram.png', mime: 'image/png', dataUrl: PNG_DATA_URL },
      ],
    },
    { role: 'assistant', content: 'Looks like a diagram' },
  ];

  const result = openAIInput(messages);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { role: 'user', content: 'Plain user message' });

  // Multimodal user message
  assert.equal(result[1].role, 'user');
  assert.equal(Array.isArray(result[1].content), true);
  assert.equal(result[1].content.length, 2);
  assert.deepEqual(result[1].content[0], { type: 'input_text', text: 'Analyze this image' });
  assert.deepEqual(result[1].content[1], { type: 'input_image', image_url: PNG_DATA_URL });

  // Assistant message
  assert.deepEqual(result[2], { role: 'assistant', content: 'Looks like a diagram' });
});

test('anthropicConversation serializes image blocks with base64 source and media_type', () => {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    {
      role: 'user',
      content: 'What is in this picture?',
      imageAttachments: [
        { name: 'photo.jpg', mime: 'image/jpeg', dataUrl: JPEG_DATA_URL },
      ],
    },
  ];

  const result = anthropicConversation(messages);
  assert.equal(result.system, 'You are a helpful assistant.');
  assert.equal(result.messages.length, 1);

  const userTurn = result.messages[0];
  assert.equal(userTurn.role, 'user');
  assert.equal(Array.isArray(userTurn.content), true);
  assert.equal(userTurn.content.length, 2);
  assert.deepEqual(userTurn.content[0], { type: 'text', text: 'What is in this picture?' });
  assert.deepEqual(userTurn.content[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: SAMPLE_BASE64,
    },
  });
});

test('geminiInitialInput serializes user_input parts with inline image data', () => {
  const messages = [
    {
      role: 'user',
      content: 'Inspect the mockups',
      imageAttachments: [
        { name: 'mockup1.png', mime: 'image/png', dataUrl: PNG_DATA_URL },
      ],
    },
    { role: 'assistant', content: 'I see the mockup.' },
  ];

  const result = geminiInitialInput(messages);
  assert.equal(result.length, 2);

  // User input with image
  assert.equal(result[0].type, 'user_input');
  assert.equal(result[0].content.length, 2);
  assert.deepEqual(result[0].content[0], { type: 'text', text: 'Inspect the mockups' });
  assert.deepEqual(result[0].content[1], {
    type: 'image',
    mime_type: 'image/png',
    data: SAMPLE_BASE64,
  });

  // Assistant output
  assert.equal(result[1].type, 'model_output');
  assert.deepEqual(result[1].content, [{ type: 'text', text: 'I see the mockup.' }]);
});

test('formatOpenAIChatMessages serializes multipart content with image_url for chat completions', () => {
  const messages = [
    { role: 'system', content: 'System instructions' },
    {
      role: 'user',
      content: 'Examine this screenshot',
      imageAttachments: [
        { name: 'screen.png', dataUrl: PNG_DATA_URL },
      ],
    },
  ];

  const result = formatOpenAIChatMessages(messages);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { role: 'system', content: 'System instructions' });

  assert.equal(result[1].role, 'user');
  assert.equal(Array.isArray(result[1].content), true);
  assert.equal(result[1].content.length, 2);
  assert.deepEqual(result[1].content[0], { type: 'text', text: 'Examine this screenshot' });
  assert.deepEqual(result[1].content[1], {
    type: 'image_url',
    image_url: { url: PNG_DATA_URL },
  });
});
