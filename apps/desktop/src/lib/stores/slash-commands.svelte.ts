export interface SlashCommand {
  name: string;
  description: string;
  example: string;
  handler?: ((prompt: string) => void | Promise<void>) | undefined;
}

export const slashCommands: SlashCommand[] = [
  {
    name: 'imagine',
    description: 'Generate an image from a text prompt',
    example: '/imagine a sunset over mountains',
    // The composer hook is a follow-up lane.
    handler: undefined
  },
  {
    name: 'council',
    description: 'Ask several models the same question, side by side',
    example: '/council which database for a desktop app?',
    // Intercepted directly in the composer's onSend (opens the council
    // overlay); no handler indirection needed here.
    handler: undefined
  },
  {
    name: 'brief',
    description: 'Chief of Staff daily brief from recent threads + open loops',
    example: '/brief',
    // Intercepted in the composer's onSend (opens the daily-brief panel);
    // no handler indirection needed here.
    handler: undefined
  },
  {
    name: 'draft',
    description: 'Draft a reply in your voice from this thread',
    example: '/draft reply proposing Friday',
    // Intercepted in the composer's onSend (opens the draft panel for the
    // active thread); no handler indirection needed here.
    handler: undefined
  }
];
