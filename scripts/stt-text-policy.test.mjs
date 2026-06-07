import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectSttTextLanguage,
  findWhisperHallucination,
} from '../src/lib/sttTextPolicy.mjs';

test('keeps a legitimate Vietnamese thank-you sentence', () => {
  const text = 'Cảm ơn các bạn đã chú ý lắng nghe bài phát biểu của tôi.';
  assert.equal(findWhisperHallucination(text), null);
  assert.equal(detectSttTextLanguage(text, ['zh', 'vi']), 'vi');
});

test('keeps the imperfect Vietnamese transcript from the mobile log', () => {
  const text = 'Cảm ơn các bạn đã chỉnh lặng nghe live video của tôi.';
  assert.equal(findWhisperHallucination(text), null);
  assert.equal(detectSttTextLanguage(text, ['zh', 'vi']), 'vi');
});

test('does not block a legitimate thank-you for following a speech', () => {
  const text = 'Cảm ơn các bạn đã theo dõi bài phát biểu của tôi.';
  assert.equal(findWhisperHallucination(text), null);
});

test('blocks explicit video boilerplate hallucinations', () => {
  assert.equal(findWhisperHallucination('Thank you for watching.'), 'thank you for watching');
  assert.equal(
    findWhisperHallucination('Cảm ơn các bạn đã xem video.'),
    'cảm ơn các bạn đã xem video'
  );
});

test('prioritizes Vietnamese marks over mixed Chinese echo', () => {
  const text = 'Cảm ơn các bạn đã chú ý lắng nghe. 很高兴与大家见面。';
  assert.equal(detectSttTextLanguage(text, ['zh', 'vi']), 'vi');
});

test('maps mixed Korean-Chinese Azure garbage to the requested Chinese script', () => {
  const text = '감은격반낯주위랑의낚시요.很高兴与大家见面。';
  assert.equal(detectSttTextLanguage(text, ['zh', 'vi']), 'zh');
});
