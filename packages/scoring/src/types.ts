export type Move = 'deepen' | 'connect' | 'broaden' | 'counterpoint' | 'wildcard' | 'intro' | 'fiction';
export type Layer = 'intro' | 'core' | 'deep' | 'counterpoint';

/** One line of "score opens into its parts" (the API's ScorePart). */
export interface ScorePart { label: string; value: number; kind: string }
