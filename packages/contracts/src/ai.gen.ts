// Generated from contracts/ai/*.schema.json by scripts/gen-ai-types.mjs. Do not edit.
/* eslint-disable */

export interface CheckRedundantOut {
  /**
   * the id of the owned book (from the input) the candidate repeats; absent when it repeats none
   */
  repeats?: string;
  reason?: string;
}

export interface ExplainPickOut {
  /**
   * one line in plain words, no hype
   */
  why: string;
}

export interface ExtractTitlesOut {
  books: {
    title: string;
    author?: string | null;
    /**
     * image/frame indexes
     */
    seenIn?: number[];
    confidence: number;
    audienceGuess?: "adult" | "kids" | "unknown";
    offTheme?: boolean;
    offThemeReason?: string;
  }[];
  framesRead?: number;
  notes?: string;
}

export interface ProposeLinksOut {
  links: {
    toBookId: string;
    reason: string;
    confidence: number;
  }[];
}

export interface SuggestNextOut {
  /**
   * @maxItems 3
   */
  suggestions: {
    title: string;
    author: string;
    move: "deepen" | "connect" | "broaden" | "counterpoint" | "wildcard";
    idea: string;
    ideas2?: string;
    /**
     * wildcards: which owned book it may join later
     */
    futureLink?: string;
    why: string;
  }[];
}

export interface TagBookOut {
  audience: "adult" | "kids";
  isFiction: boolean;
  /**
   * @maxItems 4
   */
  ideas?: {
    name: string;
    isNewIdea?: boolean;
    layer: "intro" | "core" | "deep" | "counterpoint";
    confidence: number;
  }[];
  /**
   * @maxItems 2
   */
  kidsThemes?: string[];
  ageBand?: "0-2" | "3-5" | "6-8" | "9-12" | null;
}
