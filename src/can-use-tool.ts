export interface CanUseToolOptions {
  /** Tools to always allow (bypass canUseTool for these via allowedTools — but this list
   *  is for the canUseTool callback's own logic if a tool reaches it). */
  allow?: string[];

  /** Tools to always deny. */
  deny?: string[];

  /** Handler for AskUserQuestion interception.
   *  Receives the tool input, returns an array of answer strings. */
  onAskUserQuestion?: (input: Record<string, unknown>) => Promise<string[]>;

  /** If provided, each Q&A pair is pushed here for logging. */
  questionLog?: Array<{ question: string; answers: string[]; timestamp: string }>;
}

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown },
) => Promise<PermissionResult>;

export function createCanUseTool(opts: CanUseToolOptions): CanUseToolFn {
  const allow = new Set(opts.allow ?? []);
  const deny = new Set(opts.deny ?? []);

  return async (toolName, input, _options): Promise<PermissionResult> => {
    // 1. AskUserQuestion interception
    if (toolName === "AskUserQuestion" && opts.onAskUserQuestion) {
      const questions = (input as any).questions ?? [];
      const questionTexts = questions.map((q: any) => q.question ?? String(q));

      const answers = await opts.onAskUserQuestion(input);

      // Log Q&A pairs
      if (opts.questionLog) {
        for (const qText of questionTexts) {
          opts.questionLog.push({
            question: qText,
            answers,
            timestamp: new Date().toISOString(),
          });
        }
      }

      return {
        behavior: "allow",
        updatedInput: { ...input, answers },
      };
    }

    // 2. Explicit deny list
    if (deny.has(toolName)) {
      return { behavior: "deny", message: `${toolName} is blocked in this worker profile.` };
    }

    // 3. Explicit allow list
    if (allow.has(toolName)) {
      return { behavior: "allow" };
    }

    // 4. Default: deny unknown tools
    return { behavior: "deny", message: `${toolName} is not permitted in this worker profile.` };
  };
}
