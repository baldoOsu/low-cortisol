import { describe, expect, it } from 'vitest';
import { buildJevState, HIDE_CATEGORIES, JEV_QUESTIONS, meaningfulAlt, RUBRIC_VERSION } from '../../shared/rubric';
import { stableStringify } from '../../shared/hash';
import type { MediaTranscript } from '../../shared/types';
import { snapshot } from './helpers';

describe('rubric r1', () => {
  it('asks the five questions with the Q12 categories', () => {
    expect(RUBRIC_VERSION).toBe('r1');
    expect(Object.keys(JEV_QUESTIONS)).toEqual(['ragebait', 'category', 'emotion', 'intensity', 'topic']);
    for (const k of HIDE_CATEGORIES) expect(Object.keys(JEV_QUESTIONS.category.criteria)).toContain(k);
    expect(JEV_QUESTIONS.intensity.criteria).toHaveLength(5);
  });
});

describe('buildJevState', () => {
  it('text-only post', () => {
    expect(buildJevState(snapshot())).toEqual({
      post: { author: '@alice (Alice)', text: 'hello world' },
      media_status: 'none',
    });
  });

  it('includes flags, card, quoted post and media (text pass)', () => {
    const s = snapshot({
      truncated: true,
      promoted: true,
      repostedBy: '@bob',
      card: { domain: 'example.com', title: 'Title', description: '' },
      quoted: { authorHandle: '@carol', authorName: 'Carol', text: 'quoted', truncated: false },
      media: [
        { kind: 'image', url: 'u1', key: 'media/A', alt: 'Image', inQuote: false },
        { kind: 'card_image', url: 'u2', key: 'card_img/B', inQuote: false },
        { kind: 'video_poster', url: 'u3', key: 'ext_tw_video_thumb/C', alt: 'A cat on a piano', inQuote: true },
      ],
    });
    expect(buildJevState(s)).toEqual({
      post: {
        author: '@alice (Alice)',
        text: 'hello world',
        text_truncated: true,
        reposted_by: '@bob',
        promoted: true,
        link_card: { domain: 'example.com', title: 'Title' },
        media: [{ kind: 'image' }, { kind: 'card_image' }],
        quoted_post: {
          author: '@carol (Carol)',
          text: 'quoted',
          media: [{ kind: 'video_poster', alt: 'A cat on a piano' }],
        },
      },
      media_status: 'not_transcribed',
    });
  });

  it('merges transcripts by key on the full pass', () => {
    const s = snapshot({
      media: [
        { kind: 'image', url: 'u1', key: 'media/A', inQuote: false },
        { kind: 'image', url: 'u2', key: 'media/B', inQuote: false },
      ],
    });
    const t: MediaTranscript[] = [
      {
        key: 'media/A',
        kind: 'image',
        inQuote: false,
        visibleText: 'THEY ARE LYING',
        description: 'Red text.',
        cues: ['meme'],
        model: 'claude-opus-5-5',
      },
    ];
    const st = buildJevState(s, t);
    expect(st.media_status).toBe('transcribed');
    expect(st.post.media).toEqual([
      { kind: 'image', visible_text: 'THEY ARE LYING', description: 'Red text.', cues: ['meme'] },
      { kind: 'image' },
    ]);
  });

  it('is deterministic (same input, same serialisation)', () => {
    const s = snapshot({ card: { title: 'T', domain: 'd' } });
    expect(JSON.stringify(buildJevState(s))).toBe(JSON.stringify(buildJevState(structuredClone(s))));
    expect(stableStringify(buildJevState(s))).toBe(stableStringify(buildJevState(s)));
  });

  it('meaningfulAlt drops generic placeholders', () => {
    expect(meaningfulAlt('Image')).toBeUndefined();
    expect(meaningfulAlt(' embedded video ')).toBeUndefined();
    expect(meaningfulAlt('')).toBeUndefined();
    expect(meaningfulAlt('A dog')).toBe('A dog');
  });
});
