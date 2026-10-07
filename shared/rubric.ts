// Rubric r1: the Jev question set (owner's Q12 table) and the deterministic Jev input builder. Spec §3.2

import type {
  JevMediaState,
  JevPostState,
  JevQuotedState,
  JevState,
  MediaRef,
  MediaTranscript,
  PostSnapshot,
} from './types';

export const RUBRIC_VERSION = 'r1';

export const HIDE_CATEGORIES = [
  'outrage_bait',
  'culture_war',
  'engagement_bait',
  'harassment',
  'fear_mongering',
  'drama',
  'sensational_graphic',
] as const;

export const KEEP_CATEGORIES = [
  'neutral_news',
  'sincere_personal',
  'substantive_criticism',
  'humor',
  'benign_other',
] as const;

export const INTENSITY_LEVELS = ['Calm', 'Mild', 'Moderate', 'Strong', 'Inflammatory'] as const;

export const JEV_QUESTIONS = {
  ragebait: {
    type: 'noul',
    instructions:
      'Should this post be hidden for a reader who wants a calm, low-stress timeline? Hide posts designed or likely to provoke anger, outrage, contempt, fear or doom in a typical reader, rather than to inform, help or entertain. Judge the post, its quoted post, link card and media transcripts together as one unit.',
    criteria: {
      true: 'Outrage bait or dunking; political or culture-war fighting; engagement bait (ratio, RT if you agree, deliberately wrong hot takes); insults or harassment aimed at people or groups; fear-mongering (collapse, doom, health scares); influencer or celebrity drama; sensational or graphic crime, violence, war or disaster content.',
      false:
        'Neutral factual news, even about crime, war, politics or disasters; sad but sincere personal posts (grief, illness); harsh but substantive criticism or negative reviews; sarcasm or memes that are funny rather than hostile; everyday, informative, helpful or positive posts.',
    },
  },
  category: {
    type: 'choice',
    instructions: 'Which kind of post is this (post, quoted post, card and media together)?',
    criteria: {
      outrage_bait: 'Outrage bait or dunk quote-post ("can you believe...")',
      culture_war: 'Political or culture-war fighting',
      engagement_bait: 'Engagement bait: ratio, RT if you agree, deliberately wrong hot take',
      harassment: 'Insults or harassment aimed at people or groups',
      fear_mongering: 'Fear-mongering: collapse, doom, health scares',
      drama: 'Influencer or celebrity drama',
      sensational_graphic: 'Sensational or graphic crime, violence, war or disaster content',
      neutral_news: 'Neutral factual news, even about crime, war, politics or disasters',
      sincere_personal: 'Sad but sincere personal post (grief, illness)',
      substantive_criticism: 'Harsh but substantive criticism or negative review',
      humor: 'Sarcasm or meme that is funny rather than hostile',
      benign_other: 'Anything else: everyday, informative, helpful or positive',
    },
  },
  emotion: {
    type: 'choice',
    instructions: 'Which emotion is this post most likely to evoke in a typical reader?',
    criteria: {
      anger_outrage: 'Anger or outrage',
      fear_anxiety: 'Fear or anxiety',
      disgust_contempt: 'Disgust or contempt',
      mockery_dunking: 'Mockery or dunking on someone',
      sadness_grief: 'Sadness or grief',
      neutral_informative: 'Neutral or informative',
      positive_amused: 'Positive, amused or uplifted',
    },
  },
  intensity: {
    type: 'score',
    instructions: 'How emotionally inflammatory is this post for a typical reader?',
    criteria: [...INTENSITY_LEVELS],
  },
  topic: {
    type: 'choice',
    instructions: 'What is the main topic of this post?',
    criteria: {
      politics: 'Politics, elections, government',
      culture_war: 'Culture-war or identity conflict',
      crime_violence: 'Crime or violence',
      war_conflict: 'War or armed conflict',
      disaster: 'Disaster, accident or catastrophe',
      economy_business: 'Economy, money or business',
      tech_ai: 'Technology or AI',
      science_health: 'Science or health',
      celebrity_entertainment: 'Celebrities, entertainment or influencers',
      sports: 'Sports',
      personal_life: 'Personal life or everyday experiences',
      other: 'Other',
    },
  },
} as const;

const GENERIC_ALT = /^(image|photo|picture|embedded video|video|gif)$/i;

/** Alt text worth sending: non-empty and not X's generic placeholder. */
export function meaningfulAlt(alt: string | undefined): string | undefined {
  const a = alt?.trim();
  if (!a || GENERIC_ALT.test(a)) return undefined;
  return a;
}

export function formatAuthor(handle: string, name: string): string {
  const h = handle.trim();
  const n = name.trim();
  return n && n !== h ? `${h} (${n})` : h;
}

function mediaState(m: MediaRef, byKey: Map<string, MediaTranscript> | undefined): JevMediaState {
  const out: JevMediaState = { kind: m.kind };
  const alt = meaningfulAlt(m.alt);
  if (alt) out.alt = alt;
  const t = byKey?.get(m.key);
  if (t) {
    out.visible_text = t.visibleText;
    out.description = t.description;
    out.cues = [...t.cues];
  }
  return out;
}

/**
 * Deterministic Jev input for a post. Without transcripts this is the text pass
 * (media carry only kind/alt, media_status "not_transcribed"); with transcripts it is the full pass.
 */
export function buildJevState(snapshot: PostSnapshot, transcripts?: MediaTranscript[]): JevState {
  const byKey = transcripts ? new Map(transcripts.map((t) => [t.key, t])) : undefined;
  const outerMedia = snapshot.media.filter((m) => !m.inQuote).map((m) => mediaState(m, byKey));
  const quotedMedia = snapshot.media.filter((m) => m.inQuote).map((m) => mediaState(m, byKey));

  const post: JevPostState = {
    author: formatAuthor(snapshot.authorHandle, snapshot.authorName),
    text: snapshot.text,
  };
  if (snapshot.truncated) post.text_truncated = true;
  if (snapshot.repostedBy) post.reposted_by = snapshot.repostedBy;
  if (snapshot.promoted) post.promoted = true;
  if (snapshot.card) {
    const card: JevPostState['link_card'] = {};
    if (snapshot.card.domain) card.domain = snapshot.card.domain;
    if (snapshot.card.title) card.title = snapshot.card.title;
    if (snapshot.card.description) card.description = snapshot.card.description;
    if (Object.keys(card).length > 0) post.link_card = card;
  }
  if (outerMedia.length > 0) post.media = outerMedia;
  if (snapshot.quoted) {
    const q: JevQuotedState = {
      author: formatAuthor(snapshot.quoted.authorHandle, snapshot.quoted.authorName),
      text: snapshot.quoted.text,
    };
    if (snapshot.quoted.truncated) q.text_truncated = true;
    if (quotedMedia.length > 0) q.media = quotedMedia;
    post.quoted_post = q;
  }

  const media_status =
    snapshot.media.length === 0 ? 'none' : transcripts ? 'transcribed' : 'not_transcribed';
  return { post, media_status };
}
