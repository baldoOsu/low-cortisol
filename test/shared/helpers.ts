import type { JevAnswers, PostSnapshot } from '../../shared/types';

/** Build a valid JevAnswers with overrides. Category probabilities default to benign. */
export function answers(
  o: {
    ragebait?: number;
    category?: Record<string, number>;
    intensity?: number;
    emotion?: Record<string, number>;
    topic?: Record<string, number>;
  } = {},
): JevAnswers {
  const category = o.category ?? { benign_other: 1 };
  const emotion = o.emotion ?? { neutral_informative: 1 };
  const topic = o.topic ?? { other: 1 };
  const top = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
  return {
    ragebait: { type: 'noul', noul: o.ragebait ?? 0.05 },
    category: { type: 'choice', choice: top(category), confidence: 1, probabilities: category },
    emotion: { type: 'choice', choice: top(emotion), confidence: 1, probabilities: emotion },
    intensity: {
      type: 'score',
      score: o.intensity ?? 0,
      confidence: 1,
      legend: { '0': 'Calm', '1': 'Mild', '2': 'Moderate', '3': 'Strong', '4': 'Inflammatory' },
      probabilities: { '0': 1 },
    },
    topic: { type: 'choice', choice: top(topic), confidence: 1, probabilities: topic },
  };
}

export function snapshot(o: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    postId: '1800000000000000001',
    url: 'https://x.com/alice/status/1800000000000000001',
    authorHandle: '@alice',
    authorName: 'Alice',
    text: 'hello world',
    truncated: false,
    promoted: false,
    media: [],
    ...o,
  };
}
